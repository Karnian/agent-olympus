/**
 * Autonomy - Ship Policy config loader/validator for Agent Olympus
 *
 * Loads and validates `.ao/autonomy.json`, deep-merges user config over
 * DEFAULT_AUTONOMY_CONFIG, and always returns a usable config. Always fail-safe.
 */

import { readFileSync, realpathSync } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Default autonomy/ship-policy config used when validation fails or config is absent.
 *
 * @type {{
 *   version: string,
 *   ship: {
 *     mode: 'never'|'ask'|'auto',
 *     autoPush: boolean,
 *     baseBranch: string|null,
 *     updateChangelog: boolean,
 *     updateTechDebtTracker: boolean,
 *     draftPR: boolean,
 *     autoLink: boolean,
 *     labels: string[],
 *     issuePattern: string
 *   },
 *   ci: { watchEnabled: boolean, maxCycles: number, pollIntervalMs: number, timeoutMs: number },
 *   notify: { onComplete: boolean, onBlocked: boolean, onCIFail: boolean, sound: boolean },
 *   budget: { warnThresholdUsd: number | null }
 * }}
 */
export const DEFAULT_AUTONOMY_CONFIG = {
  version: '1',
  ship: {
    mode: 'ask',
    // Deprecated compatibility field. Prefer `mode`; legacy true maps to
    // `auto`, while false or absent maps to the safe `ask` policy.
    autoPush: false,
    baseBranch: null,
    updateChangelog: true,
    updateTechDebtTracker: true,
    draftPR: true,
    autoLink: true,
    labels: [],
    issuePattern: '#(\\d+)',
  },
  ci: {
    watchEnabled: true,
    maxCycles: 2,
    pollIntervalMs: 30000,
    timeoutMs: 600000,
  },
  notify: {
    onComplete: true,
    onBlocked: true,
    onCIFail: true,
    sound: true,
  },
  budget: {
    warnThresholdUsd: null,
  },
  codex: {
    approval: 'auto',
    hostSandbox: 'auto',
  },
  gemini: {
    approval: 'auto',
    credentialSource: 'auto',
    keychainAccount: 'default-api-key',
    keychainService: null,
    useKeychain: true,
  },
  nativeTeams: false,
  planExecution: 'ask',
  architect: {
    // diffScope: "auto" (default — full context; flip to "enabled" after
    // reviewing usage-report to confirm architect is a hotspot worth
    // narrowing) | "enabled" (use 1-hop scope when no shared-lib change)
    // | "disabled" (never narrow, always full context)
    diffScope: 'auto',
  },
  stageEscalation: {
    // Opt-in for Phase 3 critic escalation pipeline. When disabled, critics
    // still emit free-text verdicts and existing retry paths continue
    // unchanged. When enabled, critic STAGE_VERDICT blocks can trigger
    // Sonnet→Opus re-runs of the prior stage.
    enabled: false,
  },
  // Phase 4 — orchestrator operation mode.
  //   "full" (default) — full pipeline with momus + architect review stages
  //   "light"          — skip momus + architect; user confirms opt-in via
  //                      AskUserQuestion at start of run. Any review reject
  //                      auto-escalates back to full.
  // Override per-run via CLI flag `--light` (highest precedence).
  mode: 'full',
};

/**
 * Validation result returned by validateAutonomyConfig.
 *
 * @typedef {{ valid: boolean, errors: string[], config: typeof DEFAULT_AUTONOMY_CONFIG }} AutonomyValidationResult
 */

/**
 * Validate the structure of a parsed autonomy config object.
 *
 * Rules checked:
 *   - config must be a non-null object
 *   - ship must be an object with a valid mode, optional base branch, boolean
 *     update flags and deprecated autoPush, plus labels/issuePattern metadata
 *   - ci.watchEnabled must be boolean
 *   - ci.maxCycles must be a positive integer
 *   - ci.pollIntervalMs must be a positive number
 *   - ci.timeoutMs must be a positive number
 *   - notify.onComplete, notify.onBlocked, notify.onCIFail, notify.sound must be booleans
 *   - budget.warnThresholdUsd must be null or a positive number
 *
 * On any validation error the function returns DEFAULT_AUTONOMY_CONFIG so the
 * caller always receives a usable config regardless of the input.
 *
 * @param {unknown} config - raw parsed config (may be null/undefined on load failure)
 * @returns {AutonomyValidationResult}
 */
export function validateAutonomyConfig(config) {
  try {
    const errors = [];

    // Guard: config must be a non-null object
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      errors.push('config must be a non-null object; received: ' + (config === null ? 'null' : typeof config));
      return { valid: false, errors, config: DEFAULT_AUTONOMY_CONFIG };
    }

    // --- ship ---
    if (!config.ship || typeof config.ship !== 'object' || Array.isArray(config.ship)) {
      errors.push(
        'config.ship must be a non-null object; received: ' +
        (config.ship === null ? 'null' : typeof config.ship)
      );
    } else {
      if (config.ship.mode !== undefined) {
        const validShipModes = ['never', 'ask', 'auto'];
        if (typeof config.ship.mode !== 'string' || !validShipModes.includes(config.ship.mode)) {
          errors.push(
            'config.ship.mode must be one of: never, ask, auto; received: ' +
            JSON.stringify(config.ship.mode)
          );
        }
      }

      for (const boolField of [
        'autoPush',
        'updateChangelog',
        'updateTechDebtTracker',
        'draftPR',
        'autoLink',
      ]) {
        const val = config.ship[boolField];
        if (val !== undefined && typeof val !== 'boolean') {
          errors.push(
            `config.ship.${boolField} must be a boolean; received: ${JSON.stringify(val)}`
          );
        }
      }

      if (config.ship.baseBranch !== undefined && config.ship.baseBranch !== null) {
        if (typeof config.ship.baseBranch !== 'string' || !config.ship.baseBranch.trim()) {
          errors.push(
            'config.ship.baseBranch must be null or a non-empty string; received: ' +
            JSON.stringify(config.ship.baseBranch)
          );
        }
      }

      if (config.ship.labels !== undefined && !Array.isArray(config.ship.labels)) {
        errors.push(
          'config.ship.labels must be an array; received: ' + typeof config.ship.labels
        );
      }

      if (config.ship.issuePattern !== undefined && typeof config.ship.issuePattern !== 'string') {
        errors.push(
          'config.ship.issuePattern must be a string; received: ' +
          JSON.stringify(config.ship.issuePattern)
        );
      }
    }

    // --- ci ---
    if (config.ci !== undefined) {
      if (!config.ci || typeof config.ci !== 'object' || Array.isArray(config.ci)) {
        errors.push(
          'config.ci must be a non-null object; received: ' +
          (config.ci === null ? 'null' : typeof config.ci)
        );
      } else {
        // ci.watchEnabled
        if (config.ci.watchEnabled !== undefined && typeof config.ci.watchEnabled !== 'boolean') {
          errors.push(
            'config.ci.watchEnabled must be a boolean; received: ' +
            JSON.stringify(config.ci.watchEnabled)
          );
        }

        // ci.maxCycles — positive integer
        const maxCycles = config.ci.maxCycles;
        if (maxCycles !== undefined) {
          if (
            typeof maxCycles !== 'number' ||
            !Number.isInteger(maxCycles) ||
            maxCycles < 1
          ) {
            errors.push(
              'config.ci.maxCycles must be a positive integer; received: ' +
              JSON.stringify(maxCycles)
            );
          }
        }

        // ci.pollIntervalMs — positive number
        const pollIntervalMs = config.ci.pollIntervalMs;
        if (pollIntervalMs !== undefined) {
          if (typeof pollIntervalMs !== 'number' || pollIntervalMs <= 0) {
            errors.push(
              'config.ci.pollIntervalMs must be a positive number; received: ' +
              JSON.stringify(pollIntervalMs)
            );
          }
        }

        // ci.timeoutMs — positive number
        const timeoutMs = config.ci.timeoutMs;
        if (timeoutMs !== undefined) {
          if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
            errors.push(
              'config.ci.timeoutMs must be a positive number; received: ' +
              JSON.stringify(timeoutMs)
            );
          }
        }
      }
    }

    // --- notify ---
    if (config.notify !== undefined) {
      if (!config.notify || typeof config.notify !== 'object' || Array.isArray(config.notify)) {
        errors.push(
          'config.notify must be a non-null object; received: ' +
          (config.notify === null ? 'null' : typeof config.notify)
        );
      } else {
        for (const boolField of ['onComplete', 'onBlocked', 'onCIFail', 'sound']) {
          const val = config.notify[boolField];
          if (val !== undefined && typeof val !== 'boolean') {
            errors.push(
              `config.notify.${boolField} must be a boolean; received: ${JSON.stringify(val)}`
            );
          }
        }
      }
    }

    // --- budget ---
    if (config.budget !== undefined) {
      if (!config.budget || typeof config.budget !== 'object' || Array.isArray(config.budget)) {
        errors.push(
          'config.budget must be a non-null object; received: ' +
          (config.budget === null ? 'null' : typeof config.budget)
        );
      } else {
        const warnThresholdUsd = config.budget.warnThresholdUsd;
        if (warnThresholdUsd !== undefined && warnThresholdUsd !== null) {
          if (typeof warnThresholdUsd !== 'number' || warnThresholdUsd <= 0) {
            errors.push(
              'config.budget.warnThresholdUsd must be null or a positive number; received: ' +
              JSON.stringify(warnThresholdUsd)
            );
          }
        }
      }
    }

    // --- codex ---
    if (config.codex !== undefined) {
      if (!config.codex || typeof config.codex !== 'object' || Array.isArray(config.codex)) {
        errors.push(
          'config.codex must be a non-null object; received: ' +
          (config.codex === null ? 'null' : typeof config.codex)
        );
      } else {
        const approval = config.codex.approval;
        if (approval !== undefined) {
          const validApprovals = ['auto', 'suggest', 'auto-edit', 'full-auto'];
          if (typeof approval !== 'string' || !validApprovals.includes(approval)) {
            errors.push(
              'config.codex.approval must be one of: auto, suggest, auto-edit, full-auto; received: ' +
              JSON.stringify(approval)
            );
          }
        }
        // codex.hostSandbox — explicit host-sandbox-tier override.
        // Consumed by host-sandbox-detect.mjs when AO_HOST_SANDBOX_LEVEL
        // env var is not set. `'auto'` (default) means "use detection".
        const hostSandbox = config.codex.hostSandbox;
        if (hostSandbox !== undefined) {
          const validSandbox = ['auto', 'unrestricted', 'workspace-write', 'read-only'];
          if (typeof hostSandbox !== 'string' || !validSandbox.includes(hostSandbox)) {
            errors.push(
              'config.codex.hostSandbox must be one of: auto, unrestricted, workspace-write, read-only; received: ' +
              JSON.stringify(hostSandbox)
            );
          }
        }
      }
    }

    // --- gemini ---
    if (config.gemini !== undefined) {
      if (!config.gemini || typeof config.gemini !== 'object' || Array.isArray(config.gemini)) {
        errors.push(
          'config.gemini must be a non-null object; received: ' +
          (config.gemini === null ? 'null' : typeof config.gemini)
        );
      } else {
        const approval = config.gemini.approval;
        if (approval !== undefined) {
          const validApprovals = ['auto', 'default', 'auto_edit', 'yolo', 'plan'];
          if (typeof approval !== 'string' || !validApprovals.includes(approval)) {
            errors.push(
              'config.gemini.approval must be one of: auto, default, auto_edit, yolo, plan; received: ' +
              JSON.stringify(approval)
            );
          }
        }

        // credentialSource: selects which resolver path to use.
        //   'auto'           = env → shared-keychain → miss (default)
        //   'env'            = env only, keychain skipped
        //   'shared-keychain'= `gemini-cli-api-key` (managed by gemini CLI)
        //   'ao-keychain'    = `agent-olympus.gemini-api-key` (managed by setup wizard)
        if (config.gemini.credentialSource !== undefined) {
          const validSources = ['auto', 'env', 'shared-keychain', 'ao-keychain'];
          const src = config.gemini.credentialSource;
          if (typeof src !== 'string' || !validSources.includes(src)) {
            errors.push(
              'config.gemini.credentialSource must be one of: auto, env, shared-keychain, ao-keychain; received: ' +
              JSON.stringify(src)
            );
          }
        }

        // keychainService: optional override for the keychain service name.
        //   null (default) = derive from credentialSource (shared → `gemini-cli-api-key`,
        //                     ao → `agent-olympus.gemini-api-key`)
        //   string         = explicit service name
        if (config.gemini.keychainService !== undefined && config.gemini.keychainService !== null) {
          const svc = config.gemini.keychainService;
          if (typeof svc !== 'string' || !svc.trim()) {
            errors.push(
              'config.gemini.keychainService must be null or a non-empty string; received: ' +
              JSON.stringify(svc)
            );
          }
        }

        // useKeychain: DEPRECATED legacy opt-out toggle. `useKeychain: false`
        // normalizes internally to `credentialSource: 'env'` at resolve time.
        // Kept so existing autonomy.json files continue to validate unchanged.
        if (config.gemini.useKeychain !== undefined && typeof config.gemini.useKeychain !== 'boolean') {
          errors.push(
            'config.gemini.useKeychain must be a boolean; received: ' +
            JSON.stringify(config.gemini.useKeychain)
          );
        }

        // keychainAccount: which account to look up in the secret store.
        // Accepts any non-empty string — execFile argv prevents shell injection,
        // so no regex restriction is needed.
        if (config.gemini.keychainAccount !== undefined) {
          const acct = config.gemini.keychainAccount;
          if (typeof acct !== 'string' || !acct.trim()) {
            errors.push(
              'config.gemini.keychainAccount must be a non-empty string; received: ' +
              JSON.stringify(acct)
            );
          }
        }
      }
    }

    // --- nativeTeams ---
    if (config.nativeTeams !== undefined && typeof config.nativeTeams !== 'boolean') {
      errors.push(
        'config.nativeTeams must be a boolean; received: ' + JSON.stringify(config.nativeTeams)
      );
    }

    // --- planExecution ---
    if (config.planExecution !== undefined) {
      const validModes = ['solo', 'ask', 'atlas', 'athena'];
      if (typeof config.planExecution !== 'string' || !validModes.includes(config.planExecution)) {
        errors.push(
          'config.planExecution must be one of: solo, ask, atlas, athena; received: ' +
          JSON.stringify(config.planExecution)
        );
      }
    }

    // --- architect ---
    if (config.architect !== undefined) {
      if (!config.architect || typeof config.architect !== 'object' || Array.isArray(config.architect)) {
        errors.push(
          'config.architect must be a non-null object; received: ' +
          (config.architect === null ? 'null' : typeof config.architect)
        );
      } else if (config.architect.diffScope !== undefined) {
        const validScope = ['auto', 'enabled', 'disabled'];
        if (typeof config.architect.diffScope !== 'string' ||
            !validScope.includes(config.architect.diffScope)) {
          errors.push(
            'config.architect.diffScope must be one of: auto, enabled, disabled; received: ' +
            JSON.stringify(config.architect.diffScope)
          );
        }
      }
    }

    // --- stageEscalation ---
    if (config.stageEscalation !== undefined) {
      if (!config.stageEscalation || typeof config.stageEscalation !== 'object' ||
          Array.isArray(config.stageEscalation)) {
        errors.push(
          'config.stageEscalation must be a non-null object; received: ' +
          (config.stageEscalation === null ? 'null' : typeof config.stageEscalation)
        );
      } else if (config.stageEscalation.enabled !== undefined &&
                 typeof config.stageEscalation.enabled !== 'boolean') {
        errors.push(
          'config.stageEscalation.enabled must be boolean; received: ' +
          JSON.stringify(config.stageEscalation.enabled)
        );
      }
    }

    // --- mode (Phase 4) ---
    if (config.mode !== undefined) {
      const validModes = ['full', 'light'];
      if (typeof config.mode !== 'string' || !validModes.includes(config.mode)) {
        errors.push(
          'config.mode must be one of: full, light; received: ' +
          JSON.stringify(config.mode)
        );
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors, config: DEFAULT_AUTONOMY_CONFIG };
    }

    return { valid: true, errors: [], config };
  } catch {
    // fail-safe: never throw
    return {
      valid: false,
      errors: ['validateAutonomyConfig threw an unexpected error; using defaults'],
      config: DEFAULT_AUTONOMY_CONFIG,
    };
  }
}

/**
 * Resolve the effective shipping policy while preserving legacy autoPush
 * behavior. An explicit valid mode always wins. A present but invalid mode is
 * fail-safe `ask`; only a missing mode can fall back to deprecated autoPush.
 *
 * @param {unknown} config
 * @returns {'never'|'ask'|'auto'}
 */
export function resolveShipMode(config) {
  try {
    const ship = config?.ship;
    if (!ship || typeof ship !== 'object' || Array.isArray(ship)) return 'ask';

    if (Object.prototype.hasOwnProperty.call(ship, 'mode')) {
      return ['never', 'ask', 'auto'].includes(ship.mode) ? ship.mode : 'ask';
    }

    return ship.autoPush === true ? 'auto' : 'ask';
  } catch {
    return 'ask';
  }
}

const META_COPY_MARKER = /\b(?:copy|example|label|literal|message|metadata|notice|phrase|state|string|text|tooltip|warning)\b|(?:문구|카피|메시지|텍스트|경고|안내|예시)/i;
const META_BLOCK_INTRO = /(?:\b(?:copy|examples?|label|literal|notice|phrase|string|tooltip|warning)\b|(?:문구|카피|예시|안내\s*문구|경고\s*문구))[^\n]*[:：]\s*$/i;
const META_INLINE_COPY_INTRO = /\b(?:add|change|display|render|replace|set|show|update|use|write)\b[^\n:]{0,80}\b(?:copy|label|literal|notice|phrase|string|text|tooltip|warning\s+(?:copy|message|text))\b[^\n:]*[:：]\s*/i;
const META_EXAMPLE_DIRECTIVE = /(?:--no-ship|\b(?:do\s+not|don['’]t|never)\s+(?:ship|push|publish|create|open|update)|^\s*no\s+(?:push|prs?|pull\s+requests?)\b|(?:푸시|PR|풀\s*리퀘스트)[^\n]{0,24}(?:마(?:세요)?|말|안\s*(?:해|돼|되)))/i;
const QUOTED_TEXT = /"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`|「[^」\n]*」/g;

/**
 * Mask quoted UI copy and the first payload line of an explicitly introduced
 * example block. The durable task brief is newline-joined, so a genuine
 * follow-up such as `No PR, please.` must otherwise remain visible.
 *
 * @param {string} text
 * @returns {string}
 */
function maskNoShipMetaExamples(text) {
  const lines = text.split('\n');
  let maskNextExampleLine = false;
  let maskExampleFence = false;

  return lines.map(line => {
    if (maskExampleFence) {
      if (/^\s*```/.test(line)) maskExampleFence = false;
      return '';
    }
    if (maskNextExampleLine) {
      if (!line.trim()) return '';
      if (/^\s*```/.test(line)) maskExampleFence = true;
      maskNextExampleLine = META_EXAMPLE_DIRECTIVE.test(line);
      return '';
    }

    const masksQuotedCopy = META_COPY_MARKER.test(line) && QUOTED_TEXT.test(line);
    QUOTED_TEXT.lastIndex = 0;
    const maskedLine = masksQuotedCopy ? line.replace(QUOTED_TEXT, '') : line;
    QUOTED_TEXT.lastIndex = 0;
    if (META_INLINE_COPY_INTRO.test(maskedLine)) {
      return maskedLine.replace(/([:：])[^:：]*$/, '$1');
    }
    if (META_BLOCK_INTRO.test(maskedLine)) maskNextExampleLine = true;
    return maskedLine;
  }).join('\n');
}

const EXPLICIT_NO_SHIP_PATTERNS = [
  /(?:^|\s)--no-ship(?:\s|$)/i,
  /\b(?:do\s+not|don['’]t|never)\s+(?:automatically\s+)?ship\b/i,
  // Push/publish are overloaded product verbs (push notifications, publish
  // telemetry). Treat them as shipping only when the directive is standalone
  // or names a repository/release artifact.
  /\b(?:do\s+not|don['’]t|never)\s+(?:automatically\s+)?(?:push|publish)\s*(?=$|[,;.?!\u2014]|-(?:\s|$)|\bplease\b)/im,
  /\b(?:do\s+not|don['’]t|never)\s+(?:automatically\s+)?(?:push|publish)\s+(?:anything|yet|later|for\s+now)\b/i,
  /\b(?:do\s+not|don['’]t|never)\s+(?:automatically\s+)?push\s+(?:this|that|it)(?:\s+(?:until\b[^\n.!?]*|yet\b|for\s+now\b|(?:to\s+)?(?:origin|upstream|(?:the\s+)?remote|github|gitlab|bitbucket)\b))?\s*(?=$|[,;.?!\u2014])/im,
  /\b(?:do\s+not|don['’]t|never)\s+(?:automatically\s+)?push\s+(?:until|before)\b/i,
  /\b(?:do\s+not|don['’]t|never)\s+(?:automatically\s+)?push\s+(?:(?:this|that|these|those|the|my|our|your|any|a|an)\s+)?(?:(?:current|working|feature)\s+)?(?:changes?|commits?|code|branch(?:es)?|tags?|refs?|head|repositor(?:y|ies)|repos?)\b(?!\s+(?:selector|object|value|identifier|name|label|field|key|event|metadata|into|onto)\b|\s+to\s+(?:the\s+)?(?:array|stack|queue|list|state|store|collection|buffer)\b)/i,
  /\b(?:do\s+not|don['’]t|never)\s+(?:automatically\s+)?push\s+to\s+(?:origin|upstream|(?:the\s+)?remote|github|gitlab|bitbucket)\b/i,
  /\b(?:do\s+not|don['’]t|never)\s+(?:automatically\s+)?publish\s+(?:(?:this|that|these|those|the|my|our|your|any|a|an)\s+)?(?:changes?|packages?|releases?|artifacts?|builds?|branch(?:es)?|repositor(?:y|ies)|repos?)\b(?!\s+(?:selector|object|value|identifier|name|label|field|key|event|notification|message|record|into|onto)\b)/i,
  /\b(?:do\s+not|don['’]t|never)\s+(?:automatically\s+)?push\b[^\n]{0,40}\b(?:create|open|raise|submit|update|edit|modify)\s+(?:(?:a|the)\s+)?(?:pr|pull\s+request)\b/i,
  /\b(?:do\s+not|don['’]t|never)\s+(?:create|make|open|raise|submit|update|edit|modify)\s+(?:(?:a|an|any|the)\s+)?(?:prs?|pull\s+requests?)\b/i,
  // Standalone "no push" is a directive; prose such as "no push notification"
  // and "No PR exists yet" is not. Bare no-PR wording is accepted only when
  // the entire sentence is the directive.
  /\bno\s+(?:automatic\s+)?push(?:ing)?\s*(?=$|[,;.!\u2014]|-(?:\s|$)|\bplease\b)/im,
  /^\s*(?:please\s*,\s*)?no\s+(?:prs?|pull\s+requests?)(?:\s*,?\s*please)?\s*[.!?]*\s*$/im,
  /\b(?:i(?:\s+(?:will|shall)|['’]ll)|(?:the\s+user|user)\s+(?:will|shall))\s+(?:manually\s+)?(?:push|publish)\s*(?=$|[,;.?!\u2014]|-(?:\s|$)|\b(?:it\s+)?(?:myself|ourselves|themselves)\b)/im,
  /\b(?:i(?:\s+(?:will|shall)|['’]ll)|(?:the\s+user|user)\s+(?:will|shall))\s+(?:manually\s+)?(?:push|publish)\s+(?:anything|later|after\s+(?:verification|review|testing))\b/i,
  /\b(?:i(?:\s+(?:will|shall)|['’]ll)|(?:the\s+user|user)\s+(?:will|shall))\s+(?:manually\s+)?push\s+(?:(?:this|that|these|those|the|my|our|your|any|a|an)\s+)?(?:(?:current|working|feature)\s+)?(?:changes?|commits?|code|branch(?:es)?|tags?|refs?|head|repositor(?:y|ies)|repos?)\b(?!\s+(?:selector|object|value|identifier|name|label|field|key|event|into|onto)\b|\s+to\s+(?:the\s+)?(?:array|stack|queue|list|state|store|collection|buffer)\b)/i,
  /\b(?:i(?:\s+(?:will|shall)|['’]ll)|(?:the\s+user|user)\s+(?:will|shall))\s+(?:manually\s+)?push\s+to\s+(?:origin|upstream|(?:the\s+)?remote|github|gitlab|bitbucket)\b/i,
  /\b(?:i(?:\s+(?:will|shall)|['’]ll)|(?:the\s+user|user)\s+(?:will|shall))\s+(?:manually\s+)?publish\s+(?:(?:this|that|these|those|the|my|our|your|any|a|an)\s+)?(?:changes?|packages?|releases?|artifacts?|builds?|branch(?:es)?|repositor(?:y|ies)|repos?)\b(?!\s+(?:selector|object|value|identifier|name|label|field|key|event|notification|message|record|into|onto)\b)/i,
  /\b(?:i(?:\s+(?:will|shall)|['’]ll)|(?:the\s+user|user)\s+(?:will|shall))\b[^\n]{0,80}\b(?:open|create|raise|submit|update|edit|modify)\s+(?:(?:a|the)\s+)?(?:single\s+)?(?:pr|pull\s+request)\b/i,
  /\b(?:i(?:\s+(?:will|shall)|['’]ll)|(?:the\s+user|user)\s+(?:will|shall))\s+(?:(?:will\s+)?(?:personally\s+)?(?:handle|manage)\s+(?:the\s+)?|(?:take\s+care\s+of)\s+(?:the\s+)?)(?:push|pushing|publishing|pr|pull\s+request)\b(?:\s+(?:personally|myself|themselves))?/i,
  /\b(?:leave|keep)\b[^\n]{0,40}\b(?:local|unpublished|unpushed)\b/i,
  /(?:푸시|push)\s*(?:(?:를|을|은|는)\s*)?(?:하지\s*(?:마(?:세요)?|말(?:아(?:\s*주세요)?|라고|라|고|자)?|않(?:아|을))|안\s*(?:해|할)|금지)/i,
  /(?:푸시|push)\s*(?:(?:를|을|은|는)\s*)?(?:하?면|할\s*경우)\s*안\s*(?:돼|되|됩니다|된다|됨)/i,
  /(?:PR|풀\s*리퀘스트)\s*(?:(?:을|를|은|는)\s*)?(?:(?:만들|생성하|작성하|열|올리|수정하|업데이트하|갱신하)지\s*(?:마(?:세요)?|말(?:아(?:\s*주세요)?|라고|라|고|자)?))/i,
  /(?:PR|풀\s*리퀘스트)\s*(?:(?:을|를|은|는)\s*)?(?:생성|작성|수정|업데이트|갱신)\s*(?:은|는)?\s*하지\s*(?:마(?:세요)?|말(?:아(?:\s*주세요)?|라고|라|고|자)?)/i,
  /(?:PR|풀\s*리퀘스트)\s*(?:(?:을|를|은|는)\s*)?(?:올리|만들|생성하|작성하|열)면\s*안\s*(?:돼|되|됩니다|된다|됨)/i,
  /(?:PR|풀\s*리퀘스트)\s*(?:(?:을|를|은|는)\s*)?(?:수정|업데이트|갱신)\s*(?:은|는)?\s*하지\s*(?:마(?:세요)?|말(?:아(?:\s*주세요)?|라고|라|고|자)?)/i,
  /(?:내가|제가|사용자(?:가|는)?)\s*(?:(?:직접|알아서|나중에)\s*)*(?:푸시|push)\s*(?:(?:를|을|은|는)\s*)?(?:할게(?:요)?|하겠(?:습니다|다)?|할\s*예정(?:입니다|이다|이에요|임)|할\s*(?:거|꺼|것)\s*(?:야|예요|에요|입니다|이다))/i,
  /(?:푸시|push)\s*(?:(?:를|을|은|는)\s*)?(?:내가|제가|사용자(?:가|는)?)\s*(?:(?:직접|알아서|나중에)\s*)*(?:할게(?:요)?|하겠(?:습니다|다)?|할\s*예정(?:입니다|이다|이에요|임)|할\s*(?:거|꺼|것)\s*(?:야|예요|에요|입니다|이다))/i,
  /(?:푸시|push)\s*(?:(?:를|을|은|는)\s*)?(?:내가|제가|사용자(?:가|는)?)\s*(?:(?:직접|알아서|나중에)\s*)*처리\s*(?:할게(?:요)?|하겠(?:습니다|다)?|할\s*예정(?:입니다|이다|이에요|임)|할\s*(?:거|꺼|것)\s*(?:야|예요|에요|입니다|이다))/i,
  /(?:내가|제가|사용자(?:가|는)?)\s*(?:(?:직접|알아서|나중에)\s*)*(?:PR|풀\s*리퀘스트)\s*(?:(?:을|를|은|는)\s*)?(?:(?:올릴|열|만들|생성하|작성하)(?:게(?:요)?|겠(?:습니다|다)?|\s*예정(?:입니다|이다|이에요|임)|\s*(?:거|꺼|것)\s*(?:야|예요|에요|입니다|이다))|(?:올리|열|만들|생성하|작성하)겠(?:습니다|다)|(?:처리\s*)?할게(?:요)?)/i,
  /(?:PR|풀\s*리퀘스트)\s*(?:(?:을|를|은|는)\s*)?(?:내가|제가|사용자(?:가|는)?)\s*(?:(?:직접|알아서|나중에)\s*)*(?:(?:올릴|열|만들|생성하|작성하)(?:게(?:요)?|겠(?:습니다|다)?|\s*예정(?:입니다|이다|이에요|임)|\s*(?:거|꺼|것)\s*(?:야|예요|에요|입니다|이다))|(?:올리|열|만들|생성하|작성하)겠(?:습니다|다)|(?:처리\s*)?할게(?:요)?)/i,
  /(?:PR|풀\s*리퀘스트)\s*(?:(?:을|를|은|는)\s*)?(?:내가|제가|사용자(?:가|는)?)\s*(?:(?:직접|알아서|나중에)\s*)*처리\s*(?:할게(?:요)?|하겠(?:습니다|다)?|할\s*예정(?:입니다|이다|이에요|임)|할\s*(?:거|꺼|것)\s*(?:야|예요|에요|입니다|이다))/i,
  // Korean first-person intent can omit the subject. Require a commitment or
  // causal ending, never the broad "올릴 예정" fragment used in feature prose.
  /(?:PR|풀\s*리퀘스트)\s*(?:(?:을|를|은|는)\s*)?[^\n]{0,16}(?:한\s*번에\s*)?올릴\s*(?:(?:거|꺼)\s*(?:니까|라서)|테니|게(?:요)?)(?=$|[\s,.;!?])/i,
];

/**
 * Detect an explicit, user-authored instruction that this run must not push or
 * create/update a pull request. Callers must pass the original task plus every
 * durable user follow-up stored in the run artifact, not a model summary.
 *
 * The matcher intentionally recognizes only direct imperatives or statements
 * that the user will perform shipping. Ambiguous discussion about Git/PRs does
 * not override the configured policy.
 *
 * @param {unknown} originalTask
 * @returns {boolean}
 */
export function taskExplicitlyForbidsShipping(originalTask) {
  try {
    const messages = Array.isArray(originalTask) ? originalTask : [originalTask];
    if (messages.length === 0
      || messages.some(message => typeof message !== 'string')) {
      return false;
    }
    return messages.some(message => {
      if (!message.trim()) return false;
      const actionableText = maskNoShipMetaExamples(message.normalize('NFKC'));
      return EXPLICIT_NO_SHIP_PATTERNS.some(pattern => pattern.test(actionableText));
    });
  } catch {
    return false;
  }
}

/**
 * Resolve the per-run ship policy from persisted config and the durable task
 * brief (original request plus follow-ups). A no-ship directive always wins
 * over legacy or explicit auto mode.
 *
 * @param {unknown} config
 * @param {unknown} originalTask
 * @returns {{ configuredMode: 'never'|'ask'|'auto', taskForbidsShipping: boolean, effectiveMode: 'never'|'ask'|'auto' }}
 */
export function resolveRunShipMode(config, originalTask) {
  const configuredMode = resolveShipMode(config);
  const taskForbidsShipping = taskExplicitlyForbidsShipping(originalTask);
  return {
    configuredMode,
    taskForbidsShipping,
    effectiveMode: taskForbidsShipping ? 'never' : configuredMode,
  };
}

/**
 * Deep-merge source object into target. Only plain objects are recursed into;
 * arrays and primitives from source overwrite those in target.
 *
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function deepMerge(target, source) {
  const result = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Promote a legacy layer's boolean ship.autoPush into ship.mode before the
 * layer is merged with defaults. Without this step, the default `mode: ask`
 * would mask a legacy `autoPush: true`. The input object is never mutated.
 *
 * @param {object} layer
 * @returns {object}
 */
function normalizeLegacyShipLayer(layer) {
  const ship = layer?.ship;
  if (!ship || typeof ship !== 'object' || Array.isArray(ship)) return layer;
  if (Object.prototype.hasOwnProperty.call(ship, 'mode')) return layer;
  if (!Object.prototype.hasOwnProperty.call(ship, 'autoPush')) return layer;
  if (typeof ship.autoPush !== 'boolean') return layer;

  return {
    ...layer,
    ship: {
      ...ship,
      mode: ship.autoPush ? 'auto' : 'ask',
    },
  };
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * CI provider markers. If ANY of these env vars is set to a truthy value, we
 * treat the environment as CI and skip the global autonomy config layer
 * (unless the user explicitly set `AO_AUTONOMY_CONFIG`).
 *
 * List spans the major CI providers. An attacker who can set env vars in a
 * legitimate CI runner already has bigger problems — this list is about
 * avoiding silent misconfiguration when a developer's dotfile-synced
 * `~/.config/agent-olympus/autonomy.json` would otherwise flip a shared
 * runner into `codex: full-auto`.
 */
const CI_ENV_MARKERS = [
  'CI',                      // GitHub Actions, GitLab, CircleCI, Travis, most generic
  'GITHUB_ACTIONS',          // GitHub Actions
  'GITLAB_CI',               // GitLab
  'CIRCLECI',                // CircleCI
  'TRAVIS',                  // Travis
  'JENKINS_URL',             // Jenkins
  'BUILDKITE',               // Buildkite
  'DRONE',                   // Drone
  'BITBUCKET_BUILD_NUMBER',  // Bitbucket Pipelines
  'TF_BUILD',                // Azure Pipelines
  'TEAMCITY_VERSION',        // TeamCity
  'APPVEYOR',                // AppVeyor
  'CODEBUILD_BUILD_ID',      // AWS CodeBuild
];

/**
 * Detect if the current process looks like a CI environment.
 *
 * Used as a "kill-switch" for global autonomy config — CI environments should
 * NOT pick up a developer's personal `~/.config/agent-olympus/autonomy.json`
 * (e.g. dotfile-synced `full-auto` could unexpectedly widen the codex sandbox
 * in a shared runner). Project-level `.ao/autonomy.json` still applies in CI
 * because it's checked into the repo and intentional.
 *
 * An explicit `AO_AUTONOMY_CONFIG` env override bypasses this kill-switch —
 * the user has stated an explicit intent.
 *
 * Checks the markers listed in `CI_ENV_MARKERS`. `CI=false` / `CI=0` are
 * treated as "not CI" (common in local dev when running CI-adjacent tools).
 *
 * @returns {boolean}
 */
export function isCIEnvironment() {
  for (const marker of CI_ENV_MARKERS) {
    const v = process.env[marker];
    if (!v) continue;
    // Explicit negatives
    if (v === 'false' || v === '0') continue;
    return true;
  }
  return false;
}

/**
 * Resolve the ordered list of autonomy.json paths to try.
 *
 * Order (highest precedence WINS during merge — later layers override earlier):
 *   1. Defaults (baked in; not a file)
 *   2. Global user-level config (SKIPPED in CI unless AO_AUTONOMY_CONFIG is set):
 *      - $XDG_CONFIG_HOME/agent-olympus/autonomy.json
 *      - ~/.config/agent-olympus/autonomy.json
 *      - ~/.ao/autonomy.json  (legacy, still honored)
 *      Only the FIRST existing global file is used (not merged across).
 *   3. Project-level config: <cwd>/.ao/autonomy.json
 *
 * Env override:
 *   AO_AUTONOMY_CONFIG=/path/to/file  — replaces the ENTIRE global chain
 *     with exactly this path. Project-level still applies on top.
 *     Bypasses CI kill-switch (explicit opt-in).
 *
 * @param {string} cwd - project root directory (absolute path)
 * @param {object} [opts]
 * @param {boolean} [opts.skipGlobal=false] - Force-skip env + all global layers
 *   (used by callers that want a pure project-only resolution, e.g. security
 *   audits or isolated test runs).
 * @param {boolean} [opts.skipEnv=false] - Force-skip the AO_AUTONOMY_CONFIG
 *   env override (global layer still resolved from home/XDG if not in CI).
 * @returns {{ global: string|null, project: string }}
 */
export function resolveAutonomyPaths(cwd, opts = {}) {
  const projectPath = path.join(cwd, '.ao', 'autonomy.json');
  const skipGlobal = opts && opts.skipGlobal === true;
  const skipEnv = opts && opts.skipEnv === true;

  if (skipGlobal) {
    return { global: null, project: projectPath };
  }

  const envOverride = process.env.AO_AUTONOMY_CONFIG;
  if (!skipEnv && envOverride && typeof envOverride === 'string' && envOverride.trim()) {
    // Explicit user intent — bypasses CI kill-switch.
    return { global: envOverride, project: projectPath };
  }

  // CI kill-switch: skip global fallbacks so developer dotfiles don't leak
  // full-auto into shared CI runners.
  if (isCIEnvironment()) {
    return { global: null, project: projectPath };
  }

  const home = os.homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim();
  const candidates = [
    xdgConfig ? path.join(xdgConfig, 'agent-olympus', 'autonomy.json') : null,
    path.join(home, '.config', 'agent-olympus', 'autonomy.json'),
    path.join(home, '.ao', 'autonomy.json'),
  ].filter(Boolean);

  // Only the first existing global file is used — no cross-merge between global
  // candidates. Keeps the mental model simple: "one global file, one project file".
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8'); // throws on missing
      return { global: candidate, project: projectPath };
    } catch { /* try next */ }
  }
  return { global: null, project: projectPath };
}

/**
 * Read + parse + validate a single autonomy config file. Returns the parsed
 * object (UNMERGED) on success, or null on any error (missing file, invalid
 * JSON, validation errors). Never throws.
 *
 * Validation is done against the parsed layer IN ISOLATION — Codex review
 * recommendation: "각 레이어를 개별 parse/validate 후 defaults <- global <-
 * project 순으로 합쳐야 한다". This catches layer-specific mistakes early
 * rather than muddling errors after merge.
 *
 * Symlink protection: when `opts.requireWithinRoots` is provided, the file's
 * realpath must be inside one of the allowed root directories. This defeats
 * a symlink redirecting the global config to an unexpected location
 * (e.g. a developer's stale ~/.ao pointing at a repo file that moved). The
 * project layer does NOT use this check — the project owner already controls
 * their own .ao/ directory.
 *
 * @param {string|null} filePath
 * @param {object} [opts]
 * @param {string[]} [opts.requireWithinRoots] - Allowed root directories. If
 *   the file's realpath escapes all of these, return null.
 * @returns {object|null}
 */
function _readLayer(filePath, opts = {}) {
  if (!filePath) return null;
  try {
    // Symlink protection: realpath must live inside an allowed root
    if (Array.isArray(opts.requireWithinRoots) && opts.requireWithinRoots.length) {
      let real;
      try { real = realpathSync(filePath); } catch { return null; }
      const okRoots = opts.requireWithinRoots
        .filter(Boolean)
        .map(r => {
          try { return realpathSync(r); } catch { return null; }
        })
        .filter(Boolean);
      const within = okRoots.some(root => {
        const withSep = root.endsWith(path.sep) ? root : root + path.sep;
        return real === root || real.startsWith(withSep);
      });
      if (!within) {
        // Symlink escaped — emit a one-line diagnostic but don't throw.
        try {
          process.stderr.write(JSON.stringify({
            event: 'autonomy_symlink_rejected',
            path: filePath,
            realpath: real,
          }) + '\n');
        } catch { /* never throw from logging */ }
        return null;
      }
    }
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const normalized = normalizeLegacyShipLayer(parsed);
    // Validate against DEFAULTS merge — only the layer's own fields count,
    // missing fields inherit defaults and pass validation trivially.
    const hypothetical = deepMerge(DEFAULT_AUTONOMY_CONFIG, normalized);
    const { valid } = validateAutonomyConfig(hypothetical);
    return valid ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Load and validate the autonomy config with layered resolution.
 *
 * Resolution order (later layers override earlier via deep merge; arrays are
 * REPLACED, not concatenated, consistent with existing deepMerge behavior):
 *
 *   defaults  ←  global (env override OR user-level)  ←  project
 *
 * On any error in any layer (missing file, parse error, validation failure),
 * that layer is silently skipped and the function continues. Result is always
 * a fully-hydrated, validated DEFAULT_AUTONOMY_CONFIG-shaped object.
 *
 * @param {string} cwd - project root directory (absolute path)
 * @param {object} [opts]
 * @param {boolean} [opts.skipGlobal=false] - Skip all global layers (env + home/XDG).
 *   Result is `defaults ← project-only`. Use for isolated/secure contexts.
 * @param {boolean} [opts.skipEnv=false] - Skip AO_AUTONOMY_CONFIG env override,
 *   but still consult home/XDG global layer (unless CI).
 * @returns {typeof DEFAULT_AUTONOMY_CONFIG}
 */
export function loadAutonomyConfig(cwd, opts = {}) {
  try {
    const { global, project } = resolveAutonomyPaths(cwd, opts);

    // Symlink allow-list for global. Honors skipEnv/skipGlobal so disabled
    // layers can't leak back in via a symlink pointing at the env override's
    // parent directory. Codex review: even when skipEnv:true drops the env
    // layer, if env parent stayed in the allow-list, a symlink inside XDG
    // could still redirect there, indirectly resurrecting the env path.
    const home = os.homedir();
    const xdgConfig = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim();
    const envOverride = process.env.AO_AUTONOMY_CONFIG;
    const envActive = !opts.skipGlobal
      && !opts.skipEnv
      && envOverride
      && typeof envOverride === 'string'
      && envOverride.trim();
    const allowedGlobalRoots = [
      xdgConfig ? path.join(xdgConfig, 'agent-olympus') : null,
      path.join(home, '.config', 'agent-olympus'),
      path.join(home, '.ao'),
      // Only whitelist env override's parent when the env override itself is
      // actually active — otherwise a dormant env var plus a symlink in XDG
      // would silently resurrect the env path.
      envActive ? path.dirname(envOverride) : null,
    ].filter(Boolean);

    const globalLayer = _readLayer(global, { requireWithinRoots: allowedGlobalRoots });
    // Project layer: no symlink guard — the project owner controls .ao/.
    const projectLayer = _readLayer(project);

    // Merge: defaults ← global ← project
    let merged = DEFAULT_AUTONOMY_CONFIG;
    if (globalLayer) merged = deepMerge(merged, globalLayer);
    if (projectLayer) merged = deepMerge(merged, projectLayer);

    // Final validation on the merged result — defensive; individual layers
    // were already validated, but validation is cheap and surfaces any bug
    // in the merge itself.
    const { config } = validateAutonomyConfig(merged);
    return config;
  } catch {
    // Never throw — return safe defaults on any unexpected error
    return DEFAULT_AUTONOMY_CONFIG;
  }
}

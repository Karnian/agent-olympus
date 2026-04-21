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
 *   ship: { autoPush: boolean, draftPR: boolean, autoLink: boolean, labels: string[], issuePattern: string },
 *   ci: { watchEnabled: boolean, maxCycles: number, pollIntervalMs: number, timeoutMs: number },
 *   notify: { onComplete: boolean, onBlocked: boolean, onCIFail: boolean, sound: boolean },
 *   budget: { warnThresholdUsd: number | null }
 * }}
 */
export const DEFAULT_AUTONOMY_CONFIG = {
  version: '1',
  ship: {
    autoPush: false,
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
 *   - ship must be an object with boolean autoPush, draftPR, autoLink; labels array; issuePattern string
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
      for (const boolField of ['autoPush', 'draftPR', 'autoLink']) {
        const val = config.ship[boolField];
        if (val !== undefined && typeof val !== 'boolean') {
          errors.push(
            `config.ship.${boolField} must be a boolean; received: ${JSON.stringify(val)}`
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
    // Validate against DEFAULTS merge — only the layer's own fields count,
    // missing fields inherit defaults and pass validation trivially.
    const hypothetical = deepMerge(DEFAULT_AUTONOMY_CONFIG, parsed);
    const { valid } = validateAutonomyConfig(hypothetical);
    return valid ? parsed : null;
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

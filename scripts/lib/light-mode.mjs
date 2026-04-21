/**
 * Light Mode — opt-in skipping of heavy critic stages for confirmed-simple tasks.
 *
 * Design principles (distilled from the Phase 0-3 cross-reviews):
 *   - Explicit user choice, NOT regex auto-detection (Codex Phase 2 review:
 *     "simple/quick" keywords are user preference, not difficulty signals)
 *   - Auto-escalate to full mode on any review reject (safety net)
 *   - Keyword detection is advisory only — shows a warning in the confirm
 *     prompt, never flips the decision silently
 *   - wisdom.jsonl record of every light-mode entry/exit for observability
 *
 * Stages skipped in light mode:
 *   - momus (plan validation)
 *   - architect (architecture review)
 *
 * Stages always kept:
 *   - metis (analysis — already single-call after Phase 1)
 *   - prometheus (planning — core output)
 *   - code-reviewer (runtime quality gate)
 *   - themis (tests/lint gate)
 *
 * Opt-in via `.ao/autonomy.json` → `{ "mode": "light" }` or CLI flag
 * `/atlas --light` / `/athena --light`. Default: "full" (no change).
 *
 * Fail-safe — every export catches and returns a sensible default.
 */

/**
 * Keywords that signal "probably risky for light mode". Detection is
 * advisory: the confirm prompt surfaces them as warnings so the user can
 * reconsider, but does not force-disable light mode (Codex Phase 2 #3
 * tightened in final plan — user choice remains sovereign).
 */
export const RISKY_KEYWORDS = [
  // Original 16 (Phase 4 v1)
  'complex', 'auth', 'security', 'infra', 'migration',
  'billing', 'role', 'crypto', 'schema', 'queue', 'concurrency',
  'payments', 'pii', 'tenant', 'transaction', 'distributed',
  // Phase 4 review expansion (Codex #4 + Gemini #3 + review consensus):
  'encryption', 'decryption', 'deadlock', 'race', 'permission',
  'authentication', 'authorization', 'session', 'csrf', 'xss',
  'sql-injection', 'ratelimit', 'rollback', 'idempotent', 'consensus',
];

const RISKY_KEYWORD_ALIASES = {
  // Approximate plural/derivative handling without overreaching.
  // Key = base RISKY keyword, value = extra variants to also match.
  schema: ['schemas', 'schematic-change'],
  migration: ['migrations'],
  role: ['roles', 'rbac'],
  permission: ['permissions'],
  transaction: ['transactions', 'transactional'],
  payment: ['payments'],
  queue: ['queues', 'queued'],
  session: ['sessions'],
  rollback: ['rollbacks', 'rolling-back'],
};

const VALID_MODES = new Set(['full', 'light']);

/**
 * Detect whether stdin is interactive. Used by callers to decide whether
 * a confirm prompt is safe to render. Non-interactive contexts (CI, pipes,
 * detached runs) should NEVER auto-accept light mode — they must either
 * require an explicit `autonomy.mode=light` in config (an opt-in that
 * already happened at config-write time) or fall back to full mode.
 *
 * @returns {boolean}
 */
export function isInteractiveStdin() {
  try {
    return Boolean(process.stdin && process.stdin.isTTY);
  } catch {
    return false;
  }
}

/**
 * Detect common CI environment markers. When true, callers should NEVER
 * auto-confirm light mode — CI runs must rely on explicit autonomy config.
 *
 * @returns {boolean}
 */
export function isCIEnvironment() {
  try {
    const env = process.env || {};
    const markers = [
      'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'TRAVIS',
      'JENKINS_URL', 'BUILDKITE', 'DRONE', 'BITBUCKET_BUILD_NUMBER',
      'TF_BUILD', 'TEAMCITY_VERSION', 'APPVEYOR', 'CODEBUILD_BUILD_ID',
    ];
    for (const m of markers) {
      const v = env[m];
      if (!v) continue;
      // Treat explicit "false"/"0" as "not CI".
      if (v === 'false' || v === '0' || v === 'False' || v === 'FALSE') continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve the requested mode from autonomy config + CLI args.
 * Precedence (highest first): CLI `--light` flag > autonomy.json `mode` > default 'full'.
 *
 * `requiresConfirm` is set to true when the source is 'cli' — interactive
 * confirm is mandatory. When the source is 'autonomy', the user already
 * opted in at config-write time, so `requiresConfirm=false` (but callers
 * should still emit an observability log).
 *
 * `safeToAutoAccept` is a runtime signal: when `requiresConfirm=true` but
 * the environment is non-interactive (no TTY or CI markers present), the
 * caller MUST NOT auto-accept — it should fall back to full mode with a
 * clear log message. Interactive environments may present AskUserQuestion.
 *
 * @param {object|null} autonomyConfig
 * @param {string[]}    cliArgs - typically process.argv.slice(2) from the caller
 * @returns {{
 *   mode: 'full'|'light',
 *   source: 'cli'|'autonomy'|'default',
 *   requiresConfirm: boolean,
 *   safeToAutoAccept: boolean,
 * }}
 */
export function resolveMode(autonomyConfig, cliArgs = []) {
  try {
    if (Array.isArray(cliArgs) && cliArgs.includes('--light')) {
      const interactive = isInteractiveStdin() && !isCIEnvironment();
      return {
        mode: 'light',
        source: 'cli',
        requiresConfirm: true,
        safeToAutoAccept: interactive,
      };
    }
    const cfg = autonomyConfig?.mode;
    if (typeof cfg === 'string' && VALID_MODES.has(cfg)) {
      return {
        mode: cfg,
        source: 'autonomy',
        requiresConfirm: false,  // user already opted in at config time
        safeToAutoAccept: true,   // config-based entry is non-interactive-safe
      };
    }
    return {
      mode: 'full',
      source: 'default',
      requiresConfirm: false,
      safeToAutoAccept: true,
    };
  } catch {
    return { mode: 'full', source: 'default', requiresConfirm: false, safeToAutoAccept: true };
  }
}

/**
 * Scan a free-text task description for risky keyword matches. Case-insensitive,
 * whole-word (via \b). Returns the ordered unique matches.
 *
 * @param {string} text - typically the user_request
 * @returns {string[]} matched keywords (may be empty)
 */
export function detectRiskyKeywords(text) {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set();
  const hits = [];
  const addIfMatch = (canonicalKw, pattern) => {
    if (seen.has(canonicalKw)) return;
    if (pattern.test(text)) { seen.add(canonicalKw); hits.push(canonicalKw); }
  };
  for (const kw of RISKY_KEYWORDS) {
    // Escape regex metachars in the keyword (e.g. "sql-injection" has a hyphen).
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Case-insensitive, word-boundary anchored on both sides.
    addIfMatch(kw, new RegExp(`\\b${esc}\\b`, 'i'));
    // Gemini Phase 4 #3 — alias expansion for common plural/variant forms.
    const aliases = RISKY_KEYWORD_ALIASES[kw];
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        const aliasEsc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        addIfMatch(kw, new RegExp(`\\b${aliasEsc}\\b`, 'i'));
      }
    }
  }
  return hits;
}

/**
 * Build a user-facing confirm message for entering light mode.
 *
 * The message lists which stages will be skipped and, when risky keywords
 * are present, appends a warning block. Callers render this through
 * `AskUserQuestion` when available, or print to stdout as a text fallback.
 *
 * @param {object} params
 * @param {string}   params.taskDescription
 * @param {string[]} params.stagesSkipped - e.g. ['momus', 'architect']
 * @returns {{ title: string, body: string, options: string[], riskyMatches: string[] }}
 */
export function buildConfirmMessage({ taskDescription, stagesSkipped }) {
  const stages = Array.isArray(stagesSkipped) && stagesSkipped.length > 0
    ? stagesSkipped : ['momus', 'architect'];
  const matches = detectRiskyKeywords(taskDescription || '');
  const lines = [];
  lines.push(`Light mode will SKIP the following review stages for this task:`);
  for (const s of stages) lines.push(`  - ${s}`);
  lines.push('');
  lines.push(`Kept: metis (analysis), prometheus (planning), code-reviewer, themis.`);
  lines.push(`Auto-escalation: any review reject will flip back to full mode.`);
  if (matches.length > 0) {
    lines.push('');
    lines.push(`⚠ Risk keywords detected in task: ${matches.join(', ')}`);
    lines.push(`   These domains typically benefit from full architectural review.`);
    lines.push(`   Consider keeping full mode unless you're certain the scope is limited.`);
  }
  return {
    title: 'Enter light mode?',
    body: lines.join('\n'),
    options: ['Yes, use light mode', 'No, use full mode'],
    riskyMatches: matches,
  };
}

/**
 * Decide which stages to run for the current mode.
 *
 * @param {'full'|'light'} mode
 * @returns {{ skipMomus: boolean, skipArchitect: boolean, keptStages: string[] }}
 */
export function stageFilter(mode) {
  if (mode === 'light') {
    return {
      skipMomus: true,
      skipArchitect: true,
      keptStages: ['metis', 'prometheus', 'executor', 'code-reviewer', 'themis'],
    };
  }
  return {
    skipMomus: false,
    skipArchitect: false,
    keptStages: ['metis', 'prometheus', 'momus', 'architect', 'executor', 'code-reviewer', 'themis'],
  };
}

/**
 * Caller contract for the auto-escalation trigger. Returns the new mode
 * ('full') and a human-readable reason when any review reject is observed
 * while in light mode. The caller should flip its internal `mode` variable
 * AND record the event via `logLightModeEvent`.
 *
 * @param {object} params
 * @param {'full'|'light'} params.currentMode
 * @param {string}         params.rejectingStage - e.g. 'code-reviewer'
 * @param {string}         [params.rejectReason]
 * @returns {{ newMode: 'full'|'light', escalated: boolean, reason: string }}
 */
export function autoEscalateOnReject(params = {}) {
  try {
    if (params.currentMode !== 'light') {
      return { newMode: params.currentMode || 'full', escalated: false, reason: 'not in light mode' };
    }
    const stage = params.rejectingStage || 'unknown-stage';
    const why = params.rejectReason ? `: ${params.rejectReason}` : '';
    return {
      newMode: 'full',
      escalated: true,
      reason: `${stage} rejected while in light mode${why} — auto-escalated to full`,
    };
  } catch {
    return { newMode: 'full', escalated: true, reason: 'escalation handler error — defaulting to full' };
  }
}

/**
 * Append a wisdom record for a light-mode event (entry/exit/escalation).
 * Fails silently on any error — wisdom logging must never block orchestration.
 *
 * @param {object} params
 * @param {'entered'|'exited'|'escalated'} params.event
 * @param {string}   params.reason
 * @param {string[]} [params.stagesSkipped]
 * @param {string[]} [params.riskyMatches]
 * @param {function} [params.addWisdomFn] - dependency injection for tests
 */
export async function logLightModeEvent(params = {}) {
  const lessonParts = [`light-mode:${params.event || 'unknown'}`];
  if (params.reason) lessonParts.push(params.reason);
  if (Array.isArray(params.stagesSkipped) && params.stagesSkipped.length > 0) {
    lessonParts.push(`skipped: ${params.stagesSkipped.join(', ')}`);
  }
  if (Array.isArray(params.riskyMatches) && params.riskyMatches.length > 0) {
    lessonParts.push(`risky keywords: ${params.riskyMatches.join(', ')}`);
  }
  const lesson = lessonParts.join(' — ');

  // Primary channel — wisdom.jsonl (structured observability).
  let primaryFailed = false;
  try {
    const addWisdom = typeof params.addWisdomFn === 'function'
      ? params.addWisdomFn
      : (await import('./wisdom.mjs')).addWisdom;
    await addWisdom({
      category: 'pattern',
      lesson,
      confidence: 'medium',
    });
  } catch {
    primaryFailed = true;
  }

  // Fallback channel — single-line JSON on stderr (Gemini Phase 4 #4).
  // Always emit, regardless of whether wisdom succeeded, so operators
  // running `claude 2>light-mode.log` can still reconstruct history when
  // wisdom.jsonl is locked/disabled/corrupted.
  try {
    const ev = {
      event: 'light_mode',
      type: params.event || 'unknown',
      lesson,
      wisdomOk: !primaryFailed,
      ts: new Date().toISOString(),
    };
    // suppressOutput-style: write to stderr but never block or throw.
    if (typeof process !== 'undefined' && process.stderr && typeof process.stderr.write === 'function') {
      process.stderr.write(JSON.stringify(ev) + '\n');
    }
  } catch {
    /* truly nothing we can do */
  }
}

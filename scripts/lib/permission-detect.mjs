/**
 * Unified Claude Code permission detection — shared by codex-approval.mjs and gemini-approval.mjs.
 *
 * Reads Claude Code's permission configuration from settings files across all
 * documented scopes (managed → project-local → project → user-local → user),
 * MERGES allow/deny/ask lists across scopes (not first-wins), and returns
 * both BROAD-literal (`Bash`, `Bash(*)`) and SCOPED (`Bash(git:*)`) grant flags
 * so callers can distinguish "host trusts codex with full shell" from
 * "host only trusts codex with file edits".
 *
 * Security-first design (Plan A, consulted with Codex 2026-04-14):
 *   - Only LITERAL `Bash` / `Bash(*)` in allow counts as a "broad" grant.
 *     Wildcard variants (`Bash(*:*)`, `Bash(**)`, `Bash(*,*)`) are SCOPED —
 *     Claude's matcher treats `:*` as a trailing-wildcard suffix, so these
 *     patterns are NOT semantically "match everything".
 *   - Any `Bash`/`Bash(...)` entry in `permissions.ask` (literal OR scoped)
 *     invalidates the broad Bash grant — codex runs non-interactively and
 *     cannot honor "please confirm". Fail-closed per Claude docs
 *     (deny → ask → allow evaluation order).
 *   - Scoped deny (`Bash(curl:*)`) also invalidates broad grants: codex's
 *     `danger-full-access` sandbox cannot respect the scoped restriction.
 *   - Precedence order: managed > project-local > project > user-local > user.
 *     Allow/deny/ask lists MERGE across scopes; defaultMode is taken from
 *     the HIGHEST precedence scope that sets it.
 *   - `permissions.disableBypassPermissionsMode: true` (any scope) disables
 *     `bypassPermissions` defaultMode, demoting it to `acceptEdits`.
 *
 * Zero npm dependencies — uses Node.js built-ins only.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { platform as osPlatform } from 'node:os';
import { loadRuntimePermissions, permissionModeToLevel } from './runtime-permissions.mjs';

/**
 * Read and parse a JSON file, returning null on any error.
 */
function readJson(filePath, fsImpl = { readFileSync }) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Safely coerce a `permissions.<listName>` field to an array of strings.
 */
function getList(data, listName) {
  const val = data?.permissions?.[listName];
  if (!Array.isArray(val)) return [];
  return val.filter(x => typeof x === 'string');
}

/**
 * Extract `permissions.defaultMode` if it's a non-empty string.
 */
function getDefaultMode(data) {
  const mode = data?.permissions?.defaultMode;
  return typeof mode === 'string' && mode.length > 0 ? mode : null;
}

/**
 * Extract `permissions.disableBypassPermissionsMode`.
 *
 * Claude docs historically accepted two schemas for this field:
 *   - legacy boolean `true`
 *   - current string `"disable"`
 * Both forms are treated as "disabled" for forward/backward compatibility.
 */
function getDisableBypass(data) {
  const v = data?.permissions?.disableBypassPermissionsMode;
  return v === true || v === 'disable';
}

/**
 * Extract `permissions.allowManagedPermissionRulesOnly` (boolean).
 * When set by a managed scope, non-managed allow lists are suppressed
 * (deny/ask still apply from all scopes for defense-in-depth).
 */
function getAllowManagedOnly(data) {
  return data?.permissions?.allowManagedPermissionRulesOnly === true;
}

/**
 * Resolve the platform-specific managed settings roots + fragment directories.
 * Returns an array of `{ file, dir }` entries (not guaranteed to exist),
 * highest precedence first.
 *
 * Paths per Claude Code docs (2026 current, with legacy fallbacks for older
 * installs):
 *   darwin:  /Library/Application Support/ClaudeCode/
 *   linux:   /etc/claude-code/
 *   win32:   C:\Program Files\ClaudeCode\  (current)
 *            %PROGRAMDATA%\ClaudeCode\      (legacy fallback)
 */
function resolveManagedPaths(opts = {}) {
  const plat = opts.platformOverride || osPlatform();
  if (opts.managedRootOverride) {
    return [{
      file: join(opts.managedRootOverride, 'managed-settings.json'),
      dir: join(opts.managedRootOverride, 'managed-settings.d'),
    }];
  }
  if (plat === 'darwin') {
    const root = '/Library/Application Support/ClaudeCode';
    return [{ file: join(root, 'managed-settings.json'), dir: join(root, 'managed-settings.d') }];
  }
  if (plat === 'win32') {
    const env = opts.env || process.env;
    const programFiles = (env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files') + '\\ClaudeCode';
    const programData  = (env.PROGRAMDATA || 'C:\\ProgramData') + '\\ClaudeCode';
    // Primary (docs-current) first, legacy second. Both merged if present.
    return [
      { file: join(programFiles, 'managed-settings.json'), dir: join(programFiles, 'managed-settings.d') },
      { file: join(programData,  'managed-settings.json'), dir: join(programData,  'managed-settings.d') },
    ];
  }
  // linux + everything else
  const root = '/etc/claude-code';
  return [{ file: join(root, 'managed-settings.json'), dir: join(root, 'managed-settings.d') }];
}

/**
 * Read all JSON fragments in a `managed-settings.d/` directory in lexical order.
 * Returns an array of parsed data objects (nulls filtered).
 */
function readManagedFragments(dir, fsImpl = { readdirSync, statSync, readFileSync }) {
  try {
    const entries = fsImpl.readdirSync(dir).sort();
    const out = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = join(dir, name);
      try {
        if (!fsImpl.statSync(full).isFile()) continue;
      } catch { continue; }
      const parsed = readJson(full, fsImpl);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Load all permission sources in precedence order (highest first).
 * Returns array of `{ scope, data }` entries; missing files are silently skipped.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string} [opts.home]
 * @param {string} [opts.managedRootOverride]  Override managed root dir (for testing)
 * @param {string} [opts.platformOverride]     Override os.platform() (for testing)
 * @param {object} [opts.env]                  Override env (for testing)
 * @param {object} [opts.fs]                   Override fs impl (for testing)
 * @returns {Array<{scope: string, data: object}>}
 */
export function loadPermissionSources(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const home = opts.home || process.env.HOME || process.env.USERPROFILE || '';
  const fs = opts.fs || { readFileSync, readdirSync, statSync };

  const managedRoots = resolveManagedPaths(opts);
  const out = [];

  // 1. Managed roots (highest precedence first — e.g. Program Files before ProgramData on Win).
  //    Within a single managed root: the root file first, then fragments in
  //    lexical order. Scalar "last-wins" merge within managed is handled in
  //    detectClaudePermissions (fragments later in the iteration override
  //    earlier values for scalar fields like defaultMode).
  for (const managed of managedRoots) {
    const managedData = readJson(managed.file, fs);
    if (managedData) out.push({ scope: 'managed', data: managedData });

    const fragments = readManagedFragments(managed.dir, fs);
    for (const data of fragments) {
      out.push({ scope: 'managed', data });
    }
  }

  // 2. Project-local, project, user-local, user.
  //
  //    `userLocal` (~/.claude/settings.local.json) is a compatibility scope:
  //    Claude's current permissions-docs explicitly document only four scopes
  //    (managed, project-local, project, user), but ~/.claude/settings.local.json
  //    is widely seen in practice (many users keep a local override alongside
  //    their committed ~/.claude/settings.json). We read it at a precedence
  //    tier between project and user for a faithful mirror of what the host
  //    Claude session actually sees on disk.
  const scoped = [
    ['projectLocal', join(cwd, '.claude', 'settings.local.json')],
    ['project',      join(cwd, '.claude', 'settings.json')],
    ['userLocal',    join(home, '.claude', 'settings.local.json')],
    ['user',         join(home, '.claude', 'settings.json')],
  ];
  for (const [scope, path] of scoped) {
    const data = readJson(path, fs);
    if (data) out.push({ scope, data });
  }

  return out;
}

/**
 * Anchored tool-name matcher.
 *
 * Returns `'broad'` for literal `Tool` or `Tool(*)`, `'scoped'` for any
 * other `Tool(...)` pattern, and `null` for non-matches.
 *
 * NOTE: `Bash(*:*)`, `Bash(**)`, `Bash(*,*)` are treated as SCOPED per
 * Claude's matcher docs (`:*` is a trailing-wildcard suffix, not a universal
 * wildcard). Only the bare tool or `Tool(*)` count as broad.
 */
export function classifyToolPattern(entry, tool) {
  if (typeof entry !== 'string') return null;
  if (entry === tool) return 'broad';
  if (entry === `${tool}(*)`) return 'broad';
  if (entry.startsWith(`${tool}(`)) return 'scoped';
  return null;
}

/**
 * Any reference to `tool` in the list (broad or scoped).
 */
function listMentionsTool(list, tool) {
  return list.some(e => classifyToolPattern(e, tool) !== null);
}

/**
 * A LITERAL broad reference to `tool` in the list.
 */
function listHasBroad(list, tool) {
  return list.some(e => classifyToolPattern(e, tool) === 'broad');
}

/**
 * A SCOPED (non-broad) reference to `tool` in the list.
 */
function listHasScoped(list, tool) {
  return list.some(e => classifyToolPattern(e, tool) === 'scoped');
}

/**
 * Detect Claude Code's permission flags from settings files.
 *
 * Returns BOTH broad-literal and scoped flags per tool so downstream
 * mapping can distinguish "unrestricted shell trust" from "trust to edit
 * files in cwd".
 *
 * `opts.effectiveDefaultMode` (added for issue #69 runtime override —
 * codex review 2026-05-08 flagged the original implementation for missing
 * managed deny / `disableBypassPermissionsMode` enforcement):
 *
 *   When a caller has captured a runtime `permission_mode` (via the
 *   SessionStart / UserPromptSubmit hook) and wants to know "what tier
 *   would the host be at if this mode were the active defaultMode?", they
 *   pass it here. The override REPLACES the settings-derived `defaultMode`
 *   ONLY for the implicit-broad computation; everything else flows through
 *   the same deny/ask/disableBypassPermissionsMode pipeline. That means:
 *     - `disableBypassPermissionsMode: true` (any scope) DROPS the implicit
 *       broad grant from `bypassPermissions` entirely. The runtime tier
 *       collapses to `suggest` unless an explicit allow list compensates —
 *       it does NOT silently fall through to `acceptEdits`.
 *     - any `Bash` deny in any scope still invalidates the runtime broad
 *       Bash grant
 *     - `acceptEdits` runtime grants Write+Edit only (not Bash)
 *     - `allowManagedPermissionRulesOnly: true` (managed scope) suppresses
 *       runtime implicit grants because the runtime override is by
 *       definition non-managed.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string} [opts.home]
 * @param {string} [opts.managedRootOverride]
 * @param {string} [opts.platformOverride]
 * @param {object} [opts.env]
 * @param {object} [opts.fs]
 * @param {string} [opts.effectiveDefaultMode] - Override settings defaultMode for implicit-broad computation
 * @returns {{
 *   hasBashStar: boolean,   hasBashScoped: boolean,
 *   hasWriteStar: boolean,  hasWriteScoped: boolean,
 *   hasEditStar: boolean,   hasEditScoped: boolean,
 *   defaultMode: string|null,
 *   bypassDisabled: boolean,
 *   managedDetected: boolean,
 * }}
 */
export function detectClaudePermissions(opts = {}) {
  try {
    const sources = loadPermissionSources(opts);

    // Managed allow/deny/ask are collected separately so we can honor
    // `allowManagedPermissionRulesOnly` (managed scope can suppress user/project
    // allow rules while keeping deny/ask defense-in-depth).
    const managedAllow = [];
    const managedDeny = [];
    const managedAsk = [];
    const otherAllow = [];
    const otherDeny = [];
    const otherAsk = [];

    // defaultMode is scope-scoped: the highest-precedence scope that sets a
    // non-null value wins. Within a single scope (notably 'managed' with
    // fragments), later entries override earlier ones for scalar fields
    // (last-wins within-scope).
    let defaultMode = null;
    let defaultModeScope = null;
    let bypassDisabled = false;
    let allowManagedOnly = false;
    let managedDetected = false;

    // Precedence rank (lower = higher precedence). Mirrors the order returned
    // by loadPermissionSources. Used to break "first-wins across scopes,
    // last-wins within scope" ties for defaultMode.
    const scopeRank = (scope) => ({
      managed: 0, projectLocal: 1, project: 2, userLocal: 3, user: 4,
    }[scope] ?? 99);

    for (const { scope, data } of sources) {
      if (scope === 'managed') {
        managedDetected = true;
        managedAllow.push(...getList(data, 'allow'));
        managedDeny.push(...getList(data, 'deny'));
        managedAsk.push(...getList(data, 'ask'));
        if (getAllowManagedOnly(data)) allowManagedOnly = true;
      } else {
        otherAllow.push(...getList(data, 'allow'));
        otherDeny.push(...getList(data, 'deny'));
        otherAsk.push(...getList(data, 'ask'));
      }

      // defaultMode precedence: higher-precedence scope wins; within the SAME
      // scope, later entries (e.g. managed fragments appearing after the root
      // managed-settings.json) override earlier values.
      const m = getDefaultMode(data);
      if (m) {
        const r = scopeRank(scope);
        if (defaultModeScope === null || r < defaultModeScope) {
          defaultMode = m;
          defaultModeScope = r;
        } else if (r === defaultModeScope) {
          // Same scope, later-wins for scalar override (e.g. fragments).
          defaultMode = m;
        }
      }

      // disableBypassPermissionsMode: OR across all scopes (any disables).
      if (getDisableBypass(data)) bypassDisabled = true;
    }

    // Assemble final lists honoring allowManagedPermissionRulesOnly:
    //   - allow: only managed if suppression is active; otherwise union.
    //   - deny/ask: ALWAYS union (defense-in-depth — a narrower restriction
    //     in any scope still applies even when managed suppresses user allows).
    const allow = allowManagedOnly ? managedAllow : [...managedAllow, ...otherAllow];
    const deny  = [...managedDeny,  ...otherDeny];
    const ask   = [...managedAsk,   ...otherAsk];

    // Per-tool broad/scoped detection with fail-closed ask/deny.
    const result = {
      hasBashStar: false,  hasBashScoped: false,
      hasWriteStar: false, hasWriteScoped: false,
      hasEditStar: false,  hasEditScoped: false,
      defaultMode,
      bypassDisabled,
      managedDetected,
      allowManagedOnly,
    };

    // defaultMode translates to an IMPLICIT allow grant per tool, then
    // flows through the same fail-closed pipeline as the explicit allow list:
    //   - `bypassPermissions` (unless disabled) → implicit broad for ALL tools
    //   - `acceptEdits`                         → implicit broad for Write + Edit only
    // Interaction with deny/ask: `bypassPermissions` + `deny: Bash(*)` gets
    // bash demoted while write/edit stay broad. Interaction with bypassDisabled:
    // when `disableBypassPermissionsMode: true` is set in any scope,
    // `bypassActive` becomes false (NOT downgraded to `acceptActive`) — the
    // implicit grant is dropped entirely, mirroring how the resolved tier
    // collapses to `suggest` unless an explicit allow list compensates.
    //
    // `opts.effectiveDefaultMode` (issue #69) lets callers override the
    // settings defaultMode for this computation only — used by the runtime
    // permission_mode merge in detectClaudePermissionLevel so deny/ask/
    // bypassDisabled all apply to the runtime tier the same way they apply
    // to the settings layer. Everything else (managedDetected, allowManagedOnly,
    // the returned `defaultMode` field) reflects the on-disk settings.
    //
    // `allowManagedPermissionRulesOnly` interaction (codex review 2026-05-08
    // residual WARN): when managed scope sets this flag, non-managed allow
    // lists are suppressed via the `allow` assembly above. The same intent
    // must apply to non-managed implicit grants — a runtime
    // `permission_mode = bypassPermissions` (always non-managed) or a
    // non-managed-scope settings defaultMode shouldn't be allowed to bypass
    // the managed-only ceiling. We track whether the implicit grant comes
    // from managed scope (the runtime override is never managed).
    const effectiveDefaultMode =
      typeof opts.effectiveDefaultMode === 'string' && opts.effectiveDefaultMode.length > 0
        ? opts.effectiveDefaultMode
        : defaultMode;
    const implicitGrantIsNonManaged = !!opts.effectiveDefaultMode || (defaultModeScope !== 0);
    const implicitSuppressedByManagedOnly = allowManagedOnly && implicitGrantIsNonManaged;
    const bypassActive =
      effectiveDefaultMode === 'bypassPermissions' &&
      !bypassDisabled &&
      !implicitSuppressedByManagedOnly;
    const acceptActive =
      effectiveDefaultMode === 'acceptEdits' &&
      !implicitSuppressedByManagedOnly;
    const implicitBroad = {
      Bash:  bypassActive,
      Write: bypassActive || acceptActive,
      Edit:  bypassActive || acceptActive,
    };

    for (const tool of ['Bash', 'Write', 'Edit']) {
      const broadAllow  = listHasBroad(allow, tool) || implicitBroad[tool];
      const scopedAllow = listHasScoped(allow, tool);

      // Any mention (broad or scoped) in ask → fail-closed for broad grant.
      // Codex is non-interactive and cannot honor "please confirm".
      const askMentions = listMentionsTool(ask, tool);

      // Literal broad deny (`Bash(*)` / `Bash`) → invalidates all grants.
      const literalDeny = listHasBroad(deny, tool);
      // Any mention in deny → invalidates broad grant (scoped deny means
      // host has restrictions codex cannot honor under danger-full-access).
      const denyMentions = literalDeny || listHasScoped(deny, tool);

      // broad flag: broad allow (literal OR implicit via defaultMode),
      // AND no ask/deny mention on this tool.
      const broadFlag = broadAllow && !askMentions && !denyMentions;

      // scoped flag: any allow (broad OR scoped), AND no literal broad deny.
      //   - broad allow survives scoped deny at scoped level (codex runs
      //     workspace-write, which cannot honor scoped deny either but at
      //     least cannot run arbitrary shell). Literal deny = full block.
      const scopedFlag = (broadAllow || scopedAllow) && !literalDeny;

      if (tool === 'Bash')  { result.hasBashStar  = broadFlag; result.hasBashScoped  = scopedFlag; }
      if (tool === 'Write') { result.hasWriteStar = broadFlag; result.hasWriteScoped = scopedFlag; }
      if (tool === 'Edit')  { result.hasEditStar  = broadFlag; result.hasEditScoped  = scopedFlag; }
    }

    return result;
  } catch {
    return {
      hasBashStar: false,  hasBashScoped: false,
      hasWriteStar: false, hasWriteScoped: false,
      hasEditStar: false,  hasEditScoped: false,
      defaultMode: null,
      bypassDisabled: false,
      managedDetected: false,
      allowManagedOnly: false,
    };
  }
}

/**
 * Numeric tier helper for runtime-vs-settings ceiling-merge logic. Higher =
 * more permissive. Mirrors the table used in codex-approval.PERM_TIER (kept
 * private here to avoid a circular import).
 */
const _LEVEL_RANK = { 'full-auto': 3, 'auto-edit': 2, 'suggest': 1 };

/**
 * Map the broad/scoped flags from `detectClaudePermissions` to a tier level
 * WITHOUT consulting the runtime override. Internal helper — exported so
 * tests and `--explain-permissions` can show the settings-only baseline
 * separately from the final level.
 *
 * @param {object} [opts] - Same as detectClaudePermissions
 * @returns {'full-auto' | 'auto-edit' | 'suggest'}
 */
export function detectClaudePermissionLevelFromSettings(opts = {}) {
  const p = detectClaudePermissions(opts);
  if (p.hasBashStar && p.hasWriteStar) return 'full-auto';
  if (p.hasWriteStar || p.hasEditStar) return 'auto-edit';
  return 'suggest';
}

/**
 * Map detected Claude permissions to a Codex-style approval level string.
 *
 * **Two-layer resolution (issue #67/#68/#69)** — settings ⇧ runtime:
 *   1. **Settings layer** (existing): merge allow/deny/ask across all scopes,
 *      derive broad/scoped flags, map to a tier.
 *   2. **Runtime layer** (NEW): read
 *      `.ao/state/ao-runtime-permissions.json`, captured by the
 *      `runtime-permissions-capture.mjs` hook from Claude Code's session
 *      `permission_mode`. UPGRADE-ONLY — the runtime tier can promote the
 *      settings tier, but never demote it.
 *
 * Why upgrade-only:
 *   - Promotion is safe: a runtime `bypassPermissions` (from
 *     `--dangerously-skip-permissions`) means the host actually accepts
 *     arbitrary tool use, so honoring it removes an over-conservative
 *     demotion of `/ask codex` and friends.
 *   - Demotion would be unsafe: a user with `Bash(*)` literal in
 *     `permissions.allow` and runtime `default` mode is still trusting tools
 *     via the explicit allow list. Mid-session Shift+Tab into "default" is
 *     usually a UI glance, not an instruction to revoke prior trust.
 *
 * Only BROAD grants promote a tier — scoped grants cannot promote because
 * codex's coarse sandbox tiers (read-only | workspace-write | danger-full-access)
 * cannot honor the user's scoped restriction. Examples:
 *   - `Write(src/**)` alone → `suggest` (workspace-write would let codex
 *     write to `docs/**`, expanding beyond the granted scope).
 *   - `Bash(git:*)` alone → `suggest` (workspace-write still lets codex run
 *     arbitrary shell within cwd — `rm`, `curl`, etc. — not just git).
 *
 * Settings mapping (highest tier first):
 *   1. Broad Bash AND broad Write              → full-auto
 *   2. Broad Write OR broad Edit               → auto-edit
 *   3. Otherwise                               → suggest
 *
 * Runtime mapping (via permissionModeToLevel):
 *   bypassPermissions → full-auto
 *   acceptEdits       → auto-edit
 *   default           → suggest
 *   plan              → suggest
 *
 * `defaultMode` (from settings) is already baked into the broad flags by
 * detectClaudePermissions, with deny/ask fail-closed applied uniformly.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.skipRuntime] - Skip runtime override (testing/diagnostic)
 * @returns {'full-auto' | 'auto-edit' | 'suggest'}
 */
export function detectClaudePermissionLevel(opts = {}) {
  const settingsLevel = detectClaudePermissionLevelFromSettings(opts);

  if (opts.skipRuntime) return settingsLevel;

  // Runtime override — UPGRADE-ONLY. Codex review 2026-05-08 flagged that
  // an earlier version mapped runtime mode to a tier IN ISOLATION, which
  // missed managed deny lists and `disableBypassPermissionsMode`. The fix:
  // re-run detection with the runtime mode AS IF it were the settings
  // defaultMode, so the existing deny/ask/bypassDisabled pipeline applies.
  // Failures fall back to settings cleanly (best-effort).
  let runtimeLevel = null;
  try {
    const rec = loadRuntimePermissions({ cwd: opts.cwd });
    if (rec && rec.permissionMode) {
      const runtimeFlags = detectClaudePermissions({
        ...opts,
        effectiveDefaultMode: rec.permissionMode,
      });
      if (runtimeFlags.hasBashStar && runtimeFlags.hasWriteStar) {
        runtimeLevel = 'full-auto';
      } else if (runtimeFlags.hasWriteStar || runtimeFlags.hasEditStar) {
        runtimeLevel = 'auto-edit';
      } else {
        runtimeLevel = 'suggest';
      }
    }
  } catch {
    // Fail open — runtime override is best-effort.
  }

  if (!runtimeLevel) return settingsLevel;

  // Pick the higher tier (more permissive). Equal tiers → settings wins
  // (canonical source). Note: runtime tier here has ALREADY been clamped
  // by the deny/ask/bypassDisabled pipeline above, so a managed
  // `disableBypassPermissionsMode: true` will have dropped the implicit
  // broad grant from runtime `bypassPermissions` BEFORE this comparison
  // (clamping it to whatever the explicit allow lists give, typically
  // `suggest`). `allowManagedPermissionRulesOnly` similarly clamps non-
  // managed runtime grants.
  const sRank = _LEVEL_RANK[settingsLevel] || 1;
  const rRank = _LEVEL_RANK[runtimeLevel] || 1;
  if (rRank > sRank) return runtimeLevel;
  return settingsLevel;
}

/**
 * Detailed breakdown of how `detectClaudePermissionLevel` arrived at its
 * answer. Used by the `--explain-permissions` flag and tests; the structure
 * is stable but the human-readable phrasing of `chosenSourceReason` is not.
 *
 * @param {object} [opts]
 * @returns {{
 *   settingsLevel: string,
 *   runtime: { mode: string, level: string, source: string, ageMs: number, sessionId: string|null }|null,
 *   finalLevel: string,
 *   chosenSource: 'settings'|'runtime',
 *   chosenSourceReason: string,
 * }}
 */
export function explainPermissionLevel(opts = {}) {
  const settingsLevel = detectClaudePermissionLevelFromSettings(opts);

  let runtime = null;
  let runtimeWasClamped = false;
  try {
    const rec = loadRuntimePermissions({ cwd: opts.cwd });
    if (rec && rec.permissionMode) {
      // Naive level if the runtime mode were applied without any
      // settings-side restrictions. We compare to the clamped level so
      // the explanation can call out when managed deny / disableBypass
      // demoted the runtime promotion.
      const naiveLevel = permissionModeToLevel(rec.permissionMode);
      const runtimeFlags = detectClaudePermissions({
        ...opts,
        effectiveDefaultMode: rec.permissionMode,
      });
      let clampedLevel;
      if (runtimeFlags.hasBashStar && runtimeFlags.hasWriteStar) clampedLevel = 'full-auto';
      else if (runtimeFlags.hasWriteStar || runtimeFlags.hasEditStar) clampedLevel = 'auto-edit';
      else clampedLevel = 'suggest';

      if (naiveLevel && clampedLevel && (_LEVEL_RANK[clampedLevel] || 1) < (_LEVEL_RANK[naiveLevel] || 1)) {
        runtimeWasClamped = true;
      }
      runtime = {
        mode: rec.permissionMode,
        level: clampedLevel,
        naiveLevel: naiveLevel || null,
        clamped: runtimeWasClamped,
        bypassDisabled: runtimeFlags.bypassDisabled,
        source: rec.source,
        ageMs: rec.ageMs,
        sessionId: rec.sessionId,
      };
    }
  } catch { /* fall through */ }

  const sRank = _LEVEL_RANK[settingsLevel] || 1;
  const rRank = runtime ? (_LEVEL_RANK[runtime.level] || 1) : -1;
  const useRuntime = runtime && rRank > sRank;
  const finalLevel = useRuntime ? runtime.level : settingsLevel;

  let chosenSourceReason;
  if (useRuntime) {
    chosenSourceReason =
      `Runtime ${runtime.mode} (from ${runtime.source}) promotes settings ` +
      `tier ${settingsLevel} → ${runtime.level}` +
      (runtime.clamped
        ? ` (clamped from ${runtime.naiveLevel} by deny/ask rules, ` +
          `disableBypassPermissionsMode, or allowManagedPermissionRulesOnly ` +
          `in some scope)`
        : '') +
      '.';
  } else if (runtime && rRank === sRank) {
    chosenSourceReason = `Runtime ${runtime.mode} matches settings tier ${settingsLevel} — settings wins (canonical).`;
  } else if (runtime && rRank < sRank) {
    chosenSourceReason =
      `Runtime ${runtime.mode} (tier ${runtime.level}) is lower than settings ` +
      `(tier ${settingsLevel}) — settings wins (upgrade-only policy; runtime ` +
      `cannot revoke explicit allow grants).`;
  } else if (settingsLevel === 'suggest') {
    chosenSourceReason =
      `No runtime override captured (no permission_mode in hook stdin or env). ` +
      `Settings has no broad allow grants. If you launched Claude Code with ` +
      `--dangerously-skip-permissions, restart your session so the SessionStart ` +
      `hook can capture the runtime mode, or set .ao/autonomy.json codex.approval.`;
  } else {
    chosenSourceReason = `No runtime override; using settings tier ${settingsLevel}.`;
  }

  return {
    settingsLevel,
    runtime,
    finalLevel,
    chosenSource: useRuntime ? 'runtime' : 'settings',
    chosenSourceReason,
  };
}

/**
 * Map a Codex-style permission level to a Claude CLI --permission-mode value.
 *
 * @param {'full-auto' | 'auto-edit' | 'suggest'} level
 * @returns {string}
 */
export function claudePermissionModeFlag(level) {
  switch (level) {
    case 'full-auto': return 'bypassPermissions';
    case 'auto-edit': return 'acceptEdits';
    case 'suggest':
    default:
      return 'default';
  }
}

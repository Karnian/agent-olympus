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
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string} [opts.home]
 * @param {string} [opts.managedRootOverride]
 * @param {string} [opts.platformOverride]
 * @param {object} [opts.env]
 * @param {object} [opts.fs]
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
    // This preserves the expected interaction with deny/ask rules: a host
    // that sets `bypassPermissions` + `deny: Bash(*)` gets bash demoted while
    // write/edit stay broad.
    const bypassActive = defaultMode === 'bypassPermissions' && !bypassDisabled;
    const acceptActive = defaultMode === 'acceptEdits';
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
 * Map detected Claude permissions to a Codex-style approval level string.
 *
 * Only BROAD grants promote a tier — scoped grants cannot promote because
 * codex's coarse sandbox tiers (read-only | workspace-write | danger-full-access)
 * cannot honor the user's scoped restriction. Examples:
 *   - `Write(src/**)` alone → `suggest` (workspace-write would let codex
 *     write to `docs/**`, expanding beyond the granted scope).
 *   - `Bash(git:*)` alone → `suggest` (workspace-write still lets codex run
 *     arbitrary shell within cwd — `rm`, `curl`, etc. — not just git).
 *
 * Mapping (highest tier first):
 *   1. Broad Bash AND broad Write              → full-auto
 *   2. Broad Write OR broad Edit               → auto-edit
 *   3. Otherwise                               → suggest
 *
 * `defaultMode` is already baked into the broad flags by detectClaudePermissions
 * (bypassPermissions → broad Bash+Write+Edit; acceptEdits → broad Write+Edit),
 * with deny/ask fail-closed applied uniformly.
 *
 * @param {object} [opts]
 * @returns {'full-auto' | 'auto-edit' | 'suggest'}
 */
export function detectClaudePermissionLevel(opts = {}) {
  const p = detectClaudePermissions(opts);

  if (p.hasBashStar && p.hasWriteStar) return 'full-auto';
  if (p.hasWriteStar || p.hasEditStar) return 'auto-edit';
  return 'suggest';
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

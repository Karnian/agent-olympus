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
 * Extract `permissions.disableBypassPermissionsMode` as a strict boolean.
 */
function getDisableBypass(data) {
  return data?.permissions?.disableBypassPermissionsMode === true;
}

/**
 * Resolve the platform-specific managed settings root + fragment directory.
 * Returns `{ file, dir }` paths (not guaranteed to exist).
 *
 * Paths per Claude Code docs:
 *   darwin: /Library/Application Support/ClaudeCode/
 *   linux:  /etc/claude-code/
 *   win32:  %PROGRAMDATA%\ClaudeCode\
 */
function resolveManagedPaths(opts = {}) {
  const plat = opts.platformOverride || osPlatform();
  if (opts.managedRootOverride) {
    return {
      file: join(opts.managedRootOverride, 'managed-settings.json'),
      dir: join(opts.managedRootOverride, 'managed-settings.d'),
    };
  }
  if (plat === 'darwin') {
    const root = '/Library/Application Support/ClaudeCode';
    return { file: join(root, 'managed-settings.json'), dir: join(root, 'managed-settings.d') };
  }
  if (plat === 'win32') {
    const root = (opts.env?.PROGRAMDATA || process.env.PROGRAMDATA || 'C:\\ProgramData') + '\\ClaudeCode';
    return { file: join(root, 'managed-settings.json'), dir: join(root, 'managed-settings.d') };
  }
  // linux + everything else
  const root = '/etc/claude-code';
  return { file: join(root, 'managed-settings.json'), dir: join(root, 'managed-settings.d') };
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

  const managed = resolveManagedPaths(opts);
  const out = [];

  // 1. Managed root file
  const managedData = readJson(managed.file, fs);
  if (managedData) out.push({ scope: 'managed', data: managedData });

  // 2. Managed fragments (lexical order, same "managed" scope)
  const fragments = readManagedFragments(managed.dir, fs);
  for (const data of fragments) {
    out.push({ scope: 'managed', data });
  }

  // 3. Project-local, project, user-local, user
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

    // Merge allow/deny/ask across ALL scopes (union semantics).
    const allow = [];
    const deny = [];
    const ask = [];
    let defaultMode = null;
    let bypassDisabled = false;
    let managedDetected = false;

    for (const { scope, data } of sources) {
      if (scope === 'managed') managedDetected = true;
      allow.push(...getList(data, 'allow'));
      deny.push(...getList(data, 'deny'));
      ask.push(...getList(data, 'ask'));

      // defaultMode: first non-null in precedence order wins.
      if (defaultMode === null) {
        const m = getDefaultMode(data);
        if (m) defaultMode = m;
      }

      // disableBypassPermissionsMode: OR across all scopes (any true disables).
      if (getDisableBypass(data)) bypassDisabled = true;
    }

    // Per-tool broad/scoped detection with fail-closed ask/deny.
    const result = {
      hasBashStar: false,  hasBashScoped: false,
      hasWriteStar: false, hasWriteScoped: false,
      hasEditStar: false,  hasEditScoped: false,
      defaultMode,
      bypassDisabled,
      managedDetected,
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
    };
  }
}

/**
 * Map detected Claude permissions to a Codex-style approval level string.
 *
 * Ordering (highest tier first):
 *   1. defaultMode `bypassPermissions` (and not disabled) → full-auto
 *   2. Broad Bash AND broad Write in allow                → full-auto
 *   3. defaultMode `acceptEdits`                          → auto-edit
 *   4. Any broad or scoped Write/Edit/Bash grant          → auto-edit
 *   5. Otherwise                                           → suggest
 *
 * Scoped Bash alone maps to `auto-edit` (not `full-auto`): codex's
 * `workspace-write` sandbox still lets it write files, which matches the
 * user's actual trust level, without granting arbitrary shell.
 *
 * @param {object} [opts]
 * @returns {'full-auto' | 'auto-edit' | 'suggest'}
 */
export function detectClaudePermissionLevel(opts = {}) {
  const p = detectClaudePermissions(opts);

  // defaultMode is already baked into per-tool flags by detectClaudePermissions
  // (bypassPermissions → all broad, acceptEdits → write/edit broad), with
  // deny/ask fail-closed applied uniformly. So level mapping is a simple
  // 3-tier decision over the final flags.

  if (p.hasBashStar && p.hasWriteStar) return 'full-auto';

  if (
    p.hasWriteStar || p.hasEditStar ||
    p.hasWriteScoped || p.hasEditScoped ||
    p.hasBashScoped
  ) {
    return 'auto-edit';
  }

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

/**
 * Architect Scope Resolver — optional diff-scope narrowing for architect agent.
 *
 * When enabled, supplies the architect prompt with a bounded scan scope
 * (changed files + 1-hop neighbours) instead of letting it roam the entire
 * codebase. Reduces per-call input tokens while preserving review quality
 * on localised changes.
 *
 * Safety invariants (from Codex Phase 2 review):
 *   - shared lib / public contract changes → automatic full-context fallback
 *   - disabled by default (opt-in via .ao/autonomy.json)
 *   - 1-hop detection is best-effort grep-based; false-positives bias toward
 *     INCLUSION (safer than exclusion)
 *
 * Fail-safe — every export catches and returns a sensible default.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname, relative, dirname, isAbsolute } from 'node:path';

/**
 * Common identifier words that produce catastrophic grep noise. When a
 * changed file's basename is one of these, we SKIP the 1-hop expansion for
 * that entry — any file in the repo likely matches, and the architect
 * would drown in false positives.
 * (Gemini Phase 2 review finding: helper/context/data noise.)
 */
const NOISY_BASENAMES = new Set([
  'index', 'main', 'app', 'utils', 'util', 'helper', 'helpers',
  'common', 'shared', 'base', 'core', 'config', 'constants',
  'context', 'data', 'model', 'models', 'types', 'schema',
  'test', 'tests', 'mock', 'mocks', 'fixtures',
]);

const MIN_BASENAME_LENGTH = 4;
const MAX_BINARY_FILE_BYTES = 100 * 1024; // 100KB cap on untracked inclusion

/**
 * Path patterns that signal "shared library / public contract" — a change
 * under any of these directories triggers full-context fallback.
 */
const SHARED_PATH_PATTERNS = [
  /(^|\/)shared\//i,
  /(^|\/)lib\//i,
  /(^|\/)common\//i,
  /(^|\/)core\//i,
  /(^|\/)public\//i,
  /(^|\/)api\//i,
  /(^|\/)types?\//i,
  /(^|\/)schemas?\//i,
  /(^|\/)interfaces?\//i,
  /(^|\/)contracts?\//i,
  // Go: internal/ is the canonical "public API surface within module" marker.
  // pkg/ is a widespread convention for library code exposed to the module.
  /(^|\/)internal\//i,
  /(^|\/)pkg\//i,
  // Rust: crates expose public surface via lib.rs / mod.rs / re-exports.
  // Not a directory pattern — covered by filename list below.
];

/**
 * Filename patterns that also trigger full-context (public contracts at
 * repo root or convention-named exports).
 */
const SHARED_FILENAME_PATTERNS = [
  // JS/TS barrels and public surface
  /^index\.(m?js|m?ts|tsx?|jsx?)$/i,
  /^main\.(m?js|m?ts|tsx?|jsx?)$/i,
  /^exports?\.(m?js|m?ts|tsx?|jsx?)$/i,
  /^api\.(m?js|m?ts|tsx?|jsx?)$/i,
  /^types?\.(d\.ts|m?ts|m?js)$/i,
  /^schema\.(m?js|m?ts|json|jsonc)$/i,
  // Build manifests / package descriptors — a change here reshapes the
  // module boundary and must be reviewed with full context.
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^tsconfig.*\.json$/i,
  /^Cargo\.(toml|lock)$/i,      // Rust
  /^pom\.xml$/i,                 // Java / Maven
  /^build\.gradle(\.kts)?$/i,    // Java / Gradle
  /^go\.(mod|sum)$/i,            // Go
  /^pyproject\.toml$/i,          // Python
  /^setup\.(py|cfg)$/i,          // Python
  /^requirements.*\.txt$/i,      // Python
  /^Gemfile(\.lock)?$/i,         // Ruby
  // Rust module surface
  /^lib\.rs$/i,
  /^mod\.rs$/i,
  // IDL / schema definitions
  /\.proto$/i,
  /^openapi\.(ya?ml|json)$/i,
  /^swagger\.(ya?ml|json)$/i,
  /\.graphql$/i,
  /\.graphqls$/i,
];

/**
 * Check if any changed file is in a shared path or is a known shared filename.
 *
 * @param {string[]} changedFiles - Repository-relative paths
 * @returns {{ shared: boolean, matchedFile: string|null, reason: string }}
 */
export function detectSharedLibChange(changedFiles) {
  try {
    const files = Array.isArray(changedFiles) ? changedFiles : [];
    for (const f of files) {
      if (typeof f !== 'string' || !f.trim()) continue;
      const norm = f.replace(/\\/g, '/');
      for (const pat of SHARED_PATH_PATTERNS) {
        if (pat.test(norm)) {
          return { shared: true, matchedFile: f, reason: `matches shared-path pattern ${pat}` };
        }
      }
      const base = basename(norm);
      for (const pat of SHARED_FILENAME_PATTERNS) {
        if (pat.test(base)) {
          return { shared: true, matchedFile: f, reason: `filename ${base} matches shared-contract pattern` };
        }
      }
    }
    return { shared: false, matchedFile: null, reason: '' };
  } catch {
    // Conservative: on any error, assume shared (fail-safe toward full context).
    return { shared: true, matchedFile: null, reason: 'detection error — defaulting to shared' };
  }
}

/**
 * Determine changed files via `git diff --name-only`. Falls back to the
 * caller-supplied list when git is unavailable or errors.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {string} [opts.base='HEAD']
 * @returns {string[]} repo-relative paths
 */
export function detectChangedFiles(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const base = typeof opts.base === 'string' && opts.base.trim() ? opts.base : 'HEAD';
  // Guard: only allow simple git refs (alphanum, slash, dot, dash, underscore, tilde, caret).
  // Rejects anything with shell metachars even though we use execFile.
  if (!/^[A-Za-z0-9_.\/\-~^]+$/.test(base)) return [];
  try {
    const out = execFileSync('git', ['diff', '--name-only', base], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    // Include untracked files as a best-effort extension. Skip files
    // larger than MAX_BINARY_FILE_BYTES to avoid sweeping huge build
    // artefacts or binaries into the review scope. (Gemini Phase 2 #5.)
    try {
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      for (const u of untracked.split('\n').map(s => s.trim()).filter(Boolean)) {
        if (lines.includes(u)) continue;
        try {
          const abs = join(cwd, u);
          if (existsSync(abs)) {
            const st = statSync(abs);
            if (st.size > MAX_BINARY_FILE_BYTES) continue;
          }
        } catch { /* best-effort size filter */ }
        lines.push(u);
      }
    } catch { /* ignore */ }
    return lines;
  } catch {
    return [];
  }
}

/**
 * Best-effort 1-hop expansion: for each changed file, grep the repo for
 * references to its basename (stripped of extension). Matches are added as
 * "neighbours" — callers, importers, related tests. Precision is low, but
 * we prefer over-inclusion (safer than under-inclusion).
 *
 * @param {string[]} changedFiles
 * @param {object}   [opts]
 * @param {string}   [opts.cwd=process.cwd()]
 * @param {number}   [opts.maxNeighbours=50]
 * @returns {string[]} repo-relative neighbour paths (excludes the change set itself)
 */
export function expandToOneHop(changedFiles, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const maxNeighbours = typeof opts.maxNeighbours === 'number' ? opts.maxNeighbours : 50;
  const maxPerBasename = typeof opts.maxPerBasename === 'number' ? opts.maxPerBasename : 25;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return [];
  const changeSet = new Set(changedFiles);
  const neighbours = new Set();
  const skipped = [];

  for (const f of changedFiles) {
    if (typeof f !== 'string' || !f.trim()) continue;
    const bn = basename(f, extname(f));
    if (!bn) continue;

    // Defence-in-depth: even though execFileSync argv is not shell-parsed,
    // reject basenames with characters that could confuse git itself
    // (e.g. leading dashes become options). Node argv-based exec is
    // already injection-safe; this is a secondary belt.
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(bn)) {
      skipped.push({ basename: bn, reason: 'unsafe chars' });
      continue;
    }

    // Skip too-common basenames to avoid grep noise catastrophe.
    if (bn.length < MIN_BASENAME_LENGTH) {
      skipped.push({ basename: bn, reason: `length<${MIN_BASENAME_LENGTH}` });
      continue;
    }
    if (NOISY_BASENAMES.has(bn.toLowerCase())) {
      skipped.push({ basename: bn, reason: 'too common' });
      continue;
    }

    let hits = [];
    try {
      // execFileSync: argv is passed to git directly, no shell. basename
      // regex above already rejects leading dashes, so '--' separator is
      // defensive only.
      const out = execFileSync(
        'git',
        ['grep', '-l', '--fixed-strings', '--', bn],
        { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
      );
      hits = out.split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
      // Exit code 1 = no match (normal). Other errors = skip silently.
      continue;
    }

    // Per-basename cap: if a basename returns too many hits, it's likely
    // a false-positive storm even though it passed NOISY_BASENAMES.
    // Treat it the same as a noisy name and skip entirely.
    if (hits.length > maxPerBasename) {
      skipped.push({ basename: bn, reason: `hits>${maxPerBasename}` });
      continue;
    }

    for (const hit of hits) {
      if (changeSet.has(hit)) continue;
      if (neighbours.size >= maxNeighbours) break;
      neighbours.add(hit);
    }
    if (neighbours.size >= maxNeighbours) break;
  }

  const out = Array.from(neighbours);
  if (skipped.length > 0) out.__skipped = skipped;  // attach for diagnostics (non-enumerable-safe)
  return out;
}

/**
 * Resolve the autonomy setting for architect diffScope.
 * Valid values: "auto" (default), "enabled", "disabled".
 *
 * @param {object|null} autonomyConfig - Loaded autonomy config
 * @returns {'auto'|'enabled'|'disabled'}
 */
export function resolveDiffScopeSetting(autonomyConfig) {
  try {
    const v = autonomyConfig?.architect?.diffScope;
    if (v === 'enabled' || v === 'disabled' || v === 'auto') return v;
    return 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Top-level resolver: decide whether to supply diff-scope to architect,
 * and if so build the scope object.
 *
 * Decision matrix:
 *   - setting='disabled'             → { apply: false, reason: 'autonomy disabled' }
 *   - setting='auto'                 → { apply: false, reason: 'auto mode defaults off; measurement first' }
 *   - setting='enabled' + shared-lib → { apply: false, reason: 'shared-lib detected: full context' }
 *   - setting='enabled' + localised  → { apply: true, scope: { changed, neighbours } }
 *
 * `auto` deliberately stays off until Phase 0 measurement indicates
 * architect is a hotspot worth narrowing. Flip to `enabled` manually
 * after reviewing `node scripts/usage-report.mjs --all`.
 *
 * @param {object} params
 * @param {string[]}    [params.changedFiles] - Pre-computed file list; auto-detected if omitted
 * @param {object|null} [params.autonomyConfig]
 * @param {string}      [params.cwd=process.cwd()]
 * @returns {{
 *   apply: boolean,
 *   scope: { changed: string[], neighbours: string[] } | null,
 *   reason: string,
 *   sharedLibDetected: boolean,
 *   setting: 'auto'|'enabled'|'disabled',
 * }}
 */
export function resolveArchitectScope(params = {}) {
  try {
    const cwd = params.cwd || process.cwd();
    const setting = resolveDiffScopeSetting(params.autonomyConfig);

    if (setting === 'disabled') {
      return { apply: false, scope: null, reason: 'autonomy.architect.diffScope=disabled', sharedLibDetected: false, setting };
    }
    if (setting === 'auto') {
      return { apply: false, scope: null, reason: 'auto mode — full context until explicit enable', sharedLibDetected: false, setting };
    }

    // enabled path
    const changed = Array.isArray(params.changedFiles) && params.changedFiles.length > 0
      ? params.changedFiles
      : detectChangedFiles({ cwd });

    if (changed.length === 0) {
      return { apply: false, scope: null, reason: 'no changed files detected', sharedLibDetected: false, setting };
    }

    const sharedCheck = detectSharedLibChange(changed);
    if (sharedCheck.shared) {
      return {
        apply: false,
        scope: null,
        reason: `shared-lib / public contract detected (${sharedCheck.matchedFile || '?'}): ${sharedCheck.reason}`,
        sharedLibDetected: true,
        setting,
      };
    }

    const neighbours = expandToOneHop(changed, { cwd });
    return {
      apply: true,
      scope: { changed, neighbours },
      reason: `localised change: ${changed.length} changed, ${neighbours.length} 1-hop neighbours`,
      sharedLibDetected: false,
      setting,
    };
  } catch {
    return { apply: false, scope: null, reason: 'resolver error — defaulting to full context', sharedLibDetected: false, setting: 'auto' };
  }
}

/**
 * Format a resolved scope object into a natural-language prompt fragment
 * that can be injected into the architect Task() prompt.
 *
 * Returns an empty string when apply=false — callers can concatenate
 * unconditionally.
 *
 * @param {ReturnType<typeof resolveArchitectScope>} resolved
 * @returns {string}
 */
export function formatScopeHint(resolved) {
  try {
    if (!resolved || !resolved.apply || !resolved.scope) return '';
    const { changed, neighbours } = resolved.scope;
    const lines = [];
    lines.push('');
    lines.push('## Review Scope Hint (diff-scope enabled)');
    lines.push('');
    lines.push('**First action required**: Before reading any file, write one paragraph');
    lines.push('titled "Scope Adequacy Check" stating whether the scope below is plausibly');
    lines.push('sufficient for this review. If not (e.g. the change modifies a re-exported');
    lines.push('symbol, extends a base class, or touches dependency-injection wiring),');
    lines.push('declare scope-insufficient and perform a full-repo scan instead.');
    lines.push('');
    lines.push('When the scope IS adequate, constrain your Glob/Grep/Read to the files');
    lines.push('below. Scanning the whole codebase would be wasteful for a localised change.');
    lines.push('');
    lines.push('Escalation trigger — STOP scope-limiting if you observe ANY of:');
    lines.push('  1. A changed symbol referenced outside the 1-hop neighbour list');
    lines.push('  2. A shared utility / public export being refactored');
    lines.push('  3. A type signature or function signature change (affects all callers)');
    lines.push('  4. Anything under shared/, lib/, internal/, api/, types/, or a barrel file');
    lines.push('Switch to full-repo analysis and note the trigger in your RISKS section so');
    lines.push('the caller can re-run without the scope hint if needed.');
    lines.push('');
    lines.push('### Changed files (primary focus)');
    for (const f of changed) lines.push(`- ${f}`);
    if (neighbours.length > 0) {
      lines.push('');
      lines.push('### 1-hop neighbours (callers / importers / related tests)');
      for (const n of neighbours) lines.push(`- ${n}`);
    }
    lines.push('');
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * UI anti-pattern registry scanner (v1.0.2 US-001)
 *
 * Detects the five canonical LLM UI slop patterns in a diff and reports
 * each violation with file:line, rule id, and matched substring.
 *
 * Called from skills/finish-branch/SKILL.md as an opt-in gate. The scan
 * only runs when config/design-blacklist.jsonc exists AND the diff
 * contains at least one UI file extension.
 *
 * Public API:
 *   loadRules(cwd?)                → { schemaVersion, rules } or null
 *   isUiPath(filePath)             → boolean — true for .css/.scss/.tsx/.jsx/.vue/.svelte/.html
 *   scanContent(content, rules, filePath, allowedFonts) → Array<violation>
 *   scanDiff({files, content, cwd, mode}) → { mode, violations, clean, skipped, reason }
 *   getScanMode(cwd)               → 'warn' | 'block'
 *
 * Violation shape:
 *   { file, line, ruleId, category, description, match }
 *
 * Modes:
 *   'warn'  — log violations but do not fail finish-branch (v1.0.2 default)
 *   'block' — fail finish-branch on any violation (opt-in stricter)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './memory.mjs';

const UI_EXTENSIONS = new Set([
  '.css', '.scss', '.sass', '.less',
  '.tsx', '.jsx',
  '.vue', '.svelte',
  '.html', '.htm',
]);

const KNOWN_SCHEMA_VERSION = 1;

/**
 * Strip JSONC line comments (// ...) before JSON.parse. Block comments are
 * not used in the example file so we keep the stripper minimal/safe.
 *
 * @param {string} raw
 * @returns {string}
 */
function stripJsoncComments(raw) {
  const lines = raw.split('\n');
  const out = [];
  for (const line of lines) {
    // Find // outside of strings (naive but good enough for our config shape).
    let inString = false;
    let escape = false;
    let cutAt = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString && ch === '/' && line[i + 1] === '/') {
        cutAt = i;
        break;
      }
    }
    out.push(cutAt >= 0 ? line.slice(0, cutAt) : line);
  }
  return out.join('\n');
}

/**
 * Load rules from config/design-blacklist.jsonc.
 * Returns null when the file doesn't exist (opt-in). Returns null on
 * parse error or schemaVersion > known (fail-safe forward compat).
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {{schemaVersion:number, rules:Array}|null}
 */
export function loadRules(cwd = process.cwd()) {
  try {
    const filePath = path.join(cwd, 'config', 'design-blacklist.jsonc');
    const raw = readFileSync(filePath, 'utf-8');
    const stripped = stripJsoncComments(raw);
    const parsed = JSON.parse(stripped);
    if (!parsed || typeof parsed !== 'object') return null;
    const ver = parsed.schemaVersion;
    if (typeof ver === 'number' && ver > KNOWN_SCHEMA_VERSION) return null;
    if (!Array.isArray(parsed.rules)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isUiPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  return UI_EXTENSIONS.has(ext);
}

/**
 * Compile a rule's pattern string to a case-insensitive multi-line RegExp.
 * Returns null on invalid regex (fail-safe).
 *
 * @param {object} rule
 * @returns {RegExp|null}
 */
function compileRule(rule) {
  try {
    if (!rule || typeof rule.pattern !== 'string') return null;
    return new RegExp(rule.pattern, 'gim');
  } catch {
    return null;
  }
}

/**
 * Scan a single file's content for violations against the rule set.
 * Respects allowedFonts from design-identity.json for font-family rules.
 *
 * @param {string} content
 * @param {Array<object>} rules
 * @param {string} filePath
 * @param {Array<string>} [allowedFonts=[]]
 * @returns {Array<object>}
 */
export function scanContent(content, rules, filePath, allowedFonts = []) {
  const violations = [];
  if (!content || !Array.isArray(rules)) return violations;

  const allowedFontSet = new Set((allowedFonts || []).map((f) => String(f).toLowerCase()));

  for (const rule of rules) {
    const re = compileRule(rule);
    if (!re) continue;

    // Re-split to find line numbers without loading the content twice.
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(content)) !== null) {
      const matched = match[0];

      // Allowed-fonts suppression: if any token inside the match is in
      // allowedFonts, skip as an intentional override.
      if (rule.category === 'typography' && allowedFontSet.size > 0) {
        const lowered = matched.toLowerCase();
        let suppressed = false;
        for (const font of allowedFontSet) {
          if (lowered.includes(font)) { suppressed = true; break; }
        }
        if (suppressed) continue;
      }

      // Compute 1-based line number from match index.
      const upto = content.slice(0, match.index);
      const line = upto.split('\n').length;

      violations.push({
        file: filePath,
        line,
        ruleId: rule.id,
        category: rule.category,
        description: rule.description,
        match: matched.slice(0, 200), // cap for output hygiene
      });

      // Prevent infinite loop on zero-width matches.
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }
  return violations;
}

/**
 * Read the scan mode from .ao/autonomy.json.
 * Default is 'warn' per v1.0.2 spec.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {'warn'|'block'}
 */
export function getScanMode(cwd = process.cwd()) {
  try {
    const raw = readFileSync(path.join(cwd, '.ao', 'autonomy.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const mode = parsed?.uiSmellScan;
    if (mode === 'block' || mode === 'warn') return mode;
    return 'warn';
  } catch {
    return 'warn';
  }
}

/**
 * Load allowedFonts from .ao/memory/design-identity.json.
 *
 * @returns {Promise<Array<string>>}
 */
async function loadAllowedFonts() {
  const identity = await readJsonFile('design-identity.json');
  if (Array.isArray(identity?.allowedFonts)) return identity.allowedFonts;
  return [];
}

/**
 * Scan a set of changed files against the rule set.
 *
 * @param {object} options
 * @param {Array<{path:string, content:string}>} options.files - pre-read files
 * @param {string} [options.cwd]
 * @returns {Promise<{
 *   mode: 'warn'|'block',
 *   violations: Array,
 *   clean: boolean,
 *   skipped: boolean,
 *   reason?: string
 * }>}
 */
export async function scanDiff({ files, cwd = process.cwd() } = {}) {
  const mode = getScanMode(cwd);
  const rules = loadRules(cwd);

  // Opt-in: no rules file → skip silently.
  if (!rules) {
    return { mode, violations: [], clean: true, skipped: true, reason: 'no-config' };
  }

  // No UI files in the diff → skip silently regardless of mode.
  const uiFiles = (files || []).filter((f) => isUiPath(f.path));
  if (uiFiles.length === 0) {
    return { mode, violations: [], clean: true, skipped: true, reason: 'no-ui-files' };
  }

  const allowedFonts = await loadAllowedFonts();

  const violations = [];
  for (const f of uiFiles) {
    const hits = scanContent(f.content || '', rules.rules, f.path, allowedFonts);
    violations.push(...hits);
  }

  return {
    mode,
    violations,
    clean: violations.length === 0,
    skipped: false,
  };
}

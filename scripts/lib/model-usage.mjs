/**
 * Model Usage Logger — records per-agent model usage for Opus-skew analysis.
 *
 * Appends one JSONL record per subagent completion. The record captures:
 *   - subagent_type (e.g. "agent-olympus:metis")
 *   - model tier — from Task(model=...) when present, otherwise from the
 *     agent's default model (AGENT_DEFAULT_MODEL table below). Raw
 *     hook-reported value is preserved in modelSource="payload" vs "default".
 *   - inputCharLength + outputCharLength (both proxies for token count)
 *   - runId (if Atlas/Athena run is active) or null for ad-hoc subagents
 *   - stage (reserved, null for v1 — populated in Phase 1+)
 *
 * Output locations:
 *   - Active run: .ao/artifacts/runs/<runId>/model-usage.jsonl
 *   - Fallback:   .ao/state/ao-model-usage.jsonl
 *
 * Append-only semantics: pure appendFileSync(). NO in-band trim/cap, because
 * the read-modify-write sequence is not atomic under concurrent SubagentStop
 * hooks (parallel Task() spawns can race and lose entries). Size management
 * is externalised: call trimFallbackUsage() from SessionEnd or operator CLI.
 *
 * Fail-safe by design — every code path returns normally, never throws.
 *
 * Known blind spot (Phase-deferred): native team tools (TeamCreate /
 * TaskCreated / TaskCompleted / TeammateIdle) do not fire SubagentStop in
 * the same way as Task() spawns. Athena native-team workers will be missing
 * from the usage log until a dedicated hook is added. Atlas and Agent-tool
 * spawns are covered.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FALLBACK_DIR = join('.ao', 'state');
const FALLBACK_FILE = join(FALLBACK_DIR, 'ao-model-usage.jsonl');
const RUNS_BASE = join('.ao', 'artifacts', 'runs');
const DEFAULT_TRIM_THRESHOLD = 1000;
const SCHEMA_VERSION = 1;

/**
 * Static agent → default-model mapping sourced from `agents/*.md` frontmatter.
 * Used as a fallback when the SubagentStop hook payload omits `tool_input.model`
 * (which it often does — the Task() API does not require model override).
 *
 * Keep in sync when agents/*.md frontmatter changes. Verified via
 * grep -r '^model:' agents/ on commit.
 *
 * @type {Record<string, 'opus'|'sonnet'|'haiku'>}
 */
export const AGENT_DEFAULT_MODEL = Object.freeze({
  // Opus tier — orchestrators, planners, critics, deep analysis
  'agent-olympus:architect':    'opus',
  'agent-olympus:atlas':        'opus',
  'agent-olympus:athena':       'opus',
  'agent-olympus:hermes':       'opus',
  'agent-olympus:metis':        'opus',
  'agent-olympus:momus':        'opus',
  'agent-olympus:prometheus':   'opus',
  // Sonnet tier — execution, review, design
  'agent-olympus:aphrodite':        'sonnet',
  'agent-olympus:ask':              'sonnet',
  'agent-olympus:code-reviewer':    'sonnet',
  'agent-olympus:debugger':         'sonnet',
  'agent-olympus:designer':         'sonnet',
  'agent-olympus:executor':         'sonnet',
  'agent-olympus:hephaestus':       'sonnet',
  'agent-olympus:security-reviewer':'sonnet',
  'agent-olympus:test-engineer':    'sonnet',
  'agent-olympus:themis':           'sonnet',
  // Haiku tier — lightweight tasks
  'agent-olympus:explore': 'haiku',
  'agent-olympus:writer':  'haiku',
});

/**
 * Resolve the effective model tier for a subagent.
 *
 * 1. If the caller passed an explicit model (`Task(model="...")` captured by
 *    the hook payload), prefer that — it is ground truth.
 * 2. Otherwise, consult AGENT_DEFAULT_MODEL.
 * 3. Otherwise return null (unknown agent or missing mapping).
 *
 * @param {string|null|undefined} payloadModel - hook-reported model
 * @param {string|null|undefined} agentType   - e.g. "agent-olympus:metis"
 * @returns {{ model: string|null, source: 'payload'|'default'|'unknown' }}
 */
export function resolveEffectiveModel(payloadModel, agentType) {
  if (typeof payloadModel === 'string' && payloadModel.trim()) {
    return { model: payloadModel.trim(), source: 'payload' };
  }
  const fallback = agentType ? AGENT_DEFAULT_MODEL[agentType] : null;
  if (fallback) return { model: fallback, source: 'default' };
  return { model: null, source: 'unknown' };
}

/**
 * Build a JSONL record for a single subagent completion.
 *
 * @param {object} params
 * @param {string|null} params.runId            - Active run id or null
 * @param {string|null} params.agentType        - e.g. "agent-olympus:metis"
 * @param {string|null} params.model            - Payload-reported model or null
 * @param {number}      params.inputCharLength  - Character length of prompt/input (new in v1)
 * @param {number}      params.outputCharLength - Character length of assistant output
 * @param {string|null} params.toolName         - Tool that triggered the spawn (usually "Task")
 * @param {string|null} params.transcriptPath   - Agent transcript file path (optional)
 * @param {string|null} [params.stage]          - Orchestrator stage (reserved for Phase 1+)
 * @returns {object} JSONL-ready record
 */
export function buildRecord(params) {
  const resolved = resolveEffectiveModel(params.model, params.agentType);
  return {
    schemaVersion: SCHEMA_VERSION,
    ts: new Date().toISOString(),
    runId: params.runId || null,
    agentType: params.agentType || null,
    model: resolved.model,
    modelSource: resolved.source,
    inputCharLength: typeof params.inputCharLength === 'number' ? params.inputCharLength : 0,
    outputCharLength: typeof params.outputCharLength === 'number' ? params.outputCharLength : 0,
    toolName: params.toolName || null,
    transcriptPath: params.transcriptPath || null,
    stage: params.stage || null,
  };
}

/**
 * Resolve the target JSONL path for the given runId.
 * Active run → per-run file; otherwise fallback.
 *
 * @param {string|null} runId
 * @param {object}      [opts]
 * @param {string}      [opts.cwd=process.cwd()]
 * @returns {{ path: string, fallback: boolean }}
 */
export function resolveUsagePath(runId, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  if (runId) {
    return { path: join(cwd, RUNS_BASE, runId, 'model-usage.jsonl'), fallback: false };
  }
  return { path: join(cwd, FALLBACK_FILE), fallback: true };
}

/**
 * Append a usage record to the resolved JSONL path.
 *
 * Append-only: does NOT cap/trim the file. Use trimFallbackUsage() from an
 * offline context (SessionEnd, operator CLI) if the fallback file grows large.
 * Rationale: any in-band read-modify-write would race with concurrent
 * SubagentStop hooks and lose entries under parallel Task() spawns.
 *
 * @param {object} record  - Output of buildRecord()
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 */
export function appendUsage(record, opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    const { path: target } = resolveUsagePath(record.runId, { cwd });
    const dir = target.slice(0, target.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(target, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {
    /* fail-safe: losing a measurement entry must not disrupt subagent flow */
  }
}

/**
 * Convenience one-liner: build + append in a single call.
 *
 * @param {object} params - Same shape as buildRecord params
 * @param {object} [opts] - { cwd }
 */
export function logUsage(params, opts = {}) {
  appendUsage(buildRecord(params), opts);
}

/**
 * Trim the fallback usage file to the most-recent `maxLines` entries.
 * Must NOT be called from the SubagentStop hot path — use from SessionEnd or
 * operator CLI, where concurrent writers are absent.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {number} [opts.maxLines=1000]
 * @returns {{ trimmedFrom: number, trimmedTo: number }}  - Line counts pre/post
 */
export function trimFallbackUsage(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const maxLines = typeof opts.maxLines === 'number' && opts.maxLines > 0
    ? opts.maxLines : DEFAULT_TRIM_THRESHOLD;
  const target = join(cwd, FALLBACK_FILE);
  try {
    if (!existsSync(target)) return { trimmedFrom: 0, trimmedTo: 0 };
    const raw = readFileSync(target, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= maxLines) return { trimmedFrom: lines.length, trimmedTo: lines.length };
    const trimmed = lines.slice(-maxLines).join('\n') + '\n';
    writeFileSync(target, trimmed, { mode: 0o600 });
    return { trimmedFrom: lines.length, trimmedTo: maxLines };
  } catch {
    return { trimmedFrom: 0, trimmedTo: 0 };
  }
}

/**
 * Read all usage records from a JSONL file.
 *
 * Lines are skipped when:
 *   - JSON parse fails
 *   - schemaVersion is missing or greater than the current SCHEMA_VERSION
 *     (forward-compat: reader returns empty for unknown future format)
 *
 * @param {string} filePath
 * @returns {Array<object>}
 */
export function readUsageRecords(filePath) {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      // schemaVersion guard: refuse unknown future versions.
      const sv = typeof parsed?.schemaVersion === 'number' ? parsed.schemaVersion : 0;
      if (sv < 1 || sv > SCHEMA_VERSION) continue;
      out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Summarise usage records by (agentType, model) pair.
 * Returns a sorted array (descending by callCount) suitable for quick
 * hotspot identification.
 *
 * @param {Array<object>} records - Output of readUsageRecords()
 * @returns {Array<{
 *   agentType: string|null,
 *   model: string|null,
 *   callCount: number,
 *   totalInputChars: number,
 *   totalOutputChars: number,
 *   payloadModelCount: number,
 *   defaultModelCount: number,
 * }>}
 */
export function summariseUsage(records) {
  const buckets = new Map();
  for (const r of records) {
    const key = `${r.agentType || '<unknown>'}__${r.model || '<null>'}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = {
        agentType: r.agentType || null,
        model: r.model || null,
        callCount: 0,
        totalInputChars: 0,
        totalOutputChars: 0,
        payloadModelCount: 0,
        defaultModelCount: 0,
      };
      buckets.set(key, entry);
    }
    entry.callCount += 1;
    entry.totalInputChars += typeof r.inputCharLength === 'number' ? r.inputCharLength : 0;
    entry.totalOutputChars += typeof r.outputCharLength === 'number' ? r.outputCharLength : 0;
    if (r.modelSource === 'payload') entry.payloadModelCount += 1;
    else if (r.modelSource === 'default') entry.defaultModelCount += 1;
  }
  return Array.from(buckets.values()).sort((a, b) => b.callCount - a.callCount);
}

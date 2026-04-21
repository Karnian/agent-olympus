/**
 * Stage Escalation — parse structured critic verdicts and decide whether
 * the caller should re-run the prior stage with more power (e.g. Sonnet
 * executor → Opus re-run on momus REJECT with insufficient evidence).
 *
 * Phase 3 scope (minimum viable): three critic agents only —
 *   - agent-olympus:momus           (plan validation)
 *   - agent-olympus:architect       (architecture review)
 *   - agent-olympus:code-reviewer   (code quality review)
 *
 * Each critic is expected to emit a fenced "STAGE_VERDICT" block in its
 * last_assistant_message. The block is optional — absence means "no
 * structured signal"; callers fall back to existing free-text VERDICT lines.
 *
 * Expected block shape (parsed leniently — fields may be missing):
 *
 *   ```stage_verdict
 *   stage: plan-validation         # or: architecture-review | code-review
 *   verdict: APPROVE|REVISE|REJECT
 *   confidence: high|medium|low    # optional
 *   escalate_to: opus|none         # optional — force re-run at higher tier
 *   reasons:
 *     - <bullet>
 *   evidence:
 *     - <path:line or excerpt>
 *   ```
 *
 * Fail-safe — parser returns null on any error; callers treat null as
 * "no structured signal, use legacy behaviour".
 *
 * Opt-in via .ao/autonomy.json:
 *   { "stageEscalation": { "enabled": true } }
 * (default: disabled — Phase 0 measurement first.)
 */

const SUPPORTED_CRITICS = new Set([
  'agent-olympus:momus',
  'agent-olympus:architect',
  'agent-olympus:code-reviewer',
]);

const VALID_VERDICTS = new Set(['APPROVE', 'REVISE', 'REJECT']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
const VALID_ESCALATE = new Set(['opus', 'none']);
const MAX_REASONS = 20;
const MAX_EVIDENCE = 20;
const MAX_BULLET_LENGTH = 500;

/**
 * Decide whether a given agent name is a supported critic.
 * @param {string} agentType
 * @returns {boolean}
 */
export function isCriticAgent(agentType) {
  return typeof agentType === 'string' && SUPPORTED_CRITICS.has(agentType);
}

/**
 * Resolve the autonomy opt-in flag. Default: false.
 * @param {object|null} autonomyConfig
 * @returns {boolean}
 */
export function isEscalationEnabled(autonomyConfig) {
  try {
    return autonomyConfig?.stageEscalation?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Locate a fenced stage_verdict block inside free-text output.
 * Accepts: ```stage_verdict ... ``` with any surrounding whitespace.
 * Case-insensitive on the language tag.
 *
 * @param {string} text
 * @returns {string|null} raw YAML-ish body, or null if no block found
 */
function extractBlock(text) {
  if (typeof text !== 'string' || !text) return null;
  // Try the canonical fenced form first (```stage_verdict or ```stage-verdict).
  // Tolerate missing newline after the tag (some models emit "```stage_verdict content").
  const primary = /```\s*stage[_-]verdict\b[^\n]*\n?([\s\S]*?)```/i;
  const mPrimary = text.match(primary);
  if (mPrimary) return mPrimary[1];

  // Gemini Phase 3 #1 — secondary: accept yaml/json-tagged blocks that
  // contain a `stage:` key at the top level (common drift pattern).
  const secondary = /```\s*(?:ya?ml|json)?\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = secondary.exec(text)) !== null) {
    const body = m[1];
    if (/^\s*stage\s*:/m.test(body) && /^\s*verdict\s*:/mi.test(body)) {
      return body;
    }
  }
  return null;
}

/**
 * Extract a single scalar field (key: value on its own line).
 * @param {string} body
 * @param {string} key
 * @returns {string|null} trimmed value, or null if absent
 */
function scalarField(body, key) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'mi');
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Extract a bullet list section.
 * Format:
 *   key:
 *     - bullet one
 *     - bullet two
 *
 * Terminates at the next top-level key or end-of-body.
 *
 * @param {string} body
 * @param {string} key
 * @returns {string[]} (possibly empty)
 */
function bulletListField(body, key) {
  const lines = body.split('\n');
  const startRe = new RegExp(`^(\\s*)${key}\\s*:\\s*$`, 'i');
  // Codex Phase 3 #4 — track indent levels so that an indented sibling
  // key (e.g. "  evidence:" listed at the same indent as bullets under
  // "reasons:") correctly terminates the current list.
  let startIndent = -1;
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(startRe);
    if (m) { startIndent = m[1].length; break; }
  }
  if (i >= lines.length) return [];
  i++;

  const bullets = [];
  const bulletRe = /^(\s*)-\s+(.*)$/;
  // Any non-bullet line with indent <= startIndent that looks like a key
  // ends the list. This catches both top-level keys AND sibling keys
  // written at the same indent (real drift pattern).
  const keyLineRe = /^(\s*)[A-Za-z_][A-Za-z0-9_]*\s*:/;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    const keyM = ln.match(keyLineRe);
    if (keyM) {
      const indent = keyM[1].length;
      // Terminate when we see a key line at <= the start indent level.
      if (indent <= startIndent) break;
    }
    const m = ln.match(bulletRe);
    if (m) {
      // Bullet must be indented deeper than the key header to belong to it.
      const bulletIndent = m[1].length;
      if (bulletIndent <= startIndent) break;
      const b = m[2].trim().slice(0, MAX_BULLET_LENGTH);
      if (b) bullets.push(b);
      if (bullets.length >= Math.max(MAX_REASONS, MAX_EVIDENCE)) break;
    }
  }
  return bullets;
}

/**
 * Parse a critic's last_assistant_message into a structured verdict object.
 *
 * Return shape (null on parse failure):
 *   {
 *     stage: string|null,
 *     verdict: 'APPROVE'|'REVISE'|'REJECT'|null,
 *     confidence: 'high'|'medium'|'low'|null,
 *     escalateTo: 'opus'|'none'|null,
 *     reasons: string[],
 *     evidence: string[],
 *     raw: string,  // the captured block body (for diagnostics)
 *   }
 *
 * @param {string} lastMessage
 * @returns {object|null}
 */
export function parseStageVerdict(lastMessage) {
  try {
    const body = extractBlock(lastMessage);
    if (!body) return null;

    const verdictRaw = scalarField(body, 'verdict');
    const verdict = verdictRaw && VALID_VERDICTS.has(verdictRaw.toUpperCase())
      ? verdictRaw.toUpperCase() : null;

    const confRaw = scalarField(body, 'confidence');
    const confidence = confRaw && VALID_CONFIDENCE.has(confRaw.toLowerCase())
      ? confRaw.toLowerCase() : null;

    const escRaw = scalarField(body, 'escalate_to');
    const escalateTo = escRaw && VALID_ESCALATE.has(escRaw.toLowerCase())
      ? escRaw.toLowerCase() : null;

    const reasons = bulletListField(body, 'reasons').slice(0, MAX_REASONS);
    const evidence = bulletListField(body, 'evidence').slice(0, MAX_EVIDENCE);

    return {
      stage: scalarField(body, 'stage'),
      verdict,
      confidence,
      escalateTo,
      reasons,
      evidence,
      raw: body,
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether the caller should re-run the prior stage at a higher
 * model tier (Sonnet → Opus).
 *
 * Policy (conservative — prefers false negatives over false positives):
 *   - Explicit escalate_to=opus from the critic → YES
 *   - verdict=REJECT + confidence=high → YES (strong signal)
 *   - verdict=REJECT + confidence=medium + reasons.length >= 2 → YES
 *   - Everything else → NO (let existing retry paths handle it)
 *
 * Dedup: callers pass `alreadyEscalated` to avoid re-re-escalating the
 * same prior stage.
 *
 * @param {object} parsed - Output of parseStageVerdict (may be null)
 * @param {object} [opts]
 * @param {boolean} [opts.alreadyEscalated=false]
 * @returns {{ escalate: boolean, reason: string, parsed: object|null }}
 */
export function shouldEscalate(parsed, opts = {}) {
  if (!parsed) return { escalate: false, reason: 'no structured verdict', parsed: null };
  if (opts.alreadyEscalated) return { escalate: false, reason: 'already escalated this stage', parsed };

  // Policy fix (Codex Phase 3 #5): APPROVE verdict NEVER escalates, even
  // when the critic requested escalate_to=opus. An approval by definition
  // means "no rework needed", so re-running the prior stage is wasteful.
  if (parsed.verdict === 'APPROVE') {
    return { escalate: false, reason: 'APPROVE verdict — no escalation regardless of escalate_to', parsed };
  }

  // Explicit escalate_to=opus wins only when verdict is REVISE or REJECT.
  if (parsed.escalateTo === 'opus' &&
      (parsed.verdict === 'REVISE' || parsed.verdict === 'REJECT')) {
    return { escalate: true, reason: 'critic requested escalate_to=opus with non-APPROVE verdict', parsed };
  }

  if (parsed.verdict === 'REJECT') {
    if (parsed.confidence === 'high') {
      return { escalate: true, reason: 'REJECT verdict with high confidence', parsed };
    }
    // Codex Phase 3 #1 — tighten medium-confidence threshold:
    //   require >=3 reasons AND >=1 piece of evidence, to avoid Opus
    //   escalation on "two common nitpicks".
    if (parsed.confidence === 'medium' &&
        Array.isArray(parsed.reasons) && parsed.reasons.length >= 3 &&
        Array.isArray(parsed.evidence) && parsed.evidence.length >= 1) {
      return { escalate: true, reason: 'REJECT verdict with medium confidence, 3+ reasons and evidence', parsed };
    }
  }
  return { escalate: false, reason: 'verdict below escalation threshold', parsed };
}

/**
 * Build a markdown prompt fragment describing the escalation request, to
 * be appended to the retried Opus call so the agent knows *why* it's
 * being re-spawned.
 *
 * @param {object} decision - Output of shouldEscalate
 * @returns {string}
 */
export function formatEscalationPrompt(decision) {
  try {
    if (!decision || !decision.escalate || !decision.parsed) return '';
    const p = decision.parsed;
    const lines = [];
    lines.push('');
    lines.push('## Escalation context (previous stage critic escalated to Opus)');
    if (p.stage) lines.push(`- Prior stage: ${p.stage}`);
    if (p.verdict) lines.push(`- Prior verdict: ${p.verdict}`);
    if (p.confidence) lines.push(`- Critic confidence: ${p.confidence}`);
    if (decision.reason) lines.push(`- Escalation reason: ${decision.reason}`);
    if (Array.isArray(p.reasons) && p.reasons.length > 0) {
      lines.push('- Critic reasons:');
      for (const r of p.reasons) lines.push(`  - ${r}`);
    }
    if (Array.isArray(p.evidence) && p.evidence.length > 0) {
      lines.push('- Evidence cited:');
      for (const e of p.evidence) lines.push(`  - ${e}`);
    }
    lines.push('');
    lines.push('Address each reason above. Do not repeat the previous attempt verbatim.');
    lines.push('');
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Full end-to-end helper — parse + decide. Used by callers that only
 * need the final decision and don't need the intermediate parsed object.
 *
 * @param {string} lastMessage
 * @param {object} [opts] - Passed through to shouldEscalate
 * @returns {{ escalate: boolean, reason: string, parsed: object|null }}
 */
export function evaluateLastMessage(lastMessage, opts = {}) {
  const parsed = parseStageVerdict(lastMessage);
  return shouldEscalate(parsed, opts);
}

// ───────────────────────────────────────────────────────────────────────────
// Per-run escalation counter — persisted alongside run-artifacts so
// Atlas/Athena loops can detect runaway escalation (Gemini Phase 3 #4).
//
// Caller contract:
//   registerEscalation(runId, stage, { cwd, cap=2 })
//     → { allowed: boolean, count: number, cap: number }
//   Call BEFORE re-spawning the prior stage at opus tier. If allowed=false,
//   the caller must NOT re-spawn (cap hit → block to prevent infinite loop).
//
// File: .ao/artifacts/runs/<runId>/escalation-log.json
//   { "<stage>": { "count": N, "firstAt": ISO, "lastAt": ISO } }
// ───────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ESCALATION_CAP = 2;
const LOG_FILE_NAME = 'escalation-log.json';

function escalationLogPath(runId, cwd) {
  return join(cwd, '.ao', 'artifacts', 'runs', runId, LOG_FILE_NAME);
}

function readEscalationLog(path) {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function writeEscalationLog(path, data) {
  try {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    /* fail-safe */
  }
}

/**
 * Register an escalation attempt for (runId, stage). Returns whether the
 * caller should proceed. When `count >= cap`, allowed=false and the caller
 * must abort the re-spawn to avoid infinite loops between semantic and
 * technical retries.
 *
 * @param {string} runId
 * @param {string} stage - e.g. "plan-validation" | "architecture-review" | "code-review"
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {number} [opts.cap=2]
 * @returns {{ allowed: boolean, count: number, cap: number }}
 */
export function registerEscalation(runId, stage, opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    const cap = typeof opts.cap === 'number' && opts.cap > 0 ? opts.cap : DEFAULT_ESCALATION_CAP;
    if (!runId || !stage) return { allowed: false, count: 0, cap };

    const path = escalationLogPath(runId, cwd);
    const log = readEscalationLog(path);
    const existing = log[stage] || { count: 0, firstAt: null, lastAt: null };
    const nowIso = new Date().toISOString();

    if (existing.count >= cap) {
      return { allowed: false, count: existing.count, cap };
    }

    const updated = {
      count: existing.count + 1,
      firstAt: existing.firstAt || nowIso,
      lastAt: nowIso,
    };
    log[stage] = updated;
    writeEscalationLog(path, log);
    return { allowed: true, count: updated.count, cap };
  } catch {
    return { allowed: false, count: 0, cap: DEFAULT_ESCALATION_CAP };
  }
}

/**
 * Look up how many times a given stage has already escalated in this run.
 * Use this to populate the `alreadyEscalated` flag on shouldEscalate.
 *
 * @param {string} runId
 * @param {string} stage
 * @param {object} [opts]
 * @returns {{ count: number, cap: number }}
 */
export function getEscalationCount(runId, stage, opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    const cap = typeof opts.cap === 'number' && opts.cap > 0 ? opts.cap : DEFAULT_ESCALATION_CAP;
    if (!runId || !stage) return { count: 0, cap };
    const log = readEscalationLog(escalationLogPath(runId, cwd));
    return { count: (log[stage]?.count || 0), cap };
  } catch {
    return { count: 0, cap: DEFAULT_ESCALATION_CAP };
  }
}

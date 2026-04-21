/**
 * Unit tests for scripts/lib/stage-escalation.mjs
 * Covers:
 *   - isCriticAgent() whitelist
 *   - isEscalationEnabled() autonomy parsing
 *   - parseStageVerdict() block extraction, field parsing, malformed input
 *   - shouldEscalate() policy (explicit, REJECT+high, REJECT+med+2reasons)
 *   - formatEscalationPrompt() output shape
 *   - evaluateLastMessage() end-to-end
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isCriticAgent,
  isEscalationEnabled,
  parseStageVerdict,
  shouldEscalate,
  formatEscalationPrompt,
  evaluateLastMessage,
  registerEscalation,
  getEscalationCount,
} from '../lib/stage-escalation.mjs';

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ao-stage-esc-test-'));
}
async function removeTmpDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// isCriticAgent
// ---------------------------------------------------------------------------

describe('isCriticAgent', () => {
  test('momus is a critic', () => {
    assert.equal(isCriticAgent('agent-olympus:momus'), true);
  });
  test('architect is a critic', () => {
    assert.equal(isCriticAgent('agent-olympus:architect'), true);
  });
  test('code-reviewer is a critic', () => {
    assert.equal(isCriticAgent('agent-olympus:code-reviewer'), true);
  });
  test('executor is not a critic', () => {
    assert.equal(isCriticAgent('agent-olympus:executor'), false);
  });
  test('null / non-string / missing → false', () => {
    assert.equal(isCriticAgent(null), false);
    assert.equal(isCriticAgent(''), false);
    assert.equal(isCriticAgent(undefined), false);
    assert.equal(isCriticAgent(42), false);
  });
  test('unknown prefix is not a critic', () => {
    assert.equal(isCriticAgent('oh-my-claude:momus'), false);
  });
});

// ---------------------------------------------------------------------------
// isEscalationEnabled
// ---------------------------------------------------------------------------

describe('isEscalationEnabled', () => {
  test('default (no config) → false', () => {
    assert.equal(isEscalationEnabled(null), false);
    assert.equal(isEscalationEnabled({}), false);
  });
  test('explicit enabled:true → true', () => {
    assert.equal(isEscalationEnabled({ stageEscalation: { enabled: true } }), true);
  });
  test('enabled:false → false', () => {
    assert.equal(isEscalationEnabled({ stageEscalation: { enabled: false } }), false);
  });
  test('non-boolean enabled → false (fail-safe)', () => {
    assert.equal(isEscalationEnabled({ stageEscalation: { enabled: 'yes' } }), false);
  });
});

// ---------------------------------------------------------------------------
// parseStageVerdict — extraction & field parsing
// ---------------------------------------------------------------------------

describe('parseStageVerdict', () => {
  test('no block in message → null', () => {
    assert.equal(parseStageVerdict('just free text, no block'), null);
  });

  test('empty/null input → null', () => {
    assert.equal(parseStageVerdict(''), null);
    assert.equal(parseStageVerdict(null), null);
    assert.equal(parseStageVerdict(undefined), null);
  });

  test('minimal block with verdict only', () => {
    const msg = [
      'Free-text review goes here.',
      '',
      '```stage_verdict',
      'stage: plan-validation',
      'verdict: APPROVE',
      '```',
    ].join('\n');
    const p = parseStageVerdict(msg);
    assert.ok(p);
    assert.equal(p.stage, 'plan-validation');
    assert.equal(p.verdict, 'APPROVE');
    assert.equal(p.confidence, null);
    assert.equal(p.escalateTo, null);
    assert.deepEqual(p.reasons, []);
    assert.deepEqual(p.evidence, []);
  });

  test('full block with all fields', () => {
    const msg = [
      '```stage_verdict',
      'stage: architecture-review',
      'verdict: REJECT',
      'confidence: high',
      'escalate_to: opus',
      'reasons:',
      '  - Circular dependency introduced',
      '  - Leaky abstraction in service layer',
      'evidence:',
      '  - src/a.ts:42',
      '  - src/b.ts:100-115',
      '```',
    ].join('\n');
    const p = parseStageVerdict(msg);
    assert.ok(p);
    assert.equal(p.stage, 'architecture-review');
    assert.equal(p.verdict, 'REJECT');
    assert.equal(p.confidence, 'high');
    assert.equal(p.escalateTo, 'opus');
    assert.deepEqual(p.reasons, [
      'Circular dependency introduced',
      'Leaky abstraction in service layer',
    ]);
    assert.deepEqual(p.evidence, ['src/a.ts:42', 'src/b.ts:100-115']);
  });

  test('invalid verdict value → verdict=null', () => {
    const msg = '```stage_verdict\nverdict: maybe\n```';
    const p = parseStageVerdict(msg);
    assert.equal(p.verdict, null);
  });

  test('invalid confidence value → confidence=null', () => {
    const msg = '```stage_verdict\nverdict: APPROVE\nconfidence: kinda\n```';
    const p = parseStageVerdict(msg);
    assert.equal(p.confidence, null);
  });

  test('invalid escalate_to value → escalateTo=null', () => {
    const msg = '```stage_verdict\nverdict: REJECT\nescalate_to: gpt5\n```';
    const p = parseStageVerdict(msg);
    assert.equal(p.escalateTo, null);
  });

  test('case-insensitive language tag', () => {
    const msg = '```Stage_Verdict\nverdict: APPROVE\n```';
    const p = parseStageVerdict(msg);
    assert.ok(p);
    assert.equal(p.verdict, 'APPROVE');
  });

  test('stops at closing fence even if body has backticks inside text', () => {
    const msg = [
      '```stage_verdict',
      'verdict: REVISE',
      'reasons:',
      '  - Watch out for `inline code` ticks',
      '```',
      '',
      'Extra prose below block.',
    ].join('\n');
    const p = parseStageVerdict(msg);
    assert.ok(p);
    assert.equal(p.verdict, 'REVISE');
    assert.equal(p.reasons.length, 1);
  });

  test('verdict lowercase is uppercased', () => {
    const msg = '```stage_verdict\nverdict: reject\n```';
    const p = parseStageVerdict(msg);
    assert.equal(p.verdict, 'REJECT');
  });

  test('bullet list terminates at next top-level key', () => {
    const msg = [
      '```stage_verdict',
      'verdict: REJECT',
      'reasons:',
      '  - One',
      '  - Two',
      'confidence: high',
      '```',
    ].join('\n');
    const p = parseStageVerdict(msg);
    assert.deepEqual(p.reasons, ['One', 'Two']);
    assert.equal(p.confidence, 'high');
  });

  test('excessive bullets are capped at MAX', () => {
    const bullets = Array.from({ length: 50 }, (_, i) => `  - bullet ${i}`).join('\n');
    const msg = ['```stage_verdict', 'verdict: REVISE', 'reasons:', bullets, '```'].join('\n');
    const p = parseStageVerdict(msg);
    assert.ok(p.reasons.length <= 20);
  });

  test('very long bullet is truncated', () => {
    const huge = 'x'.repeat(1000);
    const msg = `\`\`\`stage_verdict\nverdict: REVISE\nreasons:\n  - ${huge}\n\`\`\``;
    const p = parseStageVerdict(msg);
    assert.ok(p.reasons[0].length <= 500);
  });
});

// ---------------------------------------------------------------------------
// shouldEscalate policy
// ---------------------------------------------------------------------------

describe('shouldEscalate', () => {
  test('null parsed → no escalate', () => {
    const d = shouldEscalate(null);
    assert.equal(d.escalate, false);
    assert.match(d.reason, /no structured verdict/);
  });

  test('explicit escalate_to=opus with REVISE verdict → yes', () => {
    // Policy (Codex Phase 3 #5): escalate_to=opus is honoured only when
    // the verdict is NOT APPROVE. An APPROVE + opus request is treated as
    // contradictory and ignored (see separate test below).
    const d = shouldEscalate({ escalateTo: 'opus', verdict: 'REVISE', reasons: [] });
    assert.equal(d.escalate, true);
    assert.match(d.reason, /escalate_to=opus/);
  });

  test('REJECT + high confidence → yes', () => {
    const d = shouldEscalate({ verdict: 'REJECT', confidence: 'high', reasons: ['a'] });
    assert.equal(d.escalate, true);
    assert.match(d.reason, /high confidence/);
  });

  // Codex Phase 3 #1 — medium-confidence now requires ≥3 reasons AND ≥1 evidence.
  test('REJECT + medium + 3 reasons + 1 evidence → yes', () => {
    const d = shouldEscalate({
      verdict: 'REJECT', confidence: 'medium',
      reasons: ['a', 'b', 'c'],
      evidence: ['src/foo.ts:10'],
    });
    assert.equal(d.escalate, true);
  });

  test('REJECT + medium + 2 reasons (tightened threshold) → no', () => {
    const d = shouldEscalate({
      verdict: 'REJECT', confidence: 'medium',
      reasons: ['a', 'b'], evidence: ['x'],
    });
    assert.equal(d.escalate, false);
  });

  test('REJECT + medium + 3 reasons + NO evidence → no', () => {
    const d = shouldEscalate({
      verdict: 'REJECT', confidence: 'medium',
      reasons: ['a', 'b', 'c'], evidence: [],
    });
    assert.equal(d.escalate, false);
  });

  test('REJECT + medium + 1 reason → no', () => {
    const d = shouldEscalate({ verdict: 'REJECT', confidence: 'medium', reasons: ['a'] });
    assert.equal(d.escalate, false);
  });

  test('REJECT + low → no', () => {
    const d = shouldEscalate({ verdict: 'REJECT', confidence: 'low', reasons: ['a', 'b'] });
    assert.equal(d.escalate, false);
  });

  test('REVISE never escalates by policy (without explicit flag)', () => {
    const d = shouldEscalate({ verdict: 'REVISE', confidence: 'high', reasons: ['a', 'b'] });
    assert.equal(d.escalate, false);
  });

  test('APPROVE never escalates', () => {
    const d = shouldEscalate({ verdict: 'APPROVE', confidence: 'high' });
    assert.equal(d.escalate, false);
  });

  // Codex Phase 3 #5 — APPROVE + explicit escalate_to=opus must NOT escalate.
  test('APPROVE + escalate_to=opus → no (policy fix)', () => {
    const d = shouldEscalate({ verdict: 'APPROVE', escalateTo: 'opus' });
    assert.equal(d.escalate, false);
    assert.match(d.reason, /APPROVE/);
  });

  test('REVISE + escalate_to=opus → yes (honours critic when verdict is not approval)', () => {
    const d = shouldEscalate({ verdict: 'REVISE', escalateTo: 'opus' });
    assert.equal(d.escalate, true);
  });

  test('REJECT + escalate_to=opus → yes', () => {
    const d = shouldEscalate({ verdict: 'REJECT', escalateTo: 'opus' });
    assert.equal(d.escalate, true);
  });

  test('dedup: alreadyEscalated=true suppresses', () => {
    const d = shouldEscalate({ verdict: 'REJECT', confidence: 'high', reasons: ['a'] },
                             { alreadyEscalated: true });
    assert.equal(d.escalate, false);
    assert.match(d.reason, /already escalated/);
  });
});

// ---------------------------------------------------------------------------
// formatEscalationPrompt
// ---------------------------------------------------------------------------

describe('formatEscalationPrompt', () => {
  test('no decision → empty string', () => {
    assert.equal(formatEscalationPrompt(null), '');
    assert.equal(formatEscalationPrompt({ escalate: false }), '');
  });

  test('escalate=true renders full context', () => {
    const out = formatEscalationPrompt({
      escalate: true,
      reason: 'REJECT verdict with high confidence',
      parsed: {
        stage: 'plan-validation',
        verdict: 'REJECT',
        confidence: 'high',
        reasons: ['Missing file paths', 'No acceptance criteria'],
        evidence: ['prd.json:12'],
      },
    });
    assert.match(out, /Escalation context/);
    assert.match(out, /Prior stage: plan-validation/);
    assert.match(out, /Prior verdict: REJECT/);
    assert.match(out, /Missing file paths/);
    assert.match(out, /prd\.json:12/);
    assert.match(out, /Address each reason/);
  });
});

// ---------------------------------------------------------------------------
// evaluateLastMessage
// ---------------------------------------------------------------------------

describe('evaluateLastMessage', () => {
  test('free-text only → no escalate', () => {
    const d = evaluateLastMessage('just a review, no block');
    assert.equal(d.escalate, false);
  });

  test('REJECT + high + reasons → escalate', () => {
    const msg = [
      '```stage_verdict',
      'verdict: REJECT',
      'confidence: high',
      'reasons:',
      '  - missing edge cases',
      '```',
    ].join('\n');
    const d = evaluateLastMessage(msg);
    assert.equal(d.escalate, true);
  });

  test('APPROVE + escalate_to=opus → NO escalate (policy fix: APPROVE dominates)', () => {
    const msg = [
      '```stage_verdict',
      'verdict: APPROVE',
      'escalate_to: opus',
      '```',
    ].join('\n');
    const d = evaluateLastMessage(msg);
    assert.equal(d.escalate, false);
  });

  test('alreadyEscalated dedup flows through', () => {
    const msg = [
      '```stage_verdict',
      'verdict: REJECT',
      'confidence: high',
      'reasons:',
      '  - x',
      '```',
    ].join('\n');
    const d = evaluateLastMessage(msg, { alreadyEscalated: true });
    assert.equal(d.escalate, false);
  });
});

// ---------------------------------------------------------------------------
// bulletListField indent handling (Codex Phase 3 #4)
// ---------------------------------------------------------------------------

describe('parseStageVerdict — indent hygiene', () => {
  test('sibling "evidence:" at same indent terminates "reasons:" bullets', () => {
    const msg = [
      '```stage_verdict',
      'verdict: REJECT',
      'reasons:',
      '  - reason one',
      '  - reason two',
      'evidence:',
      '  - evi one',
      '  - evi two',
      '```',
    ].join('\n');
    const p = parseStageVerdict(msg);
    assert.deepEqual(p.reasons, ['reason one', 'reason two']);
    assert.deepEqual(p.evidence, ['evi one', 'evi two']);
  });

  test('bullet at header indent (not deeper) terminates the list', () => {
    const msg = [
      '```stage_verdict',
      '  reasons:',
      '  - at same indent as header — terminates list',
      '  next_key: foo',
      '```',
    ].join('\n');
    const p = parseStageVerdict(msg);
    // Header at indent 2; a bullet at same indent is NOT deeper, so the
    // list has zero accepted bullets. Parser bails.
    assert.deepEqual(p.reasons, []);
  });
});

// ---------------------------------------------------------------------------
// yaml/json-tagged block fallback (Gemini Phase 3 #1)
// ---------------------------------------------------------------------------

describe('parseStageVerdict — yaml/json tag fallback', () => {
  test('```yaml block with stage+verdict keys is accepted', () => {
    const msg = [
      '```yaml',
      'stage: plan-validation',
      'verdict: REJECT',
      'confidence: high',
      '```',
    ].join('\n');
    const p = parseStageVerdict(msg);
    assert.ok(p);
    assert.equal(p.verdict, 'REJECT');
    assert.equal(p.stage, 'plan-validation');
  });

  test('unrelated ```yaml block (no stage key) is ignored', () => {
    const msg = [
      '```yaml',
      'foo: bar',
      'baz: qux',
      '```',
    ].join('\n');
    assert.equal(parseStageVerdict(msg), null);
  });

  test('```json with stage+verdict keys is accepted', () => {
    const msg = [
      '```json',
      '',
      'stage: code-review',
      'verdict: APPROVE',
      '',
      '```',
    ].join('\n');
    const p = parseStageVerdict(msg);
    assert.ok(p);
    assert.equal(p.verdict, 'APPROVE');
  });
});

// ---------------------------------------------------------------------------
// Per-run escalation counter (Gemini Phase 3 #4)
// ---------------------------------------------------------------------------

describe('registerEscalation + getEscalationCount', () => {
  test('fresh run: first call allowed=true count=1', async () => {
    const cwd = await makeTmpDir();
    try {
      const r = registerEscalation('run-abc', 'plan-validation', { cwd, cap: 2 });
      assert.equal(r.allowed, true);
      assert.equal(r.count, 1);
      assert.equal(r.cap, 2);
    } finally { await removeTmpDir(cwd); }
  });

  test('second call increments; third call blocked at cap=2', async () => {
    const cwd = await makeTmpDir();
    try {
      registerEscalation('run-xyz', 's1', { cwd, cap: 2 });
      const second = registerEscalation('run-xyz', 's1', { cwd, cap: 2 });
      const third = registerEscalation('run-xyz', 's1', { cwd, cap: 2 });
      assert.equal(second.allowed, true);
      assert.equal(second.count, 2);
      assert.equal(third.allowed, false);
      assert.equal(third.count, 2);
    } finally { await removeTmpDir(cwd); }
  });

  test('different stages tracked independently', async () => {
    const cwd = await makeTmpDir();
    try {
      registerEscalation('run-1', 'stage-a', { cwd, cap: 2 });
      registerEscalation('run-1', 'stage-a', { cwd, cap: 2 });
      const blocked = registerEscalation('run-1', 'stage-a', { cwd, cap: 2 });
      const freshStage = registerEscalation('run-1', 'stage-b', { cwd, cap: 2 });
      assert.equal(blocked.allowed, false);
      assert.equal(freshStage.allowed, true);
      assert.equal(freshStage.count, 1);
    } finally { await removeTmpDir(cwd); }
  });

  test('getEscalationCount reports current count without incrementing', async () => {
    const cwd = await makeTmpDir();
    try {
      registerEscalation('run-q', 'plan', { cwd, cap: 3 });
      registerEscalation('run-q', 'plan', { cwd, cap: 3 });
      const q1 = getEscalationCount('run-q', 'plan', { cwd });
      const q2 = getEscalationCount('run-q', 'plan', { cwd });
      assert.equal(q1.count, 2);
      assert.equal(q2.count, 2);  // did NOT mutate
    } finally { await removeTmpDir(cwd); }
  });

  test('missing runId or stage → allowed=false', () => {
    const r1 = registerEscalation('', 'plan', { cwd: '/tmp' });
    const r2 = registerEscalation('run', '', { cwd: '/tmp' });
    assert.equal(r1.allowed, false);
    assert.equal(r2.allowed, false);
  });

  test('persisted log file has expected shape', async () => {
    const cwd = await makeTmpDir();
    try {
      registerEscalation('run-shape', 'plan', { cwd, cap: 5 });
      const logPath = path.join(cwd, '.ao', 'artifacts', 'runs', 'run-shape', 'escalation-log.json');
      assert.ok(existsSync(logPath));
      const parsed = JSON.parse(readFileSync(logPath, 'utf-8'));
      assert.equal(parsed.plan.count, 1);
      assert.ok(typeof parsed.plan.firstAt === 'string');
      assert.ok(typeof parsed.plan.lastAt === 'string');
    } finally { await removeTmpDir(cwd); }
  });
});

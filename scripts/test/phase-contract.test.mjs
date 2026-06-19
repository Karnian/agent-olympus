/**
 * Phase-contract linter — structural regression net for the HU-06.2/.3 SKILL.md
 * rewrites onto the phase-runner.
 *
 * A string-anchor check proves text survived; it does NOT prove behavior. So this
 * linter asserts the RUNNER GRAPH + the explicit `AO-CONTRACT:<key>` markers that
 * tag each load-bearing behavior the rewrite must preserve. It is deliberately
 * RED until the rewrite lands (TDD): it defines the target the rewrite closes.
 * Claude's content review + a fresh `claude -p` smoke cover what a linter cannot.
 *
 * HU-06.2 = atlas (this file). HU-06.3 will extend it with the athena block.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPhaseSequence } from '../lib/phase-runner.mjs';

function readSkill(rel) {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf-8');
}

// Whitespace/quote/arg-name tolerant call matchers.
function callsPhaseFn(text, fn, phaseId) {
  return new RegExp(`${fn}\\(\\s*[A-Za-z0-9_.]+\\s*,\\s*['"]${phaseId}['"]`).test(text);
}
function callsLoopTick(text, key) {
  return new RegExp(`loopTick\\([^)]*['"]${key}['"]`).test(text);
}

// loop-guard functions that the rewrite must NOT call directly (the runner is the
// sole caller). registerEscalation is intentionally excluded — it lives in
// stage-escalation.mjs and owns the light-mode-rewind cap, a separate concern.
const FORBIDDEN_LOOPGUARD_CALLS = [
  /\bregisterIteration\s*\(/,
  /\bregisterReviewRound\s*\(/,
  /\bregisterCounter\s*\(/,
  /\brecordError\s*\(/,
];
const LOOPGUARD_IMPORT = /from\s+['"][^'"]*loop-guard\.mjs['"]/;

const ATLAS_MARKERS = [
  'runner-init', 'outer-attempt', 'review-reject-reattempt', 'quality-fail',
  'light-mode-resolution', 'light-mode-rewind', 'false-trivial-guard', 'trivial-prd',
  'explore-before-metis', 'subagent-validation', 'spec-gate', 'consensus-plan',
  'cross-validation', 'debug-escalation', 'review-router', 'review-escalation',
  'verification-gate', 'ci-watch', 'cleanup',
];

describe('atlas SKILL.md phase-runner contract', () => {
  const skill = readSkill('skills/atlas/SKILL.md');
  const phaseIds = getPhaseSequence('atlas').map(p => p.id);

  test('imports the phase-runner (and the runner is the loop-guard owner)', () => {
    assert.match(skill, /from\s+['"][^'"]*phase-runner\.mjs['"]/, 'must import phase-runner.mjs');
  });

  test('every atlas phase has enterPhase + completePhase wiring', () => {
    for (const id of phaseIds) {
      assert.ok(callsPhaseFn(skill, 'enterPhase', id), `missing enterPhase('${id}')`);
      assert.ok(callsPhaseFn(skill, 'completePhase', id), `missing completePhase('${id}')`);
    }
  });

  test('outer attempt loop uses beginAttempt + reattempt (the 15-cap chokepoint)', () => {
    assert.match(skill, /beginAttempt\(/, 'missing beginAttempt(');
    assert.match(skill, /reattempt\(/, 'missing reattempt(');
  });

  test('loop phases tick the right bounded counters', () => {
    assert.ok(callsLoopTick(skill, 'review'), "missing loopTick(_,'review')");
    assert.ok(callsLoopTick(skill, 'quality'), "missing loopTick(_,'quality')");
    assert.ok(callsLoopTick(skill, 'ci'), "missing loopTick(_,'ci')");
  });

  test('verify fix loop records errors through the runner', () => {
    assert.match(skill, /recordPhaseError\(/, 'missing recordPhaseError(');
  });

  test('light-mode rewind goes through reopenPhase, keeping its own escalation cap', () => {
    assert.match(skill, /reopenPhase\([^)]*light_mode_rewind/, "missing reopenPhase('plan',{reason:'light_mode_rewind'})");
    assert.match(skill, /registerEscalation\([^)]*light-mode-rewind/, 'must KEEP registerEscalation light-mode-rewind cap (not loop-guard)');
  });

  test('NO direct loop-guard imports or calls remain', () => {
    assert.doesNotMatch(skill, LOOPGUARD_IMPORT, 'must not import loop-guard.mjs directly');
    for (const re of FORBIDDEN_LOOPGUARD_CALLS) {
      assert.doesNotMatch(skill, re, `direct loop-guard call must be replaced by a runner call: ${re}`);
    }
  });

  test('the 7 numeric saveCheckpoint phase calls are gone (completePhase checkpoints instead)', () => {
    assert.doesNotMatch(skill, /saveCheckpoint\(\s*['"]atlas['"]\s*,\s*\{\s*phase:\s*\d/, 'numeric saveCheckpoint({phase:N}) must be replaced by completePhase');
  });

  test('every AO-CONTRACT behavior marker is present', () => {
    for (const key of ATLAS_MARKERS) {
      assert.ok(skill.includes(`AO-CONTRACT:${key}`), `missing AO-CONTRACT:${key}`);
    }
  });

  // Codex review (HU-06.2) caught these wiring pitfalls; assert the fixes survive future edits.
  test('outer-attempt first-pass guard is a CONCRETE predicate (not a placeholder), preventing double-tick', () => {
    // Must test the ledger's attempt counter, not a prose comment, so a reattempt re-entry
    // (attempt>0) deterministically skips beginAttempt. (Codex HU-06.2 re-review finding.)
    assert.match(skill, /getPipelineState\(runId\)\.attempt\s*===\s*0/,
      'beginAttempt must be guarded by getPipelineState(runId).attempt === 0 (concrete first-pass test)');
    assert.match(skill, /beginAttempt\(/, 'beginAttempt must still be called');
  });

  test('light-mode rewind checks the escalation cap BEFORE reopening, on every path', () => {
    assert.match(skill, /registerEscalation\([^)]*light-mode-rewind/, 'must keep registerEscalation light-mode-rewind');
    assert.match(skill, /esc\.allowed/, 'must check registerEscalation(...).allowed before reopenPhase');
    // The Phase-2 retroactive re-entry must reuse the cap-checked block, not call reopenPhase unguarded.
    assert.match(skill, /same\s+cap-checked\s+rewind\s+block/i,
      'the retroactive re-entry must reference the cap-checked rewind block (no unguarded reopenPhase)');
  });

  test('quality-fail explicitly flips failed stories passes:false (else execute no-ops)', () => {
    assert.match(skill, /setStoriesPassesFalse|quality-failed stories passes:false/,
      'quality-fail must mark the failed stories passes:false as an explicit step');
  });

  test('dynamic ship/ci skips use skipPhase, not enterPhase().skip', () => {
    assert.match(skill, /skipPhase\(runId, 'ship'/, "ship's not-applicable path must call skipPhase('ship')");
    assert.match(skill, /skipPhase\(runId, 'ci'/, "ci's not-applicable path must call skipPhase('ci')");
  });
});

describe('agents/atlas.md references the runner chokepoint, not loop-guard', () => {
  const agent = readSkill('agents/atlas.md');

  test('points at the phase-runner / its chokepoints', () => {
    assert.ok(
      /phase-runner|beginAttempt|loopTick|recordPhaseError/.test(agent),
      'agents/atlas.md must reference the runner chokepoints',
    );
  });

  test('no direct loop-guard import or call', () => {
    assert.doesNotMatch(agent, LOOPGUARD_IMPORT, 'must not import loop-guard.mjs');
    for (const re of FORBIDDEN_LOOPGUARD_CALLS) {
      assert.doesNotMatch(agent, re, `direct loop-guard call must be replaced: ${re}`);
    }
  });
});

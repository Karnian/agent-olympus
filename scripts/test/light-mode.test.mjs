/**
 * Unit tests for scripts/lib/light-mode.mjs
 * Covers:
 *   - resolveMode() precedence: CLI > autonomy > default
 *   - detectRiskyKeywords() case-insensitive whole-word matching
 *   - buildConfirmMessage() output shape + risk warning
 *   - stageFilter() full vs light skip set
 *   - autoEscalateOnReject() safety net
 *   - logLightModeEvent() fails silently on wisdom failure
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RISKY_KEYWORDS,
  resolveMode,
  isInteractiveStdin,
  isCIEnvironment,
  detectRiskyKeywords,
  buildConfirmMessage,
  stageFilter,
  autoEscalateOnReject,
  logLightModeEvent,
} from '../lib/light-mode.mjs';

// ---------------------------------------------------------------------------
// RISKY_KEYWORDS sanity
// ---------------------------------------------------------------------------

test('RISKY_KEYWORDS includes core high-risk domains', () => {
  const required = ['auth', 'security', 'migration', 'billing', 'crypto',
                    'schema', 'concurrency', 'payments', 'pii', 'distributed'];
  for (const kw of required) {
    assert.ok(RISKY_KEYWORDS.includes(kw), `RISKY_KEYWORDS should contain "${kw}"`);
  }
});

test('RISKY_KEYWORDS has at least 16 entries (Phase 4 spec)', () => {
  assert.ok(RISKY_KEYWORDS.length >= 16, `expected ≥16 keywords, got ${RISKY_KEYWORDS.length}`);
});

// ---------------------------------------------------------------------------
// resolveMode precedence
// ---------------------------------------------------------------------------

describe('resolveMode', () => {
  test('default: no config, no flag → full, requiresConfirm=false', () => {
    const r = resolveMode(null, []);
    assert.equal(r.mode, 'full');
    assert.equal(r.source, 'default');
    assert.equal(r.requiresConfirm, false);
    assert.equal(r.safeToAutoAccept, true);
  });

  test('CLI --light wins; requiresConfirm=true', () => {
    const r = resolveMode({ mode: 'full' }, ['--light']);
    assert.equal(r.mode, 'light');
    assert.equal(r.source, 'cli');
    assert.equal(r.requiresConfirm, true);
  });

  test('autonomy.mode=light → requiresConfirm=false (opted in at config)', () => {
    const r = resolveMode({ mode: 'light' }, []);
    assert.equal(r.mode, 'light');
    assert.equal(r.source, 'autonomy');
    assert.equal(r.requiresConfirm, false);
    assert.equal(r.safeToAutoAccept, true);
  });

  test('invalid autonomy.mode → default full', () => {
    const r = resolveMode({ mode: 'turbo' }, []);
    assert.equal(r.mode, 'full');
    assert.equal(r.source, 'default');
  });

  test('non-array cliArgs does not throw', () => {
    const r = resolveMode(null, null);
    assert.equal(r.mode, 'full');
  });

  test('CLI --light + CI env → safeToAutoAccept=false', () => {
    const prevCI = process.env.CI;
    process.env.CI = '1';
    try {
      const r = resolveMode(null, ['--light']);
      assert.equal(r.mode, 'light');
      assert.equal(r.requiresConfirm, true);
      assert.equal(r.safeToAutoAccept, false);
    } finally {
      if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
    }
  });
});

describe('isInteractiveStdin / isCIEnvironment', () => {
  test('isInteractiveStdin returns boolean', () => {
    assert.equal(typeof isInteractiveStdin(), 'boolean');
  });

  test('isCIEnvironment true when CI=1', () => {
    const prev = process.env.CI;
    process.env.CI = '1';
    try {
      assert.equal(isCIEnvironment(), true);
    } finally {
      if (prev === undefined) delete process.env.CI; else process.env.CI = prev;
    }
  });

  test('isCIEnvironment true when GITHUB_ACTIONS=true', () => {
    const prev = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = 'true';
    try {
      assert.equal(isCIEnvironment(), true);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prev;
    }
  });

  test('isCIEnvironment false when CI=false', () => {
    const prev = process.env.CI;
    process.env.CI = 'false';
    try {
      // Only true if another CI var is set. Clear them.
      const cleared = {};
      for (const m of ['GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'TRAVIS',
                       'JENKINS_URL', 'BUILDKITE', 'DRONE', 'BITBUCKET_BUILD_NUMBER',
                       'TF_BUILD', 'TEAMCITY_VERSION', 'APPVEYOR', 'CODEBUILD_BUILD_ID']) {
        cleared[m] = process.env[m];
        delete process.env[m];
      }
      try {
        assert.equal(isCIEnvironment(), false);
      } finally {
        for (const [k, v] of Object.entries(cleared)) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    } finally {
      if (prev === undefined) delete process.env.CI; else process.env.CI = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// detectRiskyKeywords
// ---------------------------------------------------------------------------

describe('detectRiskyKeywords', () => {
  test('detects single keyword', () => {
    const hits = detectRiskyKeywords('refactor the auth module');
    assert.deepEqual(hits, ['auth']);
  });

  test('detects multiple keywords, deduped', () => {
    const hits = detectRiskyKeywords('migration of billing and auth tables');
    assert.ok(hits.includes('auth'));
    assert.ok(hits.includes('billing'));
    assert.ok(hits.includes('migration'));
    assert.equal(new Set(hits).size, hits.length, 'should be deduped');
  });

  test('plural "schemas" DOES match via alias expansion (Gemini Phase 4 #3)', () => {
    const hits = detectRiskyKeywords('update all schemas today');
    assert.ok(hits.includes('schema'), `expected schema via alias, got: ${hits.join(',')}`);
  });

  test('alias expansion for "migrations"', () => {
    const hits = detectRiskyKeywords('reviewing migrations folder');
    assert.ok(hits.includes('migration'));
  });

  test('alias "rbac" maps to role', () => {
    const hits = detectRiskyKeywords('refactor the rbac middleware');
    assert.ok(hits.includes('role'));
  });

  test('Phase 4 review additions — encryption/deadlock/race are detected', () => {
    assert.ok(detectRiskyKeywords('broken encryption flow').includes('encryption'));
    assert.ok(detectRiskyKeywords('fixing a deadlock').includes('deadlock'));
    assert.ok(detectRiskyKeywords('race condition on writer').includes('race'));
  });

  test('hyphenated keyword "sql-injection" matches', () => {
    const hits = detectRiskyKeywords('test sql-injection defences');
    assert.ok(hits.includes('sql-injection'));
  });

  test('case-insensitive', () => {
    const hits = detectRiskyKeywords('Add TENANT isolation');
    assert.deepEqual(hits, ['tenant']);
  });

  test('word-boundary: "schematic" does NOT match "schema"', () => {
    const hits = detectRiskyKeywords('draw a schematic diagram');
    assert.equal(hits.length, 0);
  });

  test('word-boundary: "distributedly" does NOT match "distributed" (no suffix)', () => {
    // NOTE: strict \b would actually match "distributedly" because \b is a
    // word boundary between alphanumerics. Behaviour: we accept this match.
    // Test documents current behaviour explicitly.
    const hits = detectRiskyKeywords('deploy distributedly across regions');
    // "distributed" IS a prefix of "distributedly"; regex \b only requires
    // a word-boundary transition, which is satisfied at "d" vs "l". So the
    // implementation finds it. Assert the current behaviour.
    assert.equal(hits.length, 0);
  });

  test('empty / non-string input → []', () => {
    assert.deepEqual(detectRiskyKeywords(''), []);
    assert.deepEqual(detectRiskyKeywords(null), []);
    assert.deepEqual(detectRiskyKeywords(42), []);
  });

  test('no risky keywords → []', () => {
    assert.deepEqual(detectRiskyKeywords('rename a button label'), []);
  });
});

// ---------------------------------------------------------------------------
// buildConfirmMessage
// ---------------------------------------------------------------------------

describe('buildConfirmMessage', () => {
  test('lists skipped stages + kept stages', () => {
    const m = buildConfirmMessage({
      taskDescription: 'simple rename',
      stagesSkipped: ['momus', 'architect'],
    });
    assert.match(m.body, /SKIP/);
    assert.match(m.body, /- momus/);
    assert.match(m.body, /- architect/);
    assert.match(m.body, /Kept:/);
    assert.match(m.body, /code-reviewer/);
    assert.match(m.body, /themis/);
  });

  test('risky keywords trigger warning block', () => {
    const m = buildConfirmMessage({
      taskDescription: 'add auth and payments',
      stagesSkipped: ['momus', 'architect'],
    });
    assert.match(m.body, /Risk keywords detected/);
    assert.match(m.body, /auth/);
    assert.match(m.body, /payments/);
    assert.deepEqual(m.riskyMatches.sort(), ['auth', 'payments'].sort());
  });

  test('no risky keywords → no warning block', () => {
    const m = buildConfirmMessage({
      taskDescription: 'rename button label',
      stagesSkipped: ['momus', 'architect'],
    });
    assert.doesNotMatch(m.body, /Risk keywords detected/);
    assert.deepEqual(m.riskyMatches, []);
  });

  test('options are Yes/No strings', () => {
    const m = buildConfirmMessage({ taskDescription: 'x', stagesSkipped: ['momus'] });
    assert.equal(m.options.length, 2);
    assert.match(m.options[0], /Yes/);
    assert.match(m.options[1], /No/);
  });

  test('default stagesSkipped when arg missing', () => {
    const m = buildConfirmMessage({ taskDescription: 'x' });
    assert.match(m.body, /momus/);
    assert.match(m.body, /architect/);
  });

  test('mentions auto-escalation safety net', () => {
    const m = buildConfirmMessage({ taskDescription: 'x', stagesSkipped: ['momus'] });
    assert.match(m.body, /Auto-escalation|auto-escalate/i);
  });
});

// ---------------------------------------------------------------------------
// stageFilter
// ---------------------------------------------------------------------------

describe('stageFilter', () => {
  test('full mode: skip nothing', () => {
    const f = stageFilter('full');
    assert.equal(f.skipMomus, false);
    assert.equal(f.skipArchitect, false);
    assert.ok(f.keptStages.includes('momus'));
    assert.ok(f.keptStages.includes('architect'));
  });

  test('light mode: skip momus + architect, keep others', () => {
    const f = stageFilter('light');
    assert.equal(f.skipMomus, true);
    assert.equal(f.skipArchitect, true);
    assert.ok(!f.keptStages.includes('momus'));
    assert.ok(!f.keptStages.includes('architect'));
    assert.ok(f.keptStages.includes('metis'));
    assert.ok(f.keptStages.includes('prometheus'));
    assert.ok(f.keptStages.includes('code-reviewer'));
    assert.ok(f.keptStages.includes('themis'));
  });
});

// ---------------------------------------------------------------------------
// autoEscalateOnReject
// ---------------------------------------------------------------------------

describe('autoEscalateOnReject', () => {
  test('already full mode: no escalation', () => {
    const r = autoEscalateOnReject({ currentMode: 'full', rejectingStage: 'code-reviewer' });
    assert.equal(r.escalated, false);
    assert.equal(r.newMode, 'full');
  });

  test('light mode + any reject → newMode=full, escalated=true', () => {
    const r = autoEscalateOnReject({
      currentMode: 'light',
      rejectingStage: 'code-reviewer',
      rejectReason: '🔴 SQL injection',
    });
    assert.equal(r.escalated, true);
    assert.equal(r.newMode, 'full');
    assert.match(r.reason, /code-reviewer/);
    assert.match(r.reason, /SQL injection/);
  });

  test('light mode + reject without reason still escalates', () => {
    const r = autoEscalateOnReject({ currentMode: 'light', rejectingStage: 'themis' });
    assert.equal(r.escalated, true);
    assert.equal(r.newMode, 'full');
  });
});

// ---------------------------------------------------------------------------
// logLightModeEvent fails silently
// ---------------------------------------------------------------------------

describe('logLightModeEvent', () => {
  test('calls injected addWisdom with a shaped lesson', async () => {
    let captured = null;
    const addWisdomFn = async (entry) => { captured = entry; };
    await logLightModeEvent({
      event: 'entered',
      reason: 'user confirmed',
      stagesSkipped: ['momus', 'architect'],
      riskyMatches: ['auth'],
      addWisdomFn,
    });
    assert.ok(captured);
    assert.equal(captured.category, 'pattern');
    assert.match(captured.lesson, /light-mode:entered/);
    assert.match(captured.lesson, /user confirmed/);
    assert.match(captured.lesson, /momus/);
    assert.match(captured.lesson, /auth/);
  });

  test('fails silently when addWisdom throws', async () => {
    const addWisdomFn = async () => { throw new Error('wisdom unavailable'); };
    // Must not reject
    await logLightModeEvent({ event: 'escalated', addWisdomFn });
    assert.ok(true);
  });

  test('emits stderr JSON fallback even when wisdom succeeds', async () => {
    // Capture stderr.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured = [];
    process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return true; };
    try {
      await logLightModeEvent({
        event: 'entered',
        reason: 'test',
        addWisdomFn: async () => {},
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    const emitted = captured.join('');
    assert.match(emitted, /"event"\s*:\s*"light_mode"/);
    assert.match(emitted, /"type"\s*:\s*"entered"/);
    assert.match(emitted, /"wisdomOk"\s*:\s*true/);
  });

  test('stderr fallback reports wisdomOk=false when wisdom throws', async () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured = [];
    process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return true; };
    try {
      await logLightModeEvent({
        event: 'escalated',
        addWisdomFn: async () => { throw new Error('boom'); },
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    const emitted = captured.join('');
    assert.match(emitted, /"wisdomOk"\s*:\s*false/);
  });
});

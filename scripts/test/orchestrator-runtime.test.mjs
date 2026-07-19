import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendUserTaskUpdate,
  createRun,
  finalizeRun,
  getActiveRunId,
  getRunReviewBasePin,
  getUserTaskUpdates,
} from '../lib/run-artifacts.mjs';
import { inProgressTransition, pendingTransition } from '../orchestrator-stop-gate.mjs';
import { admitOrchestratorRun } from '../orchestrator-skill-init.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIME = join(ROOT, 'scripts', 'orchestrator-runtime.mjs');
const INIT = join(ROOT, 'scripts', 'orchestrator-skill-init.mjs');
const STOP = join(ROOT, 'scripts', 'orchestrator-stop-gate.mjs');
const HOOKS = join(ROOT, 'hooks', 'hooks.json');
const ATLAS_SKILL = join(ROOT, 'skills', 'atlas', 'SKILL.md');
const INIT_URL = pathToFileURL(INIT).href;

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'ao-orchestrator-runtime-'));
  chmodSync(cwd, 0o700);
  initializeGitRepository(cwd);
  return cwd;
}

function clean(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function initializeGitRepository(cwd) {
  git(cwd, ['init', '--initial-branch=main']);
  git(cwd, ['config', 'user.name', 'Atlas Runtime Test']);
  git(cwd, ['config', 'user.email', 'atlas-runtime@example.test']);
  writeFileSync(join(cwd, '.gitignore'), '.ao/\n');
  writeFileSync(join(cwd, 'README.md'), '# Fixture\n');
  git(cwd, ['add', '.gitignore', 'README.md']);
  git(cwd, ['commit', '-m', 'base']);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function invoke(script, { cwd, args = [], input } = {}) {
  const env = { ...process.env };
  delete env.DISABLE_AO;
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
    // A hardened approval intentionally rebuilds and revalidates Git evidence
    // several times. Parallel full-suite I/O can make that exceed 10 seconds
    // even though every individual Git command has its own production bound.
    timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout must be one JSON value: ${result.stdout}`);
  return { ...result, json: JSON.parse(result.stdout) };
}

function expansion(commandArgs, overrides = {}) {
  return {
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command',
    command_name: 'agent-olympus:atlas',
    command_args: commandArgs,
    command_source: 'plugin',
    ...overrides,
  };
}

function skillInvocation(args, overrides = {}) {
  const toolInput = { skill: 'agent-olympus:atlas' };
  if (args !== undefined) toolInput.args = args;
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Skill',
    tool_input: toolInput,
    ...overrides,
  };
}

function contextRunId(output) {
  const context = output.hookSpecificOutput?.additionalContext ?? '';
  return context.match(/^runId: ([A-Za-z0-9._-]+)$/m)?.[1] ?? null;
}

describe('Atlas executable bootstrap', () => {
  it('adopts a preallocated eval run and appends with resume semantics', () => {
    const cwd = project();
    try {
      const base = join(cwd, '.ao', 'artifacts', 'runs');
      const stateDir = join(cwd, '.ao', 'state');
      const created = createRun('atlas', 'eval allocation', { base, stateDir, trustedRoot: cwd });
      assert.equal(created.ok, true);
      assert.equal(appendUserTaskUpdate(created.runId, 'eval prompt', {
        base,
        trustedRoot: cwd,
        allowCreate: true,
      }).ok, true);

      const result = invoke(INIT, { cwd, input: expansion('follow-up constraint') });
      assert.equal(result.status, 0);
      assert.equal(contextRunId(result.json), created.runId);
      assert.match(result.json.hookSpecificOutput.additionalContext, /current phase: triage/);
      assert.equal(readdirSync(base).length, 1, 'must not create a second run directory');
      const updates = getUserTaskUpdates(created.runId, { base, trustedRoot: cwd });
      assert.deepEqual(updates.updates.map(({ task }) => task), ['eval prompt', 'follow-up constraint']);
    } finally {
      clean(cwd);
    }
  });

  it('creates once, then idempotently adopts the same run on reinvocation', () => {
    const cwd = project();
    try {
      const first = invoke(INIT, { cwd, input: expansion('build it') });
      const second = invoke(INIT, {
        cwd,
        input: expansion('build it', { command_name: 'atlas' }),
      });
      const runId = contextRunId(first.json);
      assert.ok(runId);
      assert.equal(contextRunId(second.json), runId);
      assert.equal(getActiveRunId('atlas', { stateDir: join(cwd, '.ao', 'state') }), runId);
      assert.equal(readdirSync(join(cwd, '.ao', 'artifacts', 'runs')).length, 1);
      const updates = getUserTaskUpdates(runId, {
        base: join(cwd, '.ao', 'artifacts', 'runs'),
        trustedRoot: cwd,
      });
      assert.deepEqual(updates.updates.map(({ task }) => task), ['build it', 'build it']);
    } finally {
      clean(cwd);
    }
  });

  it('fails a fresh run before allocation when reviewable user changes already exist', () => {
    const cwd = project();
    try {
      writeFileSync(join(cwd, 'README.md'), '# Existing user edit\n');
      const result = invoke(INIT, { cwd, input: expansion('build it') });
      assert.equal(result.status, 0);
      assert.equal(result.json.decision, 'block');
      assert.match(result.json.reason, /commit or stash first.*README\.md/i);
      assert.equal(existsSync(join(cwd, '.ao', 'artifacts', 'runs')), false);
      assert.equal(getActiveRunId('atlas', { stateDir: join(cwd, '.ao', 'state') }), null);
      assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), '# Existing user edit\n');
    } finally {
      clean(cwd);
    }
  });

  it('allows dirty task output when resuming an already initialized run', () => {
    const cwd = project();
    try {
      const first = invoke(INIT, { cwd, input: expansion('build it') });
      const runId = contextRunId(first.json);
      assert.ok(runId);
      writeFileSync(join(cwd, 'README.md'), '# Atlas task output\n');
      const resumed = invoke(INIT, { cwd, input: expansion('add a constraint') });
      assert.equal(contextRunId(resumed.json), runId, JSON.stringify(resumed.json));
      assert.doesNotMatch(JSON.stringify(resumed.json), /commit or stash first/i);
    } finally {
      clean(cwd);
    }
  });

  it('treats malicious command_args only as durable data', () => {
    const cwd = project();
    try {
      const marker = join(cwd, 'SHOULD_NOT_EXIST');
      const malicious = `review $(touch "${marker}"); \`touch ${marker}\`; " && rm -rf .\nkeep this exact`;
      const result = invoke(INIT, { cwd, input: expansion(malicious) });
      assert.equal(result.status, 0);
      assert.equal(existsSync(marker), false);
      const runId = contextRunId(result.json);
      const updates = getUserTaskUpdates(runId, {
        base: join(cwd, '.ao', 'artifacts', 'runs'),
        trustedRoot: cwd,
      });
      assert.equal(updates.updates.at(-1).task, malicious);
      assert.doesNotMatch(result.json.hookSpecificOutput.additionalContext, /SHOULD_NOT_EXIST/);
    } finally {
      clean(cwd);
    }
  });

  it('ignores a non-plugin command source and does not allocate state', () => {
    const cwd = project();
    try {
      const result = invoke(INIT, {
        cwd,
        input: expansion('do it', { command_source: 'project' }),
      });
      assert.equal(result.status, 0);
      assert.deepEqual(result.json, {});
      assert.equal(existsSync(join(cwd, '.ao', 'artifacts', 'runs')), false);
      assert.equal(getActiveRunId('atlas', { stateDir: join(cwd, '.ao', 'state') }), null);
    } finally {
      clean(cwd);
    }
  });

  it('bootstraps delegated Skill calls and resumes without appending an empty task', () => {
    const cwd = project();
    try {
      const delegated = invoke(INIT, {
        cwd,
        input: skillInvocation('execute the approved plan'),
      });
      assert.equal(delegated.status, 0);
      assert.equal(delegated.json.hookSpecificOutput?.hookEventName, 'PreToolUse');
      const runId = contextRunId(delegated.json);
      assert.ok(runId);

      const resumed = invoke(INIT, { cwd, input: skillInvocation(undefined) });
      assert.equal(resumed.status, 0);
      assert.equal(contextRunId(resumed.json), runId);
      assert.match(resumed.json.hookSpecificOutput.additionalContext, /without appending an empty resume argument/);
      const updates = getUserTaskUpdates(runId, {
        base: join(cwd, '.ao', 'artifacts', 'runs'),
        trustedRoot: cwd,
      });
      assert.deepEqual(updates.updates.map(({ task }) => task), ['execute the approved plan']);
    } finally {
      clean(cwd);
    }
  });

  it('blocks a fresh no-argument Skill call instead of inventing a task', () => {
    const cwd = project();
    try {
      const result = invoke(INIT, { cwd, input: skillInvocation(undefined) });
      assert.equal(result.status, 0);
      assert.deepEqual(result.json.hookSpecificOutput, {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.json.hookSpecificOutput.permissionDecisionReason,
      });
      assert.match(
        result.json.hookSpecificOutput.permissionDecisionReason,
        /fresh Atlas run requires a non-empty request/,
      );
      assert.equal(result.json.decision, undefined);
      assert.equal(existsSync(join(cwd, '.ao', 'artifacts', 'runs')), false);
      assert.equal(getActiveRunId('atlas', { stateDir: join(cwd, '.ao', 'state') }), null);
    } finally {
      clean(cwd);
    }
  });

  it('uses event-specific fail-closed output for invalid expansion and Skill inputs', () => {
    const slashCwd = project();
    try {
      const slash = invoke(INIT, { cwd: slashCwd, input: expansion([]) });
      assert.equal(slash.json.decision, 'block');
      assert.match(slash.json.reason, /command_args must be empty or a non-empty string/);
      assert.equal(slash.json.hookSpecificOutput, undefined);
    } finally {
      clean(slashCwd);
    }

    const skillCwd = project();
    try {
      const skill = invoke(INIT, { cwd: skillCwd, input: skillInvocation([]) });
      assert.equal(skill.json.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(skill.json.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(
        skill.json.hookSpecificOutput.permissionDecisionReason,
        /tool_input\.args must be empty or a non-empty string/,
      );
      assert.equal(skill.json.decision, undefined);
    } finally {
      clean(skillCwd);
    }
  });
});

describe('cross-orchestrator admission', () => {
  it('blocks Atlas when an exact active Athena run already owns the project', () => {
    const cwd = project();
    try {
      const base = join(cwd, '.ao', 'artifacts', 'runs');
      const stateDir = join(cwd, '.ao', 'state');
      const athena = createRun('athena', 'team task', { base, stateDir, trustedRoot: cwd });
      assert.equal(athena.ok, true);

      const result = invoke(INIT, { cwd, input: expansion('atlas task') });
      assert.equal(result.json.decision, 'block');
      assert.match(result.json.reason, /other-orchestrator-active:athena/);
      assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: cwd }), null);
      assert.equal(getActiveRunId('athena', { stateDir, trustedRoot: cwd }), athena.runId);
    } finally {
      clean(cwd);
    }
  });

  it('blocks Athena when an exact active Atlas run already owns the project', () => {
    const cwd = project();
    try {
      const base = join(cwd, '.ao', 'artifacts', 'runs');
      const stateDir = join(cwd, '.ao', 'state');
      const atlas = createRun('atlas', 'solo task', { base, stateDir, trustedRoot: cwd });
      assert.equal(atlas.ok, true);

      let recoveryCalls = 0;
      const result = admitOrchestratorRun('athena', 'team task', {
        cwd,
        expectedRunId: null,
        recoverMissing: () => {
          recoveryCalls += 1;
          return { ok: false, canCreateNewRun: true };
        },
      });
      assert.equal(result.ok, false);
      assert.match(result.reason, /other-orchestrator-active:atlas/);
      assert.equal(recoveryCalls, 0, 'Athena recovery must stay behind cross-orchestrator admission');
      assert.equal(getActiveRunId('athena', { stateDir, trustedRoot: cwd }), null);
      assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: cwd }), atlas.runId);
    } finally {
      clean(cwd);
    }
  });

  it('allows only the exact same-orchestrator resume observed by preflight', () => {
    const cwd = project();
    try {
      const created = admitOrchestratorRun('athena', 'team task', {
        cwd,
        expectedRunId: null,
      });
      assert.equal(created.ok, true);
      assert.equal(created.created, true);

      const preflight = admitOrchestratorRun('athena', 'follow-up', {
        cwd,
        createIfMissing: false,
      });
      assert.equal(preflight.ok, true);
      assert.equal(preflight.runId, created.runId);

      const resumed = admitOrchestratorRun('athena', 'follow-up', {
        cwd,
        expectedRunId: preflight.runId,
      });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.created, false);
      assert.equal(resumed.runId, created.runId);
      assert.doesNotThrow(() => resumed.pointerGuard.revalidate({ required: true }));

      const staleAbsenceFence = admitOrchestratorRun('athena', 'unrelated task', {
        cwd,
        expectedRunId: null,
      });
      assert.deepEqual(staleAbsenceFence, {
        ok: false,
        reason: 'same-orchestrator-pointer-changed',
      });
    } finally {
      clean(cwd);
    }
  });

  it('fails closed on malformed and stale opposite-orchestrator pointers', () => {
    const invalidCwd = project();
    try {
      const stateDir = join(invalidCwd, '.ao', 'state');
      const preflight = admitOrchestratorRun('atlas', null, {
        cwd: invalidCwd,
        createIfMissing: false,
      });
      assert.equal(preflight.ok, true);
      writeFileSync(join(stateDir, 'ao-active-run-athena.json'), '{malformed', { mode: 0o600 });

      const invalid = invoke(INIT, { cwd: invalidCwd, input: expansion('atlas task') });
      assert.equal(invalid.json.decision, 'block');
      assert.match(invalid.json.reason, /other-orchestrator-pointer-invalid:athena/);
      assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: invalidCwd }), null);
    } finally {
      clean(invalidCwd);
    }

    const staleCwd = project();
    try {
      const base = join(staleCwd, '.ao', 'artifacts', 'runs');
      const stateDir = join(staleCwd, '.ao', 'state');
      const athena = createRun('athena', 'stale team task', {
        base,
        stateDir,
        trustedRoot: staleCwd,
      });
      assert.equal(athena.ok, true);
      rmSync(athena.runDir, { recursive: true, force: true });

      const stale = invoke(INIT, { cwd: staleCwd, input: expansion('atlas task') });
      assert.equal(stale.json.decision, 'block');
      assert.match(stale.json.reason, /other-orchestrator-pointer-stale:athena/);
      assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: staleCwd }), null);
    } finally {
      clean(staleCwd);
    }
  });

  it('serializes concurrent Atlas and Athena claims so exactly one wins', async () => {
    const cwd = project();
    try {
      const gate = join(cwd, 'admission-gate');
      const readyAtlas = join(cwd, 'ready-atlas');
      const readyAthena = join(cwd, 'ready-athena');
      const childSource = [
        `import { existsSync, writeFileSync } from 'node:fs';`,
        `import { admitOrchestratorRun } from ${JSON.stringify(INIT_URL)};`,
        `writeFileSync(process.env.AO_READY, 'ready');`,
        `while (!existsSync(process.env.AO_GATE)) await new Promise(resolve => setTimeout(resolve, 2));`,
        `const result = admitOrchestratorRun(process.env.AO_ORCHESTRATOR, process.env.AO_TASK, {`,
        `  cwd: process.env.AO_CWD, expectedRunId: null,`,
        `});`,
        `console.log(JSON.stringify({ ok: result.ok, reason: result.reason, runId: result.runId }));`,
      ].join('\n');
      const launch = (orchestrator, ready) => spawn(process.execPath, [
        '--input-type=module', '-e', childSource,
      ], {
        env: {
          ...process.env,
          AO_CWD: cwd,
          AO_GATE: gate,
          AO_ORCHESTRATOR: orchestrator,
          AO_READY: ready,
          AO_TASK: `${orchestrator} concurrent task`,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const atlasChild = launch('atlas', readyAtlas);
      const athenaChild = launch('athena', readyAthena);
      const collect = child => new Promise(resolveChild => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolveChild({ status, stdout, stderr }));
      });
      const atlasDone = collect(atlasChild);
      const athenaDone = collect(athenaChild);
      for (let attempt = 0; attempt < 500
        && (!existsSync(readyAtlas) || !existsSync(readyAthena)); attempt += 1) {
        await new Promise(resolveWait => setTimeout(resolveWait, 2));
      }
      assert.equal(existsSync(readyAtlas), true);
      assert.equal(existsSync(readyAthena), true);
      writeFileSync(gate, 'go');

      const completed = await Promise.all([atlasDone, athenaDone]);
      for (const child of completed) {
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stderr, '');
      }
      const outcomes = completed.map(child => JSON.parse(child.stdout));
      assert.equal(outcomes.filter(outcome => outcome.ok).length, 1);
      assert.equal(outcomes.filter(outcome => !outcome.ok).length, 1);
      assert.match(
        outcomes.find(outcome => !outcome.ok).reason,
        /other-orchestrator-active|orchestrator-admission-lock-busy/,
      );
      const stateDir = join(cwd, '.ao', 'state');
      const active = ['atlas', 'athena']
        .map(orchestrator => getActiveRunId(orchestrator, { stateDir, trustedRoot: cwd }))
        .filter(Boolean);
      assert.deepEqual(active, [outcomes.find(outcome => outcome.ok).runId]);
    } finally {
      clean(cwd);
    }
  });
});

describe('orchestrator runtime CLI', () => {
  it('emits JSON and exits non-zero for an invalid command', () => {
    const cwd = project();
    try {
      const result = invoke(RUNTIME, { cwd, args: ['shell', 'atlas'] });
      assert.notEqual(result.status, 0);
      assert.equal(result.json.ok, false);
      assert.equal(result.json.error.code, 'invalid-command');
    } finally {
      clean(cwd);
    }
  });

  it('reports a preinitialized run and rejects non-allowlisted phases', () => {
    const cwd = project();
    try {
      const initialized = invoke(INIT, { cwd, input: expansion('runtime check') });
      const runId = contextRunId(initialized.json);
      const status = invoke(RUNTIME, { cwd, args: ['status', 'atlas', runId] });
      assert.equal(status.status, 0);
      assert.equal(status.json.currentPhase, 'triage');
      assert.equal(status.json.complete, false);
      assert.equal(status.json.nextAction, 'enter');
      assert.deepEqual(status.json.allowedSkips, []);
      assert.deepEqual(status.json.allowedLoops, []);

      const denied = invoke(RUNTIME, {
        cwd,
        args: ['enter', 'atlas', runId, '../triage'],
      });
      assert.notEqual(denied.status, 0);
      assert.equal(denied.json.error.code, 'invalid-phase');

      const entered = invoke(RUNTIME, {
        cwd,
        args: ['enter', 'atlas', runId, 'triage'],
      });
      assert.equal(entered.status, 0);
      const missingOutputs = invoke(RUNTIME, {
        cwd,
        args: ['complete', 'atlas', runId, 'triage'],
      });
      assert.notEqual(missingOutputs.status, 0);
      assert.equal(missingOutputs.json.error.code, 'required-outputs-missing');
    } finally {
      clean(cwd);
    }
  });

  it('drives a trivial Atlas run through every fixed transition command', () => {
    const cwd = project();
    try {
      const baseCommit = git(cwd, ['rev-parse', 'HEAD']);
      const initialized = invoke(INIT, { cwd, input: expansion('trivial end-to-end') });
      const runId = contextRunId(initialized.json);
      const ok = (args, input = undefined) => {
        const result = invoke(RUNTIME, { cwd, args, input });
        assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}`);
        assert.equal(result.json.ok, true);
        return result.json;
      };

      ok(['enter', 'atlas', runId, 'triage']);
      ok([
        'complete', 'atlas', runId, 'triage',
        'reviewBaseRef=HEAD',
        `reviewBaseCommit=${baseCommit}`,
        'reviewBaseSource=explicit',
      ]);
      const pinnedBase = getRunReviewBasePin(runId, {
        base: join(cwd, '.ao', 'artifacts', 'runs'),
        trustedRoot: cwd,
      });
      assert.equal(pinnedBase.ok, true);
      assert.equal(pinnedBase.pin.baseRef, 'HEAD');
      assert.equal(pinnedBase.pin.baseRefCommit, baseCommit);
      assert.equal(pinnedBase.pin.source, 'explicit');
      const trivialPrd = ok(['init-trivial-prd', 'atlas', runId, 'README.md']);
      assert.equal(trivialPrd.result.storyId, 'US-001');
      assert.equal(trivialPrd.result.prd.userStories[0].passes, false);
      const trivialResume = ok(['init-trivial-prd', 'atlas', runId, 'README.md']);
      assert.equal(trivialResume.result.idempotent, true);
      const unsafeScope = invoke(RUNTIME, {
        cwd,
        args: ['init-trivial-prd', 'atlas', runId, '../outside'],
      });
      assert.notEqual(unsafeScope.status, 0);
      assert.equal(unsafeScope.json.error.code, 'invalid-trivial-scope');
      ok(['skip', 'atlas', runId, 'context', 'trivial']);
      ok(['skip', 'atlas', runId, 'spec', 'trivial']);
      ok(['skip', 'atlas', runId, 'plan', 'trivial']);
      const rewind = ok(['policy-rewind', 'atlas', runId, 'light_mode_rewind']);
      assert.deepEqual(rewind.result.reopened, ['plan']);
      ok(['enter', 'atlas', runId, 'plan']);
      ok(['complete', 'atlas', runId, 'plan']);
      ok(['enter', 'atlas', runId, 'execute']);
      ok(['attempt', 'atlas', runId]);
      writeFileSync(join(cwd, 'README.md'), '# Fixture\n\nAtlas completed the scoped change.\n');
      const passedStory = ok(['story-pass', 'atlas', runId, 'US-001']);
      assert.equal(passedStory.result.passes, true);
      ok(['complete', 'atlas', runId, 'execute']);
      ok(['enter', 'atlas', runId, 'verify']);
      const retry = ok(['reattempt', 'atlas', runId, 'quality_fail']);
      assert.deepEqual(retry.result.reopened, ['execute', 'verify']);
      assert.equal(retry.result.qualityCount, 1);
      assert.deepEqual(retry.result.prdRollback.storyIds, ['US-001']);
      ok(['enter', 'atlas', runId, 'execute']);
      ok(['story-pass', 'atlas', runId, 'US-001']);
      ok(['complete', 'atlas', runId, 'execute']);
      ok(['enter', 'atlas', runId, 'verify']);
      const recorded = ok(['record-error', 'atlas', runId, 'verify', 'BUILD_FAIL']);
      assert.equal(recorded.result.repeatCount, 1);
      const verifyStatus = ok(['status', 'atlas', runId]);
      assert.equal(verifyStatus.nextAction, 'complete');
      assert.deepEqual(verifyStatus.allowedLoops, []);
      const deniedPublicQualityTick = invoke(RUNTIME, {
        cwd,
        args: ['tick', 'atlas', runId, 'quality'],
      });
      assert.notEqual(deniedPublicQualityTick.status, 0);
      assert.equal(deniedPublicQualityTick.json.error.code, 'invalid-loop');
      const reviewGeneration = ok([
        'verification-start', 'atlas', runId, 'review',
      ]).result;
      const persistedPrdBeforeReview = JSON.parse(
        readFileSync(join(cwd, '.ao', 'prd.json'), 'utf8'),
      );
      const criterion = persistedPrdBeforeReview.userStories[0].acceptanceCriteria[0];
      ok([
        'verification-record', 'atlas', runId, 'review', reviewGeneration.generationId,
      ], {
        story_id: 'US-001',
        verdict: 'pass',
        evidence: 'README content and focused runtime checks passed on the bound tree.',
        verifiedBy: 'atlas',
        criteria: [{
          criterion_index: 0,
          criterion_text: criterion,
          verdict: 'pass',
          evidence: 'The scoped README change exists and the runtime test observed it.',
        }],
      });
      const sealedReview = ok([
        'verification-seal', 'atlas', runId, 'review', reviewGeneration.generationId,
      ]).result;
      ok([
        'complete-verification', 'atlas', runId, reviewGeneration.generationId,
      ]);
      ok(['enter', 'atlas', runId, 'review']);
      const reviewResults = Object.fromEntries(sealedReview.reviewers.map(reviewer => [
        reviewer,
        {
          schemaVersion: 1,
          reviewer,
          reviewDigest: sealedReview.reviewDigest,
          verdict: 'APPROVE',
          findings: [],
          escalations: [],
        },
      ]));
      const approvalBeforeReviewTick = invoke(RUNTIME, {
        cwd,
        args: ['approve-review', 'atlas', runId, 'review', reviewGeneration.generationId],
        input: reviewResults,
      });
      assert.notEqual(approvalBeforeReviewTick.status, 0);
      assert.equal(approvalBeforeReviewTick.json.error.code, 'phase-loop-tick-required');
      ok(['tick', 'atlas', runId, 'review']);
      const duplicateReviewTick = ok(['tick', 'atlas', runId, 'review']);
      assert.equal(duplicateReviewTick.result.reused, true);
      assert.equal(ok(['status', 'atlas', runId]).nextAction, 'complete');
      const approvedReview = ok([
        'approve-review', 'atlas', runId, 'review', reviewGeneration.generationId,
      ], reviewResults).result;
      ok(['complete-review', 'atlas', runId, approvedReview.reviewDigest]);
      ok(['enter', 'atlas', runId, 'finalize']);
      const finalEvidenceBeforeTick = invoke(RUNTIME, {
        cwd,
        args: ['verification-start', 'atlas', runId, 'final-review'],
      });
      assert.notEqual(finalEvidenceBeforeTick.status, 0);
      assert.equal(finalEvidenceBeforeTick.json.error.code, 'phase-loop-tick-required');
      ok(['tick', 'atlas', runId, 'final-review']);
      const duplicateFinalTick = ok(['tick', 'atlas', runId, 'final-review']);
      assert.equal(duplicateFinalTick.result.reused, true);
      const finalGeneration = ok([
        'verification-start', 'atlas', runId, 'final-review',
      ]).result;
      ok([
        'verification-record', 'atlas', runId, 'final-review', finalGeneration.generationId,
      ], {
        story_id: 'US-001',
        verdict: 'pass',
        evidence: 'Fresh final-tree verification passed after all cleanup.',
        verifiedBy: 'atlas',
        criteria: [{
          criterion_index: 0,
          criterion_text: criterion,
          verdict: 'pass',
          evidence: 'The final scoped tree still satisfies the exact acceptance criterion.',
        }],
      });
      const sealedFinal = ok([
        'verification-seal', 'atlas', runId, 'final-review', finalGeneration.generationId,
      ]).result;
      const finalResults = Object.fromEntries(sealedFinal.reviewers.map(reviewer => [
        reviewer,
        {
          schemaVersion: 1,
          reviewer,
          reviewDigest: sealedFinal.reviewDigest,
          verdict: 'APPROVE',
          findings: [],
          escalations: [],
        },
      ]));
      const approvedFinal = ok([
        'approve-review', 'atlas', runId, 'final-review', finalGeneration.generationId,
      ], finalResults).result;
      ok(['complete-finalize', 'atlas', runId, approvedFinal.reviewDigest]);
      const finalCommit = git(cwd, ['rev-parse', 'HEAD']);
      ok(['skip', 'atlas', runId, 'ship', 'user-declined']);
      ok(['skip', 'atlas', runId, 'ci', 'no-pr']);
      ok(['enter', 'atlas', runId, 'complete']);
      ok(['complete', 'atlas', runId, 'complete']);
      const status = ok(['status', 'atlas', runId]);
      assert.equal(status.complete, true);
      assert.equal(status.currentPhase, null);
      git(cwd, ['commit', '--allow-empty', '-m', 'post-final-review commit']);
      const staleFinalApproval = invoke(RUNTIME, {
        cwd,
        args: ['finalize', 'atlas', runId],
      });
      assert.notEqual(staleFinalApproval.status, 0);
      assert.equal(staleFinalApproval.json.error.code, 'run-finalization-denied');
      assert.equal(getActiveRunId('atlas', { stateDir: join(cwd, '.ao', 'state') }), runId);
      git(cwd, ['update-ref', 'HEAD', finalCommit]);
      ok(['finalize', 'atlas', runId]);
      assert.equal(getActiveRunId('atlas', { stateDir: join(cwd, '.ao', 'state') }), null);
      const finalizedStatus = ok(['status', 'atlas', runId]);
      assert.equal(finalizedStatus.runStatus, 'completed');
      assert.equal(finalizedStatus.nextAction, 'done');
      const ledger = JSON.parse(readFileSync(
        join(cwd, '.ao', 'artifacts', 'runs', runId, 'pipeline.json'),
        'utf8',
      ));
      assert.equal(ledger.phases.triage.outputs.reviewBaseRef, 'HEAD');
      assert.equal(ledger.phases.review.outputs.approvedReviewDigest, approvedReview.reviewDigest);
      assert.equal(ledger.phases.finalize.outputs.finalCommit, finalCommit);
      const persistedPrd = JSON.parse(readFileSync(join(cwd, '.ao', 'prd.json'), 'utf8'));
      assert.match(persistedPrd.projectName, /^atlas-trivial-/);
      assert.equal(persistedPrd.userStories[0].passes, true);
    } finally {
      clean(cwd);
    }
  });
});

describe('Atlas Stop gate', () => {
  it('uses evidence-aware recovery commands for every protected phase', () => {
    const runId = 'atlas-stop-guidance';
    assert.match(inProgressTransition(runId, 'verify'), /complete-verification atlas .*<sealed-generation-id>$/);
    assert.match(inProgressTransition(runId, 'review'), /complete-review atlas .*<approved-review-digest>$/);
    assert.match(inProgressTransition(runId, 'finalize'), /complete-finalize atlas .*<final-review-approval-digest>$/);
    for (const phase of ['verify', 'review', 'finalize']) {
      assert.doesNotMatch(inProgressTransition(runId, phase), / complete atlas /);
    }
  });

  it('does not tell a pending skippable ship/CI phase to enter unconditionally', () => {
    const runId = 'atlas-stop-guidance';
    for (const phase of ['ship', 'ci']) {
      const guidance = pendingTransition(runId, phase);
      assert.match(guidance, new RegExp(`status atlas ${runId}`));
      assert.match(guidance, new RegExp(`skip atlas ${runId} ${phase}`));
      assert.match(guidance, new RegExp(`otherwise .*enter atlas ${runId} ${phase}`));
    }
    assert.match(pendingTransition(runId, 'triage'), /enter atlas .* triage$/);
  });

  it('blocks the first Stop for an incomplete run and allows the recursive Stop', () => {
    const cwd = project();
    try {
      const initialized = invoke(INIT, { cwd, input: expansion('finish this') });
      const runId = contextRunId(initialized.json);
      const first = invoke(STOP, {
        cwd,
        input: { hook_event_name: 'Stop', stop_hook_active: false },
      });
      assert.equal(first.json.decision, 'block');
      assert.match(first.json.reason, new RegExp(`Next phase: triage`));
      assert.match(first.json.reason, new RegExp(runId));
      assert.match(first.json.reason, /\$\{CLAUDE_PLUGIN_ROOT\}/);

      const recursive = invoke(STOP, {
        cwd,
        input: { hook_event_name: 'Stop', stop_hook_active: true },
      });
      assert.deepEqual(recursive.json, {});
    } finally {
      clean(cwd);
    }
  });

  it('allows Stop when there is no active run or the run was finalized', () => {
    const empty = project();
    try {
      const noActive = invoke(STOP, {
        cwd: empty,
        input: { hook_event_name: 'Stop', stop_hook_active: false },
      });
      assert.deepEqual(noActive.json, {});
    } finally {
      clean(empty);
    }

    const cwd = project();
    try {
      const base = join(cwd, '.ao', 'artifacts', 'runs');
      const stateDir = join(cwd, '.ao', 'state');
      const created = createRun('atlas', 'already done', { base, stateDir, trustedRoot: cwd });
      assert.equal(finalizeRun(created.runId, { result: 'success' }, {
        base,
        stateDir,
        trustedRoot: cwd,
      }).ok, true);
      const finalized = invoke(STOP, {
        cwd,
        input: { hook_event_name: 'Stop', stop_hook_active: false },
      });
      assert.deepEqual(finalized.json, {});
    } finally {
      clean(cwd);
    }
  });

  it('fails closed when a raw active pointer is malformed or unsafe', () => {
    const malformedCwd = project();
    try {
      invoke(INIT, { cwd: malformedCwd, input: expansion('malformed pointer') });
      const pointer = join(malformedCwd, '.ao', 'state', 'ao-active-run-atlas.json');
      writeFileSync(pointer, '{not-json}\n');
      const malformed = invoke(STOP, {
        cwd: malformedCwd,
        input: { hook_event_name: 'Stop', stop_hook_active: false },
      });
      assert.equal(malformed.json.decision, 'block');
      assert.match(malformed.json.reason, /active-run pointer exists but is malformed or unsafe/);
    } finally {
      clean(malformedCwd);
    }

    const unsafeCwd = project();
    try {
      invoke(INIT, { cwd: unsafeCwd, input: expansion('unsafe pointer') });
      const pointer = join(unsafeCwd, '.ao', 'state', 'ao-active-run-atlas.json');
      linkSync(pointer, join(unsafeCwd, '.ao', 'state', 'unexpected-hardlink'));
      const unsafe = invoke(STOP, {
        cwd: unsafeCwd,
        input: { hook_event_name: 'Stop', stop_hook_active: false },
      });
      assert.equal(unsafe.json.decision, 'block');
      assert.match(unsafe.json.reason, /active-run pointer exists but is malformed or unsafe/);
    } finally {
      clean(unsafeCwd);
    }
  });

  it('blocks the completed-summary stale-pointer crash window with idempotent recovery', () => {
    const cwd = project();
    try {
      const base = join(cwd, '.ao', 'artifacts', 'runs');
      const stateDir = join(cwd, '.ao', 'state');
      const pointer = join(stateDir, 'ao-active-run-atlas.json');
      const created = createRun('atlas', 'crash-window recovery', {
        base,
        stateDir,
        trustedRoot: cwd,
      });
      assert.equal(created.ok, true);
      const pointerPayload = readFileSync(pointer, 'utf8');
      assert.equal(finalizeRun(created.runId, { result: 'success' }, {
        base,
        stateDir,
        trustedRoot: cwd,
      }).ok, true);
      writeFileSync(pointer, pointerPayload, { flag: 'wx', mode: 0o600 });

      const stopped = invoke(STOP, {
        cwd,
        input: { hook_event_name: 'Stop', stop_hook_active: false },
      });
      assert.equal(stopped.json.decision, 'block');
      assert.match(stopped.json.reason, /completed but its active pointer remains/);
      assert.match(stopped.json.reason, /idempotent finalize\/clear recovery/);
      assert.match(stopped.json.reason, new RegExp(`finalize atlas ${created.runId}`));
    } finally {
      clean(cwd);
    }
  });
});

describe('hook and skill wiring', () => {
  it('registers UserPromptExpansion and pins Atlas executable-control metadata', () => {
    const hooks = JSON.parse(readFileSync(HOOKS, 'utf8'));
    const expansionHooks = hooks.hooks.UserPromptExpansion ?? [];
    assert.ok(expansionHooks.some(entry => (
      String(entry.matcher).includes('atlas')
      && entry.hooks?.some(hook => String(hook.command).includes('orchestrator-skill-init.mjs'))
    )));
    assert.ok((hooks.hooks.PreToolUse ?? []).some(entry => (
      entry.matcher === 'Skill'
      && entry.hooks?.some(hook => String(hook.command).includes('orchestrator-skill-init.mjs'))
    )));

    const skill = readFileSync(ATLAS_SKILL, 'utf8');
    assert.match(skill, /^---[\s\S]*?^model: opus$/m);
    assert.match(skill, /^---[\s\S]*?^effort: high$/m);
    assert.match(skill, /^\$ARGUMENTS$/m);
    assert.ok(skill.split('\n').length <= 500);
    assert.equal((skill.match(/\[reference\.md\]\(reference\.md\)/g) || []).length, 1);
    assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    assert.match(skill, /orchestrator-runtime\.mjs/);
    assert.match(skill, /init-trivial-prd/);
    assert.match(skill, /story-pass/);
    assert.doesNotMatch(skill, /\.\/scripts/);
    assert.match(skill, /orchestrator-stop-gate\.mjs/);
    assert.doesNotMatch(skill, /<Atlas_Orchestrator>/);
  });
});

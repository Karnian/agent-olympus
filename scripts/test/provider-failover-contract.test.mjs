import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

for (const skill of ['atlas', 'athena']) {
  test(`${skill} provider fallback recipe consumes targetProvider and dispatches provider child teams`, () => {
    const source = readFileSync(path.join(REPO_ROOT, `skills/${skill}/SKILL.md`), 'utf-8');
    assert.match(source, /reassignProvider\(/);
    assert.match(source, /dispatchProviderFallback\(/);
    assert.match(source, /pollProviderFallback\(/);
    assert.match(source, /completeClaudeFallback\(/);
    assert.match(source, /monitorTeam\(/);
    assert.match(source, /collectResults\(/);
    assert.match(source, /const cwd = process\.cwd\(\)/);
    assert.match(source, /const capabilities = preflightReport\.capabilities/);
    assert.match(source, /const teamSlug =/);
    if (skill === 'athena') {
      assert.match(source, /await spawnTeam\(teamSlug, externalWorkers, cwd, capabilities, \{ runId: adapterRunId \}\)/);
    } else {
      assert.match(source, /await spawnTeam\(teamSlug, externalWorkers, cwd, capabilities\)/);
    }
    assert.equal((source.match(/await spawnTeam\(/g) || []).length, 1);
    assert.match(source, /status\?\.workers\.every\(\(worker\) => worker\.status === 'completed'\)/);
    assert.match(source, /MANDATORY WORKTREE:/);
    assert.doesNotMatch(source, /plannedWorkers/);
    assert.ok(
      source.indexOf('const teamSlug =') < source.indexOf('createWorkerWorktree(cwd, teamSlug'),
      `${skill} must define teamSlug before creating worktrees`,
    );
    assert.match(source, /targetProvider/);
    assert.match(source, /progress\.status === 'running'/);
    assert.match(source, /progress\.status === 'completed'/);
    assert.match(source, /progress\.status === 'claude-task'/);
    assert.match(source, /replacementWorker\.prompt/);
    assert.match(source, /progress\.output/);
    assert.match(source, /const claudeOutput = Task/);
    assert.doesNotMatch(source, /providerChildTeams/);
    assert.doesNotMatch(source, /reassignToClaude\(/);
    assert.doesNotMatch(source, /<atlas-team-name-for-/);
  });
}

test('atlas supervisor fallback is driven by persisted monitor status', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'skills/atlas/SKILL.md'), 'utf-8');
  assert.match(source, /const status = monitorTeam\(teamSlug\)/);
  assert.match(source, /\(status\?\.workers \|\| \[\]\)\.filter\(\(worker\) => worker\.status === 'failed'\)/);
  assert.match(source, /failedWorker\.errorReason/);
  assert.match(source, /results\[failedWorker\.name\] = progress\.output/);
  assert.doesNotMatch(source, /if \(errorCheck\.failed\)/);
});

test('atlas integrates committed external worktrees before terminal cleanup', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'skills/atlas/SKILL.md'), 'utf-8');
  assert.match(source, /External worktrees must branch from a committed Atlas checkpoint/);
  assert.match(source, /model: undefined/);
  assert.match(source, /status', '--porcelain'/);
  assert.match(source, /mergeWorkerBranch\(cwd, worker\.branchName, worker\.name\)/);
  assert.match(source, /removeWorkerWorktree\(cwd, worker\.worktreePath, worker\.branchName\)/);
  assert.ok(
    source.indexOf('mergeWorkerBranch(cwd, worker.branchName, worker.name)')
      < source.indexOf('await shutdownTeam(teamSlug, cwd)'),
    'Atlas must merge external branches before shutdown deletes their worktrees',
  );
});

test('athena external workers use provider defaults and preserve work until a clean merge', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'skills/athena/SKILL.md'), 'utf-8');
  assert.match(source, /model: workerType === 'claude' \? \(stories\[0\]\.model \|\| 'sonnet'\) : undefined/);
  assert.match(source, /MANDATORY WORKTREE:/);
  assert.match(source, /Athena parallel worktrees must branch from a committed checkpoint/);
  assert.ok(
    source.indexOf('Athena parallel worktrees must branch from a committed checkpoint')
      < source.indexOf('createWorkerWorktree(cwd, teamSlug, worker.name)'),
    'Athena must reject a dirty root before deriving isolated branches from HEAD',
  );
  assert.match(source, /if \(!created \|\| !branch \|\| !path \|\| path === cwd\) continue/);
  assert.match(source, /status', '--porcelain'/);
  assert.match(source, /if \(!result\.success\)[\s\S]*throw new Error/);
  assert.ok(
    source.indexOf('if (!result.success)')
      < source.indexOf('removeWorkerWorktree(cwd, path, branch)'),
    'Athena must reject a failed merge before removing its worktree',
  );

  assert.match(
    source,
    /completePhase\(runId, 'spawn',[\s\S]*?checkpointData:[\s\S]*?runId,[\s\S]*?teamSlug,[\s\S]*?worktrees: activeWorktrees,[\s\S]*?mergedWorkers:/,
    'spawn terminal transition must durably establish the full monitor baseline',
  );
  assert.match(
    source,
    /const workerTerminalCheckpoint = await saveCheckpoint\('athena', \{\s*phase: 3,[\s\S]*?runId,[\s\S]*?teamSlug: phase3TeamSlug,[\s\S]*?worktrees: monitorWorktrees,[\s\S]*?mergedWorkers:[\s\S]*?if \(!workerTerminalCheckpoint\.ok/,
    'every acknowledged worker terminal transition must preserve the adopted worktree mapping',
  );
  assert.match(
    source,
    /completePhase\(runId, 'monitor',[\s\S]*?terminalWorkers: phase3IntendedWorkers,[\s\S]*?checkpointData:[\s\S]*?worktrees: monitorWorktrees,[\s\S]*?mergedWorkers:/,
    'monitor terminal transition must persist the final worker/worktree state',
  );

  assert.match(
    source,
    /const mergeCheckpoint = await saveCheckpoint\('athena', \{\s*phase: 4,[\s\S]*?runId,[\s\S]*?teamSlug: integrationSpawnIdentity\.teamSlug,[\s\S]*?worktrees: phase4Worktrees,[\s\S]*?mergedWorkers:/,
    'each successful merge checkpoint must remain bound to the exact run/team',
  );
  assert.match(
    source,
    /completePhase\(runId, 'integrate',[\s\S]*?mergedWorkers: mergedWorkerNames\.join\(','\),[\s\S]*?checkpointData:[\s\S]*?worktrees: phase4Worktrees,[\s\S]*?mergedWorkers:/,
    'integrate terminal transition must preserve complete merge evidence',
  );
  assert.match(source, /if \(!mergeCheckpoint\.ok\)[\s\S]*preserve its worktree/);
  assert.ok(
    source.indexOf("const mergeCheckpoint = await saveCheckpoint('athena'")
      < source.indexOf('removeWorkerWorktree(cwd, path, branch)'),
    'Athena must durably checkpoint a successful merge before removing its worktree',
  );
  assert.match(
    source,
    /completePhase\(runId, 'review',[\s\S]*?checkpointData:[\s\S]*?runId,[\s\S]*?teamSlug: reviewSpawnIdentity\.teamSlug,[\s\S]*?worktrees: reviewCheckpoint\.worktrees,[\s\S]*?mergedWorkers: reviewCheckpoint\.mergedWorkers/,
    'Phase 5 must retain integration evidence until terminal cleanup',
  );
  assert.match(source, /const unmergedWorkers = requiredMerges\.filter/);
  assert.match(source, /if \(unmergedWorkers\.length > 0\)[\s\S]*Refusing Athena cleanup with unmerged workers/);
  assert.ok(
    source.indexOf('if (unmergedWorkers.length > 0)')
      < source.indexOf('cleanupTeamWorktrees(cwd, completionSpawnIdentity.teamSlug)'),
    'Athena completion cleanup must be gated on every isolated worker being merged',
  );
  assert.ok(
    source.indexOf('cleanupTeamWorktrees(cwd, completionSpawnIdentity.teamSlug)')
      < source.lastIndexOf("clearCheckpoint('athena')"),
    'Athena must retain its recovery checkpoint until guarded worktree cleanup succeeds',
  );
});

test('adapter supervisor revalidates process identity before descendant group reap', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts/lib/adapter-worker-supervisor.mjs'), 'utf-8');
  assert.match(source, /const expectedStartId = base\?\.adapterStartId \|\| null/);
  assert.match(source, /const currentStartId = readProcStartId\(apid\)/);
  assert.match(source, /if \(expectedStartId && currentStartId !== null && currentStartId !== expectedStartId\) return/);
  assert.ok(
    source.indexOf('currentStartId = readProcStartId(apid)')
      < source.indexOf("process.kill(-apid, 'SIGKILL')"),
    'the supervisor must reject a recycled PID before signalling the adapter group',
  );
});

test('provider fallback lock publishes a complete owner record atomically', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts/lib/worker-spawn.mjs'), 'utf-8');
  assert.match(source, /const intentPath = join\(lockDir,[\s\S]*?openSync\(intentPath, 'wx', 0o600\)/);
  assert.match(source, /writeFileSync\(fd, JSON\.stringify\(owner\)\)[\s\S]*?linkSync\(intentPath, lockPath\)/);
  assert.doesNotMatch(source, /openSync\(lockPath, 'wx'/);
  assert.match(source, /published\?\.token !== owner\.token/);
});

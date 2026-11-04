/** Executable, opt-in dependency scheduler; legacy Athena keeps its one-wave contract. */
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, realpathSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  ensureSafeDirectoryPath,
  readRegularArtifact,
  revalidateDirectoryBinding,
} from './hardened-fs.mjs';
import {
  assertExecutionPrd,
  validateChangedPathsAgainstScope,
  parseNulDelimitedGitPaths,
} from './execution-prd.mjs';
import {
  migrateRuntimeLedger,
  readActiveConcurrencyCounts,
  loadConcurrencyLimits,
  validateWorkerBatchConcurrency,
} from './concurrency-limits.mjs';
import {
  spawnTeam,
  commandWorker,
  collectWorkerCommand,
  monitorTeam,
  shutdownTeam,
} from './worker-spawn.mjs';
import { createWorkerWorktree, mergeWorkerBranch } from './worktree.mjs';
import { probeRuntimeProvider } from './runtime-provider.mjs';
import { resolveTrustedVcsBinary, sanitizedVcsEnvironment } from './trusted-vcs.mjs';
import { readProcStartId } from './proc-identity.mjs';
import { acquireRecoveryClaim, statGeneration } from './recovery-claim.mjs';
export const ATHENA_RUNTIME_SCHEMA_VERSION = 1;
export const ATHENA_TICK_LOCK_SCHEMA_VERSION = 1;

const git = (cwd, args) =>
  execFileSync(resolveTrustedVcsBinary('git'), ['-C', cwd, ...args], {
    env: sanitizedVcsEnvironment({ git: true }),
    maxBuffer: 4 * 1024 * 1024,
  });
const head = (cwd) => git(cwd, ['rev-parse', 'HEAD']).toString().trim();
const clean = (cwd) => {
  if (git(cwd, ['status', '--porcelain', '-z']).length)
    throw new Error('runtime requires a clean committed checkpoint');
};
function location(cwd, id) {
  cwd = realpathSync(cwd);
  if (!/^[0-9a-f]{16}$/.test(id || '')) throw new Error('invalid runtime id');
  const binding = ensureSafeDirectoryPath(join(cwd, '.ao/state/athena-runtime'), 'Athena runtime', {
    trustedRoot: cwd,
  });
  return { binding, file: join(binding.path, `${id}.json`) };
}
function save(cwd, state) {
  const { binding, file } = location(cwd, state.id);
  revalidateDirectoryBinding(binding, 'Athena runtime');
  const text = JSON.stringify(state);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024)
    throw new Error('Athena runtime state exceeds size limit');
  atomicWriteFileSync(file, text, { durable: true });
}
function acquireTickLock(cwd, id) {
  const { binding, file } = location(cwd, id);
  const path = `${file}.lock`,
    ownerPath = join(path, 'owner.json');
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const oldBinding = ensureSafeDirectoryPath(path, 'Athena tick lock', { trustedRoot: cwd });
    const owner = JSON.parse(readRegularArtifact(ownerPath, 'Athena tick owner', 4096).text);
    if (
      owner.schemaVersion !== ATHENA_TICK_LOCK_SCHEMA_VERSION ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 1 ||
      typeof owner.token !== 'string'
    )
      throw new Error('ambiguous tick lock owner');
    const current = readProcStartId(owner.pid);
    let gone = false;
    try {
      process.kill(owner.pid, 0);
    } catch (failure) {
      if (failure.code === 'ESRCH') gone = true;
    }
    if (!gone && !(owner.startId && current && owner.startId !== current))
      throw new Error('another runtime tick is active');
    const generation = statGeneration(lstatSync(path));
    const claim = acquireRecoveryClaim(binding.path, `tick-${id}`, generation, {
      staleMs: 0,
      isGenerationCurrent: () => statGeneration(lstatSync(path)) === generation,
    });
    if (!claim.won) throw new Error('another process is recovering this tick');
    revalidateDirectoryBinding(oldBinding, 'Athena tick lock');
    if (statGeneration(lstatSync(path)) !== generation)
      throw new Error('tick lock generation changed');
    unlinkSync(ownerPath);
    rmdirSync(path);
    mkdirSync(path, { mode: 0o700 });
  }
  const token = randomBytes(16).toString('hex');
  atomicWriteFileSync(
    ownerPath,
    JSON.stringify({
      schemaVersion: ATHENA_TICK_LOCK_SCHEMA_VERSION,
      token,
      pid: process.pid,
      startId: readProcStartId(process.pid),
    }),
    { durable: true }
  );
  return () => {
    const owner = JSON.parse(readRegularArtifact(ownerPath, 'Athena tick owner', 4096).text);
    if (owner.token !== token) throw new Error('tick lock ownership changed');
    unlinkSync(ownerPath);
    rmdirSync(path);
  };
}
export function readAthenaRuntime(cwd, id) {
  cwd = realpathSync(cwd);
  const { binding, file } = location(cwd, id);
  const state = JSON.parse(
    readRegularArtifact(file, 'Athena runtime state', 4 * 1024 * 1024, {
      revalidateContext: () => revalidateDirectoryBinding(binding, 'Athena runtime'),
    }).text
  );
  if (
    state.schemaVersion !== ATHENA_RUNTIME_SCHEMA_VERSION ||
    state.id !== id ||
    state.projectRoot !== resolve(cwd) ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.waves)
  )
    throw new Error('invalid or unsupported Athena runtime state');
  return state;
}
export function readyRuntimeTasks(state) {
  const integrated = new Set(
    state.tasks.filter((task) => task.status === 'integrated').map((task) => task.story.id)
  );
  return state.tasks.filter(
    (task, index) =>
      task.status === 'pending' &&
      (task.story.dependsOn || []).every((id) => integrated.has(id)) &&
      !state.tasks
        .slice(0, index)
        .some(
          (prior) =>
            prior.story.assignedWorker === task.story.assignedWorker &&
            prior.status !== 'integrated'
        )
  );
}
export function createAthenaRuntime({
  cwd = process.cwd(),
  prd,
  verification,
  childCapacity = {},
  _inject = {},
}) {
  cwd = realpathSync(cwd);
  if (cwd !== process.cwd()) throw new Error('run Athena runtime from the project root');
  assertExecutionPrd(prd, {
    orchestrator: 'athena',
    allowDependencyWaves: true,
    allowCompleted: false,
  });
  if (
    !Array.isArray(verification) ||
    !verification.length ||
    verification.some(
      (check) =>
        typeof check.command !== 'string' ||
        !check.command ||
        !Array.isArray(check.args) ||
        check.args.some((arg) => typeof arg !== 'string')
    )
  )
    throw new Error('explicit verification commands are required');
  clean(cwd);
  const providers = [...new Set(prd.userStories.map((story) => story.workerType))];
  const capabilities = providers.map(_inject.probeProvider || probeRuntimeProvider);
  if (capabilities.some((item) => !item.supported))
    throw new Error('one or more managed provider capabilities are unavailable');
  for (const [worker, slots] of Object.entries(childCapacity)) {
    if (
      !prd.userStories.some((story) => story.assignedWorker === worker) ||
      !slots ||
      typeof slots !== 'object' ||
      Array.isArray(slots)
    )
      throw new Error('invalid child capacity owner');
    for (const [provider, count] of Object.entries(slots)) {
      if (
        !['claude', 'codex', 'gemini'].includes(provider) ||
        !Number.isInteger(count) ||
        count < 0 ||
        count > 10
      )
        throw new Error('invalid child capacity');
    }
  }
  migrateRuntimeLedger(cwd);
  const id = randomBytes(8).toString('hex');
  const state = {
    schemaVersion: ATHENA_RUNTIME_SCHEMA_VERSION,
    id,
    projectRoot: cwd,
    status: 'ready',
    expectedHead: head(cwd),
    prdDigest: createHash('sha256').update(JSON.stringify(prd)).digest('hex'),
    verification,
    childCapacity,
    capabilities,
    waves: [],
    tasks: prd.userStories.map((story) => ({ story, status: 'pending' })),
  };
  save(cwd, state);
  return state;
}

async function stopWave(cwd, state, wave) {
  if (wave.shutdownState === 'completed') return;
  const team = monitorTeam(wave.teamName);
  if (!team || team.runId !== wave.runId)
    throw new Error(
      'cannot stop an unproven worker generation; reconcile retained runtime evidence'
    );
  // Record intent before shutdown, which removes team state. A failed cleanup
  // remains retryable; it never permits another assignment or verification.
  wave.shutdownState = 'pending';
  save(cwd, state);
  await shutdownTeam(wave.teamName);
  wave.shutdownState = 'completed';
  save(cwd, state);
}

async function finishFailedRuntime(cwd, state) {
  for (const wave of state.waves.filter(
    (wave) => !wave.verified && wave.shutdownState !== 'completed'
  )) {
    try {
      await stopWave(cwd, state, wave);
      delete wave.cleanupError;
    } catch (error) {
      // Retain uncertain capacity and explain how the operator can reconcile it.
      wave.cleanupError = error.message;
    }
  }
  save(cwd, state);
  return state;
}

async function failRuntime(cwd, state, error) {
  state.status = 'failed';
  state.failure ||= {
    category: error.category || 'runtime_failed',
    message: error.message,
    expectedHead: state.expectedHead,
    observedHead: head(cwd),
    recovery:
      'Inspect retained branches and merge commits before reverting or repairing changes. Start a new run after a clean checkpoint; see docs/internals/athena-runtime.md#failure-and-recovery.',
  };
  for (const task of state.tasks) {
    if (task.status === 'merged') task.status = 'merged_unverified';
    else if (['running', 'launching'].includes(task.status)) task.status = 'cancelled';
  }
  // Failure is durable BEFORE termination starts. A crash resumes cleanup only.
  save(cwd, state);
  return finishFailedRuntime(cwd, state);
}

/** Tick is serialized with an exclusive directory. A crashed tick preserves its lock for inspection. */
export async function tickAthenaRuntime(cwd, id, _inject = {}) {
  cwd = realpathSync(cwd);
  if (resolve(cwd) !== process.cwd()) throw new Error('run Athena runtime from the project root');
  const unlock = acquireTickLock(cwd, id);
  let state;
  try {
    state = readAthenaRuntime(cwd, id);
    if (['completed', 'cancelled'].includes(state.status)) return state;
    if (state.status === 'failed') return await finishFailedRuntime(cwd, state);
    if (head(cwd) !== state.expectedHead)
      throw new Error(
        'integration HEAD changed or prior integration is ambiguous; preserve this run'
      );
    const active = state.waves.find((wave) => !wave.verified);
    if (active) {
      if (active.launchState !== 'launched')
        throw new Error('ambiguous wave launch; preserve worktrees and never respawn blindly');
      const status = monitorTeam(active.teamName);
      if (!status || status.runId !== active.runId)
        throw new Error('active wave identity is unavailable');
      for (const item of active.workers) {
        if (item.integrated) continue;
        const task = state.tasks.find((task) => task.story.id === item.storyId);
        const observed = status.workers.find((worker) => worker.name === item.name);
        if (observed?.status === 'failed') {
          task.status = 'failed';
          task.error = {
            category: observed.errorReason || 'worker_failed',
            message: observed.errorMessage || 'managed worker failed; preserve its subtree',
          };
          return await failRuntime(cwd, state, task.error);
        }
        const result = collectWorkerCommand(active.teamName, item.name, active.runId, item.taskId);
        if (!result || result.status === 'accepted') continue;
        if (result.status !== 'completed') {
          task.status = 'failed';
          task.error = result.error || {
            category: 'worker_failed',
            message: `task ended with ${result.status}`,
          };
          return await failRuntime(cwd, state, task.error);
        }
        if (!item.shutdownId) {
          item.shutdownId = commandWorker(active.teamName, item.name, active.runId, {
            type: 'shutdown',
          }).id;
          save(cwd, state);
          continue;
        }
        const stopped = status.workers.find((worker) => worker.name === item.name);
        if (stopped?.status !== 'completed') continue;
        clean(item.cwd);
        clean(cwd);
        const changed = parseNulDelimitedGitPaths(
          git(item.cwd, ['diff', '--name-only', '-z', active.baseCommit, 'HEAD'])
        );
        if (!validateChangedPathsAgainstScope(changed, task.story.scope).ok)
          throw new Error('worker changed files outside its assigned scope');
        // Persist the merge intent. If a crash follows a Git mutation, HEAD no
        // longer matches expectedHead and resume fails closed before another merge.
        item.mergeState = 'started';
        save(cwd, state);
        const merged = mergeWorkerBranch(cwd, item.branch, item.name);
        if (!merged.success) throw new Error('wave integration failed; worker branch retained');
        state.expectedHead = head(cwd);
        item.mergeCommit = state.expectedHead;
        item.integrated = true;
        item.mergeState = 'done';
        task.status = 'merged';
        save(cwd, state);
      }
      if (active.workers.every((item) => item.integrated)) {
        clean(cwd);
        try {
          for (const check of state.verification) {
            execFileSync(check.command, check.args, {
              cwd,
              timeout: 300000,
              stdio: 'pipe',
              maxBuffer: 8 * 1024 * 1024,
            });
            if (head(cwd) !== state.expectedHead)
              throw new Error('verification changed the committed tree');
            clean(cwd);
          }
        } catch (error) {
          error.category = 'verification_failed';
          throw error;
        }
        await stopWave(cwd, state, active);
        active.verified = true;
        for (const item of active.workers)
          state.tasks.find((task) => task.story.id === item.storyId).status = 'integrated';
        save(cwd, state);
      } else return state;
    }
    const ready = readyRuntimeTasks(state);
    if (!ready.length) {
      state.status = state.tasks.every((task) => task.status === 'integrated')
        ? 'completed'
        : 'blocked';
      save(cwd, state);
      return state;
    }
    const counts = readActiveConcurrencyCounts(cwd),
      limits = loadConcurrencyLimits();
    const chosen = [],
      requested = [];
    for (const task of ready) {
      const slots = [{ type: task.story.workerType }];
      for (const [type, count] of Object.entries(
        state.childCapacity[task.story.assignedWorker] || {}
      )) {
        if (!Number.isInteger(count) || count < 0 || count > 10)
          throw new Error('invalid planned child capacity');
        slots.push(...Array(count).fill({ type }));
      }
      if (validateWorkerBatchConcurrency([...requested, ...slots], { limits, active: counts }).ok) {
        chosen.push(task);
        requested.push(...slots);
      }
    }
    if (!chosen.length) {
      state.status = 'waiting_capacity';
      save(cwd, state);
      return state;
    }
    clean(cwd);
    const wave = {
      teamName: `runtime-${id}-${state.waves.length}`,
      runId: randomBytes(8).toString('hex'),
      baseCommit: state.expectedHead,
      launchState: 'prepared',
      verified: false,
      workers: [],
    };
    state.waves.push(wave);
    save(cwd, state);
    const workers = [];
    for (const task of chosen) {
      const name = `worker-${randomBytes(8).toString('hex')}`;
      const worktree = createWorkerWorktree(cwd, wave.teamName, name, { onExisting: 'fail' });
      if (!worktree.created) throw new Error(worktree.error);
      wave.workers.push({
        name,
        storyId: task.story.id,
        cwd: worktree.worktreePath,
        branch: worktree.branchName,
      });
      task.status = 'launching';
      save(cwd, state);
      workers.push({
        name,
        type: task.story.workerType,
        model: task.story.workerType === 'claude' ? task.story.model : undefined,
        cwd: worktree.worktreePath,
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        scope: task.story.scope,
        managed: true,
        persistent: true,
        childCapacity: state.childCapacity[task.story.assignedWorker] || {},
        ...(_inject.fixtureForStory ? { fixture: _inject.fixtureForStory(task.story) } : {}),
        prompt: `Execute this Athena story in ${worktree.worktreePath}. You are not alone: stay within your assigned scope. Use ao_runtime MCP tools for child delegation; native delegation is disabled. Commit only your assigned changes to your own branch before reporting completion. Integrate/observe or explicitly discard every child result and run the acceptance checks.\n${JSON.stringify(task.story)}`,
      });
    }
    wave.launchState = 'started';
    save(cwd, state);
    const team = await spawnTeam(
      wave.teamName,
      workers,
      cwd,
      {
        hasClaudeCli: true,
        hasCodexExecJson: true,
        hasCodexAppServer: true,
        hasGeminiCli: true,
        hasGeminiAcp: true,
      },
      { ...(_inject.spawnOptions || {}), runId: wave.runId }
    );
    for (const item of wave.workers) {
      item.taskId = team.workers.find((worker) => worker.name === item.name)._handle?.workerRunId;
      if (!item.taskId) throw new Error('worker launch did not produce durable task identity');
      state.tasks.find((task) => task.story.id === item.storyId).status = 'running';
    }
    wave.launchState = 'launched';
    state.status = 'running';
    save(cwd, state);
    return state;
  } catch (error) {
    if (!state) throw error;
    return await failRuntime(cwd, state, error);
  } finally {
    unlock();
  }
}
export async function cancelAthenaRuntime(cwd, id) {
  cwd = realpathSync(cwd);
  if (cwd !== process.cwd()) throw new Error('run Athena runtime from the project root');
  const unlock = acquireTickLock(cwd, id);
  try {
    const state = readAthenaRuntime(cwd, id);
    for (const wave of state.waves.filter((wave) => !wave.verified)) {
      await stopWave(cwd, state, wave);
    }
    state.status = 'cancelled';
    save(cwd, state);
    return state;
  } finally {
    unlock();
  }
}

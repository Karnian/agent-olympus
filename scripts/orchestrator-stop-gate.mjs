#!/usr/bin/env node

/**
 * Skill-scoped Stop gate for Atlas.
 *
 * A still-active run gets one deterministic continuation nudge. Claude Code
 * sets stop_hook_active on the resulting Stop event; that second event is
 * always allowed so this hook cannot create an infinite stop loop.
 */

import { fileURLToPath } from 'node:url';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readStdin } from './lib/stdin.mjs';
import { getActiveRunId, getRun } from './lib/run-artifacts.mjs';
import {
  getPhaseSequence,
  getPipelineState,
  isComplete,
} from './lib/phase-runner.mjs';

const RUNTIME = '"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-runtime.mjs"';
const TERMINAL_PHASE_STATUSES = new Set(['completed', 'skipped']);

function allow() {
  return {};
}

function block(reason) {
  return { decision: 'block', reason };
}

function currentPhase(pipeline) {
  return getPhaseSequence('atlas').find(({ id }) => (
    !TERMINAL_PHASE_STATUSES.has(pipeline.phases?.[id]?.status)
  ))?.id ?? null;
}

export function inProgressTransition(runId, phase) {
  if (phase === 'verify') {
    return `${RUNTIME} complete-verification atlas ${runId} <sealed-generation-id>`;
  }
  if (phase === 'review') {
    return `${RUNTIME} complete-review atlas ${runId} <approved-review-digest>`;
  }
  if (phase === 'finalize') {
    return `${RUNTIME} complete-finalize atlas ${runId} <final-review-approval-digest>`;
  }
  return `${RUNTIME} complete atlas ${runId} ${phase} [allowlisted-key=value ...]`;
}

export function pendingTransition(runId, phase) {
  const descriptor = getPhaseSequence('atlas').find(({ id }) => id === phase);
  const skipReasons = descriptor?.skippableWhen ?? [];
  if (skipReasons.length > 0) {
    return `${RUNTIME} status atlas ${runId}; then use ${RUNTIME} skip atlas ${runId} ${phase} <${skipReasons.join('|')}> when applicable, otherwise ${RUNTIME} enter atlas ${runId} ${phase}`;
  }
  return `${RUNTIME} enter atlas ${runId} ${phase}`;
}

function rawActivePointerState(cwd = process.cwd()) {
  const aoDir = join(cwd, '.ao');
  const stateDir = join(aoDir, 'state');
  const pointerPath = join(stateDir, 'ao-active-run-atlas.json');
  for (const [path, kind] of [[aoDir, 'directory'], [stateDir, 'directory'], [pointerPath, 'pointer']]) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { present: false, unsafe: false };
      return { present: true, unsafe: true };
    }
    if (kind === 'directory' && (!stat.isDirectory() || stat.isSymbolicLink())) {
      return { present: true, unsafe: true };
    }
    if (kind === 'pointer') {
      return {
        present: true,
        unsafe: !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1,
      };
    }
  }
  return { present: false, unsafe: false };
}

/**
 * Handle a parsed Stop hook payload.
 *
 * @param {unknown} data
 * @returns {object}
 */
export function handleAtlasStop(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return block('Atlas Stop gate could not verify hook input; preserve the active run and retry once.');
  }
  if (data.hook_event_name !== undefined && data.hook_event_name !== 'Stop') return allow();
  if (data.stop_hook_active === true) return allow();

  const runId = getActiveRunId('atlas');
  if (!runId) {
    const rawPointer = rawActivePointerState();
    if (rawPointer.present || rawPointer.unsafe) {
      return block(
        'Atlas active-run pointer exists but is malformed or unsafe. '
        + 'Fail closed: preserve .ao artifacts and repair or remove the pointer only through a verified recovery path.',
      );
    }
    return allow();
  }

  const summary = getRun(runId).summary;
  if (summary?.runId !== runId || summary?.orchestrator !== 'atlas') {
    return block(`Atlas run ${runId} is active but its summary cannot be verified. Do not create a replacement run.`);
  }
  if (summary.status === 'completed') {
    return block(
      `Atlas run ${runId} is completed but its active pointer remains after an interrupted finalization. `
      + `Run the idempotent finalize/clear recovery: ${RUNTIME} finalize atlas ${runId}`,
    );
  }
  if (summary.status !== 'running') {
    return block(`Atlas run ${runId} has an unsafe status (${String(summary.status)}). Preserve artifacts and stop mutation.`);
  }

  const pipeline = getPipelineState(runId, { cwd: process.cwd() });
  if (pipeline?.runId !== runId || pipeline?.orchestrator !== 'atlas') {
    return block(
      `Atlas run ${runId} is incomplete and its pipeline cannot be verified. `
      + `Diagnostic CLI: ${RUNTIME} status atlas ${runId}`,
    );
  }

  if (isComplete(runId, { cwd: process.cwd() })) {
    return block(
      `Atlas run ${runId} is not finalized. Next phase: finalize-run. `
      + `Run: ${RUNTIME} finalize atlas ${runId}`,
    );
  }

  const phase = currentPhase(pipeline) ?? 'unavailable';
  const phaseStatus = pipeline.phases?.[phase]?.status ?? 'pending';
  const transition = phaseStatus === 'in_progress'
    ? inProgressTransition(runId, phase)
    : pendingTransition(runId, phase);
  const instruction = phaseStatus === 'in_progress'
    ? 'Finish and verify the phase work before running'
    : 'Resolve the pending phase with';

  return block(
    `Atlas run ${runId} is incomplete. Next phase: ${phase} (${phaseStatus}). `
    + `${instruction}: ${transition}. `
    + `Status CLI: ${RUNTIME} status atlas ${runId}`,
  );
}

export async function main() {
  if (process.env.DISABLE_AO === '1') {
    process.stdout.write('{}\n');
    return 0;
  }

  let output;
  try {
    const raw = await readStdin(3000);
    output = handleAtlasStop(JSON.parse(raw));
  } catch {
    output = block('Atlas Stop gate could not parse hook input; preserve the active run and retry once.');
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exitCode = await main();
}

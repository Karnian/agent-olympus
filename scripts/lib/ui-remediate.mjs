/**
 * UI Remediation chain helper (v1.0.2 US-008)
 *
 * Orchestrates the sequential frontend remediation pipeline:
 *   audit → normalize → polish → re-audit
 *
 * Key design constraints:
 *  - Strict sequential order (NO parallel execution — 1 active worker per stage)
 *  - Runs ONCE (no retry loop) — re-audit is a convergence gate, not a retry trigger
 *  - NO harden stage (out of scope v1.0.2)
 *  - Each stage receives ONLY the prior stage's outbox payload (not full history)
 *  - Writes .ao/artifacts/runs/<runId>/ui-remediation.json (schemaVersion: 1)
 *  - Chain halts on any stage failure; artifact still written on halt
 *  - Re-audit regression (finalCount > initialCount) → abort with regression:true
 *  - Re-audit unchanged → warn but continue (ok:true)
 *
 * Public API:
 *   STAGES                              — string[] canonical stage order
 *   buildChain({target})               — StageDescriptor[] (static chain definition)
 *   computeConvergence({initialSmellCount, finalSmellCount})
 *                                       — { status, delta, initialSmellCount, finalSmellCount, regressed }
 *   runChain({target, runId, artifactBase, executor})
 *                                       — Promise<ChainResult>
 *
 * executor({stage, target, inbox}) interface:
 *   Must return { ok, smellCount, summary?, filesTouched?, timeElapsed?, outbox?, error? }
 *   May throw — runChain catches and treats as stage failure.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './fs-atomic.mjs';

/**
 * Canonical stage names in strict execution order.
 * @type {string[]}
 */
export const STAGES = ['audit', 'normalize', 'polish', 're-audit'];

/**
 * Human-readable skill mapping per stage.
 */
const STAGE_META = {
  audit: {
    description: 'Run ui-review to establish baseline smell count',
    skill: 'ui-review',
  },
  normalize: {
    description: 'Replace hardcoded values with design tokens',
    skill: 'normalize',
  },
  polish: {
    description: 'Apply final-pass refinements without structural change',
    skill: 'polish',
  },
  're-audit': {
    description: 'Re-run ui-review and compare smell counts for convergence',
    skill: 'ui-review',
  },
};

/**
 * Build the static chain definition for a given target.
 * Returns an array of stage descriptors in strict order.
 *
 * @param {{ target: string }} options
 * @returns {Array<{ name: string, description: string, skill: string, target: string }>}
 */
export function buildChain({ target } = {}) {
  if (!target || typeof target !== 'string' || target.trim() === '') {
    throw new Error('buildChain: target (file or component path) is required');
  }
  return STAGES.map((name) => ({
    name,
    description: STAGE_META[name].description,
    skill: STAGE_META[name].skill,
    target: target.trim(),
  }));
}

/**
 * Compute convergence between initial and final smell counts.
 *
 * @param {{ initialSmellCount: number, finalSmellCount: number }} opts
 * @returns {{ status: 'improved'|'unchanged'|'regressed', delta: number,
 *             initialSmellCount: number, finalSmellCount: number, regressed: boolean }}
 */
export function computeConvergence({ initialSmellCount, finalSmellCount } = {}) {
  if (initialSmellCount === undefined || initialSmellCount === null) {
    throw new Error('computeConvergence: initialSmellCount is required');
  }
  if (finalSmellCount === undefined || finalSmellCount === null) {
    throw new Error('computeConvergence: finalSmellCount is required');
  }
  if (typeof initialSmellCount !== 'number' || isNaN(initialSmellCount)) {
    throw new TypeError('computeConvergence: initialSmellCount must be a number');
  }
  if (typeof finalSmellCount !== 'number' || isNaN(finalSmellCount)) {
    throw new TypeError('computeConvergence: finalSmellCount must be a number');
  }

  const delta = finalSmellCount - initialSmellCount;
  let status;
  if (delta < 0) {
    status = 'improved';
  } else if (delta === 0) {
    status = 'unchanged';
  } else {
    status = 'regressed';
  }

  return {
    status,
    delta,
    initialSmellCount,
    finalSmellCount,
    regressed: status === 'regressed',
  };
}

/**
 * Run the full remediation chain exactly once.
 *
 * @param {{
 *   target: string,
 *   runId: string,
 *   artifactBase: string,
 *   executor: (opts: { stage: string, target: string, inbox: object|null }) => Promise<StageOutput>
 * }} opts
 * @returns {Promise<ChainResult>}
 */
export async function runChain({ target, runId, artifactBase, executor } = {}) {
  // Validate required params up front
  if (!runId || typeof runId !== 'string') {
    throw new Error('runChain: runId is required');
  }
  if (!executor || typeof executor !== 'function') {
    throw new Error('runChain: executor function is required');
  }
  if (!target || typeof target !== 'string' || target.trim() === '') {
    throw new Error('runChain: target is required');
  }
  if (!artifactBase || typeof artifactBase !== 'string') {
    throw new Error('runChain: artifactBase is required');
  }

  const chain = buildChain({ target });
  const startedAt = new Date().toISOString();
  const stageRecords = [];

  let initialSmellCount = 0;
  let prevOutbox = null;
  let haltedAt = null;
  let chainError = null;
  let regression = false;
  let convergence = null;

  // ── sequential stage execution ──────────────────────────────────────────
  for (const stageDef of chain) {
    const stageStart = Date.now();
    let stageResult;

    try {
      stageResult = await executor({
        stage: stageDef.name,
        target: stageDef.target,
        inbox: prevOutbox,
      });
    } catch (err) {
      // Executor threw — treat as stage failure
      stageResult = {
        ok: false,
        error: err && err.message ? err.message : String(err),
        smellCount: 0,
        summary: `${stageDef.name} executor threw an error`,
        filesTouched: [],
      };
    }

    const elapsed = Date.now() - stageStart;

    const record = {
      name: stageDef.name,
      status: stageResult.ok ? 'success' : 'failure',
      summary: stageResult.summary ?? '',
      filesTouched: stageResult.filesTouched ?? [],
      smellCount: typeof stageResult.smellCount === 'number' ? stageResult.smellCount : 0,
      timeElapsed: typeof stageResult.timeElapsed === 'number' ? stageResult.timeElapsed : elapsed,
      ...(stageResult.error ? { error: stageResult.error } : {}),
    };
    stageRecords.push(record);

    // Capture initial smell count from the first stage (audit)
    if (stageDef.name === 'audit') {
      initialSmellCount = record.smellCount;
    }

    // Stage failure → halt chain
    if (!stageResult.ok) {
      haltedAt = stageDef.name;
      chainError = stageResult.error ?? `${stageDef.name} stage failed`;
      break;
    }

    // Pass only the current stage outbox to the next stage
    prevOutbox = stageResult.outbox ?? { stage: stageDef.name, smellCount: record.smellCount };

    // Re-audit convergence check
    if (stageDef.name === 're-audit') {
      convergence = computeConvergence({
        initialSmellCount,
        finalSmellCount: record.smellCount,
      });

      if (convergence.regressed) {
        regression = true;
        chainError = `Re-audit regression: smell count increased from ${initialSmellCount} to ${record.smellCount}`;
      }
      // unchanged is a warning only — chain still succeeds
    }
  }

  const completedAt = new Date().toISOString();
  const stagesCompleted = stageRecords.length;
  const ok = !haltedAt && !regression;

  // ── write artifact (always — even on halt/regression) ──────────────────
  const artifactDir = path.join(artifactBase, runId);
  const artifactData = {
    schemaVersion: 1,
    runId,
    target,
    startedAt,
    completedAt,
    ok,
    stagesCompleted,
    ...(haltedAt ? { haltedAt } : {}),
    ...(chainError ? { error: chainError } : {}),
    ...(regression ? { regression: true } : {}),
    ...(convergence ? { convergence } : {}),
    stages: stageRecords,
  };

  try {
    await fsp.mkdir(artifactDir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(
      path.join(artifactDir, 'ui-remediation.json'),
      JSON.stringify(artifactData, null, 2) + '\n',
    );
  } catch {
    // Artifact write failure is non-fatal — return the result regardless
  }

  return {
    ok,
    stagesCompleted,
    ...(haltedAt ? { haltedAt } : {}),
    ...(chainError ? { error: chainError } : {}),
    ...(regression ? { regression: true } : {}),
    ...(convergence ? { convergence } : {}),
  };
}

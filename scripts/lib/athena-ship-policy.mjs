import { loadAutonomyConfig, resolveRunShipMode } from './autonomy.mjs';
import { getRun, getUserTaskUpdates } from './run-artifacts.mjs';

function readDurableTaskBrief(runId, action) {
  const runRecord = getRun(runId);
  const strictUpdates = getUserTaskUpdates(runId);
  if (runRecord.summary?.runId !== runId
    || runRecord.summary?.orchestrator !== 'athena'
    || typeof runRecord.summary?.task !== 'string'
    || !runRecord.summary.task.trim()
    || strictUpdates.ok !== true
    || strictUpdates.updates.length < 1
    || strictUpdates.updates.some((update, index) => (
      update?.sequence !== index + 1
      || typeof update?.task !== 'string'
      || !update.task.trim()
    ))) {
    throw new Error(`Athena durable task provenance is unavailable before ${action}; stop outward actions`);
  }
  return [
    runRecord.summary.task,
    ...strictUpdates.updates.map(update => update.task),
  ];
}

export function resolveAthenaShipPolicy(runId, action) {
  const config = loadAutonomyConfig(process.cwd());
  const resolved = resolveRunShipMode(config, readDurableTaskBrief(runId, action));
  return { config, configuredShipMode: resolved.configuredMode,
    taskForbidsShipping: resolved.taskForbidsShipping, shipMode: resolved.effectiveMode,
    noShip: resolved.effectiveMode === 'never' };
}

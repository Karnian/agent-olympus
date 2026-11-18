#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { estimateCost } from './lib/cost-estimate.mjs';
import { assertExecutionPrd, buildAthenaWorkerDefinitions, buildAtlasStoryDefinitions } from './lib/execution-prd.mjs';

try {
  const prd = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const athena = prd.userStories?.[0]?.workerType !== undefined;
  const mode = process.argv[3];
  if (process.argv.length > 4 || (mode !== undefined && mode !== '--managed')) {
    throw new Error('Usage: estimate-prd-cost.mjs <execution-prd> [--managed]');
  }
  let workers;
  if (mode === '--managed') {
    assertExecutionPrd(prd, { orchestrator: 'athena', allowDependencyWaves: true });
    workers = prd.userStories.map(story => ({
      type: story.workerType,
      model: story.model ?? (story.workerType === 'claude' ? 'sonnet' : undefined),
    }));
  } else {
    workers = athena ? buildAthenaWorkerDefinitions(prd) : buildAtlasStoryDefinitions(prd);
  }
  const counts = new Map();
  for (const worker of workers) {
    // Atlas external stories carry a Claude tier for fallback, not a provider model.
    const model = athena || worker.type === 'claude' ? worker.model ?? worker.type : worker.type;
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  const modelTiers = Array.from(counts, ([model, count]) => ({ model, count }));
  console.log(JSON.stringify(estimateCost({ modelTiers })));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

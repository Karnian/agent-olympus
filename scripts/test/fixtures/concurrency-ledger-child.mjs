import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  releaseConcurrencyReservation,
  reserveWorkerBatchConcurrency,
} from '../../lib/concurrency-limits.mjs';

const [action, cwd, identity, readyPath, startPath, resultPath, finishPath] = process.argv.slice(2);

function writeResult(value) {
  writeFileSync(resultPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
}

if (action === 'reserve') {
  writeFileSync(readyPath, 'ready', { encoding: 'utf8', mode: 0o600 });
  while (!existsSync(startPath)) await sleep(5);
  const result = reserveWorkerBatchConcurrency(cwd, [{
    name: identity,
    type: 'claude',
    model: 'test',
  }], {
    teamName: identity,
    runId: identity === 'racer-a' ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb',
    limits: { global: 1, claude: 1, codex: 1, gemini: 1 },
  });
  writeResult(result);
  // Keep the winning reservation owner live until the parent has tested a
  // release from an independent process. Otherwise stale-owner reclamation is
  // correctly allowed and both sequentially scheduled racers could be admitted.
  while (!existsSync(finishPath)) await sleep(5);
} else if (action === 'release') {
  writeResult(releaseConcurrencyReservation(cwd, identity));
} else {
  writeResult({ ok: false, error: `unknown action: ${action}` });
}

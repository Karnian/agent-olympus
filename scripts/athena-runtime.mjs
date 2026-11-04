#!/usr/bin/env node
/** Explicit managed Athena entry point. Never merges a PR or publishes automatically. */
import { readFileSync } from 'node:fs';
import { createAthenaRuntime, readAthenaRuntime, tickAthenaRuntime, cancelAthenaRuntime } from './lib/athena-scheduler.mjs';
import { probeRuntimeProvider } from './lib/runtime-provider.mjs';
import { migrateRuntimeLedger, inspectRuntimeReservations, reconcileRuntimeReservation } from './lib/concurrency-limits.mjs';
import { commandWorker, collectWorkerCommand } from './lib/worker-spawn.mjs';
const [action, ...args] = process.argv.slice(2);
try {
  let result;
  if (action === 'capabilities') result = ['claude', 'codex', 'gemini'].map(probeRuntimeProvider);
  else if (action === 'migrate') result = migrateRuntimeLedger(process.cwd(), { downgrade: args[0] === '--downgrade' });
  else if (action === 'reservations') result = inspectRuntimeReservations(process.cwd());
  else if (action === 'reconcile') {
    if (args.length !== 3 || args[2] !== '--confirm-stopped') throw new Error('reconcile requires <parent-entry-id> <digest> --confirm-stopped; stop and inspect all run processes first');
    result = reconcileRuntimeReservation(process.cwd(), args[0], { digest: args[1], confirmStopped: true });
  }
  else if (action === 'start') {
    if (args.length !== 2) throw new Error('start requires PRD and runtime-options JSON file paths');
    const options = JSON.parse(readFileSync(args[1], 'utf8'));
    result = createAthenaRuntime({ cwd: process.cwd(), prd: JSON.parse(readFileSync(args[0], 'utf8')),
      verification: options.verification, childCapacity: options.childCapacity });
  } else if (action === 'tick') result = await tickAthenaRuntime(process.cwd(), args[0]);
  else if (action === 'status') result = readAthenaRuntime(process.cwd(), args[0]);
  else if (action === 'cancel') result = await cancelAthenaRuntime(process.cwd(), args[0]);
  else if (action === 'command') {
    const [team, worker, generation, commandPath] = args;
    result = commandWorker(team, worker, generation, JSON.parse(readFileSync(commandPath, 'utf8')));
  } else if (action === 'result') result = collectWorkerCommand(...args);
  else throw new Error('use capabilities | migrate [--downgrade] | reservations | reconcile <parent-entry-id> <digest> --confirm-stopped | start <prd.json> <options.json> | tick/status/cancel <run-id> | command <team> <worker> <generation> <command.json> | result <team> <worker> <generation> <command-id>');
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }

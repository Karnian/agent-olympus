#!/usr/bin/env node
import { readStdin } from './lib/stdin.mjs';
import { detectProvider } from './lib/provider-detect.mjs';
import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './lib/fs-atomic.mjs';

const STATE_DIR = join(process.cwd(), '.ao', 'state');
const STATE_FILE = join(STATE_DIR, 'ao-concurrency.json');

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { activeTasks: [] }; }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  try {
    const raw = await readStdin(3000);
    if (!raw) { process.stdout.write('{}'); process.exit(0); }
    const data = JSON.parse(raw);

    if (data.tool_name !== 'Task' && data.tool_name !== 'Agent') {
      process.stdout.write('{}');
      process.exit(0);
    }

    const provider = detectProvider(data.tool_input ?? {});
    const state = readState();
    const now = Date.now();

    // Remove oldest task matching the provider, also prune stale (>10 min)
    let released = false;
    state.activeTasks = (state.activeTasks || []).filter(t => {
      const age = now - new Date(t.startedAt || 0).getTime();
      if (age > 600000) return false; // prune stale
      if (!released && t.provider === provider) {
        released = true;
        return false; // release the oldest matching task
      }
      return true;
    });

    writeState(state);
    process.stdout.write('{}');
    process.exit(0);
  } catch {
    process.stdout.write('{}');
    process.exit(0);
  }
}

main();

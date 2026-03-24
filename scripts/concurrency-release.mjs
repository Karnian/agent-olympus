import { readStdin } from './lib/stdin.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STATE_DIR = '.ao/state';
const STATE_FILE = join(STATE_DIR, 'ao-concurrency.json');

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { activeTasks: [] }; }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
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

    const taskId = data.tool_input?.name || data.tool_input?.description || '';
    const state = readState();

    // Remove matching task
    state.activeTasks = (state.activeTasks || []).filter(t => {
      if (t.id === taskId || t.name === taskId) return false;
      // Also prune stale (>10 min)
      if (Date.now() - (t.startedAt || 0) > 600000) return false;
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

import { readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync, atomicMoveSync } from './fs-atomic.mjs';

const TEAMS_DIR = '.ao/teams';

function teamDir(teamName, workerName) {
  return join(TEAMS_DIR, teamName, workerName);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function sendMessage(teamName, fromWorker, toWorker, body) {
  const dir = join(teamDir(teamName, toWorker), 'inbox');
  ensureDir(dir);

  const msg = {
    id: randomUUID(),
    from: fromWorker,
    to: toWorker,
    body,
    timestamp: new Date().toISOString()
  };

  const filename = `${Date.now()}-${msg.id.slice(0, 8)}.json`;
  atomicWriteFileSync(join(dir, filename), JSON.stringify(msg, null, 2));

  return msg.id;
}

export function readInbox(teamName, workerName, opts = {}) {
  const dir = join(teamDir(teamName, workerName), 'inbox');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort(); // chronological by timestamp prefix

  const messages = [];
  for (const file of files) {
    try {
      const msg = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      messages.push({ ...msg, _file: file });
    } catch {}
  }

  // Auto-cleanup if requested
  if (opts.consume) {
    const processedDir = join(teamDir(teamName, workerName), 'processed');
    // ensureDir not needed here — atomicMoveSync creates the directory if absent
    for (const msg of messages) {
      try {
        // Atomic rename: crash between read and move cannot cause double-processing
        atomicMoveSync(
          join(dir, msg._file),
          join(processedDir, msg._file)
        );
      } catch {}
    }
  }

  return messages.map(({ _file, ...msg }) => msg);
}

export function writeOutbox(teamName, workerName, body) {
  const dir = join(teamDir(teamName, workerName), 'outbox');
  ensureDir(dir);

  const msg = {
    id: randomUUID(),
    from: workerName,
    body,
    timestamp: new Date().toISOString()
  };

  const filename = `${Date.now()}-${msg.id.slice(0, 8)}.json`;
  atomicWriteFileSync(join(dir, filename), JSON.stringify(msg, null, 2));

  return msg.id;
}

export function readOutbox(teamName, workerName) {
  const dir = join(teamDir(teamName, workerName), 'outbox');
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

export function readAllOutboxes(teamName) {
  const baseDir = join(TEAMS_DIR, teamName);
  if (!existsSync(baseDir)) return {};

  const results = {};
  for (const workerDir of readdirSync(baseDir)) {
    const outbox = readOutbox(teamName, workerDir);
    if (outbox.length > 0) {
      results[workerDir] = outbox;
    }
  }
  return results;
}

export function broadcast(teamName, fromWorker, body, workerNames) {
  const ids = [];
  for (const to of workerNames) {
    if (to !== fromWorker) {
      ids.push(sendMessage(teamName, fromWorker, to, body));
    }
  }
  return ids;
}

export function cleanupTeam(teamName) {
  const baseDir = join(TEAMS_DIR, teamName);
  if (!existsSync(baseDir)) return;

  // Recursive delete
  const rmrf = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) rmrf(fullPath);
      else unlinkSync(fullPath);
    }
    try { rmdirSync(dir); } catch {}
  };

  rmrf(baseDir);
}

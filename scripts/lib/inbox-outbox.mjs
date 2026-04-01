import { readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmdirSync } from 'fs';
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
    for (const msg of messages) {
      try {
        // Atomic rename: crash between read and move cannot cause double-processing
        atomicMoveSync(
          join(dir, msg._file),
          join(processedDir, msg._file)
        );
      } catch (err) {
        // Log failed moves so orchestrator can detect message processing issues
        try {
          const errFile = join(teamDir(teamName, workerName), 'failed-moves.log');
          const line = `${new Date().toISOString()} FAILED ${msg._file}: ${err?.message || 'unknown'}\n`;
          appendFileSync(errFile, line, { encoding: 'utf-8', mode: 0o600 });
        } catch {
          // fail-safe: don't break consume loop on logging failure
        }
      }
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

/**
 * Write an entry to the team's shared blackboard.
 * The blackboard is an append-only JSONL file where workers record
 * discoveries, decisions, and warnings for the whole team to reference.
 *
 * @param {string} teamName
 * @param {string} workerName - Who wrote this entry
 * @param {{ category: string, content: string }} entry
 *   category: 'discovery' | 'decision' | 'warning' | 'api-note'
 * @returns {string} Entry ID
 */
export function writeBlackboard(teamName, workerName, entry) {
  try {
    const dir = join(TEAMS_DIR, teamName);
    ensureDir(dir);

    const record = {
      id: randomUUID(),
      from: workerName,
      category: (entry && entry.category) ? entry.category : 'general',
      content: (entry && entry.content !== undefined) ? entry.content : '',
      timestamp: new Date().toISOString()
    };

    const blackboardPath = join(dir, 'blackboard.jsonl');
    appendFileSync(blackboardPath, JSON.stringify(record) + '\n', { encoding: 'utf-8', mode: 0o600 });

    return record.id;
  } catch {
    // fail-safe: return a UUID even on error so callers don't break
    return randomUUID();
  }
}

/**
 * Read entries from the team's shared blackboard.
 *
 * @param {string} teamName
 * @param {{ category?: string, limit?: number, since?: string }} [opts]
 *   category: filter to entries matching this category
 *   limit:    return only the most recent N entries
 *   since:    ISO date string — only return entries after this time
 * @returns {Array<{ id, from, category, content, timestamp }>}
 */
export function readBlackboard(teamName, opts = {}) {
  try {
    const blackboardPath = join(TEAMS_DIR, teamName, 'blackboard.jsonl');
    if (!existsSync(blackboardPath)) return [];

    const raw = readFileSync(blackboardPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    let entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    // Filter by category
    if (opts.category) {
      entries = entries.filter(e => e.category === opts.category);
    }

    // Filter by since (ISO date string — only entries strictly after this time)
    if (opts.since) {
      const sinceMs = new Date(opts.since).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() > sinceMs);
    }

    // Apply limit — most recent N
    if (opts.limit !== undefined && opts.limit >= 0) {
      entries = entries.slice(-opts.limit);
    }

    return entries;
  } catch {
    return [];
  }
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

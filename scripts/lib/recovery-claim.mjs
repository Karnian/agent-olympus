/** One-shot election claim for reclaiming an exact stale filesystem generation. */

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProcStartId } from './proc-identity.mjs';

/**
 * Elect exactly one recoverer for `generation`. Claims are intentionally not
 * deleted: a caller holding an old observation can never win again after a new
 * owner is published at the same pathname.
 */
export function acquireRecoveryClaim(dir, namespace, generation) {
  const digest = createHash('sha256').update(String(generation)).digest('hex');
  const path = join(dir, `.${namespace}-recovery-${digest}.claim`);
  const owner = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    startId: readProcStartId(process.pid),
    generationDigest: digest,
    createdAt: new Date().toISOString(),
  };
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8');
    closeSync(fd);
    return { won: true, path, owner };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    if (error?.code === 'EEXIST') return { won: false, path, owner: null };
    throw error;
  }
}

export function statGeneration(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

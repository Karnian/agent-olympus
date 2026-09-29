/**
 * Detached reaper for a Codex process released at turn.completed.
 *
 * codex-exec's release() lets the caller exit while Codex finishes its own
 * teardown (plugins, MCP servers, SessionEnd hooks). Nobody is left to run the
 * issue #74 process-group reap, so release() starts this script detached. It
 * waits for the Codex group leader to exit on its own, then SIGTERMs whatever
 * is left in its process group and SIGKILLs any survivor after a grace period.
 * A leader still alive at the deadline is terminated the same way so a hung
 * teardown cannot linger forever, but only when its start identity is known:
 * a changed or unknown identity means the PID may belong to another process.
 * POSIX only; codex-exec never releases a handle on Windows.
 *
 * Usage: node codex-release-reaper.mjs <pid> [startId]
 */

import { pathToFileURL } from 'node:url';
import { readProcStartId } from './proc-identity.mjs';

export const RELEASE_REAP_DEADLINE_MS = 30000;
const POLL_MS = 250;
const KILL_GRACE_MS = 2000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isGroupAlive(pid) {
  return isAlive(-pid);
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

/**
 * @returns {Promise<'reaped'|'terminated'|'reused'|'unverified'>}
 */
export async function reapReleasedGroup({
  pid,
  startId = null,
  deadlineMs = RELEASE_REAP_DEADLINE_MS,
  pollMs = POLL_MS,
  graceMs = KILL_GRACE_MS,
  alive = isAlive,
  groupAlive = isGroupAlive,
  readStartId = readProcStartId,
  killGroup = signalGroup,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const identity = startId || readStartId(pid);
  const reused = () => {
    if (!identity) return false;
    const current = readStartId(pid);
    return current !== null && current !== identity;
  };

  const deadline = now() + deadlineMs;
  let outcome = 'reaped';
  while (alive(pid)) {
    if (reused()) return 'reused';
    if (now() >= deadline) {
      // Without a start identity a live PID may not be Codex any more.
      if (!identity) return 'unverified';
      outcome = 'terminated';
      break;
    }
    await sleep(pollMs);
  }

  // Once the leader has exited, the PGID cannot be reused while any member
  // of the group is still alive, so group signals reach only its survivors.
  killGroup(pid, 'SIGTERM');
  await sleep(graceMs);
  if (groupAlive(pid) && !reused()) killGroup(pid, 'SIGKILL');
  return outcome;
}

async function main() {
  const pid = Number(process.argv[2]);
  if (!Number.isInteger(pid) || pid <= 1) return;
  await reapReleasedGroup({ pid, startId: process.argv[3] || null });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {}).finally(() => process.exit(0));
}

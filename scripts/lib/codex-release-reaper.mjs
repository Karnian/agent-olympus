/**
 * Detached reaper for a Codex process released at turn.completed.
 *
 * codex-exec's release() lets the caller exit while Codex finishes its own
 * teardown (plugins, MCP servers, SessionEnd hooks). Nobody is left to run the
 * issue #74 process-group reap, so release() starts this script detached. It
 * waits for the Codex group leader to exit on its own, then SIGTERMs whatever
 * is left in its process group and SIGKILLs any survivor after a grace period.
 * It needs the start identity the launching parent captured, and it reaps a
 * group only after it has itself seen that identity alive, which it reports
 * with a `ready` line; the parent keeps its own exit reap until then.
 * A leader still alive at the deadline is terminated the same way so a hung
 * teardown cannot linger forever, but only when its current start identity
 * matches the one the launching parent captured: a changed, unreadable, or
 * missing identity means the PID may belong to another process.
 * POSIX only; codex-exec never releases a handle on Windows.
 *
 * Usage: node codex-release-reaper.mjs <pid> <startId>
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
  onConfirmed = () => {},
}) {
  // Only the launching parent saw the original Codex process; an identity
  // read here could already belong to a process that reused the PID. Without
  // it nothing proves which group is Codex's, so nothing is signalled.
  const identity = startId || null;
  if (!identity) return 'unverified';

  // A live PID is Codex only if its current identity matches the original.
  // Once no process holds the PID, a group signal reaches only survivors of
  // the Codex group: its PGID cannot be reused while any member is alive.
  const canSignalGroup = () => (alive(pid)
    ? readStartId(pid) === identity
    : readStartId(pid) === null);

  // The group is reaped only after this process has itself seen the original
  // Codex alive, so a PID that was recycled (and abandoned) before the first
  // observation is never mistaken for Codex's group.
  let confirmed = false;
  const deadline = now() + deadlineMs;
  let outcome = 'reaped';
  while (alive(pid)) {
    const current = readStartId(pid);
    if (current !== null && current !== identity) return 'reused';
    if (current === identity && !confirmed) {
      confirmed = true;
      onConfirmed();
    }
    if (now() >= deadline) {
      if (current !== identity) return 'unverified';
      outcome = 'terminated';
      break;
    }
    await sleep(pollMs);
  }

  if (!confirmed) return 'unverified';
  if (!canSignalGroup()) return 'reused';
  killGroup(pid, 'SIGTERM');
  await sleep(graceMs);
  if (groupAlive(pid) && canSignalGroup()) killGroup(pid, 'SIGKILL');
  return outcome;
}

async function main() {
  const pid = Number(process.argv[2]);
  if (!Number.isInteger(pid) || pid <= 1) return;
  // The launching process waits for this line before it lets Codex go; a
  // write after it stopped listening must not crash the reaper.
  process.stdout.on('error', () => {});
  await reapReleasedGroup({
    pid,
    startId: process.argv[3] || null,
    onConfirmed: () => { try { process.stdout.write('ready\n'); } catch { /* listener gone */ } },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {}).finally(() => process.exit(0));
}

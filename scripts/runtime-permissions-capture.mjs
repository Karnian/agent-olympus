#!/usr/bin/env node

/**
 * Agent Olympus runtime permission_mode capture hook.
 *
 * Fires on SessionStart and UserPromptSubmit. Reads the JSON payload Claude
 * Code writes to stdin, looks for the `permission_mode` field (or any of the
 * documented variants). The project-local `.ao` record stores only hook
 * identity/diagnostics; the authoritative, short-lived mode grant is written
 * to the user's private runtime cache outside the workspace. Downstream code
 * accepts it only when the current session pointer and both records agree.
 *
 * Why two events
 * ──────────────
 * SessionStart catches the `--dangerously-skip-permissions` /
 * `--permission-mode` launch flags at the earliest possible moment.
 * UserPromptSubmit refreshes the cache on every user turn so mid-session
 * mode flips (Shift+Tab) are picked up reasonably promptly without forcing
 * a session restart.
 *
 * Fail-safe contract
 * ──────────────────
 * Always exits 0. Never blocks the hook chain. Outputs `{}` on stdout
 * regardless of what was captured — this hook is a SILENT OBSERVER.
 *
 * Zero npm dependencies. Node.js built-ins only.
 */

import { readStdin } from './lib/stdin.mjs';
import {
  extractPermissionModeFromStdin,
  extractPermissionModeFromEnv,
  captureRuntimePermissions,
} from './lib/runtime-permissions.mjs';

async function main() {
  try {
    const raw = await readStdin(3000);
    let data = {};
    try { data = JSON.parse(raw); } catch { /* empty/invalid payload — fall through */ }

    const cwd = (typeof data?.cwd === 'string' && data.cwd) || process.cwd();

    // 1. Try stdin first — this is the authoritative source while a Claude
    //    Code session is live.
    const fromStdin = extractPermissionModeFromStdin(data);
    if (fromStdin.mode || fromStdin.modeObserved) {
      captureRuntimePermissions({
        permissionMode: fromStdin.mode,
        permissionModeObserved: fromStdin.modeObserved,
        source: 'hook_stdin',
        sessionId: fromStdin.sessionId,
        rawStdinKeys: fromStdin.observedKeys,
      }, { cwd });
    } else {
      // 2. Observe env vars for diagnostics only. Project configuration can
      //    influence a hook process environment, so env mode values never
      //    create an authoritative grant even when stdin supplies a session
      //    identity. Identity-only refresh may preserve an independently
      //    validated same-session stdin grant without extending its TTL.
      const fromEnv = extractPermissionModeFromEnv();
      if (fromEnv) {
        captureRuntimePermissions({
          permissionMode: fromEnv,
          source: fromStdin.sessionId ? 'hook_stdin' : 'env',
          permissionSource: 'env',
          sessionId: fromStdin.sessionId,
          rawStdinKeys: fromStdin.observedKeys,
        }, { cwd });
      } else if (fromStdin.sessionId) {
        captureRuntimePermissions({
          permissionMode: null,
          permissionModeObserved: false,
          source: 'hook_stdin',
          sessionId: fromStdin.sessionId,
          rawStdinKeys: fromStdin.observedKeys,
        }, { cwd });
      }
      // No mode and no session identity → silent no-op. Cache (if any) keeps
      // its prior value until TTL expires.
    }
  } catch {
    // swallow — never block hooks
  }
  try { process.stdout.write('{}'); } catch { /* ignored */ }
  process.exit(0);
}

main();

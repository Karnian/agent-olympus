#!/usr/bin/env node

/**
 * Agent Olympus runtime permission_mode capture hook.
 *
 * Fires on SessionStart and UserPromptSubmit. Reads the JSON payload Claude
 * Code writes to stdin, looks for the `permission_mode` field (or any of the
 * documented variants), and persists it to
 * `.ao/state/ao-runtime-permissions.json` so downstream code (`/ask`,
 * `permission-detect.mjs`, Atlas/Athena) can resolve the SESSION-RUNTIME
 * permission tier — not just the settings-file tier.
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
    if (fromStdin.mode) {
      captureRuntimePermissions({
        permissionMode: fromStdin.mode,
        source: 'hook_stdin',
        sessionId: fromStdin.sessionId,
        rawStdinKeys: fromStdin.observedKeys,
      }, { cwd });
    } else {
      // 2. Fallback to env vars. Only writes if a valid mode is present —
      //    we never overwrite a stdin-sourced cache with a less-trusted
      //    env-sourced one within the same hook invocation.
      const fromEnv = extractPermissionModeFromEnv();
      if (fromEnv) {
        captureRuntimePermissions({
          permissionMode: fromEnv,
          source: 'env',
          sessionId: fromStdin.sessionId,
          rawStdinKeys: fromStdin.observedKeys,
        }, { cwd });
      }
      // No stdin field, no env → silent no-op. Cache (if any) keeps its
      // prior value until TTL expires.
    }
  } catch {
    // swallow — never block hooks
  }
  try { process.stdout.write('{}'); } catch { /* ignored */ }
  process.exit(0);
}

main();

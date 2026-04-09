#!/usr/bin/env node
/**
 * scripts/diagnose-sandbox.mjs — Host sandbox diagnostic dump.
 *
 * Prints the full HostSandboxRecord (tier + source + signals) as JSON,
 * plus the derived `effectiveCodexLevel` that codex workers would actually
 * run at. Use this when you need to understand why codex workers are
 * running at a particular tier or whether you need to set
 * `AO_HOST_SANDBOX_LEVEL` / `autonomy.codex.hostSandbox`.
 *
 * Usage:
 *   node scripts/diagnose-sandbox.mjs
 *
 * Output: JSON on stdout. Exits 0 on success, 1 on unexpected error.
 *
 * Active probing (writing outside cwd, network requests) is intentionally
 * NOT performed — this is a passive diagnostic. Real active probing will
 * ship in a follow-up PR.
 *
 * Zero npm dependencies.
 */

import { detectHostSandbox } from './lib/host-sandbox-detect.mjs';
import {
  resolveCodexApproval,
  detectClaudePermissionLevel,
  buildHostSandboxWarning,
} from './lib/codex-approval.mjs';
import { loadAutonomyConfig } from './lib/autonomy.mjs';

/**
 * Emit a single authoritative effective level. This is the SAME value that
 * `worker-spawn.spawnTeam()` would pass to `codexExec.spawn()` /
 * `codexAppServer.createThread()` — `resolveCodexApproval()`. Tools that
 * consume this report must trust this single field, not reconstruct from
 * components, to avoid drift between diagnose output and actual runtime.
 */
async function main() {
  try {
    const cwd = process.cwd();
    const autonomyConfig = loadAutonomyConfig(cwd);

    // Use the SAME call path as worker-spawn to guarantee the report and
    // runtime stay in sync. The report's effective level IS what workers get.
    const effective = resolveCodexApproval(autonomyConfig, { cwd });

    // Informational fields (components of the decision) — labeled as inputs,
    // NOT as a separate "effective" calculation to prevent confusion with
    // runtime. These must NOT be recomputed by consumers.
    const permLevel = detectClaudePermissionLevel({ cwd });
    const hostSandbox = detectHostSandbox({ cwd, autonomyConfig });
    const warning = buildHostSandboxWarning(effective, hostSandbox);

    const report = {
      cwd,
      effectiveCodexLevel: effective,          // ← authoritative, matches runtime
      warning,                                  // ← null or one-line recommendation
      inputs: {
        permLevelFromAllowList: permLevel,      // permissions.allow derivation
        hostSandbox,                            // tier + source + signals
      },
      notes: {
        env: {
          AO_HOST_SANDBOX_LEVEL: process.env.AO_HOST_SANDBOX_LEVEL || null,
          OPERON_SANDBOXED_NETWORK: process.env.OPERON_SANDBOXED_NETWORK || null,
          CLAUDECODE: process.env.CLAUDECODE || null,
        },
        autonomyCodex: autonomyConfig?.codex || null,
      },
    };

    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[diagnose-sandbox] fatal: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}

main();

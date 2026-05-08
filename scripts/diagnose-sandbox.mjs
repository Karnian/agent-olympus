#!/usr/bin/env node
/**
 * scripts/diagnose-sandbox.mjs — Host sandbox + permission diagnostic dump.
 *
 * Default mode: prints the full HostSandboxRecord (tier + source + signals)
 * as JSON, plus the derived `effectiveCodexLevel` that codex workers would
 * actually run at. Use this when you need to understand why codex workers
 * are running at a particular tier or whether you need to set
 * `AO_HOST_SANDBOX_LEVEL` / `autonomy.codex.hostSandbox`.
 *
 * `--explain-permissions` mode (issue #67/#68/#69): prints a verbose
 * breakdown of permission resolution — settings layer (per-scope allow/deny/
 * ask), runtime layer (captured permission_mode), final tier, and the
 * narrative explanation of WHY that tier was chosen. Use this when /ask
 * codex falls back to read-only or you want to verify the runtime override
 * hook is firing.
 *
 * Usage:
 *   node scripts/diagnose-sandbox.mjs
 *   node scripts/diagnose-sandbox.mjs --explain-permissions
 *
 * Output: JSON on stdout. Exits 0 on success, 1 on unexpected error.
 *
 * Active probing (writing outside cwd, network requests) is intentionally
 * NOT performed — this is a passive diagnostic.
 *
 * Zero npm dependencies.
 */

import { detectHostSandbox } from './lib/host-sandbox-detect.mjs';
import {
  resolveCodexApproval,
  detectClaudePermissionLevel,
  buildHostSandboxWarning,
} from './lib/codex-approval.mjs';
import {
  detectClaudePermissions,
  detectClaudePermissionLevelFromSettings,
  explainPermissionLevel,
} from './lib/permission-detect.mjs';
import { loadRuntimePermissions } from './lib/runtime-permissions.mjs';
import { loadAutonomyConfig } from './lib/autonomy.mjs';

function parseArgs(argv) {
  const out = { explainPermissions: false };
  for (const a of argv.slice(2)) {
    if (a === '--explain-permissions' || a === '--explain') out.explainPermissions = true;
  }
  return out;
}

/**
 * Build the `--explain-permissions` payload. Captures every piece of
 * information that goes into the final tier decision so the user can see
 * exactly why codex is/isn't allowed to do something.
 */
function buildExplainReport(cwd, autonomyConfig) {
  const settingsFlags = detectClaudePermissions({ cwd });
  const settingsLevel = detectClaudePermissionLevelFromSettings({ cwd });
  const runtime = loadRuntimePermissions({ cwd });
  const explain = explainPermissionLevel({ cwd });
  const finalLevel = detectClaudePermissionLevel({ cwd });
  const effective = resolveCodexApproval(autonomyConfig, { cwd });
  const hostSandbox = detectHostSandbox({ cwd, autonomyConfig });

  return {
    cwd,
    finalLevel,                          // detectClaudePermissionLevel result
    effectiveCodexLevel: effective,      // intersected with host sandbox
    layers: {
      settings: {
        level: settingsLevel,
        flags: settingsFlags,
      },
      runtime: runtime
        ? {
            present: true,
            permissionMode: runtime.permissionMode,
            level: explain.runtime ? explain.runtime.level : null,
            source: runtime.source,
            capturedAt: runtime.capturedAt,
            ageMs: runtime.ageMs,
            sessionId: runtime.sessionId,
            rawStdinKeys: runtime.rawStdinKeys,
          }
        : {
            present: false,
            note:
              'No runtime permission_mode captured. ' +
              'If you launched Claude Code with --dangerously-skip-permissions ' +
              'or --permission-mode, the SessionStart hook should have written ' +
              '.ao/state/ao-runtime-permissions.json. ' +
              'Restart your session if you upgraded agent-olympus mid-session, ' +
              'or set CLAUDE_PERMISSION_MODE=<mode> as a fallback.',
          },
      hostSandbox,
    },
    decision: {
      chosenSource: explain.chosenSource,
      reason: explain.chosenSourceReason,
    },
    autonomyOverride: {
      codexApproval: autonomyConfig?.codex?.approval || null,
      codexHostSandbox: autonomyConfig?.codex?.hostSandbox || null,
    },
    env: {
      AO_HOST_SANDBOX_LEVEL: process.env.AO_HOST_SANDBOX_LEVEL || null,
      OPERON_SANDBOXED_NETWORK: process.env.OPERON_SANDBOXED_NETWORK || null,
      CLAUDECODE: process.env.CLAUDECODE || null,
      CLAUDE_PERMISSION_MODE: process.env.CLAUDE_PERMISSION_MODE || null,
      CLAUDE_CODE_PERMISSION_MODE: process.env.CLAUDE_CODE_PERMISSION_MODE || null,
    },
  };
}

/**
 * Emit a single authoritative effective level. This is the SAME value that
 * `worker-spawn.spawnTeam()` would pass to `codexExec.spawn()` /
 * `codexAppServer.createThread()` — `resolveCodexApproval()`. Tools that
 * consume this report must trust this single field, not reconstruct from
 * components, to avoid drift between diagnose output and actual runtime.
 */
async function main() {
  const args = parseArgs(process.argv);
  try {
    const cwd = process.cwd();
    const autonomyConfig = loadAutonomyConfig(cwd);

    if (args.explainPermissions) {
      const report = buildExplainReport(cwd, autonomyConfig);
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(0);
      return;
    }

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
        permLevelFromAllowList: permLevel,      // permissions.allow + runtime
        hostSandbox,                            // tier + source + signals
      },
      notes: {
        env: {
          AO_HOST_SANDBOX_LEVEL: process.env.AO_HOST_SANDBOX_LEVEL || null,
          OPERON_SANDBOXED_NETWORK: process.env.OPERON_SANDBOXED_NETWORK || null,
          CLAUDECODE: process.env.CLAUDECODE || null,
        },
        autonomyCodex: autonomyConfig?.codex || null,
        hint: 'Run with --explain-permissions for per-layer (settings/runtime) breakdown.',
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

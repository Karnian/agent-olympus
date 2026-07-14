/**
 * Fail-closed Gemini CLI configuration for read-only validation workers.
 *
 * `--approval-mode plan` limits built-in tools, but user/project hooks, skills,
 * extensions, and MCP servers are separate lifecycle surfaces. Gemini CLI's
 * system settings layer overrides user and project settings, so each validator
 * receives a private 0600 system-settings file outside the repository while
 * retaining the caller's HOME/OAuth state.
 */

import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const GEMINI_READONLY_SYSTEM_SETTINGS = Object.freeze({
  hooksConfig: Object.freeze({ enabled: false }),
  skills: Object.freeze({ enabled: false }),
  // System-layer registration allowlist: user-tier policy rules can override
  // Plan's built-in decisions, but cannot execute a mutator that was never
  // registered. Keep this list to filesystem inspection primitives only.
  tools: Object.freeze({
    core: Object.freeze([
      'read_file',
      'read_many_files',
      'glob',
      'grep_search',
      'list_directory',
    ]),
  }),
  admin: Object.freeze({
    secureModeEnabled: true,
    extensions: Object.freeze({ enabled: false }),
    mcp: Object.freeze({ enabled: false }),
    skills: Object.freeze({ enabled: false }),
  }),
});

/**
 * Create one invocation-scoped system settings file. Cleanup is idempotent.
 * @param {{ tmpDir?: string }} [opts]
 * @returns {{ path: string, env: {GEMINI_CLI_SYSTEM_SETTINGS_PATH:string}, cleanup: () => void }}
 */
export function createGeminiReadOnlySettings(opts = {}) {
  const invocationId = randomUUID();
  const path = join(
    opts.tmpDir || tmpdir(),
    `ao-gemini-readonly-${invocationId}.json`,
  );
  // Gemini CLI normally walks from ~/.gemini/GEMINI.md through project
  // GEMINI.md files and injects that hierarchy into every prompt. Point the
  // system settings layer at an invocation-unguessable filename that we never
  // create, preventing global/project instructions from biasing an independent
  // validator while preserving HOME for authentication.
  const settings = {
    ...GEMINI_READONLY_SYSTEM_SETTINGS,
    context: { fileName: `.ao-readonly-context-${invocationId}.md` },
  };
  writeFileSync(
    path,
    `${JSON.stringify(settings, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  let cleaned = false;
  return {
    path,
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { unlinkSync(path); } catch {}
    },
  };
}

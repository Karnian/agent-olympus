/** Explicit provider launch configuration for managed workers (no global settings writes). */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from './resolve-binary.mjs';

export const RUNTIME_CLAUDE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
const proxy = fileURLToPath(new URL('../runtime-mcp.mjs', import.meta.url));

export function effectiveRuntimeLevel(m) {
  const levels = ['suggest', 'auto-edit', 'full-auto'];
  let rank = levels.indexOf(m.level);
  if (rank < 0) throw new Error('managed workers require a resolved permission level');
  if (m.readOnly) return 'suggest';
  const modes = { plan: 0, default: 0, dontAsk: 0, auto: 0,
    acceptEdits: 1, auto_edit: 1, bypassPermissions: 2, yolo: 2 };
  for (const hint of [m.permissionMode, m.approvalMode]) {
    if (hint === undefined || hint === null) continue;
    if (!Object.hasOwn(modes, hint)) throw new Error('unsupported managed permission mode');
    rank = Math.min(rank, modes[hint]);
  }
  return levels[rank];
}

export function probeRuntimeProvider(provider) {
  try {
    const binary = resolveBinary(provider);
    const help = execFileSync(binary, ['--help'], { encoding: 'utf8', timeout: 10000 });
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    let supported = false;
    if (provider === 'claude') supported = ['--tools', '--mcp-config', '--strict-mcp-config'].every(flag => help.includes(flag));
    if (provider === 'codex') {
      const features = execFileSync(binary, ['features', 'list'], { encoding: 'utf8', timeout: 10000 });
      supported = /^multi_agent\s/m.test(features) && /^multi_agent_v2\s/m.test(features);
    }
    // This settings contract was inspected in the 0.50.x CLI distribution.
    // Unknown versions are unavailable until their registration policy is tested.
    if (provider === 'gemini') supported = /^0\.50\./.test(version) && help.includes('--acp');
    return { provider, supported, version, control: supported ? 'configured' : 'unavailable',
      guarantee: 'managed task graph only; unrestricted shell launches are outside this cap' };
  } catch (error) { return { provider, supported: false, control: 'unavailable', reason: error.message }; }
}

export function createRuntimeProviderOptions(m, bootstrapPath = null) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-runtime-config-'));
  const server = bootstrapPath ? {
    command: process.execPath, args: [proxy, bootstrapPath],
  } : null;
  const config = { mcpServers: server ? { ao_runtime: server } : {} };
  const mcpConfig = join(dir, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  const overrides = ['features.multi_agent=false', 'features.multi_agent_v2=false'];
  if (server) overrides.push(`mcp_servers.ao_runtime={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)}}`);
  const settings = join(dir, 'gemini.json');
  writeFileSync(settings, JSON.stringify({
    experimental: { enableAgents: false }, hooksConfig: { enabled: false },
    mcpServers: server ? { ao_runtime: { ...server, trust: true } } : {},
    mcp: { allowed: server ? ['ao_runtime'] : [] },
    admin: { extensions: { enabled: false } },
  }), { mode: 0o600, flag: 'wx' });
  const tools = m.readOnly ? ['Read', 'Glob', 'Grep'] : RUNTIME_CLAUDE_TOOLS;
  return {
    options: { tools, mcpConfig, configOverrides: overrides, strictConfig: true,
      allowedTools: server ? ['spawn', 'inspect', 'followup', 'cancel', 'integrate', 'discard'].map(name => `mcp__ao_runtime__${name}`) : [],
      env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings } },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

import { meetsMinimum } from './cli-version.mjs';

/**
 * Codex CLI capabilities whose flags are consumed by worker adapters.
 *
 * Keep the minimum version and the user-facing failure text together so the
 * direct adapter and the tmux fallback cannot drift. The objects are frozen to
 * make this module the authoritative runtime source for these gates.
 */
export const CODEX_CLI_CAPABILITIES = Object.freeze({
  ignoreUserConfig: Object.freeze({
    minimum: '0.122.0',
    purpose: '--no-mcp',
    detail: '--ignore-user-config support',
  }),
  ignoreRules: Object.freeze({
    minimum: '0.143.0',
    purpose: 'read-only rule isolation',
    detail: '--ignore-rules support',
  }),
  strictConfig: Object.freeze({
    minimum: '0.143.0',
    purpose: 'strict validator config',
    detail: '--strict-config support',
  }),
});

/**
 * Fail closed unless a concrete Codex version satisfies one capability.
 *
 * `meetsMinimum()` is intentionally fail-open for advisory callers, so this
 * security-sensitive wrapper rejects an unknown version explicitly.
 *
 * @param {string|null} codexVersion
 * @param {'ignoreUserConfig'|'ignoreRules'|'strictConfig'} capabilityName
 * @returns {void}
 */
export function requireCodexCapability(codexVersion, capabilityName) {
  const capability = CODEX_CLI_CAPABILITIES[capabilityName];
  if (!capability) {
    throw new TypeError(`unknown Codex CLI capability: ${capabilityName}`);
  }

  const hasConcreteVersion = typeof codexVersion === 'string'
    && /^v?\d+\.\d+(?:\.\d+)?$/i.test(codexVersion.trim());
  if (!hasConcreteVersion || !meetsMinimum(codexVersion, capability.minimum)) {
    const detected = hasConcreteVersion ? codexVersion : 'unknown';
    throw new Error(
      `${capability.purpose} requires Codex >=${capability.minimum} `
      + `(${capability.detail}); detected ${detected}. `
      + 'Upgrade with: npm install -g @openai/codex@latest',
    );
  }
}

/**
 * Pure manifest → adapter-call option builders for the adapter-worker supervisor.
 *
 * Extracted into their OWN module (not adapter-worker-supervisor.mjs) so the
 * manifest→adapter-call WIRING is unit-testable WITHOUT importing the supervisor
 * CLI — the supervisor runs main() unconditionally on import, and a guard that
 * suppressed it (import.meta.url === argv[1]) was not symlink/realpath-alias safe
 * (a spawn through a symlinked path or under --preserve-symlinks could exit 0
 * without ever running, silently breaking every adapter worker). Keeping these
 * here lets the supervisor keep its unconditional `main()`.
 *
 * A regression in any of these silently drops a worker option (e.g. the gemini
 * model once went to startServer(), which ignores it, instead of createSession())
 * and otherwise only surfaces at runtime. The supervisor's run* functions MUST
 * use these so the tested contract is exactly the one production runs.
 *
 * Zero deps. Pure functions (no I/O, no module state).
 */

/**
 * codex-exec | claude-cli | gemini-exec spawn() options.
 * `credential` is the CONFIG (not the key — the adapter resolves it in-process so
 * the key never touches the manifest on disk).
 * @param {Object} m - the validated supervisor manifest
 */
import { effectiveRuntimeLevel } from './runtime-provider.mjs';

export function buildExecOpts(m) {
  const readOnly = m.readOnly === true;
  const runtimeLevel = m.managed || m.runtimeLeaf ? effectiveRuntimeLevel(m) : null;
  return {
    cwd: m.cwd, model: m.model, readOnly, level: readOnly ? 'suggest' : (runtimeLevel || m.level),
    appendSystemPrompt: m.systemPrompt, maxBudgetUsd: m.maxBudgetUsd,
    // A read-only Codex review must not load project/user MCP servers or other
    // mutable user configuration. Other exec adapters ignore this option.
    ignoreUserConfig: readOnly ? true : undefined,
    ignoreRules: readOnly ? true : undefined,
    skipGitRepoCheck: readOnly ? true : undefined,
    strictConfig: readOnly ? true : undefined,
    configOverrides: readOnly
      ? ['project_doc_max_bytes=0', 'skills.bundled.enabled=false', ...(m.runtimeOptions?.configOverrides || [])]
      : (m.runtimeOptions?.configOverrides || m.configOverrides),
    approvalMode: readOnly ? 'plan' : (runtimeLevel
      ? ({ 'full-auto': 'yolo', 'auto-edit': 'auto_edit', suggest: 'plan' }[runtimeLevel]) : m.approvalMode),
    permissionMode: readOnly ? 'plan' : (runtimeLevel
      ? ({ 'full-auto': 'bypassPermissions', 'auto-edit': 'acceptEdits', suggest: 'plan' }[runtimeLevel]) : m.permissionMode),
    allowedTools: readOnly ? ['Read', 'Glob', 'Grep'] : m.allowedTools,
    credential: m.geminiCredential,
    ...(m.runtimeOptions ? {
      tools: m.runtimeOptions.tools, mcpConfig: m.runtimeOptions.mcpConfig,
      strictConfig: true, env: m.runtimeOptions.env,
      allowedTools: [...(readOnly ? ['Read', 'Glob', 'Grep'] : m.allowedTools || []), ...(m.runtimeOptions.allowedTools || [])],
    } : {}),
  };
}

/**
 * codex-appserver createThread() options.
 * @param {Object} m
 */
export function buildAppserverThreadOpts(m) {
  return {
    cwd: m.cwd,
    level: m.readOnly === true ? 'suggest' : m.level,
    ephemeral: true,
    serviceName: `agent-olympus:${m.teamName}`,
    ...(m.model ? { model: m.model } : {}),
  };
}

/**
 * gemini-acp createSession() options. `model` MUST live here (→
 * unstable_setSessionModel); startServer ignores it.
 * @param {Object} m
 */
export function buildGeminiAcpSessionOpts(m) {
  const readOnly = m.readOnly === true;
  const runtimeLevel = m.managed || m.runtimeLeaf ? effectiveRuntimeLevel(m) : null;
  return {
    cwd: m.cwd,
    approvalMode: readOnly ? 'plan' : (runtimeLevel
      ? ({ 'full-auto': 'yolo', 'auto-edit': 'auto_edit', suggest: 'plan' }[runtimeLevel]) : m.approvalMode),
    // Legacy sessions warn and continue when the server cannot change modes.
    // A cross-validation worker cannot safely do that: plan mode is part of
    // its execution security contract, so createSession must fail closed.
    requireApprovalMode: readOnly || m.managed === true,
    model: m.model,
  };
}

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
export function buildExecOpts(m) {
  return {
    cwd: m.cwd, model: m.model, level: m.level,
    appendSystemPrompt: m.systemPrompt, maxBudgetUsd: m.maxBudgetUsd,
    approvalMode: m.approvalMode, credential: m.geminiCredential,
  };
}

/**
 * codex-appserver createThread() options.
 * @param {Object} m
 */
export function buildAppserverThreadOpts(m) {
  return { cwd: m.cwd, level: m.level, ephemeral: true, serviceName: `agent-olympus:${m.teamName}` };
}

/**
 * gemini-acp createSession() options. `model` MUST live here (→
 * unstable_setSessionModel); startServer ignores it.
 * @param {Object} m
 */
export function buildGeminiAcpSessionOpts(m) {
  return { cwd: m.cwd, approvalMode: m.approvalMode, model: m.model };
}

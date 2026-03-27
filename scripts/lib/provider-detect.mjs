/**
 * Detect the AI provider from a Task/Agent tool_input.
 * Returns: 'claude' | 'codex' | 'gemini' | 'unknown'
 *
 * Note: Both concurrency-gate.mjs and concurrency-release.mjs had identical
 * implementations. The gate version included an inline comment about the
 * agent-olympus default fallback, which is preserved here.
 */

/**
 * @param {object} toolInput - The tool_input object from a Task or Agent hook event.
 * @returns {'claude' | 'codex' | 'gemini'} The detected provider name.
 */
export function detectProvider(toolInput) {
  const subagentType = toolInput?.subagent_type ?? '';
  const model = (toolInput?.model ?? '').toLowerCase();

  if (subagentType.includes('claude') || model.includes('claude') || model.includes('anthropic')) {
    return 'claude';
  }
  if (subagentType.includes('codex') || model.includes('codex') || model.includes('openai') || model.includes('gpt')) {
    return 'codex';
  }
  if (subagentType.includes('gemini') || model.includes('gemini') || model.includes('google')) {
    return 'gemini';
  }
  // Default: treat as claude if subagent_type contains 'agent-olympus' or similar
  if (subagentType) {
    return 'claude';
  }
  return 'claude';
}

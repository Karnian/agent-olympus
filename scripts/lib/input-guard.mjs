/**
 * Input size guard for orchestrator sub-agent calls.
 *
 * Prevents L-scale silent failures by:
 * 1. Estimating token count from input text
 * 2. Detecting when input exceeds sub-agent effective limits
 * 3. Providing chunking strategies to fit within context windows
 *
 * Sub-agents (Hermes, Metis, Prometheus) receive the full orchestrator prompt
 * PLUS the user's input. When the user provides a 1358-line document with 31
 * user stories, the combined prompt can exceed effective context limits even
 * if the raw token count fits within the model's window — because the model
 * loses coherence on very long prompts well before hitting the hard limit.
 */

/**
 * Rough token estimate: ~4 chars per token for English, ~2 chars for CJK.
 * This is intentionally conservative (overestimates) to prevent edge cases.
 *
 * @param {string} text
 * @returns {number} Estimated token count
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;

  // Count CJK characters (more tokens per character)
  const cjkCount = (text.match(/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/g) || []).length;
  const nonCjkLength = text.length - cjkCount;

  return Math.ceil(nonCjkLength / 4) + Math.ceil(cjkCount / 1.5);
}

/**
 * Count lines in text.
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
  if (!text || typeof text !== 'string') return 0;
  return text.split('\n').length;
}

/**
 * Effective context limits per sub-agent model tier.
 * These are the USABLE prompt sizes, not the model's raw context window.
 * Sub-agents need room for their own system prompt + response generation.
 *
 * @type {Record<string, { maxInputTokens: number, maxInputLines: number }>}
 */
const TIER_LIMITS = {
  haiku:  { maxInputTokens: 30_000,  maxInputLines: 500 },
  sonnet: { maxInputTokens: 80_000,  maxInputLines: 1500 },
  opus:   { maxInputTokens: 150_000, maxInputLines: 3000 },
};

/**
 * Check if input exceeds safe limits for a given model tier.
 *
 * @param {string} input - The text to check
 * @param {'haiku'|'sonnet'|'opus'} tier - Model tier
 * @returns {{ safe: boolean, tokens: number, lines: number, limit: { maxInputTokens: number, maxInputLines: number } }}
 */
export function checkInputSize(input, tier = 'opus') {
  const tokens = estimateTokens(input);
  const lines = countLines(input);
  const limit = TIER_LIMITS[tier] || TIER_LIMITS.opus;

  return {
    safe: tokens <= limit.maxInputTokens && lines <= limit.maxInputLines,
    tokens,
    lines,
    limit,
  };
}

/**
 * Extract structural summary from a large document.
 * Preserves headings, user story IDs, acceptance criteria patterns,
 * and key structural elements while removing verbose prose.
 *
 * @param {string} text - Full document text
 * @param {number} targetLines - Target line count for summary (default: 200)
 * @returns {{ summary: string, originalLines: number, preservedIds: string[] }}
 */
export function extractStructuralSummary(text, targetLines = 200) {
  if (!text || typeof text !== 'string') {
    return { summary: '', originalLines: 0, preservedIds: [] };
  }

  const lines = text.split('\n');
  const originalLines = lines.length;
  const preservedIds = [];
  const kept = [];

  // Phase 1: Identify and keep structural elements
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Always keep: headings (and extract story IDs from them)
    if (/^#{1,6}\s/.test(trimmed)) {
      kept.push(line);
      const headingStoryMatch = trimmed.match(/\b(US|RF|AC|ST)-\d{3}\b/);
      if (headingStoryMatch) preservedIds.push(headingStoryMatch[0]);
      continue;
    }

    // Always keep: user story IDs (US-001, RF-001, etc.)
    const storyMatch = trimmed.match(/\b(US|RF|AC|ST)-\d{3}\b/);
    if (storyMatch) {
      kept.push(line);
      preservedIds.push(storyMatch[0]);
      continue;
    }

    // Always keep: GIVEN/WHEN/THEN acceptance criteria
    if (/^\s*[-*]?\s*(GIVEN|WHEN|THEN)\b/i.test(trimmed)) {
      kept.push(line);
      continue;
    }

    // Always keep: "As a" user story format
    if (/\*\*As a\*\*|\bAs a\b.*\bI want to\b/i.test(trimmed)) {
      kept.push(line);
      continue;
    }

    // Keep: list items with key content (constraints, goals, requirements)
    if (/^\s*[-*]\s/.test(trimmed) && trimmed.length > 10 && trimmed.length < 200) {
      kept.push(line);
      continue;
    }

    // Keep: table rows
    if (/^\s*\|/.test(trimmed)) {
      kept.push(line);
      continue;
    }

    // Keep: code block markers
    if (/^```/.test(trimmed)) {
      kept.push(line);
      continue;
    }

    // Keep: key metadata lines
    if (/^(Scale|Status|Phase|Priority|Category|Type|Created|Updated):/i.test(trimmed)) {
      kept.push(line);
      continue;
    }
  }

  // Phase 2: If still too long, hard-truncate to targetLines
  // Preserve document order (don't separate headings from their content)
  let summary;
  if (kept.length > targetLines) {
    summary = kept.slice(0, targetLines).join('\n');
  } else {
    summary = kept.join('\n');
  }

  return {
    summary,
    originalLines,
    preservedIds: [...new Set(preservedIds)],
  };
}

/**
 * Prepare input for a sub-agent call, chunking if necessary.
 *
 * Returns the input as-is if safe, or a structural summary with
 * a reference note pointing to the original document.
 *
 * @param {string} input - Full input text
 * @param {'haiku'|'sonnet'|'opus'} tier - Model tier
 * @param {string} [sourcePath] - Original file path (for reference note)
 * @returns {{ text: string, wasChunked: boolean, originalLines: number, preservedIds: string[] }}
 */
export function prepareSubAgentInput(input, tier = 'opus', sourcePath) {
  const check = checkInputSize(input, tier);

  if (check.safe) {
    return {
      text: input,
      wasChunked: false,
      originalLines: check.lines,
      preservedIds: [],
    };
  }

  // Input exceeds safe limits — extract structural summary
  // Target: well under the tier's line limit (use 1/4 to leave room for
  // the orchestrator's own prompt + system instructions)
  const tierLimit = (TIER_LIMITS[tier] || TIER_LIMITS.opus).maxInputLines;
  const targetLines = Math.min(Math.floor(tierLimit / 4), 500);
  const { summary, originalLines, preservedIds } = extractStructuralSummary(input, targetLines);

  let text = summary;

  // Add reference note for the full document
  if (sourcePath) {
    text += `\n\n---\n_This is a structural summary (${originalLines} → ${countLines(summary)} lines). Full document at: ${sourcePath}_`;
  } else {
    text += `\n\n---\n_This is a structural summary (${originalLines} → ${countLines(summary)} lines). Request the full document if detailed context is needed for specific sections._`;
  }

  return {
    text,
    wasChunked: true,
    originalLines,
    preservedIds,
  };
}

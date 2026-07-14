const EXACT_MCP_AUTH_SIGNAL = /Auth\(AuthorizationRequired\)|\bAuthorizationRequired\b/i;
const MCP_CONTEXT = /\b(?:mcp|rmcp)\b/i;
const UNRELATED_AUTH_CONTEXT = /\b(?:openai|chatgpt)\s+(?:api|account|login|authentication|authorization)\b/i;
const AUTH_FAILURE_SIGNAL = /\b(?:(?:authentication|authorization)(?:\s+(?:attempt|check|request|method|flow|fallback|handshake|token|credentials?|is|was|has|have)){0,3}\s+(?:failed|failure|required|denied|rejected)|requires?\s+(?:authentication|authorization)|(?:is|are|was|were)\s+not\s+(?:authenticated|authorized)|unauthori[sz]ed|oauth\s+login\s+(?:is\s+)?required|oauth(?:\s+access)?(?:\s+token)?\s+(?:expired|invalid|missing|rejected)|(?:access\s+)?token\s+(?:expired|invalid|missing|rejected)|invalid\s+(?:api\s+key|credentials?)|(?:api\s+key|credentials?)\s+(?:is\s+|are\s+)?(?:invalid|expired|missing|required|rejected)|http\s+(?:401\s+unauthori[sz]ed|403\s+forbidden))\b/i;
const RATE_LIMIT_SIGNAL = /rate.?limit|429|quota.*exceeded|too many requests/i;
const NETWORK_FAILURE_SIGNAL = /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i;
const NOT_INSTALLED_SIGNAL = /command not found|ENOENT|codex:.*not found|No such file or directory|not found in PATH/i;
const CRASH_SIGNAL = /fatal error|unhandled exception|panic:|SIGSEGV|SIGABRT|segmentation fault/i;
const TIMEOUT_SIGNAL = /\btimeout\b|\btimed?\s+out\b|did not complete within/i;
const MCP_AUTH_RECOVERY_SIGNAL = /\b(?:auth(?:entication|orization)?|oauth(?:\s+(?:login|token))?)\b[^\r\n]{0,80}\b(?:succeeded|successful|restored|refreshed|renewed|recovered)\b|\b(?:authenticated|authorized|reauthenticated)\b[^\r\n]{0,40}\b(?:successfully|succeeded)\b/i;
const MCP_AUTH_RECOVERY_NEGATION = /\b(?:no|not|never|can(?:not|['’]t)|isn['’]t|wasn['’]t|weren['’]t|unlikely\s+to(?:\s+be)?)\b[^\r\n;,.!?]{0,48}\b(?:succeeded|successful|restored|refreshed|renewed|recovered|authenticated|authorized|reauthenticated)\b/i;

function authFailureMatches(errorText) {
  const authSignals = new RegExp(AUTH_FAILURE_SIGNAL.source, 'gi');
  const matches = [];
  for (const match of errorText.matchAll(authSignals)) {
    const offset = match.index ?? -1;
    const prefix = errorText.slice(Math.max(0, offset - 24), offset);
    const matchedText = match[0] || '';
    if (/(?:\bno|\bnot|\bwithout|\bdoes\s+not|\bdoesn't|\bis\s+not|\bisn't)\s*$/i.test(prefix)) {
      continue;
    }
    if (/\bnot\s+(?:required|needed)\b/i.test(matchedText)) continue;
    matches.push(match);
  }
  return matches;
}

function lineAtOffset(text, offset) {
  const start = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end === -1 ? text.length : end);
}

function isSafeContinuation(line, currentRecord) {
  const trimmed = line.trim();
  if (!trimmed || UNRELATED_AUTH_CONTEXT.test(trimmed)) return false;
  if (/^\s+/.test(line)) return true;
  if (/^(?:(?:additional\s+)?details?|reason|cause|caused\s+by|inner\s+error|transport\s+channel|when)\b\s*:?/i.test(trimmed)) {
    return true;
  }

  // Some provider diagnostics put the auth reason on the next unindented
  // line. Only join it to an already-failing MCP record; never join after an
  // informational record such as "MCP startup succeeded".
  return MCP_CONTEXT.test(currentRecord)
    && /\b(?:error|fatal|failed|failure|quit|closed|rejected|denied)\b/i.test(currentRecord)
    && AUTH_FAILURE_SIGNAL.test(trimmed);
}

function diagnosticRecords(errorText) {
  const records = [];
  let current = '';

  for (const line of errorText.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) records.push(current);
      current = '';
      continue;
    }
    if (!current) {
      current = line;
    } else if (isSafeContinuation(line, current)) {
      current += `\n${line}`;
    } else {
      records.push(current);
      current = line;
    }
  }
  if (current) records.push(current);
  return records;
}

function patternMatches(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))];
}

function isNegatedMcpAuthRecovery(record, signal) {
  const start = signal.index ?? 0;
  const end = start + (signal[0]?.length ?? 0);
  const context = record.slice(Math.max(0, start - 64), end);
  const boundaries = [...context.matchAll(/[;,.!?\r\n]|\b(?:but|however|nevertheless|then|yet)\b/gi)];
  const latestBoundary = boundaries.at(-1);
  const governingClause = latestBoundary
    ? context.slice((latestBoundary.index ?? 0) + latestBoundary[0].length)
    : context;
  return MCP_AUTH_RECOVERY_NEGATION.test(governingClause);
}

/**
 * Recognize only an explicit, positive MCP authentication recovery record.
 * This is shared with tmux pane filtering so a later INFO recovery line is
 * retained even when it falls outside the preceding error window.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function hasExplicitMcpAuthRecovery(record) {
  try {
    if (typeof record !== 'string' || !MCP_CONTEXT.test(record)) return false;
    return patternMatches(record, MCP_AUTH_RECOVERY_SIGNAL)
      .some(signal => !isNegatedMcpAuthRecovery(record, signal));
  } catch {
    return false;
  }
}

function diagnosticEvents(record) {
  const events = [];
  const networkSignals = patternMatches(record, NETWORK_FAILURE_SIGNAL);

  for (const signal of patternMatches(record, EXACT_MCP_AUTH_SIGNAL)) {
    const signalLine = lineAtOffset(record, signal.index ?? 0);
    events.push({
      index: signal.index ?? 0,
      category: UNRELATED_AUTH_CONTEXT.test(signalLine) ? 'auth_failed' : 'mcp_auth',
    });
  }

  for (const signal of authFailureMatches(record)) {
    const signalLine = lineAtOffset(record, signal.index ?? 0);
    const isMcp = MCP_CONTEXT.test(record) && !UNRELATED_AUTH_CONTEXT.test(signalLine);
    events.push({
      index: signal.index ?? 0,
      category: isMcp ? 'mcp_auth' : 'auth_failed',
    });
  }

  for (const signal of patternMatches(record, RATE_LIMIT_SIGNAL)) {
    events.push({ index: signal.index ?? 0, category: 'rate_limited' });
  }
  for (const signal of networkSignals) {
    events.push({ index: signal.index ?? 0, category: 'network' });
  }
  for (const signal of patternMatches(record, NOT_INSTALLED_SIGNAL)) {
    events.push({ index: signal.index ?? 0, category: 'not_installed' });
  }
  for (const signal of patternMatches(record, CRASH_SIGNAL)) {
    events.push({ index: signal.index ?? 0, category: 'crash' });
  }
  // Concrete transport codes/errors are more specific than explanatory text
  // such as "ETIMEDOUT ... timed out" in the same diagnostic record.
  if (networkSignals.length === 0) {
    for (const signal of patternMatches(record, TIMEOUT_SIGNAL)) {
      events.push({ index: signal.index ?? 0, category: 'timeout' });
    }
  }

  if (MCP_CONTEXT.test(record)) {
    for (const signal of patternMatches(record, MCP_AUTH_RECOVERY_SIGNAL)) {
      if (isNegatedMcpAuthRecovery(record, signal)) continue;
      // Place recovery after the complete success phrase. This makes
      // "authentication failed, then recovered" invalidate the failure even
      // though both regexes begin at the same word.
      events.push({
        index: (signal.index ?? 0) + (signal[0]?.length ?? 0),
        recovery: 'mcp_auth',
      });
    }
  }

  return events.sort((left, right) => left.index - right.index);
}

/**
 * Classify the latest effective auth/provider diagnostic in record order.
 * Codex can log an MCP startup auth failure, recover, and later exit for an
 * unrelated OpenAI API, network, or rate-limit failure. Selecting a category
 * by global regex priority would incorrectly keep the stale MCP diagnosis.
 * Explicit MCP auth success invalidates the most recent unresolved MCP auth
 * record; otherwise the last recognized failure signal is authoritative.
 *
 * @param {unknown} errorText
 * @returns {'mcp_auth'|'auth_failed'|'rate_limited'|'network'|'not_installed'|'crash'|'timeout'|null}
 */
export function classifyCodexDiagnostic(errorText) {
  try {
    if (typeof errorText !== 'string' || !errorText) return null;
    const failures = [];

    for (const record of diagnosticRecords(errorText)) {
      for (const event of diagnosticEvents(record)) {
        if (event.recovery === 'mcp_auth') {
          for (let index = failures.length - 1; index >= 0; index -= 1) {
            if (!failures[index].invalid && failures[index].category === 'mcp_auth') {
              failures[index].invalid = true;
            }
          }
        } else if (event.category) {
          failures.push({ category: event.category, invalid: false });
        }
      }
    }

    for (let index = failures.length - 1; index >= 0; index -= 1) {
      if (!failures[index].invalid) return failures[index].category;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Identify a concrete authentication failure without treating informational
 * messages that merely mention authentication as failures.
 *
 * @param {unknown} errorText
 * @returns {boolean}
 */
export function hasGenericAuthFailure(errorText) {
  try {
    return classifyCodexDiagnostic(errorText) === 'auth_failed';
  } catch {
    return false;
  }
}

/**
 * Identify an MCP-specific authentication failure without treating every
 * rmcp transport warning (or a nearby generic API auth failure) as MCP auth.
 * Exact transport enum names are self-identifying. Natural-language signals
 * must share one diagnostic record with an MCP/RMCP marker; only explicit,
 * low-ambiguity continuation lines are folded into that record.
 *
 * @param {unknown} errorText
 * @returns {boolean}
 */
export function hasMcpAuthFailure(errorText) {
  try {
    return classifyCodexDiagnostic(errorText) === 'mcp_auth';
  } catch {
    return false;
  }
}

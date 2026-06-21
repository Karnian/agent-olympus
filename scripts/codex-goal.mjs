#!/usr/bin/env node
/**
 * Thin CLI helper for one Codex goal turn.
 *
 * The Claude-side skill owns verification and retry loops. This helper only
 * spawns/resumes Codex through the existing adapter, collects one turn, and
 * best-effort parses the final goal result JSON from adapter output.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as realAdapter from './lib/codex-exec.mjs';

const VALID_LEVELS = new Set(['suggest', 'auto-edit', 'full-auto']);
const COLLECT_TIMEOUT_MS = 900_000;
const RAW_TAIL_CHARS = 2048;

let adapter = realAdapter;

/**
 * Replace the codex-exec adapter module for hermetic tests.
 *
 * @param {{spawn: Function, spawnResume: Function, collect: Function, shutdown: Function}|null} next
 * @returns {object} previous adapter
 */
export function _setAdapter(next = realAdapter) {
  const previous = adapter;
  adapter = next || realAdapter;
  return previous;
}

/**
 * Parse CLI argv.
 *
 * @param {string[]} argv
 * @returns {{cwd: string, level: 'suggest'|'auto-edit'|'full-auto', resume: string|null, noTrust: boolean}}
 */
export function parseArgs(argv = []) {
  const parsed = {
    cwd: process.cwd(),
    level: 'full-auto',
    resume: null,
    noTrust: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') {
      parsed.cwd = requireValue(argv, ++i, '--cwd');
    } else if (arg === '--level') {
      const level = requireValue(argv, ++i, '--level');
      if (!VALID_LEVELS.has(level)) {
        throw new Error(`Invalid --level "${level}". Expected one of: suggest, auto-edit, full-auto`);
      }
      parsed.level = level;
    } else if (arg === '--resume') {
      parsed.resume = requireValue(argv, ++i, '--resume');
    } else if (arg === '--no-trust') {
      parsed.noTrust = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/**
 * Build the Codex global `-c` value that marks a project path as trusted.
 *
 * @param {string} absCwd
 * @returns {string}
 */
export function buildTrustOverride(absCwd) {
  return `projects."${escapeTomlBasicString(absCwd)}".trust_level="trusted"`;
}

function escapeTomlBasicString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

/**
 * Extract the last parseable JSON object from mixed Codex output.
 *
 * @param {string} outputText
 * @returns {{parsed: object|null, ok: boolean}}
 */
export function extractGoalResult(outputText) {
  try {
    const text = String(outputText ?? '');
    if (!text.trim()) return { parsed: null, ok: false };

    const candidates = collectJsonObjectCandidates(text);
    candidates.sort((a, b) => {
      if (a.end !== b.end) return b.end - a.end;
      return a.start - b.start;
    });

    for (const candidate of candidates) {
      try {
        const value = JSON.parse(text.slice(candidate.start, candidate.end + 1));
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return { parsed: value, ok: true };
        }
      } catch {
        // Keep scanning earlier candidates.
      }
    }
  } catch {
    // Contract: malformed, partial, or unusual output never escapes.
  }

  return { parsed: null, ok: false };
}

function collectJsonObjectCandidates(text) {
  const candidates = [];

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findMatchingBrace(text, start);
    if (end === -1) continue;
    candidates.push({ start, end });
  }

  return candidates;
}

function findMatchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

/**
 * Run exactly one Codex goal turn and return the structured CLI payload plus
 * the intended process exit code.
 *
 * @param {string} prompt
 * @param {{cwd: string, level: string, resume: string|null, noTrust?: boolean}} args
 * @returns {Promise<{payload: object, exitCode: number}>}
 */
export async function runGoalTurn(prompt, args = parseArgs([])) {
  const startedAt = Date.now();
  let handle = null;

  try {
    const cwd = args.cwd || process.cwd();
    const spawnOpts = {
      persist: true,
      level: args.level,
      cwd,
    };

    if (!args.noTrust) {
      spawnOpts.configOverrides = [buildTrustOverride(resolve(cwd))];
    }

    handle = args.resume
      ? adapter.spawnResume(args.resume, prompt, spawnOpts)
      : adapter.spawn(prompt, spawnOpts);

    let collected;
    try {
      collected = await adapter.collect(handle, COLLECT_TIMEOUT_MS);
    } finally {
      await shutdownQuietly(handle);
    }

    const output = String(collected?.output ?? handle?._output ?? '');
    const threadId = handle?.threadId ?? collected?.threadId ?? args.resume ?? null;
    const durationMs = Date.now() - startedAt;

    if (collected?.error || collected?.status === 'failed') {
      return {
        payload: {
          status: 'failed',
          threadId,
          durationMs,
          result: null,
          rawTail: tail(output),
          error: normalizeError(collected?.error, 'Codex adapter failed'),
        },
        exitCode: 1,
      };
    }

    const extracted = extractGoalResult(output);
    return {
      payload: {
        status: 'ok',
        threadId,
        durationMs,
        result: extracted.ok ? extracted.parsed : null,
        rawTail: tail(output),
      },
      exitCode: 0,
    };
  } catch (err) {
    const output = String(handle?._output ?? '');
    return {
      payload: {
        status: 'failed',
        threadId: handle?.threadId ?? args.resume ?? null,
        durationMs: Date.now() - startedAt,
        result: null,
        rawTail: tail(output),
        error: normalizeError(err, 'Codex adapter failed'),
      },
      exitCode: 1,
    };
  }
}

async function shutdownQuietly(handle) {
  if (!handle) return;
  try {
    await adapter.shutdown(handle);
  } catch {
    // Cleanup failure should not mask the completed turn or original failure.
  }
}

function tail(text) {
  const value = String(text ?? '');
  return value.length > RAW_TAIL_CHARS ? value.slice(-RAW_TAIL_CHARS) : value;
}

function normalizeError(err, fallbackMessage) {
  if (!err) {
    return { category: 'unknown', message: fallbackMessage };
  }
  return {
    category: typeof err.category === 'string' && err.category ? err.category : inferCategory(err),
    message: typeof err.message === 'string' && err.message ? err.message : String(err),
  };
}

function inferCategory(err) {
  const message = typeof err?.message === 'string' ? err.message : String(err ?? '');
  if (/timeout|timed?\s*out|did not complete within/i.test(message)) return 'timeout';
  return 'adapter_error';
}

function readStdinAll() {
  return new Promise((resolveStdin, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolveStdin(data));
    process.stdin.on('error', reject);
  });
}

async function cliMain() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const payload = {
      status: 'failed',
      threadId: null,
      durationMs: 0,
      result: null,
      rawTail: '',
      error: normalizeError(err, 'Invalid arguments'),
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
    return;
  }

  const prompt = await readStdinAll();
  const { payload, exitCode } = await runGoalTurn(prompt, args);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = exitCode;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectRun()) {
  cliMain().catch((err) => {
    const payload = {
      status: 'failed',
      threadId: null,
      durationMs: 0,
      result: null,
      rawTail: '',
      error: normalizeError(err, 'Codex goal helper failed'),
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
/**
 * scripts/ask.mjs — Single-shot query helper for the `/ask` skill.
 *
 * Routes to codex-exec or gemini-exec adapters directly. Does NOT use
 * selectAdapter() (which prefers multi-turn app-server/ACP) and does NOT
 * fall back to tmux (see docs/plans/ask-adapter-migration/spec.md §4.1.1(b)).
 *
 * Usage:
 *   echo "<prompt>" | node scripts/ask.mjs <model>
 *   <model> ∈ { codex | gemini | auto }
 *
 * Exit codes:
 *   0 — success, response on stdout
 *   1 — adapter error (auth/network/crash/timeout) — error on stderr
 *   2 — requested model not available — answer directly as Claude
 *   3 — argv/usage error
 *
 * Writes an artifact to .ao/artifacts/ask/<model>-<timestamp>.md whenever an
 * adapter actually runs (success, adapter error, or timeout — errors get a
 * `# Error` header). Exit-2 (no adapter available) and exit-3 (usage error)
 * paths do NOT write an artifact because no model was actually queried.
 *
 * Zero npm dependencies.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectCapabilities } from './lib/preflight.mjs';
import { resolveGeminiApproval } from './lib/gemini-approval.mjs';
import { resolveCodexApproval, shouldDemoteCodexWorker } from './lib/codex-approval.mjs';
import { loadAutonomyConfig } from './lib/autonomy.mjs';

const COLLECT_TIMEOUT_MS = 120_000;
const ARTIFACT_DIR = '.ao/artifacts/ask';
const VALID_MODELS = ['codex', 'gemini', 'auto'];

/**
 * Pure routing function — picks an exec adapter based on model arg + capabilities.
 * Deliberately excludes codex-appserver/gemini-acp (multi-turn, Atlas/Athena
 * territory) and tmux (legacy fallback being phased out).
 *
 * @param {'codex'|'gemini'|'auto'} model
 * @param {{ hasCodexExecJson?: boolean, hasGeminiCli?: boolean }} caps
 * @returns {'codex-exec' | 'gemini-exec' | 'none'}
 */
export function pickAskAdapter(model, caps = {}) {
  if (model === 'auto') {
    if (caps.hasCodexExecJson) return 'codex-exec';
    if (caps.hasGeminiCli) return 'gemini-exec';
    return 'none';
  }
  if (model === 'codex') {
    return caps.hasCodexExecJson ? 'codex-exec' : 'none';
  }
  if (model === 'gemini') {
    return caps.hasGeminiCli ? 'gemini-exec' : 'none';
  }
  return 'none';
}

/**
 * Read all of stdin to a string.
 * @returns {Promise<string>}
 */
function readStdinAll() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Build the artifact filename.
 * @param {string} model - resolved model name (codex | gemini)
 * @returns {string}
 */
function artifactPath(model) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return join(ARTIFACT_DIR, `${model}-${ts}.md`);
}

/**
 * Write an artifact file. Body-only — no YAML frontmatter (per spec §4.1).
 * Fail-safe: errors are swallowed so artifact failure doesn't break the helper.
 *
 * @param {string} path
 * @param {string} body
 */
function writeArtifact(path, body) {
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, body, { mode: 0o600 });
  } catch {
    // Best-effort — never throw from artifact writing
  }
}

/**
 * Map an adapter name to its ESM module loader.
 * @param {'codex-exec' | 'gemini-exec'} adapterName
 * @returns {Promise<Object>}
 */
async function loadAdapter(adapterName) {
  if (adapterName === 'codex-exec') return import('./lib/codex-exec.mjs');
  if (adapterName === 'gemini-exec') return import('./lib/gemini-exec.mjs');
  throw new Error(`Unknown adapter: ${adapterName}`);
}

/**
 * Build adapter-specific spawn options.
 *
 * Codex: passes `level` resolved from host Claude permissions via
 * `resolveCodexApproval`. The codex-exec spawn() then maps level →
 * `-a never -s <sandbox>` global flags. If the host level is `'suggest'`,
 * codex cannot run usefully (read-only sandbox would silently complete with
 * "I can only suggest changes"); the caller must check the returned
 * `_demoted` flag and exit with code 2 (model not available).
 *
 * Gemini: approval mode mirrored from Claude permissions via gemini-approval.
 *
 * Exported for tests so we can verify the production approval plumbing
 * without mocking dynamic imports.
 *
 * @param {'codex-exec' | 'gemini-exec'} adapterName
 * @returns {Object} Spawn opts; may also carry `_demoted: true` for codex
 *   when the host level is too low to run codex usefully.
 */
export function buildSpawnOpts(adapterName) {
  const opts = { cwd: process.cwd() };
  if (adapterName === 'codex-exec') {
    try {
      const autonomy = loadAutonomyConfig(process.cwd());
      const level = resolveCodexApproval(autonomy, { cwd: process.cwd() });
      if (shouldDemoteCodexWorker(level)) {
        // Signal the caller — `/ask` cannot demote to claude-cli the way
        // worker-spawn does (it has no team context); instead we exit-2.
        opts._demoted = true;
        opts._demotionReason = `host permission level (${level}) too low for non-interactive codex`;
      } else {
        opts.level = level;
      }
    } catch {
      // Fall through with no level — codex-exec spawn() will use its
      // legacy bypass fallback.
    }
  } else if (adapterName === 'gemini-exec') {
    try {
      const autonomy = loadAutonomyConfig(process.cwd());
      opts.approvalMode = resolveGeminiApproval(autonomy, { cwd: process.cwd() });
    } catch {
      // Fall through with no approval mode (gemini default)
    }
  }
  return opts;
}

/**
 * Resolve the canonical model label for filenames + messages.
 * @param {'codex-exec' | 'gemini-exec'} adapterName
 * @returns {'codex' | 'gemini'}
 */
function modelLabel(adapterName) {
  return adapterName === 'codex-exec' ? 'codex' : 'gemini';
}

/**
 * Run the adapter once: spawn → collect → shutdown (always).
 * Returns { ok, output, error, artifactPath }.
 *
 * @param {'codex-exec' | 'gemini-exec'} adapterName
 * @param {string} prompt
 * @param {{ adapter?: object, opts?: object }} [_inject] - Test injection point.
 *   Tests pass a fake adapter module + spawn opts to exercise runtime paths
 *   without spawning real subprocesses. Production callers omit this.
 * @returns {Promise<{ ok: boolean, output: string, error: string|null, artifactPath: string }>}
 */
export async function runOnce(adapterName, prompt, _inject = {}) {
  const adapter = _inject.adapter || (await loadAdapter(adapterName));
  const opts = _inject.opts || buildSpawnOpts(adapterName);
  const label = modelLabel(adapterName);
  const path = artifactPath(label);

  // Codex permission gate: if buildSpawnOpts marked the worker as demoted
  // (host permission too low for non-interactive codex), refuse to spawn.
  // Returning ok:false with `demoted: true` signals main() to exit with code
  // 2 (model not available, answer as Claude).
  //
  // Per the file-header contract, exit-2 paths do NOT write an artifact
  // (no model was actually queried) — we return artifactPath: null and the
  // caller must not log a path either.
  if (opts._demoted) {
    const msg = opts._demotionReason || 'demoted';
    return { ok: false, output: '', error: `demoted: ${msg}`, artifactPath: null, demoted: true };
  }

  let handle = null;
  try {
    handle = adapter.spawn(prompt, opts);
  } catch (err) {
    const msg = `Failed to spawn ${adapterName}: ${err && err.message ? err.message : String(err)}`;
    writeArtifact(path, `# Error\n\n${msg}\n`);
    return { ok: false, output: '', error: msg, artifactPath: path };
  }

  try {
    const result = await adapter.collect(handle, COLLECT_TIMEOUT_MS);
    const output = (handle._output || result.output || '').trim();

    if (result.error) {
      const cat = result.error.category || 'unknown';
      const msg = result.error.message || `${adapterName} error: ${cat}`;
      writeArtifact(path, `# Error\n\nCategory: ${cat}\n\n${msg}\n`);
      return { ok: false, output, error: `${cat}: ${msg}`, artifactPath: path };
    }

    writeArtifact(path, output + (output.endsWith('\n') ? '' : '\n'));
    return { ok: true, output, error: null, artifactPath: path };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    writeArtifact(path, `# Error\n\nUnexpected: ${msg}\n`);
    return { ok: false, output: '', error: msg, artifactPath: path };
  } finally {
    // MANDATORY cleanup — codex-exec/gemini-exec spawn detached children.
    // Without this, a hung process can outlive the helper.
    if (handle) {
      try {
        await adapter.shutdown(handle);
      } catch {
        // Best-effort
      }
    }
  }
}

/**
 * Print a usage / unavailable hint to stderr.
 */
function printUnavailable(model) {
  process.stderr.write(
    `[ask] No adapter available for model="${model}".\n` +
    `[ask] /ask requires codex (>=0.116, 'codex --version') or gemini installed.\n` +
    `[ask] Try '/ask auto' to auto-pick whichever is available, or upgrade with:\n` +
    `[ask]   npm install -g @openai/codex@latest\n` +
    `[ask]   npm install -g @google/gemini-cli@latest\n` +
    `[ask] Falling back: answer directly as Claude.\n`
  );
}

/**
 * Print a usage error and return exit code 3.
 */
function printUsage(reason) {
  process.stderr.write(
    `[ask] Usage error: ${reason}\n` +
    `[ask] Usage: echo "<prompt>" | node scripts/ask.mjs <codex|gemini|auto>\n`
  );
}

async function main() {
  const model = process.argv[2];
  if (!model || !VALID_MODELS.includes(model)) {
    printUsage(`missing or invalid model arg (got: ${JSON.stringify(model)})`);
    process.exit(3);
  }

  let prompt;
  try {
    prompt = (await readStdinAll()).trim();
  } catch (err) {
    printUsage(`failed to read stdin: ${err && err.message ? err.message : err}`);
    process.exit(3);
  }
  if (!prompt) {
    printUsage('empty stdin — pipe a prompt via stdin');
    process.exit(3);
  }

  let caps;
  try {
    caps = await detectCapabilities();
  } catch {
    caps = {};
  }

  let adapterName = pickAskAdapter(model, caps);
  if (adapterName === 'none') {
    printUnavailable(model);
    process.exit(2);
  }

  let result = await runOnce(adapterName, prompt);

  if (result.demoted) {
    // Codex permission gate fired (host level too low for non-interactive
    // codex). In `auto` mode, transparently fall back to gemini-exec if it
    // is available — `auto` is contractually "whichever model works".
    // For explicit codex requests, exit 2 (model not available, answer as
    // Claude) per the file-header contract (no artifact written).
    if (model === 'auto' && adapterName === 'codex-exec' && caps.hasGeminiCli) {
      process.stderr.write(`[ask] codex unavailable (${result.error}); falling back to gemini-exec\n`);
      adapterName = 'gemini-exec';
      result = await runOnce(adapterName, prompt);
      // Fall through to standard ok/error handling below.
    } else {
      process.stderr.write(`[ask] codex unavailable: ${result.error}\n`);
      process.exit(2);
    }
  }

  if (!result.ok) {
    process.stderr.write(`[ask] adapter error: ${result.error}\n`);
    process.stderr.write(`[ask] artifact: ${result.artifactPath}\n`);
    process.exit(1);
  }

  process.stdout.write(result.output);
  if (!result.output.endsWith('\n')) process.stdout.write('\n');
  process.stderr.write(`[ask] artifact: ${result.artifactPath}\n`);
  process.exit(0);
}

// Only run main when invoked directly (not when imported by tests)
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[ask] fatal: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

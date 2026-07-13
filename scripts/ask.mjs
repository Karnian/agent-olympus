#!/usr/bin/env node
/**
 * scripts/ask.mjs — `/ask` skill CLI helper.
 *
 * Two modes on a single entry point:
 *
 * 1. **Legacy sync path** (v1.0.3 contract preserved byte-identical):
 *      echo "<prompt>" | node scripts/ask.mjs <codex|gemini|auto> [--no-mcp]
 *    → spawn adapter, await collect (120s timeout), print to stdout, exit.
 *    Writes `.ao/artifacts/ask/<model>-<timestamp>.md`.
 *
 *    Exit codes:
 *      0 — success, response on stdout
 *      1 — adapter error (auth/network/crash/timeout) on stderr
 *      2 — requested model not available — answer directly as Claude
 *      3 — argv/usage error
 *
 * 2. **Job-based async path** (v1.0.4, see docs/plans/ask-job-based/spec.md
 *    rev 4 APPROVED):
 *      echo "<prompt>" | node scripts/ask.mjs async <model> [--no-mcp]
 *      node scripts/ask.mjs status <jobId>
 *      node scripts/ask.mjs collect <jobId> [--wait] [--timeout Ns]
 *      node scripts/ask.mjs cancel <jobId>
 *      node scripts/ask.mjs list [--status ...] [--older-than Ns]
 *      node scripts/ask.mjs _run-job <jobId>   (internal, detached)
 *    → fire-and-forget; a detached runner process owns the adapter lifecycle
 *    and flips `.ao/state/ask-jobs/<jobId>.json` metadata when done.
 *    Writes `.ao/artifacts/ask/<jobId>.{jsonl,md}`.
 *
 * Zero npm dependencies. ESM. Node built-ins only.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { detectCapabilities } from './lib/preflight.mjs';
import { resolveGeminiApproval } from './lib/gemini-approval.mjs';
import { resolveCodexApproval, shouldDemoteCodexWorker } from './lib/codex-approval.mjs';
import { explainPermissionLevel } from './lib/permission-detect.mjs';
import { loadAutonomyConfig } from './lib/autonomy.mjs';
import * as askJobs from './lib/ask-jobs.mjs';

/**
 * System-prompt guard prepended to `/ask codex` prompts when the host has not
 * granted the broad permissions codex needs to actually edit files. The
 * adapter still runs under codex's `read-only` sandbox tier (no FS writes,
 * no shell network), but the prompt prefix tells the model to ALSO refrain
 * from claiming it edited anything in its response — defense-in-depth
 * against the "I applied the change" hallucination codex flagged in our
 * cross-review (#67 codex consultation, 2026-05-08).
 */
const READONLY_GUARD_HEADER = (
  '⚠️ READ-ONLY MODE — host permissions do not grant write access.\n' +
  'Rules for this turn:\n' +
  '  1. Do NOT edit files, run shell commands, or claim to have applied any change.\n' +
  '  2. Reply with analysis, suggestions, or explanations only.\n' +
  '  3. If the user asked for an edit, output the proposed diff/snippet inline ' +
  'without writing it to disk.\n' +
  '  4. If a question genuinely requires execution, say so explicitly so the user ' +
  'can re-invoke with broader permissions.\n\n' +
  '──── User prompt below ────\n\n'
);

const COLLECT_TIMEOUT_MS = 120_000;       // Sync path only
const RUNNER_COLLECT_TIMEOUT_MS = 86_400_000; // Runner: 24h (spec §4.3 step 11)
const ARTIFACT_DIR = '.ao/artifacts/ask';
const VALID_MODELS = ['codex', 'gemini', 'auto'];
const MCP_AUTH_HINT =
  '[hint] an MCP server configured in ~/.codex/config.toml failed authentication — ' +
  're-login to that server, or retry with `ask --no-mcp`.';

// ═══════════════════════════════════════════════════════════════════════════
// Test injection seams
// ═══════════════════════════════════════════════════════════════════════════

const _injected = {
  runJobSpawner: null,  // replaces the detached runner spawn in runAsyncLaunch
  adapter: null,        // replaces loadAdapter() return value (used by runner path)
  buildSpawnOpts: null, // replaces buildSpawnOpts() (runner path)
  clock: null,          // replaces `new Date()` where observable
  liveness: null,       // replaces askJobs.isProcessAlive
  pollInterval: null,   // replaces collect --wait poll interval
  exitFn: null,         // replaces process.exit
  stdoutWrite: null,    // captures stdout
  stderrWrite: null,    // captures stderr
  stdinReader: null,    // replaces readStdinAll; returns a promise for the prompt
  capabilities: null,   // replaces detectCapabilities() result
  killFn: null,         // replaces process.kill for cancel (for tests)
};

/**
 * Inject test doubles. Pass `null` to reset a specific key, or call with no
 * args to reset everything. Returns the previous injected state for save/restore.
 *
 * Special: `liveness` is forwarded to `askJobs._injectLiveness` so the
 * shared pid→bool map reaches `reconcileStatus`/`isProcessAlive` via the
 * helper's module-level seam. (The test previously passed the map as a
 * `killImpl` positional arg, which silently coerced to "false".)
 */
export function _inject(map = null) {
  const prev = { ..._injected };
  if (map === null) {
    for (const k of Object.keys(_injected)) _injected[k] = null;
    askJobs._injectLiveness(null);
    return prev;
  }
  for (const [k, v] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(_injected, k)) {
      _injected[k] = v;
    }
  }
  if (Object.prototype.hasOwnProperty.call(map, 'liveness')) {
    askJobs._injectLiveness(map.liveness);
  }
  return prev;
}

function _clock() {
  return _injected.clock ? _injected.clock() : new Date();
}

function _exit(code) {
  if (_injected.exitFn) return _injected.exitFn(code);
  return process.exit(code);
}

function _writeStdout(s) {
  if (_injected.stdoutWrite) return _injected.stdoutWrite(s);
  return process.stdout.write(s);
}

function _writeStderr(s) {
  if (_injected.stderrWrite) return _injected.stderrWrite(s);
  return process.stderr.write(s);
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers (used by sync + async paths)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure routing function — picks an exec adapter based on model arg + capabilities.
 * Deliberately excludes codex-appserver/gemini-acp (multi-turn, Atlas/Athena
 * territory) and the legacy tmux fallback.
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

function readStdinAll() {
  if (_injected.stdinReader) return Promise.resolve(_injected.stdinReader());
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function _detectCaps() {
  if (_injected.capabilities) return _injected.capabilities;
  try { return await detectCapabilities(); } catch { return {}; }
}

/** Sync-path artifact filename: `<cwd>/.ao/artifacts/ask/<model>-<ts>.md`. */
function syncArtifactPath(model) {
  const now = _clock();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return join(ARTIFACT_DIR, `${model}-${ts}.md`);
}

function writeArtifact(path, body) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, body, { mode: 0o600 });
  } catch { /* best-effort */ }
}

async function loadAdapter(adapterName) {
  if (_injected.adapter) return _injected.adapter;
  if (adapterName === 'codex-exec') return import('./lib/codex-exec.mjs');
  if (adapterName === 'gemini-exec') return import('./lib/gemini-exec.mjs');
  throw new Error(`Unknown adapter: ${adapterName}`);
}

function applyNoMcpOption(opts, adapterName, noMcp) {
  const base = opts && typeof opts === 'object' ? opts : {};
  if (!noMcp || adapterName !== 'codex-exec') return base;
  return {
    ...base,
    // `mcp_servers={}` is an empty-table overlay and therefore does not
    // remove servers loaded from ~/.codex/config.toml. Supported Codex exec
    // versions provide an explicit, fail-closed switch which skips that file
    // while retaining CODEX_HOME authentication and command-line -c overrides.
    ignoreUserConfig: true,
  };
}

function warnNoMcpIgnored(noMcp, adapterName) {
  if (noMcp && adapterName !== 'codex-exec') {
    _writeStderr('[ask] --no-mcp only applies to codex; ignored\n');
  }
}

/**
 * Build adapter-specific spawn options (codex level, gemini approvalMode).
 *
 * Codex demotion behavior (issue #67/#68/#69)
 * ───────────────────────────────────────────
 * Historically, when `resolveCodexApproval` returned `suggest` (host had no
 * broad allow grants and no runtime override picked it up), `/ask codex`
 * exited with code 2 ("demoted") and refused to spawn. That blocked the
 * common case of asking codex a read-only review question on a host with
 * deliberately narrow permissions.
 *
 * New behavior: the suggest-tier path now FALLS BACK to codex's `read-only`
 * sandbox (`-s read-only -a never`) instead of demoting. The adapter runs
 * with no FS write capability and no shell network, which is enough for any
 * pure analysis/review prompt. The caller marks `opts._readonlyFallback =
 * true` so the spawn path can prepend a system-prompt guard and the post-
 * adapter step can verify nothing leaked through (`git diff --quiet`).
 *
 * Atlas/Athena workers and other non-`/ask` callers DO NOT use this fallback
 * — they still demote to a Claude worker (preserves the existing safety:
 * a structured-output worker reporting "I applied the change" without
 * actually doing so would confuse the orchestrator).
 *
 * Exported for tests.
 * @param {string} adapterName
 * @param {{noMcp?: boolean}} [requestOpts]
 * @returns {object}
 */
export function buildSpawnOpts(adapterName, { noMcp = false } = {}) {
  if (_injected.buildSpawnOpts) {
    const injectedOpts = _injected.buildSpawnOpts(adapterName, { noMcp });
    return applyNoMcpOption(injectedOpts, adapterName, noMcp);
  }
  const opts = { cwd: process.cwd() };
  if (adapterName === 'codex-exec') {
    try {
      const autonomy = loadAutonomyConfig(process.cwd());
      const level = resolveCodexApproval(autonomy, { cwd: process.cwd() });
      if (shouldDemoteCodexWorker(level)) {
        // Issue #67/#68/#69: instead of demoting, run codex at suggest level
        // (mapped to `-s read-only -a never`). Pure-analysis prompts work
        // fine; write/exec attempts are blocked by the sandbox.
        opts.level = level;
        opts._readonlyFallback = true;

        // Build the diagnostic explanation once so callers (status, error
        // logs, post-run notices) can show WHY we fell back instead of
        // running with broader access.
        try {
          const explain = explainPermissionLevel({ cwd: process.cwd() });
          opts._readonlyExplanation = explain.chosenSourceReason;
          opts._permissionExplain = explain;
        } catch {
          opts._readonlyExplanation =
            'host permissions resolved to suggest tier; running codex under ' +
            'read-only sandbox (no FS writes, no shell network).';
        }
      } else {
        opts.level = level;
      }
    } catch (err) {
      // Fail CLOSED — codex review (#67) flagged this catch as a security
      // regression. A thrown error here means we couldn't resolve the host's
      // permission tier (corrupt autonomy.json, fs error, …). The previous
      // `/* fall through */` left `opts.level` undefined, which made
      // codex-exec.mjs fall back to `--dangerously-bypass-approvals-and-sandbox`
      // (legacy bypass) — i.e. unverified failure → maximum permissions.
      // We now pin the safest possible level + flag the read-only fallback
      // so the spawn still produces useful output without ever exceeding
      // the most restrictive sandbox.
      opts.level = 'suggest';
      opts._readonlyFallback = true;
      opts._readonlyExplanation =
        `permission resolution threw (${err && err.message ? err.message : err}); ` +
        `failing closed to read-only sandbox to avoid the legacy bypass path.`;
    }
  } else if (adapterName === 'gemini-exec') {
    try {
      const autonomy = loadAutonomyConfig(process.cwd());
      opts.approvalMode = resolveGeminiApproval(autonomy, { cwd: process.cwd() });
      // Thread credential resolver config so gemini-exec can pull the key
      // from the OS secret store (macOS Keychain / Linux secret-tool) at
      // spawn time — users running `gemini /auth` once don't need to also
      // export GEMINI_API_KEY.
      opts.credential = {
        credentialSource: autonomy.gemini?.credentialSource,
        service: autonomy.gemini?.keychainService,
        useKeychain: autonomy.gemini?.useKeychain,
        account: autonomy.gemini?.keychainAccount || 'default-api-key',
      };
    } catch { /* fall through */ }
  }
  return applyNoMcpOption(opts, adapterName, noMcp);
}

function modelLabel(adapterName) {
  return adapterName === 'codex-exec' ? 'codex' : 'gemini';
}

// ═══════════════════════════════════════════════════════════════════════════
// SYNC PATH (v1.0.3 contract — preserved byte-identical)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sync-path single-shot runner: spawn → collect → shutdown (always).
 * Exported for tests.
 *
 * Read-only fallback (issue #67/#68/#69): when `opts._readonlyFallback` is set
 * (codex on a suggest-tier host), prepend `READONLY_GUARD_HEADER` to the
 * prompt so the model is reminded NOT to claim it edited anything. After
 * collect, run `git diff --quiet` as a defense-in-depth check; if the tree
 * changed, log a warning to stderr (the adapter shouldn't be able to write
 * under `-s read-only`, but a misbehaving MCP server inside the codex CLI
 * could still leak through, so we surface it).
 */
export async function runOnce(adapterName, prompt, _testInject = {}) {
  const adapter = _testInject.adapter || _injected.adapter || (await loadAdapter(adapterName));
  const noMcp = _testInject.noMcp === true;
  const opts = _testInject.opts
    ? applyNoMcpOption(_testInject.opts, adapterName, noMcp)
    : buildSpawnOpts(adapterName, { noMcp });
  const label = modelLabel(adapterName);
  const path = syncArtifactPath(label);

  if (opts._demoted) {
    const msg = opts._demotionReason || 'demoted';
    return { ok: false, output: '', error: `demoted: ${msg}`, artifactPath: null, demoted: true };
  }

  // Apply read-only guard header BEFORE the user prompt. The header prefix
  // is stable so the model sees the same disclaimer every time. Atlas/Athena
  // never set this flag — the fallback is a /ask-only feature.
  const effectivePrompt = opts._readonlyFallback
    ? READONLY_GUARD_HEADER + prompt
    : prompt;

  // Capture the pre-run git tree state for the defense-in-depth post-check.
  // execFileSync with stdio:'pipe' so a missing git binary or non-repo cwd
  // doesn't pollute hook output.
  let preRunGitClean = null;
  if (opts._readonlyFallback) {
    preRunGitClean = isGitTreeClean(opts.cwd || process.cwd());
  }

  let handle = null;
  try {
    handle = adapter.spawn(effectivePrompt, opts);
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

    // Read-only post-check: if the tree was clean before the run and is
    // dirty after, the codex sandbox failed to contain a write. We don't
    // block — the response is still valid analysis — but we attach a
    // warning so the user can investigate.
    let readonlyViolation = null;
    if (opts._readonlyFallback && preRunGitClean === true) {
      const postRunGitClean = isGitTreeClean(opts.cwd || process.cwd());
      if (postRunGitClean === false) {
        readonlyViolation =
          'Read-only fallback: tree was clean before /ask but is now dirty. ' +
          'Codex may have written outside its sandbox (MCP server, raw shell, ' +
          'or a sandbox bug). Run `git status` to inspect.';
      }
    }

    writeArtifact(path, output + (output.endsWith('\n') ? '' : '\n'));
    return {
      ok: true,
      output,
      error: null,
      artifactPath: path,
      readonlyFallback: !!opts._readonlyFallback,
      readonlyExplanation: opts._readonlyExplanation || null,
      readonlyViolation,
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    writeArtifact(path, `# Error\n\nUnexpected: ${msg}\n`);
    return { ok: false, output: '', error: msg, artifactPath: path };
  } finally {
    if (handle) {
      try { await adapter.shutdown(handle); } catch { /* best-effort */ }
    }
  }
}

/**
 * Defense-in-depth helper: returns true if `git status --porcelain` is empty,
 * false if it has any output, null on any failure (no git, not a repo, etc.).
 * Used to detect whether the codex `read-only` sandbox failed to contain a
 * write. The check is best-effort — a null return means "we couldn't tell"
 * and the caller skips the warning.
 *
 * @param {string} cwd
 * @returns {boolean | null}
 */
function isGitTreeClean(cwd) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return out.trim().length === 0;
  } catch {
    return null;
  }
}

function printUnavailable(model) {
  _writeStderr(
    `[ask] No adapter available for model="${model}".\n` +
    `[ask] /ask requires codex (>=0.116, 'codex --version') or gemini installed.\n` +
    `[ask] Try '/ask auto' to auto-pick whichever is available, or upgrade with:\n` +
    `[ask]   npm install -g @openai/codex@latest\n` +
    `[ask]   npm install -g @google/gemini-cli@latest\n` +
    `[ask] Falling back: answer directly as Claude.\n`
  );
}

function printUsage(reason) {
  _writeStderr(
    `[ask] Usage error: ${reason}\n` +
    `[ask] Usage:\n` +
    `[ask]   echo "<prompt>" | node scripts/ask.mjs <codex|gemini|auto> [--no-mcp]\n` +
    `[ask]   echo "<prompt>" | node scripts/ask.mjs async <codex|gemini|auto> [--no-mcp]\n` +
    `[ask]   --no-mcp: disable configured MCP servers for Codex; ignored for Gemini/Claude.\n` +
    `[ask]   node scripts/ask.mjs status <jobId>\n` +
    `[ask]   node scripts/ask.mjs collect <jobId> [--wait] [--timeout Ns]\n` +
    `[ask]   node scripts/ask.mjs cancel <jobId>\n` +
    `[ask]   node scripts/ask.mjs list [--status ...] [--older-than Ns]\n`
  );
}

/**
 * Legacy sync path. Byte-identical behavior to v1.0.3.
 * Preserved entry point for all existing callers (Atlas, Athena, external).
 */
async function runSyncPath(model, noMcp = false) {
  let prompt;
  try {
    prompt = (await readStdinAll()).trim();
  } catch (err) {
    printUsage(`failed to read stdin: ${err && err.message ? err.message : err}`);
    return _exit(3);
  }
  if (!prompt) {
    printUsage('empty stdin — pipe a prompt via stdin');
    return _exit(3);
  }

  const caps = await _detectCaps();

  let adapterName = pickAskAdapter(model, caps);
  if (adapterName === 'none') {
    warnNoMcpIgnored(noMcp, 'claude');
    printUnavailable(model);
    return _exit(2);
  }

  warnNoMcpIgnored(noMcp, adapterName);
  let result = await runOnce(adapterName, prompt, { noMcp });

  if (result.demoted) {
    // Demotion is now reserved for paths that explicitly opt out of read-only
    // fallback (Atlas/Athena workers — buildSpawnOpts above sets `_demoted`
    // only when the fallback isn't appropriate). For `/ask` itself this
    // branch is reachable only via test injection.
    if (model === 'auto' && adapterName === 'codex-exec' && caps.hasGeminiCli) {
      _writeStderr(`[ask] codex unavailable (${result.error}); falling back to gemini-exec\n`);
      adapterName = 'gemini-exec';
      warnNoMcpIgnored(noMcp, adapterName);
      result = await runOnce(adapterName, prompt, { noMcp });
    } else {
      if (adapterName === 'codex-exec') warnNoMcpIgnored(noMcp, 'claude');
      _writeStderr(`[ask] codex unavailable: ${result.error}\n`);
      return _exit(2);
    }
  }

  if (!result.ok) {
    _writeStderr(`[ask] adapter error: ${result.error}\n`);
    _writeStderr(`[ask] artifact: ${result.artifactPath}\n`);
    return _exit(1);
  }

  _writeStdout(result.output);
  if (!result.output.endsWith('\n')) _writeStdout('\n');

  // Read-only fallback annotations — visible to the user so they understand
  // why codex didn't run with full sandbox access and can override the
  // detection if they prefer.
  if (result.readonlyFallback) {
    _writeStderr(
      `[ask] codex ran in READ-ONLY mode (-s read-only). ` +
      `${result.readonlyExplanation || ''}\n` +
      `[ask]   To run codex with FS write access, either:\n` +
      `[ask]     • set \`"codex": { "approval": "full-auto" }\` in .ao/autonomy.json (explicit override)\n` +
      `[ask]     • restart Claude Code so the SessionStart hook can capture the runtime permission_mode\n` +
      `[ask]     • add LITERAL "Bash(*)" + "Write(*)" to permissions.allow\n`
    );
    if (result.readonlyViolation) {
      _writeStderr(`[ask] WARNING: ${result.readonlyViolation}\n`);
    }
  }

  _writeStderr(`[ask] artifact: ${result.artifactPath}\n`);
  return _exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// ASYNC LAUNCH PATH (spec §4.2)
// ═══════════════════════════════════════════════════════════════════════════

async function runAsyncLaunch(model, noMcp = false) {
  let prompt;
  try {
    prompt = (await readStdinAll()).trim();
  } catch (err) {
    printUsage(`failed to read stdin: ${err && err.message ? err.message : err}`);
    return _exit(3);
  }
  if (!prompt) {
    printUsage('empty stdin — pipe a prompt via stdin');
    return _exit(3);
  }

  const caps = await _detectCaps();

  let adapterName = pickAskAdapter(model, caps);
  if (adapterName === 'none') {
    warnNoMcpIgnored(noMcp, 'claude');
    printUnavailable(model);
    return _exit(2);
  }

  // §4.2 step 4a — dispatch-level codex→gemini fallback on demoted host.
  // Codex now uses read-only fallback (issue #67/#68/#69) instead of
  // demoting at /ask, so `_demoted` is rare; it remains for paths where the
  // adapter genuinely cannot run (e.g. gemini auth missing).
  let opts = buildSpawnOpts(adapterName, { noMcp });
  if (opts._demoted) {
    if (model === 'auto' && adapterName === 'codex-exec' && caps.hasGeminiCli) {
      _writeStderr(`[ask] codex unavailable (${opts._demotionReason}); falling back to gemini-exec\n`);
      adapterName = 'gemini-exec';
      opts = buildSpawnOpts(adapterName, { noMcp });
      if (opts._demoted) {
        warnNoMcpIgnored(noMcp, 'claude');
        _writeStderr(`[ask] gemini also unavailable: ${opts._demotionReason}\n`);
        return _exit(2);
      }
    } else {
      warnNoMcpIgnored(noMcp, 'claude');
      _writeStderr(`[ask] ${modelLabel(adapterName)} unavailable: ${opts._demotionReason}\n`);
      return _exit(2);
    }
  }
  warnNoMcpIgnored(noMcp, adapterName);
  // If we landed on the read-only fallback, surface it to the user before
  // the runner detaches — async callers won't see the per-run readonly
  // explanation otherwise.
  if (opts._readonlyFallback) {
    _writeStderr(
      `[ask] codex will run in READ-ONLY mode. ` +
      `${opts._readonlyExplanation || ''}\n`
    );
  }

  // Allocate jobId + ensure dirs exist + write prompt sidecar.
  const jobId = askJobs.allocateJobId(adapterName);
  askJobs.ensureJobDirs(process.cwd());
  askJobs.writePromptFile(jobId, prompt);

  const promptHash = askJobs.computePromptHash(model, prompt);
  const startedAt = _clock().toISOString();

  // §4.2 step 8 — scriptPath is the resolved absolute path of this module.
  const scriptPath = fileURLToPath(import.meta.url);

  // §4.2 step 9 — detached re-exec the runner.
  const spawner = _injected.runJobSpawner || ((sp, args, options) => nodeSpawn(sp, args, options));
  const runner = spawner(process.execPath, [scriptPath, '_run-job', jobId], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: process.cwd(),
  });

  // §4.2 step 10 — metadata MUST be written synchronously AFTER spawn (we
  // need runner.pid) but BEFORE unref/exit (so the runner's step-1 read
  // never sees a missing file in the happy path).
  const meta = {
    jobId,
    model,
    adapterName,
    noMcp: noMcp === true,
    runnerPid: runner.pid || 0,
    adapterPid: null,
    startedAt,
    lastActivityAt: startedAt,
    status: 'running',
    promptHash,
    promptBytes: Buffer.byteLength(prompt, 'utf-8'),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  };
  askJobs.writeMetadata(jobId, meta);

  // §4.2 step 11 — unref so the async parent can exit without waiting.
  try { runner.unref(); } catch { /* test doubles may lack unref */ }

  // §4.2 step 12 — emit one JSON line with the handoff details.
  const handoff = {
    jobId,
    artifactPath: meta.artifactMdPath,
    runnerPid: meta.runnerPid,
  };
  _writeStdout(JSON.stringify(handoff) + '\n');
  return _exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER ENTRY POINT (_run-job <jobId>)   spec §4.3
// ═══════════════════════════════════════════════════════════════════════════

async function runJob(jobId) {
  // Step 1: read metadata with 2s retry loop for defence-in-depth.
  let meta = null;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    meta = askJobs.readMetadata(jobId);
    if (meta) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!meta) {
    // Truly orphaned — parent never wrote metadata.
    return _exit(1);
  }

  // Step 2: read + unlink prompt sidecar.
  let prompt;
  try {
    prompt = askJobs.readAndUnlinkPromptFile(jobId);
  } catch {
    // No prompt file → treat as failed and write sentinel + metadata.
    askJobs.writeRunnerSentinel(meta.artifactJsonlPath, {
      reason: 'failed',
      category: 'orphaned',
      message: 'prompt file missing at runner startup',
      text: '',
    });
    askJobs.writeMetadata(jobId, {
      ...meta,
      status: 'failed',
      errorCategory: 'orphaned',
      errorMessage: 'prompt file missing at runner startup',
      endedAt: _clock().toISOString(),
    });
    return _exit(0);
  }

  // Step 3: ensure artifact dir exists BEFORE any branch (spec rev 4 fix).
  askJobs.ensureJobDirs(process.cwd());

  // Step 4: resolve opts (may demote).
  const opts = buildSpawnOpts(meta.adapterName, { noMcp: meta.noMcp === true });
  if (opts._demoted) {
    // Step 5 demoted branch: sentinel first, then metadata flip.
    askJobs.writeRunnerSentinel(meta.artifactJsonlPath, {
      reason: 'failed',
      category: 'demoted',
      message: opts._demotionReason || 'demoted',
      text: '',
    });
    askJobs.writeMetadata(jobId, {
      ...meta,
      status: 'failed',
      errorCategory: 'demoted',
      errorMessage: opts._demotionReason || 'demoted',
      exitCode: 2,
      endedAt: _clock().toISOString(),
    });
    return _exit(0);
  }

  // Step 6: load the adapter.
  let adapter;
  try {
    adapter = await loadAdapter(meta.adapterName);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    askJobs.writeRunnerSentinel(meta.artifactJsonlPath, {
      reason: 'failed',
      category: 'not_installed',
      message: `adapter load failed: ${msg}`,
      text: '',
    });
    askJobs.writeMetadata(jobId, {
      ...meta,
      status: 'failed',
      errorCategory: 'not_installed',
      errorMessage: msg,
      endedAt: _clock().toISOString(),
    });
    return _exit(0);
  }

  // Step 7: open tee stream for adapter.data chunks.
  let jsonlStream = null;
  try {
    const { createWriteStream } = await import('node:fs');
    jsonlStream = createWriteStream(meta.artifactJsonlPath, { flags: 'a', mode: 0o600 });
    jsonlStream.on('error', (err) => {
      meta._jsonlError = err && err.message ? err.message : String(err);
    });
  } catch (err) {
    // Non-fatal — adapter collect still runs. The sentinel at finalize time
    // uses appendFileSync directly, independent of this stream.
    meta._jsonlError = err && err.message ? err.message : String(err);
  }

  // Step 8 (deferred): spawn the adapter.
  // Read-only fallback (issue #67/#68/#69): mirror runOnce by prepending the
  // guard header to the prompt before spawn. We don't run the post-collect
  // git diff check in the runner because (a) the runner is detached and
  // we can't surface a warning to the user mid-stream, and (b) the runner's
  // 24h collect window makes git state at finalize time meaningless. The
  // sandbox itself is the primary defense — the prompt header is belt-and-
  // suspenders.
  const spawnPrompt = opts._readonlyFallback ? `${READONLY_GUARD_HEADER}${prompt}` : prompt;
  let handle;
  try {
    handle = adapter.spawn(spawnPrompt, opts);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    askJobs.writeRunnerSentinel(meta.artifactJsonlPath, {
      reason: 'failed',
      category: 'spawn_error',
      message: msg,
      text: '',
    });
    askJobs.writeMetadata(jobId, {
      ...meta,
      status: 'failed',
      errorCategory: 'spawn_error',
      errorMessage: msg,
      endedAt: _clock().toISOString(),
    });
    if (jsonlStream) try { jsonlStream.end(); } catch {}
    return _exit(0);
  }

  // Step 8 cont'd: persist adapterPid (single-writer, first mutation after launch).
  meta.adapterPid = handle.pid || null;
  // Initialize flush bookkeeping so maybeFlushMetadata treats the next
  // chunk as "fresh" without tripping the adapterPid-first-set branch twice.
  meta._lastFlushAt = _clock().getTime();
  meta._prevFlushedStatus = meta.status;
  meta._prevFlushedAdapterPid = meta.adapterPid;
  askJobs.writeMetadata(jobId, meta);

  // Step 9: attach JSONL tee listener + debounced metadata flush (§4.3.1).
  if (jsonlStream && handle.stdout && typeof handle.stdout.on === 'function') {
    handle.stdout.on('data', (chunk) => {
      try { jsonlStream.write(chunk); } catch {}
      meta.lastActivityAt = _clock().toISOString();
      askJobs.maybeFlushMetadata(meta, {
        flushImpl: (m) => {
          // Persist everything except the in-memory bookkeeping fields.
          // writeMetadata() is atomic (tmp+rename) so partial writes can't
          // be observed.
          askJobs.writeMetadata(jobId, m);
        },
      });
    });
  }

  // Step 10: once-only finalize gated by shared flag.
  let finalizing = false;
  const finalize = async (reason, category, message) => {
    if (finalizing) return;
    finalizing = true;

    const terminalMessage = category === 'mcp_auth'
      ? `${MCP_AUTH_HINT}\n${message || 'adapter error'}`
      : message;

    try { await adapter.shutdown(handle); } catch { /* best-effort */ }

    // Drain the tee stream BEFORE writing the sentinel. process.exit does
    // not flush buffered WriteStreams.
    if (jsonlStream) {
      try {
        await new Promise((resolve) => {
          let resolved = false;
          const done = () => { if (!resolved) { resolved = true; resolve(); } };
          jsonlStream.end(done);
          jsonlStream.once('error', done);
          // Safety timeout — don't hang the runner on a stuck stream.
          setTimeout(done, 2000).unref?.();
        });
      } catch { /* ignored */ }
    }

    // Synchronous sentinel write — bypasses any buffer.
    askJobs.writeRunnerSentinel(meta.artifactJsonlPath, {
      reason,
      category,
      message: terminalMessage,
      text: handle._output || '',
    });

    // Flip metadata.
    const terminalMeta = {
      ...meta,
      status: reason,
      endedAt: _clock().toISOString(),
    };
    if (category) terminalMeta.errorCategory = category;
    if (terminalMessage) terminalMeta.errorMessage = terminalMessage;
    if (reason === 'completed') terminalMeta.exitCode = 0;
    else if (reason === 'failed') terminalMeta.exitCode = 1;
    else if (reason === 'cancelled') terminalMeta.exitCode = 1;
    askJobs.writeMetadata(jobId, terminalMeta);

    // Synthesize .md on completed path.
    if (reason === 'completed') {
      const output = (handle._output || '').trim();
      const body = output + (output.endsWith('\n') ? '' : '\n');
      try {
        writeFileSync(terminalMeta.artifactMdPath, body, { mode: 0o600 });
      } catch { /* swallow — sentinel already has the text */ }
    }

    return _exit(0);
  };

  // SIGTERM handler: reason='cancelled'. Once-only via finalizing flag.
  const sigtermHandler = () => {
    // finalize is async; we fire-and-forget here — the process event loop
    // stays alive because finalize does async I/O then exits.
    finalize('cancelled').catch(() => _exit(1));
  };
  process.on('SIGTERM', sigtermHandler);

  // Step 11: collect with explicit 24h timeout (spec rev 4).
  let result;
  try {
    result = await adapter.collect(handle, RUNNER_COLLECT_TIMEOUT_MS);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    await finalize('failed', 'unexpected', msg);
    return;
  }

  // Step 12: dispatch based on collect result.
  if (result && result.error) {
    await finalize('failed', result.error.category || 'unknown', result.error.message || 'adapter error');
  } else {
    await finalize('completed');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STATUS (spec §4.4)
// ═══════════════════════════════════════════════════════════════════════════

function runStatus(jobId) {
  const meta = askJobs.readMetadata(jobId);
  if (!meta) {
    _writeStderr(`[ask] unknown jobId: ${jobId}\n`);
    return _exit(3);
  }

  const reconcile = askJobs.reconcileStatus(meta);

  const startedMs = Date.parse(meta.startedAt || '');
  const nowMs = _clock().getTime();
  const elapsedSec = Number.isFinite(startedMs) ? (nowMs - startedMs) / 1000 : 0;

  let bytesOut = 0;
  try { bytesOut = statSync(meta.artifactJsonlPath).size; } catch {}

  const out = {
    jobId,
    status: reconcile.status,
    startedAt: meta.startedAt,
    elapsedSec,
    bytesOut,
    lastActivityAt: meta.lastActivityAt,
    runnerAlive: reconcile.runnerAlive,
    adapterAlive: reconcile.adapterAlive,
  };
  if (reconcile.error) {
    out.errorCategory = reconcile.error.category;
    out.errorMessage = reconcile.error.message;
  }

  _writeStdout(JSON.stringify(out) + '\n');
  return _exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// COLLECT (spec §4.5)
// ═══════════════════════════════════════════════════════════════════════════

async function runCollect(jobId, wait, timeoutSec) {
  const startMs = _clock().getTime();
  const timeoutMs = timeoutSec * 1000;
  const pollMs = _injected.pollInterval || 500;

  while (true) {
    const meta = askJobs.readMetadata(jobId);
    if (!meta) {
      _writeStderr(`[ask] unknown jobId: ${jobId}\n`);
      return _exit(3);
    }
    const reconcile = askJobs.reconcileStatus(meta, {
      livenessImpl: _injected.liveness,
    });

    if (reconcile.status === 'completed') {
      // Try the .md artifact; fall back to sentinel text if missing.
      if (existsSync(meta.artifactMdPath)) {
        _writeStdout(readFileSync(meta.artifactMdPath, 'utf-8'));
        return _exit(0);
      }
      const body = askJobs.synthesizeMdFromSentinel(meta.artifactJsonlPath);
      if (body) {
        try { writeFileSync(meta.artifactMdPath, body, { mode: 0o600 }); } catch {}
        _writeStdout(body);
        return _exit(0);
      }
      _writeStderr(`[ask] completed but .md missing and sentinel has no text\n`);
      return _exit(1);
    }

    if (reconcile.status === 'failed') {
      const err = reconcile.error || { category: 'unknown', message: 'unknown failure' };
      _writeStderr(`[ask] ${err.category}: ${err.message}\n`);
      return _exit(1);
    }

    if (reconcile.status === 'cancelled') {
      _writeStderr(`[ask] cancelled\n`);
      return _exit(1);
    }

    // Still running.
    if (!wait) {
      _writeStderr(`[ask] job ${jobId} still running (run with --wait to block)\n`);
      return _exit(75);
    }

    const elapsed = _clock().getTime() - startMs;
    if (elapsed >= timeoutMs) {
      _writeStderr(`[ask] timeout waiting for job ${jobId}\n`);
      return _exit(75);
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CANCEL (spec §4.6)
// ═══════════════════════════════════════════════════════════════════════════

async function runCancel(jobId) {
  const meta = askJobs.readMetadata(jobId);
  if (!meta) {
    _writeStderr(`[ask] unknown jobId: ${jobId}\n`);
    return _exit(3);
  }

  // Reconcile status BEFORE liveness check (spec rev 4 §4.6 fix).
  const reconcile = askJobs.reconcileStatus(meta);
  if (reconcile.status !== 'running') {
    return _exit(0); // Already terminal; idempotent.
  }

  // Metadata + reconcile both say running. Pick the victim: prefer runner
  // (normal path), fall back to adapter (runner crashed but left adapter
  // detached). reconcile said running, so at least one must be alive.
  const runnerAlive = askJobs.isProcessAlive(meta.runnerPid);
  const adapterAlive = meta.adapterPid
    ? askJobs.isProcessAlive(meta.adapterPid)
    : false;

  const victimPid = runnerAlive ? meta.runnerPid : (adapterAlive ? meta.adapterPid : null);
  if (!victimPid) {
    // Neither alive — this shouldn't happen because reconcile just said
    // running, but race windows exist. Report and bail.
    _writeStderr(`[ask] runner and adapter both dead; run 'status' to reconcile\n`);
    return _exit(1);
  }

  const killFn = _injected.killFn || ((pid, sig) => process.kill(pid, sig));
  try { killFn(victimPid, 'SIGTERM'); }
  catch (err) {
    _writeStderr(`[ask] failed to signal ${runnerAlive ? 'runner' : 'adapter'}: ${err && err.message ? err.message : err}\n`);
    return _exit(1);
  }

  // Poll for up to 5s; escalate to SIGKILL if still alive.
  const deadline = _clock().getTime() + 5000;
  while (_clock().getTime() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (!askJobs.isProcessAlive(victimPid)) {
      return _exit(0);
    }
  }
  try { killFn(victimPid, 'SIGKILL'); } catch {}
  return _exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST (spec §4.8)
// ═══════════════════════════════════════════════════════════════════════════

function runList(statusFilter, olderThanSec) {
  const jobs = askJobs.listJobs({ statusFilter, olderThanSec });
  _writeStdout(JSON.stringify(jobs, null, 2) + '\n');
  return _exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════

export async function main(argv = process.argv) {
  const desc = askJobs.parseAskArgs(argv);

  switch (desc.command) {
    case 'sync':
      return runSyncPath(desc.model, desc.noMcp);
    case 'async':
      return runAsyncLaunch(desc.model, desc.noMcp);
    case 'status':
      return runStatus(desc.jobId);
    case 'collect':
      return runCollect(desc.jobId, desc.wait, desc.timeoutSec);
    case 'cancel':
      return runCancel(desc.jobId);
    case 'list':
      return runList(desc.statusFilter, desc.olderThanSec);
    case 'run-job':
      return runJob(desc.jobId);
    case 'error':
    default:
      printUsage(desc.reason || 'invalid arguments');
      return _exit(3);
  }
}

// Only run main when invoked directly (not when imported by tests).
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    _writeStderr(`[ask] fatal: ${err && err.message ? err.message : err}\n`);
    _exit(1);
  });
}

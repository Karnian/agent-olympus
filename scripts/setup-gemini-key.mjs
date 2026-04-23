#!/usr/bin/env node
/**
 * Agent Olympus — Gemini API Key setup wizard.
 *
 * Creates an AO-owned macOS keychain item (`agent-olympus.gemini-api-key`)
 * with `/usr/bin/security` pre-listed as trusted, so gemini worker spawns
 * never trigger the macOS keychain password prompt.
 *
 * Usage:
 *   node scripts/setup-gemini-key.mjs          # interactive prompt
 *   node scripts/setup-gemini-key.mjs --help
 *
 * The API key is read from stdin with echo disabled. It is never placed on
 * argv (see scripts/lib/ao-keychain-write.mjs for why). The wizard also
 * verifies the write by re-reading the item via the normal resolver path
 * and offers to flip `.ao/autonomy.json` to `credentialSource: "ao-keychain"`
 * so subsequent AO runs use the new item.
 *
 * macOS-only. On Linux, tell the user to set GEMINI_API_KEY instead
 * (libsecret doesn't have the same ACL problem).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAoKeychainItem } from './lib/ao-keychain-write.mjs';
import { resolveGeminiApiKey } from './lib/gemini-credential.mjs';

const HELP = `
Agent Olympus — Gemini Keychain Setup Wizard

Creates an AO-owned keychain item so /usr/bin/security can read your Gemini
API key without macOS prompting for your login password every time.

Usage:
  node scripts/setup-gemini-key.mjs [--account <name>] [--service <name>]
                                    [--update-autonomy|--no-update-autonomy]

Options:
  --account <name>            Keychain account name (default: default-api-key)
  --service <name>            Keychain service name (default: agent-olympus.gemini-api-key)
  --update-autonomy           After success, write credentialSource: ao-keychain
                              into .ao/autonomy.json without asking
  --no-update-autonomy        Skip the autonomy.json prompt/update entirely
  -h, --help                  Show this help and exit

The API key is read from stdin with echo disabled. You can also pipe it in:

  echo "AIza..." | node scripts/setup-gemini-key.mjs --update-autonomy
`.trim();

// ─── tiny argv parser ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ParseArgsResult
 * @property {boolean} help
 * @property {string|null} account
 * @property {string|null} service
 * @property {boolean|null} updateAutonomy - null=ask, true=auto-yes, false=skip
 * @property {string|null} error - non-null when argv is malformed; caller exits with code 2
 */

/**
 * Parse the wizard CLI. Returns an error field (non-null) on malformed input
 * rather than calling process.exit — makes the parser unit-testable and keeps
 * the caller in control of exit behavior.
 *
 * @param {string[]} argv
 * @returns {ParseArgsResult}
 */
export function parseArgs(argv) {
  const out = {
    help: false,
    account: null,
    service: null,
    updateAutonomy: null,
    error: null,
  };
  const requiresValue = (flag) =>
    `setup-gemini-key: ${flag} requires a value (got none)`;
  const looksLikeFlag = (v) => typeof v === 'string' && v.startsWith('-');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--account') {
      const next = argv[i + 1];
      if (next === undefined || looksLikeFlag(next)) {
        out.error = requiresValue('--account');
        return out;
      }
      out.account = next;
      i++;
    }
    else if (a === '--service') {
      const next = argv[i + 1];
      if (next === undefined || looksLikeFlag(next)) {
        out.error = requiresValue('--service');
        return out;
      }
      out.service = next;
      i++;
    }
    else if (a === '--update-autonomy') out.updateAutonomy = true;
    else if (a === '--no-update-autonomy') out.updateAutonomy = false;
    else {
      out.error = `setup-gemini-key: unknown argument: ${a}`;
      return out;
    }
  }
  return out;
}

// ─── hidden stdin input ───────────────────────────────────────────────────────

/**
 * Read a single line from stdin without echoing characters. Backspace supported.
 * Returns the input without the trailing newline.
 *
 * If stdin is NOT a TTY (e.g. piped input from another command), reads until
 * EOF and returns the trimmed line — caller is responsible for keeping the
 * input off ps/scrollback in that case.
 *
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Non-interactive: just slurp stdin
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { buf += chunk; });
      process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
      process.stdin.on('error', reject);
      process.stdin.resume();
      return;
    }

    // Interactive path. Keep all cleanup in ONE place (`teardown`) so that
    // any exit — normal Enter, Ctrl-C, stream error, or unexpected exception
    // from listener code — restores terminal state. Without this, a stray
    // throw would leave the user's shell stuck in raw mode (unresponsive
    // keyboard) until the terminal is force-killed.
    process.stdout.write(prompt);
    let rawModeSet = false;
    let onData = null;
    let onError = null;
    let settled = false;
    const teardown = () => {
      if (onData) try { process.stdin.removeListener('data', onData); } catch {}
      if (onError) try { process.stdin.removeListener('error', onError); } catch {}
      if (rawModeSet) {
        try { process.stdin.setRawMode(false); } catch {}
        rawModeSet = false;
      }
      try { process.stdin.pause(); } catch {}
    };
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      teardown();
      fn(arg);
    };

    try { process.stdin.setRawMode(true); rawModeSet = true; }
    catch (e) { return done(reject, e); }
    try { process.stdin.resume(); process.stdin.setEncoding('utf8'); }
    catch (e) { return done(reject, e); }

    let input = '';
    onData = (chunk) => {
      try {
        for (const char of chunk) {
          if (char === '\r' || char === '\n' || char === '\u0004') {
            process.stdout.write('\n');
            return done(resolve, input);
          }
          if (char === '\u0003') { // Ctrl-C
            teardown();
            process.stdout.write('\n^C\n');
            process.exit(130);
          }
          if (char === '\b' || char === '\x7f') { // Backspace / Delete
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.write('\b \b');
            }
            continue;
          }
          input += char;
          process.stdout.write('*');
        }
      } catch (err) {
        done(reject, err);
      }
    };
    onError = (err) => done(reject, err);
    process.stdin.on('data', onData);
    process.stdin.on('error', onError);
  });
}

function readLineEcho(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve('');
    process.stdout.write(prompt);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        resolve(buf.slice(0, nl).trim());
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// ─── autonomy.json update ─────────────────────────────────────────────────────

function readAutonomy(cwd) {
  const path = join(cwd, '.ao', 'autonomy.json');
  if (!existsSync(path)) return { path, existed: false, data: {} };
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { path, existed: true, data: {} };
    }
    return { path, existed: true, data };
  } catch {
    return { path, existed: true, data: {} };
  }
}

function writeAutonomy(cwd, data) {
  const path = join(cwd, '.ao', 'autonomy.json');
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch {}
  const body = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

/**
 * Idempotently patch .ao/autonomy.json to point at ao-keychain.
 *
 * Critical: if the caller uses the default AO service, explicitly REMOVE any
 * existing `keychainService` override. Without this the wizard would write to
 * `agent-olympus.gemini-api-key` but leave a stale `keychainService: "my.old.service"`
 * in the config, so resolver reads would still target the old service and
 * silently fail — the exact class of drift bug codex flagged in PR 3 review.
 */
export function patchCredentialSource(data, service) {
  const patched = { ...(data && typeof data === 'object' ? data : {}) };
  patched.gemini = { ...(patched.gemini || {}) };
  patched.gemini.credentialSource = 'ao-keychain';
  if (service && service !== 'agent-olympus.gemini-api-key') {
    patched.gemini.keychainService = service;
  } else {
    // Reverting to default service: drop any stale override.
    delete patched.gemini.keychainService;
  }
  return patched;
}

// ─── main flow ────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stderr.write(opts.error + '\n');
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }

  if (process.platform !== 'darwin') {
    process.stderr.write(
      `setup-gemini-key: this wizard is macOS-only.\n` +
      `On Linux/Windows, set GEMINI_API_KEY in your shell instead — the ` +
      `keychain ACL problem this wizard solves doesn't exist on those platforms.\n`
    );
    process.exit(1);
  }

  const account = opts.account || 'default-api-key';
  const service = opts.service || 'agent-olympus.gemini-api-key';

  process.stdout.write(
    `Agent Olympus — Gemini Keychain Setup\n` +
    `======================================\n` +
    `Target:  ${service} / ${account}\n` +
    `Trusted: /usr/bin/security, /usr/bin/env, ${process.execPath}\n\n` +
    `Paste your Gemini API key (input will be hidden).\n` +
    `Get one at https://aistudio.google.com/apikey if you don't have it yet.\n\n`
  );

  let apiKey;
  try {
    apiKey = await readSecret('API key: ');
  } catch (err) {
    process.stderr.write(`\nFailed to read input: ${err.message}\n`);
    process.exit(1);
  }
  apiKey = (apiKey || '').trim();
  if (!apiKey) {
    process.stderr.write('No key entered. Aborting.\n');
    process.exit(1);
  }
  if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(apiKey)) {
    process.stderr.write(
      `Warning: key does not match the expected "AIza..." pattern. ` +
      `Proceeding anyway (sometimes Google rotates formats), but double-check ` +
      `it against https://aistudio.google.com/apikey if auth fails later.\n`
    );
  }

  process.stdout.write(
    `\n[1/3] Writing keychain item via /usr/bin/security (stdin mode, no argv exposure)...\n`
  );
  process.stdout.write(
    `      macOS may ask for your login password ONCE for the ACL change.\n`
  );

  const writeResult = writeAoKeychainItem({ apiKey, account, service });
  if (!writeResult.ok) {
    process.stderr.write(
      `\n[FAIL] Could not write keychain item.\n` +
      `       ${writeResult.error}\n` +
      (writeResult.stderr ? `       security stderr: ${writeResult.stderr}\n` : '') +
      `\nIf the error mentions "SecKeychainSearchCreate" or similar, your login ` +
      `keychain may be locked. Open Keychain Access.app, unlock "login", and retry.\n`
    );
    process.exit(1);
  }
  // Clear the key from memory as soon as possible. Not perfect (JS GC timing
  // isn't deterministic), but removes the obvious strong reference.
  apiKey = '';

  process.stdout.write(`      ✓ keychain item written\n`);

  // Surface partition-list status — users who miss this see passwords prompts
  // on every subsequent gemini spawn (the whole reason the wizard exists).
  if (writeResult.partitionListSet) {
    process.stdout.write(
      `      ✓ partition list granted to /usr/bin/security (zero-prompt reads enabled)\n`
    );
  } else if (writeResult.partitionWarning) {
    process.stderr.write(`      ⚠ ${writeResult.partitionWarning}\n`);
  }

  // [2/3] Verify via the resolver — we want to confirm /usr/bin/security can
  // read WITHOUT a password prompt. The wizard grants /usr/bin/security
  // trusted access, so the resolver should hit without delay.
  process.stdout.write(`\n[2/3] Verifying read-back via /usr/bin/security...\n`);
  const readStart = Date.now();
  const readKey = resolveGeminiApiKey({
    credentialSource: 'ao-keychain',
    service,
    account,
    forceRefresh: true,
  });
  const readMs = Date.now() - readStart;
  if (!readKey) {
    process.stderr.write(
      `      ✗ read-back failed. Check Console.app (search "securityd") for ` +
      `authorization errors; the wizard may not have ACL-granted correctly.\n`
    );
    process.exit(1);
  }
  if (readMs > 3000) {
    process.stderr.write(
      `      ⚠ read-back took ${readMs}ms — this suggests macOS prompted you ` +
      `after all. The ACL may not include /usr/bin/security. See ` +
      `docs/gemini-keychain-setup.md Option 2 for manual fix.\n`
    );
  } else {
    process.stdout.write(`      ✓ read-back succeeded in ${readMs}ms (no prompt)\n`);
  }

  // [3/3] Optionally patch autonomy.json
  process.stdout.write(`\n[3/3] Update .ao/autonomy.json?\n`);
  const cwd = process.cwd();
  const { path: autonomyPath, existed, data } = readAutonomy(cwd);
  const current = data?.gemini?.credentialSource;
  if (current === 'ao-keychain' && data?.gemini?.keychainService === (service === 'agent-olympus.gemini-api-key' ? undefined : service)) {
    process.stdout.write(`      ${autonomyPath} already uses ao-keychain. No change needed.\n`);
  } else {
    let doUpdate = opts.updateAutonomy;
    if (doUpdate === null) {
      const ans = await readLineEcho(
        `      Set "gemini.credentialSource": "ao-keychain" in ${autonomyPath}? [Y/n] `
      );
      doUpdate = ans === '' || /^y(es)?$/i.test(ans);
    }
    if (doUpdate) {
      const patched = patchCredentialSource(data, service);
      const finalPath = writeAutonomy(cwd, patched);
      process.stdout.write(
        `      ✓ ${existed ? 'updated' : 'created'} ${finalPath}\n`
      );
    } else {
      process.stdout.write(
        `      Skipped autonomy.json update. To switch later, add this to ` +
        `.ao/autonomy.json:\n` +
        `        { "gemini": { "credentialSource": "ao-keychain" } }\n`
      );
    }
  }

  process.stdout.write(
    `\nDone. Next Gemini worker spawn will read the AO-owned keychain item ` +
    `with no password prompt.\n`
  );
  process.exit(0);
}

// Only execute main() when invoked as a script, not when this module is
// imported for unit testing its exported helpers.
const isEntrypoint = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('setup-gemini-key.mjs');
if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`\nsetup-gemini-key: ${err?.message || err}\n`);
    process.exit(1);
  });
}

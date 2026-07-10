# Credentials
> Moved verbatim from CLAUDE.md (Codex Interop v1, Ship order 1).

### Credential Resolution (Gemini)

Gemini workers resolve `GEMINI_API_KEY` at spawn time via
`scripts/lib/gemini-credential.mjs`. Users who already ran `gemini /auth`
(which stores the key in the OS secret store) do **not** need to also
export the key into their shell — Agent Olympus fetches it per-spawn and
injects into the child process env. The parent `process.env` is never
mutated.

**Resolution priority** (first hit wins):

1. `process.env.GEMINI_API_KEY` — if set (non-empty), used verbatim. An
   explicitly empty value (`GEMINI_API_KEY=""`) is treated as "disable"
   and **skips** the keychain fallback, respecting user intent.
2. **macOS Keychain** — `security find-generic-password -s gemini-cli-api-key -a <account> -w`
3. **Linux libsecret** — `secret-tool lookup service gemini-cli-api-key account <account>`
   (tries `/usr/bin`, `/usr/local/bin`, NixOS paths, then `PATH`)
4. `null` — spawn proceeds without the env var, letting the gemini CLI
   produce its own auth error if the user has no other credential source

**Caching**: Per-(platform, service, account) `Map` with split TTL —
24 hours on hit, 60 seconds on error (timeout / ACL-denied / binary-missing),
30 seconds on empty miss. Null results are cached too so the keychain isn't
re-hammered on every spawn when no key is stored. See the dedicated "Cache
TTL" block below for rationale. On `auth_failed` category from the exec/acp
error classifiers, all cache entries for that account (across all services)
are invalidated so the next spawn re-reads the secret store — supports
`/auth` recovery within a single session.

**Spawn paths covered**:
- `scripts/lib/gemini-exec.mjs` — single-turn `gemini --output-format json -p`
- `scripts/lib/gemini-acp.mjs` — multi-turn ACP JSON-RPC via `gemini --acp`
  (invalidates cache on 401/403 from every early-return path:
  initializeServer / createSession / loadSession / sendPrompt)
- `scripts/ask.mjs` — `/ask gemini` quick-query
- `scripts/lib/worker-spawn.mjs` — Atlas/Athena team workers
- `scripts/lib/tmux-session.mjs` — tmux fallback (via `new-session -e KEY=VAL`
  so the key never enters `send-keys` input or `capture-pane` output)

**Config** (`.ao/autonomy.json`):
```json
{
  "gemini": {
    "credentialSource": "auto",
    "keychainAccount": "default-api-key",
    "keychainService": null,
    "useKeychain": true
  }
}
```

`credentialSource` values (all four resolve through the same backend; they
differ in WHICH service name is read and whether env is considered first):

- `"auto"` (default) — env → `gemini-cli-api-key` (shared) → miss. Matches
  pre-PR-3 behavior for users who already authenticated with `gemini /auth`.
- `"env"` — env only; keychain is never consulted. Use when you set
  `GEMINI_API_KEY` explicitly and don't want the wizard path.
- `"shared-keychain"` — skip env, read gemini CLI's own `gemini-cli-api-key`
  item. Explicit opt-in to the shared store (useful when env is set to
  something stale and you want to force a keychain read).
- `"ao-keychain"` — skip env, read the AO-owned
  `agent-olympus.gemini-api-key` item created by `node scripts/setup-gemini-key.mjs`.
  The wizard pre-lists `/usr/bin/security` as trusted, so AO reads never
  trigger a macOS password prompt. See [docs/gemini-keychain-setup.md](docs/gemini-keychain-setup.md)
  for the tradeoffs (drift risk vs. no prompts).

`keychainService` (default `null`) overrides the service name for whichever
source was selected. Most users leave it null. `keychainAccount` accepts any
non-empty string — `execFile` argv prevents shell injection.

`useKeychain` is a deprecated legacy toggle; `useKeychain: false` normalizes
internally to `credentialSource: "env"` at resolve time, so old configs keep
working without migration. New configs should use `credentialSource` directly.

**Cache TTL** (per-(platform, service, account) in-process cache):
- Successful resolution: **24 hours** — orchestrators stay warm across many
  worker spawns without re-hammering the keychain.
- Empty miss: **30 seconds** — brief enough to pick up the user's fix (wizard
  re-run, env var export, manual ACL edit) without making them restart Claude
  Code, long enough to absorb a worker spawn batch.
- Error (timeout / acl_denied / binary_not_found): **60 seconds** — slightly
  longer than miss because these indicate a structural problem that needs
  user action, not a transient empty slot.
- `resolveGeminiApiKey({ forceRefresh: true })` bypasses all buckets.
- `invalidateCache(account)` is called from adapter 401/403 classifiers so a
  rotated key is picked up on the next spawn regardless of TTL.

**macOS Keychain prompt (root cause & fix)**: The resolver shells out to `/usr/bin/security find-generic-password`. macOS checks the keychain item's ACL against `/usr/bin/security` — NOT against Node. gemini CLI saves its API key via `keytar`, which writes a default ACL trusting only the creating executable (typically the Node binary that ran gemini CLI at save time), so `/usr/bin/security` is untrusted and each read shows a password prompt. Clicking **Always Allow** authorizes the `security` tool for future access on that item — subsequent reads complete in <100ms.

**If you keep seeing the prompt**: you likely clicked "Allow Once" (not "Always Allow"), the item was recreated, or a newer gemini CLI wrote a stricter ACL. Two options available today:

1. **Manual ACL fix** — see [docs/gemini-keychain-setup.md](docs/gemini-keychain-setup.md) for a Keychain Access.app walkthrough; one-time, persists across restarts.
2. **Export the key explicitly** — set `GEMINI_API_KEY` in your shell; the resolver skips the keychain entirely when env is set. Downside: the key becomes visible in `env` output of your shell and every child process.

**Wizard** (`/setup-gemini-auth` or `node $CLAUDE_PLUGIN_ROOT/scripts/setup-gemini-key.mjs`): one-time setup that creates an AO-owned keychain item with `/usr/bin/security` pre-listed as trusted, eliminating prompts entirely. Scoped to the "Gemini API key stored in keychain" scenario — OAuth/Vertex/ADC/env-var users don't need it. On `auth_failed` with `credentialSource === "ao-keychain"`, adapters emit `{"event":"gemini_cred_stale_ao_keychain","account":"...","message":"..."}` on stderr to tell the user exactly what to do (re-run the wizard).

If the prompt is dismissed, `execFileSync` hits `EXEC_TIMEOUT_MS` (10s) and returns `null` — gemini CLI then surfaces its own auth error.

### Gemini CLI tier split (2026-06-18)

As of 2026-06-18, Google no longer serves Gemini CLI free, Pro, or Ultra tiers through the `gemini` CLI path. Those users are directed to the Antigravity `agy` CLI, which Agent Olympus treats as a drop-in Gemini-compatible binary fallback inside the existing Gemini adapters.

API-key and enterprise users are still served by the `gemini` CLI. The `/setup-gemini-auth` flow is unchanged because it only manages the API-key Keychain path used to populate `GEMINI_API_KEY` before spawning the worker.

Binary resolution order is `AO_GEMINI_BINARY` override, then `gemini`, then `agy`. Set `AO_GEMINI_BINARY` to an explicit compatible binary path when neither default name matches the local install.

**Logging & security**:
- Raw keys are never logged. Diagnostic events emit as single-line JSON on
  stderr with masked keys (`AIza****xx` format).
- `AO_DEBUG_GEMINI=1` is the umbrella debug flag. It enables:
  - `gemini-exec/acp: GEMINI_API_KEY=AIza****xx` line per spawn (mask only)
  - `gemini_cred_resolve` event stream from the resolver (start/fetch_end/end stages)
- `AO_DEBUG_CREDENTIAL=1` enables ONLY the `gemini_cred_resolve` stream (use this
  when you want resolver tracing without the per-spawn spawn-side masked-key line).
  Both flags accept the exact string `'1'` for resolver tracing (no truthy coercion)
  so `AO_DEBUG_CREDENTIAL=true` or `=0` will NOT enable it.
- `gemini_cred_resolve` event shape (JSONL on stderr):
  `{"event":"gemini_cred_resolve","stage":"end","source":"macos_security|linux_secret_tool|env|cache|disabled|windows_unsupported","result":"hit|miss|error","account":"...","elapsedMs":N,"keyMask":"AIza****xx"|null,"stderrClass":"not_found|acl_denied|timeout|binary_not_found|unknown|windows_unsupported","exitCode":N|null,"errnoCode":"ETIMEDOUT|ENOENT|null"}`.
  Backend error classification from `fetch_end` is also carried up to `end`, so
  `jq 'select(.stage=="end") | {source,result,stderrClass,elapsedMs}'` alone is
  enough to distinguish miss-due-to-no-item from miss-due-to-ACL-prompt-timeout.
- tmux error messages are redacted via regex — any `*_KEY`, `*_TOKEN`,
  `*_SECRET`, `*_PASSWORD` values in argv echoes are replaced with
  `<redacted>` before reaching state files.

### Gemini Team Communication
Unlike Codex app-server (which supports `steerTurn()` for mid-turn injection), Gemini ACP only accepts new prompts between turns. Team communication uses a message queue pattern:
- `enqueueMessage(handle, message, { from, priority })` — queues messages during active turns
- Messages auto-drain as sequential turns when current turn completes
- Failed messages retry once, then move to dead letters (`handle._deadLetters`)
- Queue capped at `MAX_QUEUE_DEPTH=200` to prevent memory leaks

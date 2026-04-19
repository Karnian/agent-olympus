# Gemini API Key — macOS Keychain Setup

This guide explains why Agent Olympus may repeatedly prompt for your macOS login password when spawning a Gemini worker, and how to stop it.

## Do you need this guide? (auth method matrix)

AO's credential resolver only intervenes when a **Gemini API key needs to land in `process.env.GEMINI_API_KEY`** at child-spawn time. Everything else, gemini CLI handles itself. Check your auth method below before reading further:

| Auth method | AO behavior | Do you need this guide? |
|---|---|---|
| `export GEMINI_API_KEY=AIza...` in shell | Reads env directly, keychain untouched | **No** — set `credentialSource: "env"` for clarity |
| `gemini /auth` → "Login with Google" (OAuth) | Tokens at `~/.gemini/oauth_creds.json`, AO resolver returns null, gemini CLI handles auth | **No** |
| `gemini /auth` → "Use API key" (stored in keychain) | AO reads keychain via `/usr/bin/security` → ACL prompt | **Yes — this is the scenario this guide solves** |
| Vertex AI (`GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` or `GOOGLE_API_KEY`) | AO resolver returns null; gemini CLI uses the Vertex path **if you've already configured it** (env vars + ADC or service account) | **No** |
| GCP Cloud Shell / `GEMINI_CLI_USE_COMPUTE_ADC=true` | AO resolver returns null; gemini CLI uses Application Default Credentials (requires ADC setup) | **No** |
| Linux or Windows, any method | Different trust model (no per-app ACL prompts) | **No** |

If you're in a "No" row, set `credentialSource: "env"` in `.ao/autonomy.json` to make the intent explicit, and close this guide — the rest is for the one "Yes" scenario.

```jsonc
// .ao/autonomy.json — explicit "no keychain needed"
{ "gemini": { "credentialSource": "env" } }
```

## Why the prompt appears

When you authenticate the gemini CLI with an API key (`gemini /auth` → API key), the CLI uses `keytar` to write the key to your default keychain (usually the `login` keychain) under the service name `gemini-cli-api-key`. By default, macOS attaches an ACL to that keychain item trusting only the **creating executable** — typically the Node binary that ran gemini CLI at save time.

Agent Olympus reads the same item by shelling out to `/usr/bin/security find-generic-password`. Since `/usr/bin/security` is NOT on the item's ACL, macOS treats every read as an untrusted access attempt and shows the password prompt.

Clicking **Always Allow** on that dialog authorizes the `security` tool for future access on that item — subsequent reads complete in under 100ms without prompting.

## Option 1 — Click "Always Allow" on the next prompt

The simplest fix. The next time you see the dialog:

> `"security" wants to use your confidential information stored in "gemini-cli-api-key" in your keychain.`

1. Enter your login password.
2. Click **Always Allow** (NOT "Allow Once").

That's it. The `security` tool is now trusted for this item until the item is recreated or a macOS update resets ACL trust.

## Option 2 — Manual ACL edit in Keychain Access.app

Use this if you accidentally clicked "Allow Once" before, or if you want to verify the ACL state without triggering another prompt.

1. Open **Keychain Access.app** (Spotlight → "Keychain Access").
2. In the sidebar pick your default keychain (usually **login**) and the **Passwords** category.
3. In the search box type `gemini-cli-api-key`.
4. Double-click the matching item to open its detail window.
5. Switch to the **Access Control** tab.
6. Choose one of:
   - **"Allow all applications to access this item"** — most convenient, least granular. Any process owned by your user can read the key via the Security framework. Reasonable for developer workstations, not for shared/managed Macs.
   - **"Confirm before allowing access"** — keep this and add the `security` tool to the list. Click **+** ("Add"), then select the `security` binary. If Keychain Access.app prevents you from navigating into `/usr/bin`, try Option 3 (explicit env var) instead.
7. Click **Save Changes** at the bottom. macOS will ask for your login password one final time.

After this, Agent Olympus Gemini workers will read the key without prompts.

## Option 3 — Set `GEMINI_API_KEY` in your shell

If you prefer not to rely on the keychain at all:

```bash
# ~/.zshrc or ~/.bashrc
export GEMINI_API_KEY="AIza..."
```

The resolver checks `process.env.GEMINI_API_KEY` before touching the keychain, so this short-circuits the whole path.

Tradeoffs:
- The key ends up in your shell history if you type `export GEMINI_API_KEY=...` interactively. Prefer editing the rc file directly, or use a secret-loader tool.
- Every child process inherits the env var by default, so anything you spawn from this shell can read the key via `process.env`.
- In shared terminal sessions (tmux attached by multiple users, screen, shared servers) the env var is visible to the other attached users.

## Verifying the fix

After applying Option 1 or 2, confirm the ACL is correct **without** printing the secret. Run:

```bash
/usr/bin/security find-generic-password -s gemini-cli-api-key -a default-api-key >/dev/null 2>&1 && echo "OK: no prompt, ACL ok"
```

If the command prints `OK: no prompt, ACL ok` immediately (no password dialog, no delay), the ACL is correctly configured and Agent Olympus will no longer stall on Gemini spawns. Do NOT pass `-w` — that flag prints the raw key into your terminal scrollback.

## Caveats

- **Recreating the item resets the ACL.** If you ever run `gemini /auth` again with a new key, you'll need to redo Option 1 or 2 once.
- **macOS security updates** occasionally reset ACL trust for system binaries. If the prompt returns after a macOS upgrade, repeat the fix.
- **Non-macOS platforms** don't have this problem — Linux libsecret (`secret-tool`) uses D-Bus authorization with different semantics.

## Diagnosing which branch is failing

`AO_DEBUG_CREDENTIAL=1` emits one JSON line per resolver call on stderr. `AO_DEBUG_GEMINI=1` does the same plus per-spawn masked-key logging. Example:

```bash
AO_DEBUG_CREDENTIAL=1 <your AO command> 2> >(grep gemini_cred_resolve)
```

Typical patterns you'll see at `stage: "end"`:

- `{"result":"hit","source":"macos_security","elapsedMs":42,"keyMask":"AIza****xx"}` — everything working.
- `{"result":"miss","source":"macos_security","stderrClass":"not_found","exitCode":44}` — the item isn't in the keychain; run `gemini /auth` first.
- `{"result":"error","source":"macos_security","stderrClass":"timeout","elapsedMs":10002}` — the Keychain password dialog stayed unanswered past the 10s timeout; the ACL needs fixing (Option 1 or 2 above).
- `{"result":"error","source":"macos_security","stderrClass":"acl_denied","exitCode":51}` — ACL rejected the read after the dialog was answered; likely clicked "Deny" or a subsequent policy rejected the app.
- `{"result":"hit","source":"cache","elapsedMs":0}` — a previous resolution succeeded and is still within TTL; no actual keychain hit this time.
- `{"result":"hit","source":"env"}` — `GEMINI_API_KEY` was set in the environment, keychain was not consulted.

The key in each event is masked to `AIza****xx`; raw key material never appears in the event stream, even when the child process error dumped it into `stderr`/`message`.

## Option 4 — AO-owned keychain item via the setup wizard

The cleanest fix. Runs once, survives forever (until you rotate the key):

```bash
node scripts/setup-gemini-key.mjs
```

What the wizard does:

1. Reads your Gemini API key from stdin with echo disabled (characters show as `*`, not the real key).
2. Calls `/usr/bin/security add-generic-password -U -T /usr/bin/security -T /usr/bin/env -T <node-binary> -w` (bare `-w`, password delivered via stdin — the key never appears on argv / `ps` output).
3. Verifies the read-back via the same `/usr/bin/security` code path AO uses at runtime. If the verification takes longer than ~3 seconds, the wizard warns you — that's a sign the ACL didn't attach correctly.
4. Offers to flip `.ao/autonomy.json` to `"credentialSource": "ao-keychain"` so subsequent AO runs read the new item.

After the wizard, `gemini_cred_resolve` events show `source: "macos_security"`, `service: "agent-olympus.gemini-api-key"`, and no dialog.

**Tradeoff — drift**: the AO-owned item is SEPARATE from the gemini CLI's own `gemini-cli-api-key` item. If you ever refresh the key with `gemini /auth`, you must also re-run `node scripts/setup-gemini-key.mjs` to update the AO copy, or AO workers will fail with 401/403. This is a conscious design choice: we don't automatically sync because that would re-introduce the exact ACL read that prompts in the first place.

**Tradeoff — per-project vs. global**: the wizard writes to the keychain (OS-wide, per-user) but updates `.ao/autonomy.json` in the current working directory. If you want the `credentialSource` switch to apply to every project, add it to `~/.config/agent-olympus/autonomy.json` instead:

```jsonc
{
  "gemini": {
    "credentialSource": "ao-keychain"
  }
}
```

**Piping a key**: the wizard accepts piped input for scripting:

```bash
# 1Password / pass / etc. can pipe the key in without it hitting terminal history:
op read "op://Personal/Gemini/api key" | node scripts/setup-gemini-key.mjs --update-autonomy
```

## When the wizard won't help

- **Linux/Windows** — the keychain ACL problem this wizard solves doesn't exist on Linux (libsecret uses D-Bus authorization, not per-app ACLs) or Windows (Credential Manager isn't supported by the resolver in v1). The wizard exits early on those platforms with a message recommending `GEMINI_API_KEY` in your shell.
- **Managed Macs** — corporate MDM profiles sometimes disable `add-generic-password` or require authenticated keychain writes that no script can satisfy without user interaction. The wizard surfaces `security`'s error in that case; you'll need to ask IT.

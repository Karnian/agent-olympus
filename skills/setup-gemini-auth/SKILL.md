---
name: setup-gemini-auth
description: macOS-only one-time wizard for Gemini API-key users whose key is stored in the macOS Keychain by `gemini /auth`. Creates an AO-owned keychain item so `/usr/bin/security` can read the API key without the login-password dialog firing on every Gemini worker spawn. Triggers ONLY for "Gemini keychain password prompt", "security wants to use keychain gemini", "setup gemini keychain item", "제미니 키체인 암호 프롬프트", "gemini 키체인 매번 뜸". Do NOT trigger for generic password prompts, OAuth (`gemini /auth → Login with Google`), Vertex AI, GEMINI_API_KEY env users, or Linux/Windows — those paths don't hit the ACL problem this wizard solves.
---

## BEFORE RUNNING THIS WIZARD

**Confirm the user is in the scenario this wizard addresses:**
- ✅ macOS
- ✅ They saw the literal `"security" wants to use your confidential information stored in "gemini-cli-api-key"` dialog (or similar login-password prompt) when an AO Gemini worker spawned
- ✅ They authenticated via `gemini /auth` → **Use API key** (NOT Login with Google)

**If ANY of these are true, STOP and explain they don't need the wizard:**
- User has `export GEMINI_API_KEY=...` in shell — AO reads env, keychain untouched
- User did `gemini /auth` → "Login with Google" (OAuth tokens in `~/.gemini/oauth_creds.json`)
- User has Vertex AI env vars (`GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` or `GOOGLE_API_KEY`)
- User is in GCP Cloud Shell or set `GEMINI_CLI_USE_COMPUTE_ADC=true`
- User is on Linux or Windows

Point those users at [docs/gemini-keychain-setup.md](docs/gemini-keychain-setup.md) "Do you need this guide?" section and suggest setting `credentialSource: "env"` in `.ao/autonomy.json` for clarity.

<SetupGeminiAuth>

## Purpose

Stop the macOS keychain password prompt from appearing every time Agent
Olympus spawns a Gemini worker. The wizard creates a SEPARATE keychain
item (`agent-olympus.gemini-api-key`) with `/usr/bin/security` pre-listed
as trusted, so subsequent AO reads never trigger the password dialog.

One-time action. Persists across `gemini /auth` re-runs (unlike clicking
"Always Allow" on the gemini CLI's own item, which resets when gemini
recreates that item).

## When to use this

Only when ALL of these are true:
- You're on **macOS** (Linux/Windows don't have this ACL problem).
- You use **Gemini API key auth** (not OAuth, not Vertex AI, not ADC).
- Your API key lives in the **macOS keychain** (saved there by
  `gemini /auth` → "Use API key", stored in service `gemini-cli-api-key`).
- You see the password prompt on every Gemini worker spawn, or Atlas/
  Athena stalls waiting for it.

## When NOT to use this (skip the wizard entirely)

- You `export GEMINI_API_KEY=AIza...` in your shell profile. AO reads
  `process.env.GEMINI_API_KEY` before touching the keychain.
- You signed in via `gemini /auth` → **"Login with Google"** (OAuth).
  Tokens live in `~/.gemini/oauth_creds.json`, NOT the keychain. AO
  resolver returns null cleanly and gemini CLI handles auth itself.
- You use **Vertex AI** with `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`
  or `GOOGLE_API_KEY`.
- You run inside **GCP Cloud Shell** (`CLOUD_SHELL=true`) or set
  `GEMINI_CLI_USE_COMPUTE_ADC=true` (Application Default Credentials).
- You're on **Linux/Windows**. libsecret/Credential Manager use a
  different trust model without per-app ACLs in the same way.

In all of the above, AO's resolver either reads env directly or returns
"no key" quickly, letting gemini CLI handle authentication on its own.
No prompts.

## Steps

### 1. Run the wizard

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/setup-gemini-key.mjs"
```

`$CLAUDE_PLUGIN_ROOT` is set by Claude Code and resolves to the installed
plugin directory — you don't need to know the absolute path.

### 2. Paste the Gemini API key when prompted

Input is echo-disabled (shown as `*`). Get one at
https://aistudio.google.com/apikey if you don't have it yet.

### 3. macOS may ask for your login password ONCE

This authorizes the ACL change on the new keychain item. One dialog total,
not one per spawn.

### 4. Accept the autonomy.json patch

The wizard offers to set `gemini.credentialSource: "ao-keychain"` in
`.ao/autonomy.json`. Press Enter (Y) to accept, or run with
`--update-autonomy` to skip the prompt.

For a global setting that applies to every project, add the field to
`~/.config/agent-olympus/autonomy.json` instead:

```jsonc
{ "gemini": { "credentialSource": "ao-keychain" } }
```

## Automation / Piped input

Piping the key avoids echoing it into the shell history:

```bash
# Via password manager (example: 1Password CLI)
op read "op://Personal/Gemini/api key" \
  | node "$CLAUDE_PLUGIN_ROOT/scripts/setup-gemini-key.mjs" --update-autonomy

# Via pass
pass show gemini/api-key \
  | node "$CLAUDE_PLUGIN_ROOT/scripts/setup-gemini-key.mjs" --update-autonomy
```

macOS may still show the login-password dialog once for the ACL change
itself — that's a system-level policy the wizard can't bypass.

## After setup

Subsequent Gemini worker spawns read the new item silently. Verify with:

```bash
AO_DEBUG_CREDENTIAL=1 <your AO command> 2>&1 | grep gemini_cred_resolve
```

At `stage: "end"` you should see `source: "macos_security"`,
`service: "agent-olympus.gemini-api-key"`, `result: "hit"`, and
`elapsedMs` under ~100.

## Key rotation

If you refresh the Gemini key later (new key from AI Studio, or running
`gemini /auth` again), the AO keychain item is now stale and Gemini
workers fail with 401/403. Fix: re-run `/setup-gemini-auth` with the
new key. The wizard is idempotent (`-U` flag updates in place).

The resolver emits `{"event":"gemini_cred_stale_ao_keychain"}` on stderr
when it detects this exact scenario so you know what to do.

## Related

- [docs/gemini-keychain-setup.md](docs/gemini-keychain-setup.md) — full
  background on why the prompt appears and four manual alternatives.
- `scripts/setup-gemini-key.mjs` — the wizard itself; has `--help` with
  all flags.

</SetupGeminiAuth>

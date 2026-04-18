# Gemini API Key — macOS Keychain Setup

This guide explains why Agent Olympus may repeatedly prompt for your macOS login password when spawning a Gemini worker, and how to stop it.

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

## Future work (not available yet)

A `credentialSource` option in `.ao/autonomy.json` is planned:

```jsonc
// PLANNED — not yet implemented
{
  "gemini": {
    "credentialSource": "ao-keychain"  // or "env" | "shared-keychain" | "auto"
  }
}
```

With `ao-keychain`, a one-time setup wizard will write an AO-owned keychain item (`agent-olympus.gemini-api-key`) with `/usr/bin/security` pre-listed as trusted, eliminating prompts entirely. A companion `AO_DEBUG_CREDENTIAL=1` tracing flag will emit `gemini_cred_resolve` events to stderr to help diagnose which branch (miss vs. ACL prompt vs. timeout) is failing.

Track progress in the roadmap; until those ship, Options 1–3 above are the supported workarounds.

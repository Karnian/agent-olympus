# Permission Mirroring
> Moved verbatim from CLAUDE.md (Codex Interop v1, Ship order 1).

### Permission Mirroring

All worker types (Codex, Claude, Gemini) mirror the host session's permission level via `scripts/lib/permission-detect.mjs`. This shared module eliminates duplication between adapter-specific approval modules.

**Detection (Plan A, 2026-04-14)** reads allow/deny/ask lists from ALL documented Claude scopes and MERGES them (union semantics, per Claude docs):

- Precedence order (highest first): **managed** (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/` on Linux, `%PROGRAMDATA%\ClaudeCode\` on Windows, plus lexically-ordered `managed-settings.d/*.json` fragments) → **project-local** `.claude/settings.local.json` → **project** `.claude/settings.json` → **user-local** `~/.claude/settings.local.json` → **user** `~/.claude/settings.json`.
- `allow` / `deny` / `ask` lists UNION across all scopes (a user-level `Bash(*)` merges with a project-level `Write(*)`).
- `defaultMode` is taken from the HIGHEST precedence scope that sets it.
- `disableBypassPermissionsMode: true` in ANY scope (OR semantics) demotes `bypassPermissions` to no-implicit-grant.

**Broad vs scoped split** — only LITERAL `Tool` or `Tool(*)` in `allow` count as "broad". Wildcard variants like `Bash(*:*)`, `Bash(**)`, `Bash(*,*)` are SCOPED (per Claude's matcher, `:*` is a trailing-wildcard suffix, not universal). **Only broad grants promote a tier** — scoped grants alone map to `suggest`, because codex's coarse sandbox tiers cannot honor the user's scoped restriction:
- `Write(src/**)` alone → `suggest`. `workspace-write` would let codex edit `docs/**` too (privilege expansion).
- `Bash(git:*)` alone → `suggest`. `workspace-write` still allows arbitrary shell in cwd (`rm`, `curl`, etc.) — not just git.

**Managed policy** — managed settings come from OS-specific locations (macOS `/Library/Application Support/ClaudeCode/`, Linux `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\` with `%PROGRAMDATA%\ClaudeCode\` as legacy fallback). Each root supports a `managed-settings.json` plus a lexically-ordered `managed-settings.d/*.json` fragment dir. Within managed scope, **fragments override earlier scalars** (last-wins) for `defaultMode` and similar scalar fields. `permissions.allowManagedPermissionRulesOnly: true` in managed suppresses non-managed `allow` lists, but deny/ask from ALL scopes still apply (defense-in-depth). `disableBypassPermissionsMode` accepts both legacy boolean `true` and current string `"disable"`.

**Fail-closed rules** (codex is non-interactive, cannot honor "please confirm"):
- Any `Bash(...)` or `Bash` entry in `ask` — even scoped — invalidates the broad Bash grant.
- Literal broad deny (`Bash(*)` or `Bash`) removes ALL Bash grants (broad + scoped).
- Any scoped deny (`Bash(curl:*)`) invalidates the broad Bash grant (scoped restriction cannot be honored under `danger-full-access`).

**defaultMode as implicit grant** — `bypassPermissions` (unless disabled) is an implicit broad allow for ALL tools; `acceptEdits` is an implicit broad allow for Write+Edit only. Both flow through the SAME deny/ask fail-closed pipeline, so `bypassPermissions + deny Bash(*)` correctly demotes Bash while keeping Write/Edit broad.

**Codex** mirrors permissions to the **sandbox axis** (not the approval axis). Both `codex-exec` and `codex-appserver` workers run non-interactively — there is no TTY to prompt for approvals — so we hold the approval policy at `never` and vary the Codex sandbox tier instead. (Codex 0.118+ docs: *"Prefer `on-request` for interactive runs or `never` for non-interactive runs"*; the `--auto-edit` flag was removed in 0.118.)

| Merged Claude permissions                                          | `-a` (approval) | `-s` (sandbox)       |
|--------------------------------------------------------------------|-----------------|----------------------|
| Broad `Bash(*)` + broad `Write(*)`, no ask/deny interference       | `never`         | `danger-full-access` |
| Any broad/scoped Write/Edit, or scoped Bash, or `acceptEdits` mode | `never`         | `workspace-write`    |
| Otherwise (suggest-tier)                                           | _demoted_       | _demoted_            |

Suggest-tier hosts cannot use a Codex implementation worker safely — a `read-only` sandbox could let it return advice that Atlas/Athena mistakes for completed edits. So:
- **Atlas/Athena teams** (`worker-spawn.mjs`): codex workers are demoted to `claude` workers BEFORE adapter selection (`demoteCodexWorkersIfNeeded`). The `_demotedFrom`/`_demotionReason`/`_demotedModel` fields are preserved on the worker for observability. Provider-specific fields like `model` are stripped so the Claude path doesn't receive a Codex model name.
- **`/ask` skill** (`ask.mjs`): analysis-only Codex requests stay available under `-s read-only -a never`, with a system-prompt no-write guard and a post-run `git status --porcelain` check. This exception does not apply to implementation workers.

The `-a` and `-s` flags are GLOBAL Codex CLI flags and MUST appear BEFORE the `exec` subcommand. `codex exec -a never` errors with `unexpected argument '-a'` in 0.118+.

**Settings-file mirror + bound runtime override (v1.1.6+, hardened after v1.5.1).** Detection reads Claude Code's *settings files* and a runtime `permission_mode` captured by the `RuntimePermissionsCapture` hook on SessionStart + UserPromptSubmit. Project-local `.ao/state/ao-runtime-permissions.json` is identity/diagnostic state only and never grants permission. The authoritative record is stored outside the workspace at `~/.cache/agent-olympus/runtime-permissions/<sha256(canonical-project-root)>.json`, with private directory/file modes and no-follow, single-link, bounded-size, ownership, ancestry, and replacement-race checks. Promotion requires the hardened current-session pointer, local hook session/capture ID, and external record to agree; new/unknown sessions tombstone an old grant, SessionEnd revokes the matching grant, and failures fall back to settings-only. Windows runtime promotion is disabled until equivalent ACL ownership can be proved.

The two layers merge **upgrade-only** in `detectClaudePermissionLevel`: runtime can promote a tier (`bypassPermissions` settings-empty → `full-auto`) but never demote it (settings literal allow grants stay broad even when runtime mode flips to `default`). The runtime tier flows through the same deny/ask/disableBypassPermissionsMode/allowManagedPermissionRulesOnly pipeline as the settings defaultMode, so a managed deny on Bash still clamps a runtime `bypassPermissions` to `auto-edit`. **Still NOT observable**: `--allowedTools` / `--disallowedTools` / `--tools` CLI flags and `--settings` inline overrides — there is no documented stdin/env signal for these. Set `.ao/autonomy.json { codex: { approval: "suggest" } }` or run `node scripts/diagnose-sandbox.mjs --explain-permissions` if you need to verify the resolved tier.

**Host sandbox intersection** (`scripts/lib/host-sandbox-detect.mjs`). The codex permission level derived from `permissions.allow` is now INTERSECTED with a passive host-sandbox detection (the more restrictive of the two wins). Signal priority:

1. **Explicit override** (ground truth) — `AO_HOST_SANDBOX_LEVEL` env var OR `.ao/autonomy.json { codex: { hostSandbox: ... } }` ∈ `{unrestricted, workspace-write, read-only}`. Env wins when both are set.
2. **Linux LSM enforcing** — AppArmor (`/proc/self/attr/current` `(enforce)`), SELinux (`/sys/fs/selinux/enforce == 1` + non-`unconfined_t` context), or Landlock (`/proc/self/status` Landlock field). Any of these → tier `workspace-write`.
3. **Otherwise** — tier `unknown` (NO silent downgrade; ambiguous signals like containers, seccomp, or macOS `OPERON_SANDBOXED_NETWORK` are recorded as SIGNALS but don't force a tier change).

When tier is `unknown` but filesystem-scoped signals exist (containerized, seccomp filter, NoNewPrivs), Atlas/Athena records a one-time `architecture` wisdom warning asking the user to set `AO_HOST_SANDBOX_LEVEL` explicitly. Network-only signals (OPERON_SANDBOXED_NETWORK) do NOT trigger the warning because the override controls filesystem tier, not network.

Diagnostic CLI: `node scripts/diagnose-sandbox.mjs` prints the full detection record (tier, source, all signals, effective codex level) as JSON. Use it to figure out whether you need to set an explicit override.

**Known limitation.** Host sandbox detection is passive only — no active probing of writable roots or network reachability. A host that appears unrestricted on paper but is actually inside a chroot or `sandbox-exec` policy without exposing LSM-equivalent signals will still show tier `unknown`. Set `AO_HOST_SANDBOX_LEVEL` explicitly in those environments.

**Claude** workers now auto-detect permission level (no longer default to `--dangerously-skip-permissions`):
- `Bash(*) + Write(*)` → `--permission-mode bypassPermissions`
- `Write(*)` or `Edit(*)` → `--permission-mode acceptEdits`
- Otherwise → `--permission-mode default`

**Gemini** approval mode follows the same detection logic, mapped to Gemini modes:
- `Bash(*) + Write(*)` → `--approval-mode yolo`
- `Write(*)` or `Edit(*)` only → `--approval-mode auto_edit`
- Otherwise → no flag (Gemini default interactive mode)

Override via `.ao/autonomy.json`:
```json
{
  "codex": { "approval": "full-auto", "hostSandbox": "auto" },
  "gemini": { "approval": "yolo" },
  "planExecution": "ask"
}
```
Codex values: `auto` (default), `suggest`, `auto-edit`, `full-auto`
Codex host sandbox: `auto` (default — detect), `unrestricted`, `workspace-write`, `read-only`. Env var `AO_HOST_SANDBOX_LEVEL` (same enum, minus `auto`) takes precedence.
Gemini values: `auto` (default), `default`, `auto_edit`, `yolo`, `plan`
`nativeTeams` is a legacy compatibility boolean only. Runtime support now
requires both `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and Claude Code 2.1.178+;
configuration cannot manufacture a missing native-team capability.
`planExecution`: `ask` (default) presents Solo/Atlas/Athena choice via `AskUserQuestion` interactive UI after plan approval (text fallback for non-Desktop environments); `solo` skips orchestration; `atlas`/`athena` auto-routes. Simple plans (S-scale or ≤2 stories) auto-skip to solo.

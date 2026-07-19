# Autonomy Config Resolution (Layered)
> Recovered verbatim from CLAUDE.md.


`loadAutonomyConfig(cwd, opts?)` in `scripts/lib/autonomy.mjs` resolves the
effective `autonomy.json` by merging up to three layers, lowest-precedence first:

```
defaults  ←  global (env override OR user-level)  ←  project
```

**Resolution order for the global layer** (only the FIRST existing file wins;
layers are not cross-merged within the global slot):

1. `AO_AUTONOMY_CONFIG=<path>` — explicit env override. Skips the CI kill-switch.
2. `$XDG_CONFIG_HOME/agent-olympus/autonomy.json`
3. `~/.config/agent-olympus/autonomy.json`
4. `~/.ao/autonomy.json` — legacy path, still honored

**Project layer**: `<cwd>/.ao/autonomy.json`. Always applies.

**CI kill-switch**: when running inside a CI provider (detected via `CI`,
`GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `TRAVIS`, `JENKINS_URL`,
`BUILDKITE`, `DRONE`, `BITBUCKET_BUILD_NUMBER`, `TF_BUILD`, `TEAMCITY_VERSION`,
`APPVEYOR`, `CODEBUILD_BUILD_ID`), the global layer is **skipped** so a
developer's dotfile-synced `~/.config/agent-olympus/autonomy.json` can't
silently widen the sandbox on a shared runner. An explicit `AO_AUTONOMY_CONFIG`
bypasses this kill-switch (opt-in). Set `CI=false` or `CI=0` to disable.

**Symlink guard**: global-layer files must resolve (via `realpath`) to a
location inside one of the allowed directories (XDG / `~/.config` / `~/.ao`,
plus the AO_AUTONOMY_CONFIG parent when actively used). Symlinks escaping these
roots are rejected with an `autonomy_symlink_rejected` stderr event. Project
files are trusted (the repo owner controls `.ao/`).

**Safe-mode opts**:
```js
loadAutonomyConfig(cwd, { skipGlobal: true })  // project-only, no env/home
loadAutonomyConfig(cwd, { skipEnv: true })     // ignore AO_AUTONOMY_CONFIG only
```

**Merge semantics**: deep-merge for objects; **arrays are replaced** (not
concatenated) so `ship.labels` in the project config cleanly overrides the
global one without accidental concatenation.

## Ship Policy

`ship.mode` controls release side effects and defaults to the conservative
`"ask"` policy:

- `"never"` — do not update the changelog or tech-debt tracker, push, create a
  PR, or start CI watching. Leave the branch ready for the user to ship.
- `"ask"` — express the intent to require human approval before push/PR. The
  current code-owned Atlas runtime has no host-attested approval-receipt
  channel, so it fails closed with `ship-approval-unattested`, leaves the
  branch local, and hands shipping to the user. Interactive availability does
  not change this behavior; a candidate-written event claiming an
  `AskUserQuestion` answer is not authorization.
- `"auto"` — push and create a PR automatically after preflight succeeds.

An explicit no-push/no-PR constraint in the original task or any user follow-up
durably appended to the active run always overrides the configured mode,
including `"auto"`. Follow-ups are stored in the identity-bound, atomically
rewritten `task-updates.json` ledger. Each durable rename is fsynced and bound
to a separate sequence-and-hash anchor, so a valid older ledger prefix also
fails closed. If a process stops between the two publications, the next locked
append repairs only an exactly one-step-ahead ledger whose prior prefix matches
the durable anchor; the best-effort `events.jsonl` copy is audit-only. A missing,
torn, malformed, identity-mismatched, or anchor-mismatched task ledger stops
the run before release side effects. Policy is re-read on every resume and
immediately before each push or PR mutation, so a follow-up after finalize still
revokes shipping. On the current code-owned Atlas path, the candidate can write
the same run events that record approval, so neither a `human_ship_approval`
event, a caller-authored `source: "AskUserQuestion"` field, nor model-generated
prose proves that the host displayed a prompt and a human selected an answer.
Until the host provides a nonce-bound receipt that Atlas can verify, `"ask"`
always stops before outward release side effects and requires manual shipping.
The durable ledger supports revocation and run identity, but it is not
cryptographic user-origin attestation.

Before any Atlas shipping action, `complete-finalize` creates the exact commit
envelope that the final reviewers approved. It invokes a fixed, trusted Git
binary through normal `git commit`, so repository commit hooks run with the
user's toolchain `PATH`; ambient `GIT_*` and GitHub repository selectors remain
filtered. The author and committer are the explicit
`Agent Olympus <agent-olympus@localhost>` automation identity, the UTC timestamp
and message are reviewer-bound, and any hook or setting that changes the tree or
metadata makes finalization fail closed before push. This automation envelope is
intentionally unsigned (`--no-gpg-sign`), because a signature header cannot be
known before final review. Repositories that require signed commits must use a
manual shipping path; supporting signatures requires a future commit-before-final-
review protocol rather than weakening the exact metadata check.

`ship.autoPush` is deprecated but remains validated for compatibility. Within
a valid config layer that omits `ship.mode`, legacy `autoPush: true` maps to
`"auto"` and `false` maps to `"ask"`; if both fields are absent, the lower layer
or default remains in effect. An explicit valid `ship.mode` always wins over a
conflicting legacy value. Persisted layers with malformed `autoPush` or invalid
`mode` retain the loader's existing fail-safe behavior: that layer is rejected
while valid lower layers continue to apply. Direct calls to
`resolveShipMode(rawConfig)` return `"ask"` for malformed input or an invalid
present mode.

`ship.baseBranch` defaults to `null`. A nonblank override is used as-is;
otherwise the PR helper asks GitHub for the repository default branch, falls
back to the local `origin/HEAD` only for read-only preparation, and finally
falls back to `main`. Shipping preflight itself is fail-closed unless GitHub
returns authoritative default-branch metadata for the repository parsed from
`origin`. The same resolved branch is used for the diff and PR base.

Preflight also binds credential-free canonical fetch and push URLs plus the
host-qualified GitHub repository to the run. It rejects multiple or mismatched
push URLs. Atlas and Athena persist that identity with the initial branch,
base, and HEAD intent, then re-check it before every push and PR mutation. Push
uses the pinned URL and exact commit-to-branch refspec, while PR commands use
the pinned `--repo`. A changed checkout, commit, default branch, origin, or
ambient `GH_HOST`/`GH_REPO` cannot silently redirect an automatic or previously
approved ship operation.

PR creation also passes the pinned head branch explicitly instead of asking
`gh` to infer it from the current checkout. CI polling and failed-log lookup
receive the same pinned working directory and host-qualified repository. Each
poll is bound to an exact durable commit SHA, so an older successful workflow
run on the same branch cannot certify a newly pushed commit. The watcher
aggregates every visible workflow run for that SHA and never treats one success
as sufficient while another run is pending, failed, malformed, or at the query
cap. Local and remote branch HEAD are checked before and after polling and again
before CI completion.

CI fix recovery persists `ci_fix_started`, a descendant
`ci_fix_candidate`, and finally the remotely confirmed `ci_head_target`, with a
single fix-attempt identity linking the transition. Resume rechecks ancestry
and reconciles the pinned remote idempotently. If a crash leaves only the start
record and a changed local HEAD, that inferred candidate requires a fresh
structured human approval even under `ship.mode: "auto"`.

`ship.updateChangelog` and `ship.updateTechDebtTracker` both default to `true`
and independently gate their finalize-time updates. `ship.mode: "never"`
suppresses both regardless of those flags.

```json
{
  "ship": {
    "mode": "ask",
    "baseBranch": null,
    "updateChangelog": true,
    "updateTechDebtTracker": true
  }
}
```

**Quick setup** — turn codex into full-auto globally:
```bash
mkdir -p ~/.config/agent-olympus
echo '{"codex":{"approval":"full-auto"}}' > ~/.config/agent-olympus/autonomy.json
```
This applies to every project that doesn't have a project-level override.
Project-level `.ao/autonomy.json` always wins per-repo.

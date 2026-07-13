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
- `"ask"` — require an actual human approval from an interactive channel before
  push/PR. In a headless or unattended run, notify when `notify.onBlocked` is
  enabled, then skip shipping and CI without pushing.
- `"auto"` — push and create a PR automatically after preflight succeeds.

An explicit no-push/no-PR constraint in the original task always overrides the
configured mode, including `"auto"`. The orchestrator cannot approve its own
prompt; only an actual user response satisfies `"ask"`.

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
otherwise the PR helper detects `origin/HEAD`, then asks `gh` for the repository
default branch, and finally falls back to `main`. The same resolved branch is
used for the diff and PR base.

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

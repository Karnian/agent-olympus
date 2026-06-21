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

**Quick setup** — turn codex into full-auto globally:
```bash
mkdir -p ~/.config/agent-olympus
echo '{"codex":{"approval":"full-auto"}}' > ~/.config/agent-olympus/autonomy.json
```
This applies to every project that doesn't have a project-level override.
Project-level `.ao/autonomy.json` always wins per-repo.

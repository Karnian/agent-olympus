# Eval Harness Engine

This directory contains the HU-01 eval-harness engine MVP. It defines the task
contract, runs one task over isolated seed copies, invokes an orchestrator, calls
an independent deterministic grader, and writes JSONL plus summary output.

## Run

A bare `node evals/run.mjs --task <dir>` is **refused** — it will not silently
spawn a real, unsupervised orchestrator run. Choose a mode:

```sh
# Hermetic (no Claude): apply the task's reference solution/ → GREEN
node evals/run.mjs --task evals/tasks/fix-failing-test --fixture solution
# Hermetic: no-op orchestrator, seed stays broken → RED
node evals/run.mjs --task evals/tasks/fix-failing-test --fixture none
# LIVE: spawn the real orchestrator (see caveat below)
node evals/run.mjs --task evals/tasks/fix-failing-test --live
```

The engine self-test also uses the sample fixture task
(`--task evals/tasks/_sample --fixture pass|fail`). Results are written to
`evals/results/<runId>/results.jsonl` and `.../summary.json`.

## MVP Scope

P0b is engine-only and manual:

- Three real regression tasks ship here: `fix-failing-test`, `fix-null-deref`,
  `fix-off-by-one` (each: broken seed + deterministic grader + reference
  `solution/`).
- MVP defaults to `k=1`.
- Deterministic graders decide green/red outcomes (never the agent's own
  self-verification).
- The fixture orchestrator (`--fixture solution|none|pass|fail`) is the test
  path; it does not call Claude. `--live` is the only way to spawn a real run.
- `passHatK` reports all-trials reliability and `passAtK` reports any-trial success.

## Task Contract

Each task directory must contain:

- `task.json`, matching `evals/tasks/_schema/task.schema.json`.
- `seed/`, copied into a fresh temporary workdir for each trial.
- `grader.mjs`, exporting `grade(workdir)`.

The runner copies `seed/` with Node built-ins instead of creating a git worktree
from repository HEAD, so vendored task seeds are graded exactly as shipped.

## LIVE-RUN CAVEAT

The real `claude -p /atlas` path requires `--plugin-dir <repo>` so Claude loads
this branch's Agent Olympus plugin. The existing `--bare` worker-adapter path
does not load hooks or plugins, so it would not exercise `/atlas` correctly.

Live evals burn real tokens and run Atlas or Athena unsupervised. They are
manual/on-demand only, never for CI in this MVP, and are not exercised by the
test suite. Tests use the deterministic fixture orchestrator.

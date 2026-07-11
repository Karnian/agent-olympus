# Eval Harness Engine

This directory contains the HU-01 eval harness. It runs vendored tasks over
isolated seed copies, invokes an orchestrator, calls an independent deterministic
grader, and writes atomic JSONL plus summary output.

The harness keeps two tracks separate:

- `regression`: small tasks held at 100% `pass^k`; these form the committed baseline and hermetic CI proof.
- `capability`: harder deterministic tasks used to measure progress; they are reported but do not gate CI.

## Run

A bare `node evals/run.mjs --task <dir>` is **refused** — it will not silently
spawn a real, unsupervised orchestrator run. Choose a mode:

```sh
# Hermetic (no Claude): apply the task's reference solution/ → GREEN
node evals/run.mjs --task evals/tasks/fix-failing-test --fixture solution
# Hermetic: no-op orchestrator, seed stays broken → RED
node evals/run.mjs --task evals/tasks/fix-failing-test --fixture none
# LIVE operator run: spawn the real orchestrator (see caveat below)
node evals/run.mjs --task evals/tasks/fix-failing-test --live
```

The engine self-test also uses the sample fixture task
(`--task evals/tasks/_sample --fixture pass|fail`). Results are written to
`evals/results/<runId>/results.jsonl` and `.../summary.json`.

Run the complete two-track suite with a single run-level summary and JSONL:

```sh
node evals/run-suite.mjs --track all --fixture solution
node evals/run-suite.mjs --track regression --fixture none
```

`run-suite.mjs` discovers task directories, rejects unsafe or duplicate task
IDs, and aggregates task verdicts, track rollups, and tokens. Suite baseline
refresh is intentionally rejected because task-by-task writes would not be
atomic as a set.

Each real task runs at `k=3`. `passHatK` reports all-trials reliability and
`passAtK` reports any-trial capability. Fixture runs always report zero
aggregate tokens and `null` raw usage; they must not be used to claim provider
cost or live reliability.

## Task Contract

Each task directory must contain:

- `task.json`, matching `evals/tasks/_schema/task.schema.json`.
- `seed/`, copied into a fresh temporary workdir for each trial.
- `grader.mjs`, exporting `grade(workdir)`.
- `solution/`, when the task participates in the hermetic GREEN proof.

The runner copies `seed/` with Node built-ins instead of creating a git worktree
from repository HEAD, so vendored task seeds are graded exactly as shipped.
Graders use deterministic local tests and hidden behavioral checks; they never
trust the agent's self-report.

## Hermetic CI and baseline

CI runs the full Node test suite, validates `baseline.json`, and proves every
regression seed both GREEN with `--fixture solution` and RED with
`--fixture none`. CI never invokes a provider, requires credentials, or spends
tokens. `verify-fixtures.mjs` discovers the regression task set automatically,
so adding a baseline task cannot silently omit it from the proof.

Run the same baseline integrity check locally:

```sh
node evals/verify-baseline.mjs
```

## Manual live comparison and baseline refresh

The real `claude -p /atlas` path requires `--plugin-dir <repo>` so Claude loads
this branch's Agent Olympus plugin. The existing `--bare` worker-adapter path
does not load hooks or plugins, so it would not exercise `/atlas` correctly.

Live orchestration is an operator-only or private nightly action. Run each
regression task explicitly with `--live`, then inspect `summary.json`:
`delta_vs_baseline` is `-1`, `0`, or `1`, and `tokenUsage` contains aggregate
result-event usage. The deterministic grader measures task outcome; it is a
reliability floor, not a trajectory-quality judgment.

After reviewing a trusted live run, refresh that task's committed baseline with
the same command plus `--update-baseline`. Refresh is rejected for capability
tasks, failed runs, fixture runs, ambiguous `--live`+`--fixture` invocations,
unknown tasks, or a `k` that differs from the committed baseline. Review the
resulting `evals/baseline.json` diff before committing it.

Inspect release-over-release per-track pass rates and token totals with:

```sh
node evals/report.mjs --trend
```

Trend output excludes fixture and legacy unknown-mode summaries by default so
hermetic GREEN/RED proofs cannot masquerade as live reliability history. Use
`--include-fixtures` only when debugging the reporter itself.

Live evals burn real tokens and run Atlas or Athena unsupervised. They are never
run by CI or this repository's test suite.

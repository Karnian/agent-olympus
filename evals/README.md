# Eval Harness Engine

This directory contains the HU-01 eval harness. It runs vendored tasks over
isolated seed copies, invokes an orchestrator, calls an independent deterministic
grader, and writes atomic JSONL plus summary output.

The harness keeps two tracks separate:

- `regression`: small tasks held at 100% `pass^k`; these form the committed baseline and hermetic CI proof.
- `capability`: harder deterministic tasks used to measure progress; they are reported but do not gate CI.

## Role contract audit (provider-free)

`roles/manifest.json` pins the exact 19-agent inventory, namespaced invocation
identity, model tier, effective tool declaration, read-only mutation boundary,
and documented machine-output contracts. The static audit parses the real
`agents/*.md` frontmatter and validates documented `AO_REVIEW_V1`, `AO_SPEC_V1`,
and `STAGE_VERDICT` examples through the production parsers without invoking a
model:

```sh
node --test scripts/test/eval-role-contracts.test.mjs
```

## Run

A bare `node evals/run.mjs --task <dir>` is **refused** — it will not silently
spawn a real, unsupervised orchestrator run. Choose a mode:

```sh
# Hermetic (no Claude): apply the task's reference solution/ → GREEN
node evals/run.mjs --task evals/tasks/fix-failing-test --fixture solution
# Hermetic: no-op orchestrator, seed stays broken → RED
node evals/run.mjs --task evals/tasks/fix-failing-test --fixture none
# LIVE operator run: every provider call requires an explicit/task cap
node evals/run.mjs --task evals/tasks/fix-failing-test --live --k 1 --max-budget-usd 1
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

Paid suites require an explicit `--track` plus all three controls up front:
explicit `--k`, a per-trial `--max-budget-usd`, and a conservative
`--max-total-budget-usd` at least as
large as `taskCount * k * perTrialCap`. The suite rejects an insufficient
aggregate cap before spawning, passes the per-trial cap to every child run,
and stops scheduling if a child exceeds its cap, omits cost evidence, or the
aggregate cap is reached. The provider cap is enforced by Claude inside a
trial; reported cost is checked between trials and tasks.

Regression tasks and established capability benchmarks run at `k=3`.
New direct-agent wiring tasks default to `k=1`; an operator must explicitly
request `--k 3` after the route, provenance, grader, and budget controls pass.
Regression track rollups use `passHatK`
(all-trials reliability), while capability track rollups use `passAtK`
(at least one successful trial). Raw JSONL trial rows retain their individual
`pass` verdicts. Fixture runs always report zero
aggregate tokens and `null` raw usage; they must not be used to claim provider
cost or live reliability.

Live results keep the independent grader verdict (`outcomePass`,
`outcomePassAtK`, and `outcomePassHatK`) separate from the overall
`pass`/`passAtK`/`passHatK` verdict. The latter also requires the applicable
route, pipeline, provenance, treatment-consistency, and budget gates. A
functionally correct patch therefore remains visible when an orchestration or
efficiency axis fails, without being reported as an overall success.

`task.json.modelTier` is passed to Claude as `--model <tier>` for live runs and
is persisted on trial, task, suite, and trend records. Model selectors are
restricted to option-safe model names so task metadata cannot inject CLI flags.
Task metadata is enforced with the same exact required-key contract as the
checked-in JSON schema; unknown or missing fields fail instead of silently
falling back to another model, timeout, or k.

Individual plugin agents use `orchestrator: "agent"` plus a bundled bare agent
name, for example `"agent": "executor"`. The live runner sends the task as a
plain prompt and activates the persona with
`--agent agent-olympus:executor`. Direct-agent tasks are capability-only: the
committed regression baseline currently compares orchestrators, not individual
agent targets. The bare name is validated against the 19 agents shipped by this
plugin, so task metadata cannot select another plugin or inject a CLI option.
Each direct trial stages a hook-free plugin snapshot, restricts Claude settings
to the isolated project, and sets `DISABLE_AO=1` as defense in depth so the
production intent/model router cannot contaminate the persona treatment. The
`solo` control uses Claude safe mode with no plugin snapshot. Atlas/Athena keep
their staged hooks because hook behavior is part of those product paths. All
headless arms disable prompt-suggestion messages, pin effort to `high`, and
record resolved models plus reported fast-mode, speed, and service-tier state.

## Task Contract

Each task directory must contain:

- `task.json`, matching `evals/tasks/_schema/task.schema.json`.
- `seed/`, copied into a fresh temporary workdir for each trial.
- `grader.mjs`, exporting `grade(workdir)`.
- `solution/`, when the task participates in the hermetic GREEN proof.

The runner copies `seed/` with Node built-ins instead of creating a git worktree
from repository HEAD, so vendored task seeds are graded exactly as shipped.
Graders use deterministic local tests and hidden behavioral checks; they never
trust the agent's self-report. Public tests and hidden checks run sequentially
in bounded child processes. A small supervisor owns a private process group,
reaps descendants, caps output, and uses a close watchdog. Hidden checks also
run under Node's permission model: candidate code can read/write its workdir,
but cannot spawn child processes or workers. The selected grader and generic
grader library are copied to a fresh private snapshot that omits the task seed,
reference solution, and source task directory. Grader coordinates are delivered
over consumed stdin; `argv`, `execArgv`, diagnostic reports, hidden stack frames,
and callback source are redacted before candidate code loads. These controls
protect runner availability and reduce oracle leakage, but they remain
defense-in-depth inside one Node process, not an OS sandbox for arbitrary hostile
native code or heap-introspection techniques.

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

The real `claude -p /agent-olympus:atlas` path requires `--plugin-dir <repo>` so
Claude loads this branch's Agent Olympus plugin. Plugin skills are namespaced;
an unqualified `/atlas` does not invoke the skill loaded by `--plugin-dir`. The
existing `--bare` worker-adapter path does not load hooks or plugins, so it
would not exercise `/agent-olympus:atlas` correctly. The `solo` control arm is
sent as a plain prompt because it is not a plugin skill.

Live orchestration is an operator-only or private nightly action. Run each
regression task explicitly with `--live`, then inspect `summary.json`.
Before each Atlas/Athena Claude trial, the runner copies only runtime plugin roots
(`.claude-plugin/`, agents, skills, hooks, scripts excluding tests, config, and
schemas) into a fresh private temporary snapshot. Direct-agent snapshots copy
the same runtime surface except the root hook tree; solo copies no plugin.
`summary.json` records the route-specific mode as
`staged-plugin-best-effort`, `staged-plugin-hook-free`, or
`safe-mode-no-plugin`. This reduces accidental access
to reference solutions and graders, but `bypassPermissions` is not an OS
sandbox, so the snapshot is not a security boundary against a malicious agent.

For Atlas and Athena live trials, the harness also pre-allocates one production
run identity inside the fresh trial workdir before the provider starts. A trial
can pass only when the provider adopts that exact run, writes a strict
`pipeline.json` plus ordered `events.jsonl`, completes every required phase,
matches the production iteration/review/CI counters in `loop-guard.json`,
finalizes `summary.json`, and clears the matching active-run pointer. The
pipeline is checked before the independent grader runs, so grader-side writes
cannot manufacture orchestration evidence. Pre-existing `.ao` state, extra run
directories, corrupt or future schemas, symlinks, incomplete phases, and
out-of-order completion events fail closed. Evidence files are opened without
following symlinks, size-bounded, and required to have been written during the
trial. Fixture runs record pipeline evidence as not applicable and never
satisfy this live-only gate.

Direct-agent and solo-control trials deliberately record pipeline evidence as
not applicable. They measure the selected persona's bounded task outcome, not
Atlas/Athena phase-protocol compliance. The target agent is retained on every
trial, task summary, and run summary so two persona results cannot collapse
into an indistinguishable `orchestrator: "agent"` bucket.

Athena uses its own production phase sequence and recovery phases
(`spawn`/`monitor`/`integrate`). The evidence verifier applies the Athena phase
contract and requires monitor-loop authority instead of treating it as an Atlas
run with renamed output. Live execution is still operator-only because it can
spawn multiple paid workers and is never exercised by CI.

This evidence is deliberately labelled `trust: "candidate-asserted"`: it closes
stale, missing, and accidental false-PASS paths for a cooperative orchestrator,
but the live process can still write its own workdir under
`bypassPermissions`. In particular, reviewer rosters/result maps,
`subagent_completed` events, and verification records (including `verifiedBy`)
are candidate-authored. The verifier recomputes the routed roster, parses the
result schemas, and binds those records to the PRD, review digest, Git tree,
generation, and phase ledger, but no candidate-inaccessible host channel proves
that the named reviewer or verifier was actually invoked or authored the
record.

Consequently, a pipeline PASS means the candidate-asserted protocol, tree, and
evidence records are mutually consistent under these checks. It is not proof
of an individual agent's invocation or performance; those claims require the
separate direct-agent live track (or future host-attested telemetry) and its
independent outcome/role grading. This evidence is not cryptographic or
OS-level attestation. HU-11 must provide a candidate-inaccessible event channel
and sandbox boundary before the project can claim adversarially
tamper-resistant trajectory evidence.

`delta_vs_baseline` is a measured-outcome comparison. It is `-1`, `0`, or `1`
only for a live run whose k exactly matches both the baseline's root k and that
task's k, whose orchestrator, `modelTier`, Claude CLI version, resolved model
IDs, effective per-trial budget, staged-plugin hash, and target prompt hash
match, and whose `benchmarkFingerprint` matches. That fingerprint covers
`task.json`, `seed/`, `grader.mjs`, and the shared grader-isolation runtime.
For Atlas, the target prompt identity is a domain-separated composite of the
concise `skills/atlas/SKILL.md` and its progressive-disclosure
`skills/atlas/reference.md`; minimal legacy test fixtures that omit the
reference retain their single-file identity.

The measurement machinery has a separate `pipelineProtocolFingerprint` over
the live harness, pipeline-evidence policy, and production
phase/loop-guard/run-artifact roots, the Atlas bootstrap/runtime/Stop gates,
the interacting global Stop hook, and the installed hook registry, plus their
repo-local relative-import closure.
Builtins, packages, and unreferenced SUT files are excluded. A
protocol-only change therefore does
not erase an otherwise valid outcome delta. It sets
`baselineComparison.protocolGate.passed: false` and
`decisionEligible: false` with reason `pipeline-protocol-mismatch`; a human must
review or refresh the measurement before using that delta as a release gate.
Benchmark changes remain outcome-incomparable. `baselineComparison` always
includes both identities and baseline provenance in machine output.
For a measured live LKG, its historical protocol fingerprint is immutable:
`verify-baseline.mjs` reports it in `protocolReviewRequired` instead of
pretending the old run used the current protocol. Only a newly reviewed live
run with `--update-baseline` may replace that measured fingerprint.

The initial committed `baseline.json` is a declared target (regression tasks
must hold 100% `pass^k` at `k=3`), not a measured live result — no live run has
produced it yet. Declared targets never return `comparable: true` and never
populate `delta_vs_baseline`; machine output reports `baseline-unmeasured`,
preserves the null live provenance, and puts the goal-relative result in the
separate `delta_vs_target` field. Each task records `source`, `runId`,
`measuredAt`, `modelTier`, `orchestrator`, `benchmarkFingerprint`, and
`pipelineProtocolFingerprint`; measured entries additionally require Claude
CLI, plugin/prompt, resolved-model, and effective-budget provenance. Targets
cannot masquerade as a measured LKG.

After reviewing a trusted live run, refresh that task's committed baseline with
the same capped command plus `--update-baseline`. Refresh is rejected for capability
tasks, failed runs, fixture runs, ambiguous `--live`+`--fixture` invocations,
unknown tasks, or a `k` that differs from the committed baseline. Review the
resulting `evals/baseline.json` diff before committing it.
Concurrent refreshes are rejected by a sibling lock rather than silently
overwriting another task's baseline update.

Inspect release-over-release per-track pass rates and token totals with:

```sh
node evals/report.mjs --trend
```

Trend output excludes fixture and legacy unknown-mode summaries by default so
hermetic GREEN/RED proofs cannot masquerade as live reliability history. Use
`--include-fixtures` only when debugging the reporter itself. Each trend point
also carries `k`/`ks`, a track-level `benchmarkFingerprint`, and the observed
`pipelineProtocolFingerprint` set. Compare outcomes only when benchmark fields
match, and require review when protocol identities differ.

Direct-agent runs also produce one chronological series per persona. Each
point retains independent outcome and overall verdicts, completed/k counts,
reported cost/duration/turns, per-trial and scheduled budget caps, resolved
models, effort/runtime state, Claude CLI version, and
benchmark/plugin/prompt/protocol fingerprints.
This prevents Executor and Hephaestus results on the same fixture from being
collapsed into a generic `orchestrator: "agent"` series.

Local run artifacts under `evals/results/` are gitignored so live output cannot
be swept into an automatic WIP commit.

Supported Atlas, Athena, and direct-agent live evals burn real tokens and run
unsupervised. None of these paths is run by CI or this repository's test suite.

## Failed-run candidate feedback loop (HU-17)

Atlas/Athena may explicitly finalize a genuinely terminal task-outcome or
orchestration failure with a minimal categorized marker. At SessionEnd, only
runs linked to that session are inspected (newest 64 maximum). Eligible runs
become local review records under `.ao/eval-candidates/records/`; candidates
contain allowlisted metadata, hashes, sizes, and counts—not prompts, errors,
paths, diffs, evidence text, checkpoint payloads, or provider output.
The collector independently verifies the exact failed pipeline cut and its
single failure event, caps pending/total records at 500/2,000, and gives
SessionEnd one non-waiting queue-lock attempt inside a one-second deadline.

Review the queue with:

```sh
node scripts/eval-candidates.mjs list
node scripts/eval-candidates.mjs show <candidateId>
node scripts/eval-candidates.mjs approve <candidateId>
node scripts/eval-candidates.mjs reject <candidateId>
node scripts/eval-candidates.mjs link <candidateId> <reviewed-task-id>
```

Approval never creates a golden task. A human must separately author and review
the vendored seed, deterministic grader, and reference solution, then `link`
the candidate to that task ID. The CLI has no promote/scaffold, provider,
network, or git mutation path. Infrastructure failures and cancellations are
not candidate-eligible. See
[HU-17-failure-ingestion.md](../docs/plans/harness-upgrade/HU-17-failure-ingestion.md).

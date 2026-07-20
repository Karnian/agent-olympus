# 19-Agent Role Evaluation Plan

**Status:** in progress — 19/19 free contracts pass; first shared live pair passes; Atlas runtime remediation is locally green, with the live smoke still inconclusive after a timeout and an external rate limit

**Scope:** all 19 Agent Olympus agents; deterministic CI contracts plus operator-only live evaluation

## Goal

Measure whether each agent adds role-specific value, not merely whether Claude can complete a task. Keep four verdict axes separate:

1. **Outcome** — the independent task grader passes.
2. **Role contract** — the agent respected its scope, output schema, and tool/edit boundary.
3. **Trajectory** — required orchestration, delegation, or diagnostic steps are evidenced.
4. **Efficiency** — cost, latency, turns, and tool use stay within the declared budget.

A run is release-eligible only when every required axis passes. A good patch cannot hide a missing orchestration pipeline, and a well-formed report cannot hide a failed task.

## July 19, 2026 audit evidence

The provider-free contract track now covers the exact 19-agent inventory. It
validates frontmatter, model/tool declarations, namespace hygiene, read-only
mutation boundaries, and the documented `AO_REVIEW_V1`, `AO_SPEC_V1`, and
`STAGE_VERDICT` examples through the production parsers. All 19 contracts pass.

Nine prompt-only boundary corrections were made where behavior could be proven
from the current caller, parser, or tool surface: Metis, Prometheus, Test
Engineer, Debugger, Architect, Code Reviewer, Explore, Writer, and Ask. These
changes narrow ownership or make an existing executable path explicit; they do
not claim a stochastic performance gain.

The first same-fixture live pair is valid:

| Run | Agent | Outcome / scope | Duration | Reported cost |
|---|---|---|---:|---:|
| `eval-1784407210658-bb80c144` | Executor | PASS / PASS | 15.724 s | $0.0399930 |
| `eval-1784407240944-393e8dd1` | Hephaestus | PASS / PASS | 17.004 s | $0.0457392 |

Both agents fixed the same difficulty-S fixture and touched only the allowed
source file. This `k=1` result shows no Hephaestus advantage on the small task;
it is insufficient to merge or remove either role. The next meaningful
comparison is a shared M/L cross-module fixture at `k=3`. An earlier Executor
call (`eval-1784407122191-a06021a4`, $0.0771096) exposed a grader newline bug;
it is excluded from agent comparison. Total July 19 live spend through this
pair is $0.1628418, including that diagnostic call.

Atlas now has a code-owned, allowlisted phase runtime instead of relying on the
model to imitate pseudo-code from a long prompt. The namespaced skill bootstrap
creates or adopts exactly one run, phase transitions go through a fixed CLI,
and a skill-scoped Stop hook blocks an early successful exit. The detailed
legacy behavior is retained as non-executable reference material while the
control loop stays concise.

Two post-remediation Atlas live smokes both fixed the seeded bug and advanced
the production ledger through `triage → execute → verify → review`. Neither is
a pipeline PASS:

| Run | Functional result | Pipeline cut | Terminal condition | Reported cost |
|---|---|---|---|---:|
| `eval-1784409287157-73beedaa` | PASS | `review` in progress; attempt 1, review round 1 | 120 s process timeout | unavailable |
| `eval-1784409517549-aed214fe` | PASS | `review` in progress; attempt 1, review round 1 | provider `rate_limited` before the 180 s timeout | unavailable |

The first run revealed that generic JavaScript fell through to the five-reviewer
fallback. A deterministic `generic-js-ts` route now selects Code Reviewer only,
and the Atlas smoke timeout is 180 seconds. The second run exercised that
configuration but was cut off by the provider rate limit, so it is recorded as
external/inconclusive rather than a passing baseline or another runtime defect.
Neither interrupted call emitted terminal usage/cost evidence. Each invocation
had a hard `$1` Claude CLI cap; therefore the two-call exposure ceiling is `$2`,
and the July 19 exposure ceiling including the exact direct-agent spend is
`$2.1628418`. A third paid call is deferred until the provider limit resets.
The final local patch also prevents the global WIP Stop hook from committing an
incomplete Atlas tree. The final local hardening also binds review and
final-review approval to code-owned verification generations, the immutable
review base, the authoritative all-passing PRD, and the real clean Git
HEAD/tree/commit. Those interactions are now part of protocol fingerprint
`21d396e6b5ff7c523c5db4b73913a1df6088d1c36a828c97455f5c14a5f04a6f`.
Consequently, the next live smoke starts a new comparable protocol series.

This remains a cooperative, `candidate-asserted` evidence boundary. Reviewer
rosters/result maps, `subagent_completed` events, and verification
`verifiedBy` labels come from the candidate-writable trial tree. The verifier
recomputes routing and checks schema, PRD, generation, review-digest, Git-tree,
phase, and timestamp consistency, but the host does not attest that any named
reviewer or verifier subagent was actually called or authored a record. A
future Atlas pipeline PASS would therefore establish only
protocol/tree/evidence consistency. An overall eval PASS would additionally
require the separately graded task outcome; neither verdict establishes an
individual agent's invocation or performance. Role-performance claims still
require the direct-agent live track (or future host-attested telemetry).

Current disposition across all 19 agents:

| Disposition | Agents | Action |
|---|---|---|
| Runtime P0 | Atlas | Bootstrap/runtime/Stop enforcement implemented and locally verified; retain P0 until a post-rate-limit namespaced live pipeline PASS |
| Deferred runtime P1 | Athena | Apply the proven Atlas pattern only after Atlas smoke passes; preserve native-team recovery semantics |
| Boundary corrected | Metis, Prometheus, Test Engineer, Debugger, Architect, Code Reviewer, Explore, Writer, Ask | Keep corrections and add role-specific live fixtures |
| Live validation first | Designer, Aphrodite | Verify current Preview/browser tool availability and shared UI fixture before changing tools or prompts |
| Keep current prompt | Hermes, Momus, Executor, Hephaestus, Security Reviewer, Themis | Do not change model tier or merge roles without shared-fixture `k=3` evidence |

## July 18, 2026 smoke evidence

Both `fix-failing-test` trials repaired `src/sum.mjs` and passed the public and hidden functional checks. Neither produced a finalized Atlas pipeline, so both overall eval verdicts correctly remained FAIL.

| Run | Invocation state | Functional result | Pipeline result | Claude duration | Reported cost |
|---|---|---|---|---:|---:|
| `eval-1784377149594-8887cf53` | Unqualified `/atlas`; not a valid invocation of the staged plugin skill | PASS | FAIL: active-run pointer remained; required finalized evidence absent | 25.943 s | $0.2190012 |
| `eval-1784377816969-e6fed68c` | Corrected namespaced `/agent-olympus:atlas` | PASS | FAIL: `pipeline.json` and events absent, summary still `running`, active pointer remained | 35.936 s | $0.6484044 |

The first run exposed an invocation bug: `--plugin-dir` loads the plugin but does not make an unqualified `/atlas` resolve to its skill. The harness correction is to invoke plugin skills by namespace. The second run proves the correction reached the skill route, but it does **not** prove Atlas orchestration; the production phase protocol still did not execute/finalize.

These two `k=1` runs are diagnostics, not a baseline. Their route and pipeline-protocol fingerprints differ, and the first route was invalid, so their cost difference must not be interpreted as a performance regression.

The first direct-agent runner smoke is valid:

| Run | Route | Outcome / scope | Provenance / budget | Claude duration | Reported cost |
|---|---|---|---|---:|---:|
| `eval-1784390454482-c73d885e` | `--agent agent-olympus:executor`, hook-free staged plugin | PASS / PASS | complete / PASS under $1 cap | 16.801 s | $0.0799941 |

The run used Claude Code 2.1.214 with `effort=high`, prompt-suggestion messages
disabled, fast mode off, and standard speed. Claude still reported both
`claude-sonnet-5` and a small `claude-haiku-4-5-20251001` auxiliary usage. The
runner does not guess the auxiliary call's cause; it retains the exact resolved
model set and all reported cost. The staged plugin and Executor prompt hashes,
the $1 treatment cap, runtime state, shared fixture fingerprint, and final
protocol fingerprint `ee81b6a36d0c97c6aa4341657f0aa745bd1f1e1355dfe7eebc030f6745bc211d`
are also retained in the per-agent trend point. This is still a `k=1` runner
validation, not evidence that Executor should be kept, removed, or preferred
over Hephaestus.

## Invocation contract

- Plugin skills always use `/<plugin>:<skill>`, for example `/agent-olympus:atlas` and `/agent-olympus:athena`.
- Direct agent trials use `--agent agent-olympus:<name>` and pass the task as a plain prompt, for example:

  ```sh
  claude -p "$PROMPT" \
    --agent agent-olympus:debugger \
    --setting-sources project \
    --plugin-dir "$STAGED_PLUGIN" \
    --max-budget-usd 1 \
    --prompt-suggestions false \
    --effort high \
    --output-format stream-json --verbose
  ```

- Direct-agent staging excludes the root hook tree and sets `DISABLE_AO=1`; this prevents production intent/model-routing hooks from contaminating a persona treatment.
- `solo` remains a plain-prompt safe-mode control. It is not a plugin skill and receives no plugin snapshot.
- Every live trial uses a fresh seed copy. Atlas/Athena and direct-agent routes receive their own appropriate fresh staged-plugin snapshot. The candidate never receives the grader, reference solution, defect manifest, or sibling trial artifacts.

## Three tracks

| Track | Cost | Coverage | Purpose | Gate |
|---|---:|---|---|---|
| **C — free contracts** | $0 | All 19 agents | Parse frontmatter, references, declared models/tools, read-only boundaries, machine-output examples, and namespace hygiene. Run hermetic fixture GREEN/RED proofs. | Required on every PR |
| **D — direct-agent live** | Paid | 17 specialist agents; optional diagnostic persona probes for Atlas/Athena | Invoke exactly one persona with `--agent agent-olympus:<name>` in an isolated workdir. Grade role value without Atlas/Athena routing noise. | Operator/nightly; `k=1` development, `k=3` measured baseline |
| **O — orchestrator live** | Paid, potentially multi-worker | Atlas and Athena skills | Grade end-to-end outcome, routing/delegation, production phase evidence, recovery/finalization, and aggregate efficiency. | Operator-only; blocked until a namespaced `k=1` pipeline smoke passes |

Direct Atlas/Athena persona probes may diagnose whether a defect lives in `agents/*.md` or the corresponding skill, but only the namespaced skill path counts as the product's orchestrator score.

## Standard task and result contract

Add role tasks under the existing `evals/tasks/<task-id>/` contract with:

- `task.json`: role, track, fixture class, prompt, declared model, timeout, required metric IDs, and `k`;
- `seed/`: candidate-visible workdir only;
- `grader.mjs`: deterministic independent grader;
- private grader data: expected fact/defect IDs, mutants, or golden outputs, copied only into the grader snapshot;
- `solution/` and a deliberately insufficient control where a workdir outcome can be expressed.

Reuse the existing staged-plugin, subprocess supervision, isolated grader, atomic result writers, and `orchestrator: "agent"` route. Add the remaining role-static layer without duplicating provider execution:

- `evals/roles/manifest.json` — exact 19-agent inventory, role class, required contracts, overlap group;
- `evals/lib/role-contracts.mjs` — free/static checks;
- `evals/lib/role-score.mjs` — common metric normalization;
- the existing `evals/run.mjs` / `run-suite.mjs` — direct-agent selection and budget enforcement;
- `scripts/test/eval-role-*.test.mjs` — argv, schema, scoring, budget, isolation, and GREEN/RED tests.

Each trial persists the prompt ID, exact redacted argv, terminal stream, worktree diff, grader checks, role-contract checks, trajectory evidence, and usage. Summary records include:

| Category | Required fields |
|---|---|
| Outcome | `outcomePass`, check-level verdicts, `passAtK`, `passHatK` |
| Role quality | required-fact/defect recall, precision, F1, unsupported-claim count, schema validity, scope/edit violations; mutation score where applicable |
| Trajectory | tool calls, read/write boundary violations, required-order checks, delegation/provider counts, pipeline phase/finalization status |
| Efficiency | wall time, TTFT, turns, input/output/cache tokens, reported USD, cost per passing trial |
| Provenance | run/trial IDs, UTC time, source commit and dirty state, staged-plugin hash, agent/skill hashes, fixture/grader/benchmark fingerprint, measurement-protocol fingerprint, model ID/tier, Claude CLI version, permission mode, OS/Node version, `k`, and oracle-isolation mode |

`costPerPass` is null when there is no passing trial. Regression uses `pass^k` (`passHatK`); capability uses `pass@k`. Baseline comparison is decision-eligible only when role, model, `k`, invocation route, benchmark fingerprint, and measurement-protocol fingerprint match.

## Role fixture and grader matrix

`W` denotes a workdir task suitable for the first implementation phase. `R` is a report/output grader. `T` needs trajectory evidence and comes after the direct workdir runner is stable.

| Agent | Live track/type | Seeded fixture | Independent grader |
|---|---|---|---|
| **atlas** | O/T | Small regression first, then a multi-story change needing analyze, plan, execute, verify, and review | Hidden behavior checks plus exact Atlas phase order, bounded counters, delegation evidence, finalized summary, and cleared active pointer |
| **athena** | O/T | Two independent changes plus one integration dependency | Hidden behavior checks plus worker isolation and the Athena `spawn → monitor → integrate` recovery/finalization contract |
| **metis** | D/R | Shared change packet containing affected callers, compatibility risk, unsafe assumption, and unresolved decisions | Expected-fact recall with file evidence, risk/unknown separation, unsupported claims, no edits |
| **prometheus** | D/R | Same packet plus approved analysis, with parallel and sequential work | Exact paths/functions, dependency-valid non-overlapping groups, testable acceptance criteria, complete verification plan |
| **momus** | D/R | Paired plans: one sound and variants with seeded fatal flaws | Defect recall/precision, correct APPROVE/REVISE/REJECT, valid `STAGE_VERDICT`, false-positive rate on sound control |
| **hermes** | D/R | Ambiguous feature, incomplete engineering change, and reverse-spec repository variants | `AO_SPEC_V1` schema, required goals/non-goals/constraints/stories, evidence fidelity, no fabricated facts |
| **executor** | D/W | Bounded one-file implementation with tempting unrelated cleanup | Hidden tests, exact requested behavior, diff allowlist, no unrelated edits, test evidence |
| **hephaestus** | D/W | Cross-module refactor with a behavioral invariant and misleading local shortcut | Hidden tests, architecture invariant, complete call-site migration, scope and regression checks |
| **debugger** | D/W+T | Reproducible failure whose visible symptom is downstream of the seeded root cause | Minimal root-cause fix, regression test, hidden tests; later require reproduce-before-edit and evidence-backed hypothesis order |
| **test-engineer** | D/W | Correct implementation with shallow happy-path tests and private mutants | Candidate tests pass the solution and kill required mutants, cover boundaries/errors, remain deterministic, production diff forbidden |
| **designer** | D/W | Small component with seeded responsive, semantic, focus, and token defects | DOM/CSS/a11y assertions and screenshot thresholds; no unrelated business-logic edits |
| **aphrodite** | D/R | Same UI with a private issue manifest and harmless decoys | Usability/a11y/design issue recall and precision, evidence/location quality, severity calibration, zero edits |
| **architect** | D/R | Shared patch with boundary leakage, dependency-cycle risk, and safe decoys | Architecture-defect recall/precision, blast-radius evidence, actionable minimum remediation, zero edits |
| **security-reviewer** | D/R | Shared patch with exploitable trust-boundary flaws and dangerous-looking non-vulnerabilities | Exploit-path recall/precision, preconditions/impact/evidence, severity calibration, no invented CVEs, zero edits |
| **code-reviewer** | D/R | Shared patch with logic defects, maintainability issues, and decoys | Defect recall/precision, severity/location accuracy, actionable recommendation, zero edits |
| **explore** | D/R | Unfamiliar repository with answerable path, symbol, and call-flow questions | Exact fact/path recall, citation validity, unsupported claims, latency, zero edits |
| **writer** | D/W | Stale README/API guide whose commands and names disagree with the seed | Link/path checks, executable examples, required facts, style lint, documentation-only diff |
| **ask** | D/T | Injected fake Codex/Gemini adapter returning a canonical answer and failure variants | Correct provider selection, prompt fidelity, result/error relay, artifact handling, no repository edits; real-provider leg is optional and separately budgeted |
| **themis** | D/W+T | Repository instructions declaring a passing check, a real failure, a blocked check, and a mutating trap | Exact safe commands and cwd/exit evidence, correct PASS/FAIL/CONDITIONAL, blocked-vs-passed distinction, no worktree mutation |

## Overlap ablations

Run ablations only after each underlying fixture has hermetic GREEN/RED proof and each direct role has at least one valid live trial. Use the same fixture fingerprint and grader IDs for every arm; at `k=1`, results are descriptive only.

| Overlap group | Arms on the shared fixture | Decision signal |
|---|---|---|
| **Metis / Hermes / Prometheus** | Each alone; `Metis → Prometheus`; `Hermes → Prometheus`; full `Metis → Hermes → Prometheus`; plain-model control | Marginal required-fact and plan-completeness gain, boundary leakage/duplication, dollars and seconds per unique accepted item |
| **Executor / Hephaestus** | Both agents on the same bounded S task and exploratory L task; plain-model control | Success/scope/cost crossover. Keep separate routing only if one has repeatable advantage in its intended complexity band |
| **Code / Architect / Security reviewers** | Each alone, code reviewer alone as the base arm, and union of all three | Unique true-positive recall, overlap/Jaccard, false positives, severity calibration, and marginal dollars per unique valid finding |
| **Designer / Aphrodite** | Designer only; Aphrodite critique only; `Aphrodite → Designer`; `Designer → Aphrodite → Designer` | Hidden UI/a11y/visual score improvement attributable to critique/remediation, regressions introduced, and incremental cost |

Do not remove or merge a role because another role can occasionally answer the same prompt. Require `k=3` repeatability and either no unique value or strictly dominated outcome/precision/cost on the shared ablation fixture.

## Delivery phases

### Phase 0 — free contracts for all 19

1. Create the explicit role manifest and fail on a missing, duplicate, or unexpected agent.
2. Validate frontmatter and tool/model declarations. Enforce no Edit/Write/Bash mutation surface for declared read-only reviewers; Themis may execute Bash but its contract forbids mutations.
3. Parse every machine-output example with the production parser where one exists, and validate all internal agent/skill references use `agent-olympus:` names.
4. Add hermetic RED tests for each enforcement rule. This phase runs in normal CI and spends no provider tokens.

### Phase 1 — direct-agent workdir runner first

Implement the isolated `--agent agent-olympus:<name>` path and four deterministic first-tranche tasks. The runner and the first shared-fixture pair are now present:

1. `role-executor-scope` — implemented
2. `role-hephaestus-scope` — implemented as the paired ablation arm
3. `debugger/root-cause-fix`
4. `test-engineer/mutant-kill`
5. `themis/quality-gate`

These fixtures exercise mutation, diagnosis, test quality, and no-edit command execution without subjective judges. Start at `k=1`; require complete artifacts and independent grader output, not a one-shot PASS, before treating the runner as validated. Then add Designer and Writer workdir fixtures.

### Phase 2 — output and trajectory graders

Add Explore; Metis/Hermes/Prometheus/Momus; Code/Architect/Security reviewers; Aphrodite; and Ask. Use private fact/defect IDs and machine schemas. Add debugger/Themis command-order evidence only after the output capture and process-event format are stable.

### Phase 3 — namespaced orchestrators

1. Re-run Atlas `fix-failing-test` with `/agent-olympus:atlas`, `k=1`, after the provider rate limit resets.
2. Do not expand the Atlas suite until outcome **and** production pipeline evidence pass in the same trial.
3. Add one medium Atlas task, then one Athena parallel/integration task.
4. Move to `k=3` only after the relevant `k=1` protocol smoke passes and the operator approves the printed budget.

### Phase 4 — overlap ablations and baselines

Run the four shared-fixture ablations at `k=3`, establish measured live baselines, and publish per-role trend reports. Keep capability tasks report-only until their graders and score distributions are calibrated.

## Cost and execution gates

- No live call is implicit. Every live run requires `--live` plus a task-declared or explicit per-trial budget. A live suite additionally requires explicit `--track`, `--k`, `--max-budget-usd`, and `--max-total-budget-usd`; it rejects an underfunded aggregate cap before spawning.
- Phase 1 first tranche defaults to `k=1`, 120 seconds per trial, **$1 reported-cost ceiling per trial and $4 aggregate ceiling**. A completed over-cap trial keeps its outcome but fails the efficiency axis and stops scheduling further trials.
- Atlas regression treatments pin `modelTier: opus` to match the Atlas skill, use 180 seconds, and retain a $1 aggregate ceiling. The original Sonnet metadata and 120-second ceiling were retired after the code-owned pipeline selected Opus, reached review with a green task, and timed out before finalization. Athena and any multi-worker task require a separate explicit budget; initial default ceiling is $5 and 600 seconds.
- The provider reports cost only during/after a call, so the harness passes Claude its per-call cap, verifies reported cost between trials/tasks, and uses the process timeout inside a trial. Missing cost evidence fails closed and stops later scheduling. The harness must never claim it can stop an in-flight call at an exact dollar value.
- `k=3`, real Codex/Gemini calls, capability suites, and ablations each require a separate opt-in. The fake-adapter Ask task is the default.
- After five valid trials for a task class, replace provisional ceilings only through a reviewed change using observed p95 cost/latency. Record budget breaches separately from functional failures.

## Interpretation rules

1. **No blended success:** report outcome, role contract, trajectory, and efficiency separately. For Atlas/Athena, outcome PASS plus pipeline FAIL is an orchestrator FAIL.
2. **Route validity first:** an unnamespaced skill call is `invalid-invocation`, not evidence about that skill. A direct-agent result is evidence only for the exact `--agent agent-olympus:<name>` route.
3. **`k=1` is diagnostic:** do not rewrite prompts, remove agents, or refresh a baseline from one stochastic trial. Use `k=3` for regression decisions.
4. **Comparable provenance only:** a model, prompt, agent/skill hash, benchmark, grader, permission mode, invocation, or protocol change opens a new series unless an explicit bridge run is performed.
5. **Independent grading:** self-reported tests, reviews, or pipeline claims are evidence inputs, never the outcome oracle. Missing required evidence is FAIL or BLOCKED, never inferred PASS.
6. **Read-only means no edits:** any worktree mutation by Aphrodite, Architect, Code Reviewer, Security Reviewer, Explore, or a read-only Ask/Themis scenario is a hard role-contract failure even if the report is good.
7. **Shared-fixture comparisons only:** raw scores from different role rubrics are not rankings. Compare overlap only through the registered ablation arms and defect/fact IDs.
8. **Efficiency is conditional on quality:** lower cost or latency is an improvement only when required outcome and precision/recall floors are preserved.

## Completion criteria

- All 19 agents pass the free contract track.
- Every specialist has at least one isolated direct-agent task with an independent grader and complete provenance.
- Atlas and Athena each have a namespaced live trial where functional outcome and their exact production pipeline contract pass together.
- The four overlap groups have `k=3` shared-fixture ablation results.
- No measured baseline is created from an invalid invocation, missing trajectory, incomparable fingerprint, or `k=1` run.

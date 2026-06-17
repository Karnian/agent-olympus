# Harness Upgrade Roadmap

> Forward-looking advancement plan for Agent Olympus, produced by a 3-axis
> harness-engineering review on **2026-06-16** (baseline: `main` @ v1.1.6 +
> `feat/adapter-worker-supervisor` @ v1.2.0).

## Provenance (how this was produced)

| Axis | Method | Output |
|------|--------|--------|
| Trend gap-analysis | 21-agent workflow: web research → adversarial verification → per-dimension gap, with cited primary sources | 7-dimension verdicts + backlog |
| External cross-review | Gemini 2.x independent review (read CLAUDE.md + select `scripts/lib`) | 7-dimension verdicts + backlog |
| Code verification | Direct grep/read of this repo | every P0–P1 claim below confirmed against source |
| Codex (gpt-5.5) | First pass hit the account limit; **constrained cross-review delivered 2026-06-17** (49k tokens, reasoning=high) critiquing this roadmap | resolved the split verdicts (3/5/7) + the reprioritization below |

**Code-verified facts** (not hallucinated — checked on `main`):
- `hooks/hooks.json` registers 9 events; **no `PreCompact`**.
- **0 of 19** `agents/*.md` declare `tools`/`disallowedTools` — read-only intent is prose only.
- `scripts/subagent-stop.mjs:49` → `lastMessage.slice(0, 4000)` (raw byte truncation, not distillation).
- `evals/` directory **absent**; 0 OpenTelemetry refs in `scripts/lib`; 0 `pass@k` refs.
- `scripts/lib/model-usage.mjs` records `inputCharLength`/`outputCharLength` — **character proxies, not real tokens** (per its own header comment).
- **Version hygiene is NOT a defect** (see HU-07): `main` is internally consistent at 1.1.6, the feature branch at 1.2.0. The reviewer's "drift" finding was a cross-branch artifact.

## Validity verdict (per dimension)

| # | Dimension | Web | Gemini | Codex | Net (majority) | One-line |
|---|-----------|:--:|:--:|:--:|:--:|----------|
| 1 | Context engineering | on-par | on-par | on-par | 🟡 on-par | strong JIT retrieval + structured notes; **passive on compaction** |
| 2 | Memory / learning | behind | behind | behind | 🟠 behind | flat JSONL + lexical Jaccard; no consolidation/supersession/semantic |
| 3 | Orchestration & control | behind | ahead | **behind** | 🟠 behind | Codex broke the tie → prose phases + snapshot, no deterministic/durable engine |
| 4 | Claude Code native | on-par | on-par | on-par | 🟡 on-par | excellent hook usage; hand-rolls primitives the SDK now ships |
| 5 | Multi-model / coding tools | on-par | ahead | **on-par** | 🟡 on-par | "well-made multi-provider wrapper" — no best-of-N/selection/cloud/conformance |
| 6 | **Eval / observability** | behind | missing | behind | 🔴 worst gap | **zero** measurement of orchestration quality (unanimous) |
| 7 | Reliability & safety | on-par | ahead | **behind** | 🟠 behind | Codex most critical → no injection defense / unsandboxed workers / no idempotency |

> **3-model resolution:** Codex sided against Gemini on all three contested dimensions (3, 5, 7), tilting each to the more-critical verdict. Gemini's three "ahead" calls are outvoted 2:1 — **no dimension is "ahead" by majority; the strongest are on-par.** Olympus's implementation is genuinely strong, but it does not lead the frontier on any dimension.

### Synthesis thesis — *"ahead on craft, behind on paradigm"*

Every disagreement (3, 5, 7) shares one shape: **Gemini scores implementation
sophistication** (supervisor, adapters, permission union are genuinely best-in-class
→ *ahead*) while **the web-grounded axis scores adoption of 2026 frontier paradigms**
(durable execution, eval harnesses, injection defense, best-of-N → *behind*). Both
are correct. Olympus is frontier-grade at *implementing its chosen primitives* and
lagging at *adopting newer paradigms*. The upgrade direction follows directly: not
"build it better" but **"import the new paradigms, and cede to native what the
platform has absorbed."**

> Codex endorsed this thesis as the roadmap's strongest call — with one calibration:
> "craft" should read as *strong implementation*, **not** a frontier lead. Per the
> 3-model majority, no dimension is "ahead"; the supervisor/adapters/permission union
> are best-in-class *implementations of on-par/behind paradigms*.

## Prioritized backlog

Legend — 🔵 both reviewers · 🟣 Gemini · 🟢 web-verified · ⬇️ native-obsolescence risk (custom code the platform may replace)

### 🔴 P0 — foundational (trust under autonomy)

| ID | Item | Effort | Evidence / rationale |
|----|------|:--:|------|
| **HU-01** 🔵 | **Agent eval + CI regression harness** (`evals/`) — see [eval-harness-spec.md](eval-harness-spec.md) | L | `evals/` absent; 79 tests are plumbing-only. A one-line prompt/agent edit can degrade orchestration quality **undetectably**. Anthropic two-track (capability + regression) model. |
| **HU-02** 🔵🟢 | **Autonomous-worker safety gate** — (a) lethal-trifecta / Agents-Rule-of-Two gate before worker spawn; (b) promote per-agent read-only intent to SDK-enforced `disallowedTools` | M (b=S) | No live prompt-injection defense for external-model workers; `disallowedTools` is **0/19**. Read-only/review agents to constrain: **explore, architect, code-reviewer, security-reviewer, aphrodite** (⚠️ Codex: **NOT `debugger`** — its role includes *fixing*; disallowing Edit/Write would break it). |

> **⚠️ Codex re-sequencing (adopted) — close the measured boundary before building the measuring device.**
> A prose-defined orchestrator cannot be reliably eval'd: `claude -p "/atlas …"` measures
> "how well Claude followed that prose today," not the Olympus state machine. So the P0 bundle
> is too big; split it and pull the cheap safety win forward:
> - **P0a** = HU-02b reduced: enforce `disallowedTools` on read-only/review agents + a schema linter (cheap, immediate).
> - **P0b** = HU-01 **MVP only**: Atlas-only, 3 regression tasks, `k=1`, manual run. (pass^k / CI gate / baseline trend are **not** P0.)
> - **P0c** = HU-02a reduced: lethal-trifecta gate + env denylist on external-content / external-model worker spawn.
> - **HU-06 is the eval prerequisite, promote toward P1-first:** code-ify a minimal Atlas/Athena phase entrypoint so HU-01 reproduces real orchestration, not prose-following.

### 🟠 P1 — short-term (measure · durability · memory)

| ID | Item | Effort | Evidence / rationale |
|----|------|:--:|------|
| **HU-03** 🟢⬇️ | Real token-usage telemetry — replace char-length proxy + 4000/2000 constant with adapter `usage` events | M | `model-usage.mjs` logs chars; `cost-estimate.mjs` is a flat guess. Adapters already receive real usage. Foundation for cost caps + eval cost. |
| **HU-04** 🟢 | `PreCompact` hook — flush durable state + re-assert a survival summary at the compaction boundary | M | Compaction is a named top-3 context technique; Olympus is the only place fully passive. wisdom/checkpoint/prd state can be silently dropped. |
| **HU-05** 🔵 | Memory consolidation + supersession — sleep-time merge pass + `supersededBy` + freshness penalty | M / S | `pruneWisdom` only does TTL+FIFO+Jaccard-dedup; corrected facts never demote stale ones (the "change-as-replacement" staleness problem). |
| **HU-06** 🟢⬇️ | Deterministic `pipeline mode` + idempotent durable resume — code-defined phase runner + per-stage completion records | L | Orchestration is prose phases; caps (15-iter, 3-review) are advisory. checkpoints are snapshots, not replay-to-completion with exactly-once. |
| **HU-07** 🟢 | ~~Manifest version hygiene~~ — **VERIFIED NON-ISSUE** | — | `main`=1.1.6 and feature=1.2.0 are each internally consistent. Do **not** bump `main`'s manifests (would create real drift: version without supervisor code). Real action = merge `feat/adapter-worker-supervisor` → `main`. |

### 🟡 P2 — frontier alignment

| ID | Item | Effort | Native risk |
|----|------|:--:|:--:|
| **HU-08** 🔵 | Adopt native memory tool + context-editing (`context-management-2025-06-27`) behind a capability flag (Anthropic: +39% eval / −84% tokens) | L | ⬇️ |
| **HU-09** 🟢 | Emit OpenTelemetry GenAI spans alongside `events.jsonl` (export to Langfuse/Braintrust/LangSmith) | L | ⬇️ |
| **HU-10** 🟢 | best-of-N generate-and-select across N models in parallel worktrees (promote cross-validation from verify-only) | M | — |
| **HU-11** 🟢 | Sandbox detached workers + strip env credentials (native `/sandbox` + `@anthropic-ai/sandbox-runtime`) | L | ⬇️ |
| **HU-12** 🟢 | Distilled sub-agent return contract (1–2K-token summary) replacing the 4000-char raw slice | S | — |
| **HU-13** 🟢 | Calibrated LLM-judge for Themis/cross-val — human gold set + isolated-per-rubric + `Unknown` escape | M | — |

### 🟢 P3 — strategic / optional

| ID | Item | Effort | Native risk |
|----|------|:--:|:--:|
| **HU-14** | Per-subagent memory scoping (align with native per-subagent `MEMORY.md`) | M | ⬇️ |
| **HU-15** | "Delegate and close the laptop" via native `RemoteTrigger`/`CronCreate` (thin skill vs custom fleet) | S | ⬇️ |
| **HU-16** | Semantic/structured wisdom retrieval pilot (local embed index) — respect zero-dep constraint, keep optional | L | — |
| **HU-17** | Hierarchical `AGENTS.md` deeper-file-wins semantics + eval-to-guardrail loop (failed runs → golden tasks) | S/M | — |

### ➕ Codex-added items (2026-06-17 cross-review)

| ID | Item | Priority | Rationale |
|----|------|:--:|------|
| **HU-18** | Agent-definition **contract linter** in CI — frontmatter schema + role→`allowedTools`/`disallowedTools` matrix + read-only-agent enforcement | P0/P1 | Makes HU-02b durable: stops a future agent edit from silently re-opening the read-only hole. Pairs with HU-02b. |
| **HU-19** | **Adapter conformance suite** — per-provider parity tests: usage events, cancellation, timeout, sandbox mode, env scrubbing, error schema | P1 | The 3 adapters (codex/claude/gemini) are not tested for behavioral parity; divergence is invisible today. |
| **HU-20** | **Threat-model doc** — trust boundaries for untrusted web/docs, model output, worker filesystem, env secrets, git ops | P1 | Should precede HU-02a — you can't gate injection without naming the boundaries. |
| **HU-21** | **Autonomous budget / kill-switch** — enforce time / token / spend / iteration caps as user-visible policy | P1 | Caps today are advisory prose; an enforced policy is table-stakes for unattended runs. |
| **HU-17→P1** | Promote **eval-to-guardrail loop** from P3 to **P1** | P1 | 3 human-authored fixtures rot fast; routing failed prod runs into the golden set is what keeps the suite alive. |

## Native-obsolescence map (⬇️ strategy)

> ⚠️ **Codex caveat:** the native equivalents below are asserted from platform **docs**
> (training + web), **not verified against this repo or the installed CLI version**. Treat
> them as *capability-flag experiments to validate*, not settled roadmap foundations.

| Custom mechanism | Native equivalent (2026) | Recommended stance |
|------------------|--------------------------|--------------------|
| `memory.mjs` / `wisdom.jsonl` | memory tool + context-editing beta | **Adopt** native plumbing; keep AO relevance-scoring as the *curation* layer |
| `checkpoint.mjs` | native `/rewind` | **Delegate** conversation/code rewind; re-position Stop-hook WIP for the bash side-effects `/rewind` misses |
| `model-router.mjs` / `model-routing.jsonc` | SDK-enforced per-agent `model` | **Drop** Claude-only routing; keep the Codex/Gemini multi-model layer (its real value) |
| `host-sandbox-detect.mjs` | `/sandbox` + `@anthropic-ai/sandbox-runtime` | **Use native** as the execution backend |
| persona prose tool limits | `AgentDefinition.disallowedTools` | **Adopt now** (HU-02b, cheap) |
| `permission-detect.mjs` | (future) native subagent permission propagation | **Monitor** — highest-complexity module, shrink candidate |
| worker adapters | MCP / native external-model support | **Monitor** — still the core differentiator today |

## Biggest single risk & opportunity

**🔴 Risk — "heuristic surface growing under un-measured autonomy."**
Increasingly autonomous multi-model workers run with **no eval to detect quality
regression** (HU-01) and **no injection defense** (HU-02), while a large hand-rolled
heuristic surface (wisdom/intent/permission = thousands of lines of regex + rules,
independently flagged by Gemini as *"Heuristic Overload"*) is being absorbed by the
platform. The compounding danger: maintenance cost rises while the ability to verify
the system still works does not.

**🟢 Opportunity — "Durable Background Orchestrator" as the product identity.**
The v1.2.0 detached supervisor is the **one asset both reviewers call genuinely
ahead**. Leaning into "an orchestrator that survives the session and runs in the
background" — backed by durable-execution idempotency (HU-06) and eval (HU-01) to
make autonomy *trustworthy* — is the path from "a plugin" to "an agent runtime."

## Confidence guide (where the reviewers disagree)

| Dimension | Reconciliation |
|-----------|----------------|
| Orchestration (3) | Ahead on the supervisor *mechanism*; behind on durable-execution *semantics* + deterministic control. |
| Multi-model (5) | Ahead on adapter *engineering*; on-par/behind on best-of-N + the background-cloud category. |
| Reliability (7) | Ahead on permission *detection*; behind on injection defense + worker sandboxing + idempotency. |

High-confidence (both axes agree): **Eval/observability is the #1 gap**, **Memory is behind**, **Context & Native are on-par**.

## Sources (verified, primary)

- Anthropic — [effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [long-running agent harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [demystifying evals](https://anthropic.com/engineering/demystifying-evals-for-ai-agents) · [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [building effective agents](https://www.anthropic.com/research/building-effective-agents)
- Counterpoints — [Cognition: don't build multi-agents](https://cognition.ai/blog/dont-build-multi-agents) · [Diagrid: checkpoints ≠ durable execution](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows)
- Memory — [Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute) · [Mem0 state of agent memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026) · [LangMem](https://www.langchain.com/blog/langmem-sdk-launch)
- Observability/eval — [OTel GenAI agent spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) · [Langfuse LLM-as-judge tracing](https://langfuse.com/changelog/2025-10-16-llm-as-a-judge-execution-tracing) · [Galileo CI for AI](https://galileo.ai/blog/continuous-integration-ci-ai-fundamentals)
- Native surface — [Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents) · [sandboxing](https://code.claude.com/docs/en/sandboxing) · [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

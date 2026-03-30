# Agent Olympus

**Language / 언어:** [English](README.md) | [한국어](README.ko.md)

> Self-driving AI orchestrator plugin for Claude Code — zero dependencies, maximum autonomy.

Agent Olympus is a standalone Claude Code plugin that transforms how you build software. Give it a task, and it orchestrates specialized AI agents to complete it autonomously — analyzing requirements, planning execution, implementing changes, verifying results, and fixing issues until everything passes.

Two orchestrators, 18 specialized agents, 24 workflow skills. Zero npm dependencies.

## What It Does

Agent Olympus solves the **supervision problem**: you shouldn't have to babysit AI. Instead, you describe the goal and the orchestrator handles the complexity — planning, routing work to specialized agents, integrating results, catching failures, and looping until the task is truly complete.

Two distinct modes:

- **Atlas** — Hub-and-spoke orchestration. One orchestrator brain analyzes the task, creates a plan, spawns specialized agents in parallel, verifies results, and fixes issues autonomously. Best for independent, parallelizable work.
- **Athena** — Peer-to-peer team orchestration. Multiple agents collaborate with each other via native SendMessage and Codex workers via tmux. Best for interdependent tasks requiring real-time coordination.

Both loop until every acceptance criterion is met, the build passes, tests pass, and code review is approved — or escalate with evidence if something is unfixable.

## Features

- **Two orchestrators**: Atlas (hub-and-spoke) and Athena (peer-to-peer team)
- **18 specialized agents**: Explorer, Metis (analysis), Prometheus (planning), Momus (validation), Hermes (spec), Executor, Designer (UI/UX), **Aphrodite (design review)**, Test Engineer, Debugger, Architect, Security Reviewer, Code Reviewer, Writer (docs), Hephaestus (deep coding), Themis (quality gate), Atlas, Athena
- **24 workflow skills**: atlas, athena, ask, deep-interview, research, trace, cancel, slop-cleaner, git-master, deepinit, deep-dive, consensus-plan, external-context, verify-coverage, plan, tdd, systematic-debug, brainstorm, finish-branch, **design-critique, a11y-audit, design-system-audit, ux-copy-review, ui-review**
- **Session recovery**: Checkpoint system survives interruptions; resume from any phase
- **Structured wisdom**: Cross-session learnings in JSONL format; persists across runs; intent-aware query expansion
- **Zero npm dependencies**: Node.js built-ins only
- **Multi-model support**: Claude (Opus/Sonnet/Haiku) + Codex/Gemini via tmux
- **Multilingual intent detection**: English, Korean, Japanese, Chinese aliases for all skills
- **Worker Status Dashboard**: Real-time inline markdown display of all active worker states during Athena team runs
- **Athena worktree isolation**: Each parallel worker runs in an isolated git worktree, preventing silent file overwrites between concurrent workers
- **SessionStart hook**: Automatically injects prior wisdom and interrupted checkpoint context at session start
- **Stop hook WIP commit**: Auto-saves uncommitted work as a WIP commit on session end
- **Atomic writes**: All state files use tmp+rename pattern for crash-safe writes
- **Superpowers methodology**: TDD discipline, systematic debugging, brainstorm-first gate, two-stage code review — embedded as native skills (standalone; no Superpowers install required)
- **Post-code automation** *(v0.8)*: After commit — auto-create PR, parse issue refs, watch CI, auto-fix failures, update CHANGELOG
- **Ship policy config** *(v0.8)*: `.ao/autonomy.json` controls `autoPush`, `draftPR`, `ci.maxCycles`, `notify.*`, `costAwareness`
- **OS notifications** *(v0.8)*: Desktop notifications on task complete/blocked/CI events — macOS, Linux, terminal bell fallback
- **Cost awareness** *(v0.8)*: Token cost estimate before long runs; configurable per orchestrator
- **Auto-onboarding** *(v0.8)*: Runs `deepinit` automatically if no `AGENTS.md` found
- **Visual verification** *(v0.8)*: Optional Claude Preview MCP screenshot after UI changes
- **UI/UX design review** *(v0.8.3)*: Aphrodite agent + 5 design skills — critique (Nielsen+Gestalt), a11y audit (WCAG 2.2 AA), design system audit (token leaks), UX copy review, unified UI review
- **372+ unit tests**: Comprehensive test suite using `node:test` across 25 test files
- **Fail-safe architecture**: Hooks never block Claude Code; graceful degradation on errors

## Installation

### Via Marketplace (Recommended)

1. Open Claude Code
2. Go to **Marketplace** → **Productivity**
3. Find **Agent Olympus** by Karnian
4. Click **Install**

### Manual Install

Clone the repository and reference it in your Claude Code plugin directory:

```bash
git clone https://github.com/Karnian/agent-olympus.git ~/.claude/plugins/agent-olympus
```

## Quick Start

### Atlas (Hub-and-Spoke)

Start an autonomous task:

```
/atlas build a user authentication system with login and signup
```

Or use the multilingual aliases:

```
/아틀라스 사용자 로그인 시스템을 구현해줘
/do-it rebuild the payment processing pipeline
```

Atlas will:

1. **Triage** the task (trivial vs. complex)
2. **Analyze** affected files and dependencies
3. **Plan** a structured work breakdown with acceptance criteria
4. **Validate** the plan (catches blocking issues early)
5. **Execute** in parallel using specialized agents
6. **Verify** build, tests, linting
7. **Review** architecture, security, code quality
8. **Loop** on failures — debug and retry until everything passes

### Athena (Peer-to-Peer Team)

Spawn a coordinated team:

```
/athena build an API with frontend, tests, and documentation
```

Athena will:

1. **Design** a team of Claude workers + Codex workers
2. **Plan** task assignments and handoff points
3. **Spawn** workers simultaneously
4. **Monitor** and bridge Claude↔Codex communication
5. **Integrate** results
6. **Verify** and review
7. **Loop** until all workers' outputs are tested and approved

### Resume Interrupted Work

If a session is interrupted:

```
/atlas [previous task]
```

Atlas detects the checkpoint and offers to resume:

```
[Previous session found: Phase 3/EXECUTE. Completed: 2/5 stories.
Resume from Phase 3 or restart?]
```

Reply `resume` to pick up where you left off.

### Post-Code Automation (New in v0.8.0)

After `/atlas` or `/athena` completes and commits, the SHIP phase runs automatically:

1. Reads `.ao/autonomy.json` for ship policy (`autoPush`, `draftPR`, `ci.maxCycles`)
2. Pushes branch and creates PR (with parsed issue refs from branch/commits)
3. Monitors CI via `gh run list` until pass or fail
4. On CI failure: fetches failed logs → spawns debugger → fixes → pushes → re-polls (max 3 cycles)
5. Sends desktop notification on completion or block

Configure by creating `.ao/autonomy.json` in your project:

```json
{
  "autoPush": true,
  "draftPR": false,
  "ci": { "maxCycles": 3, "pollIntervalMs": 10000 },
  "notify": { "onDone": true, "onBlocked": true, "onCIFail": true },
  "costAwareness": true,
  "progressBriefing": true
}
```

### Methodology Skills (New in v0.7.0)

- **`/tdd`** — Test-driven development: write failing test first, then minimum code to pass, then refactor
- **`/brainstorm`** — Design-before-code: diverge (many options) → converge (filter) → refine (approve) before any implementation
- **`/systematic-debug`** — Root-cause-first debugging: reproduce consistently → isolate to component → understand cause → minimal fix → verify
- **`/finish-branch`** — Structured branch completion: tests → lint → coverage → review → present merge options

### Other Skills

- **`/ask`** — Quick single-shot query to Codex or Gemini
- **`/research`** — Parallel web research for external docs and APIs
- **`/deep-interview`** — Socratic clarification for ambiguous requirements
- **`/trace`** — Evidence-driven root-cause analysis when debugger is stuck
- **`/slop-cleaner`** — Clean AI-generated bloat before final commit
- **`/git-master`** — Atomic, well-structured commit discipline
- **`/deepinit`** — Generate codebase map (AGENTS.md) for orientation
- **`/cancel`** — Gracefully stop a running orchestrator and clean up state
- **`/deep-dive`** — Exhaustive single-topic investigation with multi-angle synthesis
- **`/consensus-plan`** — Multi-agent planning consensus (Prometheus + Momus) before execution
- **`/external-context`** — Fetch and inject external documentation or specs into the active context
- **`/verify-coverage`** — Detect test coverage gaps for recently changed files and generate missing tests

### UI/UX Design Review Skills (New in v0.8.3)

- **`/ui-review`** — Comprehensive UI review: chains design-critique + a11y-audit + design-system-audit + ux-copy-review in parallel
- **`/design-critique`** — Structured design feedback using Nielsen 10 heuristics + Gestalt principles + WCAG standards
- **`/a11y-audit`** — WCAG 2.2 AA accessibility audit via code review only — no browser tools needed
- **`/design-system-audit`** — Audit for token leaks (hardcoded colors, spacing), component API consistency, missing states
- **`/ux-copy-review`** — Review error messages, CTAs, empty states, labels for clarity, consistency, and tone

## Orchestrators

### Atlas: Hub-and-Spoke

**When to use:**
- Task has independent, parallelizable components
- You want one orchestrator brain making all routing decisions
- Standard implementation, testing, review workflows

**Architecture:**

```
User Request
    ↓
[Triage] → Trivial? → Execute directly
    ↓ Moderate+
[Analyze] (Metis: deep requirements, risks, unknowns)
    ↓
[Plan] (Prometheus: structured work breakdown)
    ↓
[Validate] (Momus: catches blocking issues)
    ↓
[Execute] (Parallel agents: executor, designer, test-engineer, debugger, etc.)
    ↓
[Verify] (Build + tests + lint)
    ↓ Failures?
[Debug] (Debugger agent fixes issues, loops back)
    ↓
[Review] (Architect + Security + Code Quality reviewers)
    ↓ Rejections?
[Fix & Re-review] (Loops until approved)
    ↓
[Done] (Cleanup, wisdom saved)
```

**Phases:**

1. **Triage** — Classify complexity, decide strategy
2. **Analyze** — Requirements, risks, dependencies
3. **Plan + Validate** — Work breakdown with acceptance criteria
4. **Execute** — Parallel agent work
5. **Verify** — Build, tests, lint
6. **Review** — Architecture, security, code quality
7. **Slop Clean + Commit** — Cleanup and atomic commits

### Athena: Peer-to-Peer Team

**When to use:**
- Task has interdependent parts (API + frontend need coordination)
- Workers need to share discoveries in real-time
- Large-scale work across many files and multiple specialties

**Architecture:**

```
[Athena Lead] ← Orchestrator (NEVER implements, only coordinates)
    ↓
    ├─→ Claude Native Team (SendMessage, TaskList)
    │   ├─ API Worker (executor)
    │   ├─ Frontend Worker (designer)
    │   ├─ Test Worker (test-engineer)
    │   └─ Docs Worker (writer)
    │
    └─→ Codex Workers (via tmux, inbox/outbox)
        ├─ Algorithm Worker
        └─ Refactoring Worker
```

**Phases:**

1. **Triage & Team Design** — Map task into independent scopes
2. **Plan** — Task assignments, dependencies, handoff protocol
3. **Spawn Team** — Launch all workers simultaneously
4. **Monitor & Coordinate** — Bridge communication, unblock workers
5. **Integrate & Verify** — Merge outputs, run build + tests
6. **Review** — All reviewers, fix rejections
7. **Slop Clean + Commit** — Final cleanup and commits

**Key Difference from Atlas:**

| Aspect | Atlas | Athena |
|--------|-------|--------|
| Communication | Hub-and-spoke (lead controls all) | Peer-to-peer (workers talk to each other) |
| Discovery sharing | Lead relays insights | Workers share discoveries directly |
| Best for | Independent tasks | Interdependent tasks |
| Overhead | Lower | Higher but more collaborative |

## Agents (18 Total)

| Agent | Model | Role |
|-------|-------|------|
| **atlas** | Opus 4.6 | Hub-and-spoke orchestrator — triage, analyze, plan, execute, verify, review, loop |
| **athena** | Opus 4.6 | Peer-to-peer team orchestrator — design team, spawn workers, coordinate, bridge, integrate |
| **metis** | Opus | Deep analysis — affected files, hidden requirements, risks, unknowns, recommendations |
| **prometheus** | Opus | Strategic planner — work breakdown, parallelization, acceptance criteria, file ownership |
| **momus** | Opus | Plan validator — catches blocking issues before execution begins (clarity, verification, context) |
| **hermes** | Opus | Product planning specialist — transforms vague ideas into executable specs (forward & reverse PRD) |
| **explore** | Haiku | Fast codebase scanner — architecture, file structure, tech stack, test framework |
| **executor** | Sonnet/Opus | Implementation specialist — handles standard coding tasks, focused execution |
| **designer** | Sonnet | UI/UX implementation specialist — builds accessible, responsive interfaces with design system discipline |
| **aphrodite** | Sonnet | UI/UX design reviewer (read-only) — Nielsen heuristics, Gestalt principles, WCAG 2.2 AA critique |
| **test-engineer** | Sonnet | Test specialist — designs comprehensive test strategies, writes robust tests |
| **debugger** | Sonnet | Root-cause analyzer — systematically diagnoses and fixes bugs |
| **hephaestus** | Sonnet | Deep autonomous coder — exploratory end-to-end multi-file tasks |
| **architect** | Opus | Architecture reviewer (read-only) — structural integrity, module boundaries |
| **security-reviewer** | Sonnet | Security reviewer (read-only) — OWASP Top 10, common vulnerabilities |
| **code-reviewer** | Sonnet | Code quality reviewer (read-only) — standards, patterns, maintainability |
| **themis** | Sonnet | Quality gate enforcer (read-only) — tests, syntax, namespace hygiene; PASS/FAIL/CONDITIONAL verdict |
| **writer** | Haiku | Documentation specialist — clear, accurate technical docs and code comments |

## Skills (24 Total)

| Skill | Level | Aliases | Use Case |
|-------|-------|---------|----------|
| **atlas** | 5 | `atlas`, `아틀라스`, `do-it`, `해줘`, `just-do-it` | Autonomous hub-and-spoke orchestration |
| **athena** | 5 | `athena`, `아테나`, `team-do-it`, `팀으로해`, `collaborate` | Autonomous peer-to-peer team orchestration |
| **plan** | 4 | `plan`, `계획`, `spec`, `기획`, `prd`, `역기획` | Adaptive product planner — forward (idea→spec) and reverse (code→spec) |
| **tdd** | 3 | `tdd`, `test-driven`, `테스트주도개발`, `red-green-refactor` | Test-driven development — RED→GREEN→REFACTOR discipline |
| **brainstorm** | 3 | `brainstorm`, `브레인스토밍`, `design-first`, `설계먼저` | Design-before-code — diverge→converge→refine with approval gate |
| **systematic-debug** | 3 | `systematic-debug`, `체계적디버깅`, `root-cause-debug`, `디버그` | Root-cause-first debugging — reproduce→isolate→understand→fix→verify |
| **finish-branch** | 2 | `finish-branch`, `브랜치완료`, `finish`, `완료` | Structured branch completion with verified checklist before merge |
| **ask** | 2 | `ask`, `물어봐`, `codex`, `gemini`, `quick-ask` | Quick single-shot query to Codex/Gemini |
| **deep-interview** | 4 | `deep-interview`, `인터뷰`, `clarify`, `명확하게` | Socratic requirements clarification |
| **research** | 3 | `research`, `조사`, `외부정보`, `lookup` | Parallel web research for external knowledge |
| **trace** | 3 | `trace`, `추적`, `root-cause`, `원인분석` | Evidence-driven root-cause analysis |
| **slop-cleaner** | 3 | `slop-cleaner`, `deslop`, `슬롭`, `cleanup` | AI bloat removal with regression safety |
| **git-master** | 2 | `git-master`, `commit`, `커밋`, `atomic` | Atomic commit discipline and history |
| **deepinit** | 2 | `deepinit`, `init`, `초기화`, `map-codebase` | Generate AGENTS.md codebase documentation |
| **cancel** | 1 | `cancel`, `취소`, `stop`, `abort` | Graceful session shutdown and cleanup |
| **deep-dive** | 3 | `deep-dive`, `깊게파봐`, `exhaustive` | Exhaustive single-topic investigation with synthesis |
| **consensus-plan** | 4 | `consensus-plan`, `합의`, `consensus` | Multi-agent planning consensus before execution |
| **external-context** | 2 | `external-context`, `외부문서`, `docs`, `inject-docs` | Fetch and inject external docs/specs into context |
| **verify-coverage** | 3 | `verify-coverage`, `coverage`, `커버리지`, `test-gaps` | Detect test coverage gaps for recently changed files |
| **ui-review** | 3 | `ui-review`, `UI리뷰`, `종합UI검토`, `full-design-review` | Comprehensive UI review — chains 4 design review skills |
| **design-critique** | 2 | `design-critique`, `디자인리뷰`, `design-review` | Structured design critique (Nielsen + Gestalt + WCAG) |
| **a11y-audit** | 2 | `a11y-audit`, `접근성검사`, `accessibility-audit` | WCAG 2.2 AA accessibility audit via code review |
| **design-system-audit** | 2 | `design-system-audit`, `디자인시스템검사`, `ds-audit` | Design system health: token leaks, component consistency |
| **ux-copy-review** | 2 | `ux-copy-review`, `카피리뷰`, `copy-review` | UX copy quality: clarity, consistency, tone, inclusivity |

## Architecture

### Directory Structure

```
agents/              Agent persona definitions (.md files with model + role)
skills/              User-facing workflow skills (SKILL.md with triggers, steps)
scripts/             Hook scripts (Node.js ESM, zero dependencies)
  lib/               Shared libraries (stdin, intent, tmux, wisdom, checkpoint)
  run.cjs            Universal hook entry point with version fallback
config/              Model routing configuration (JSONC)
hooks/               Hook event registrations (hooks.json)
.claude-plugin/      Plugin metadata (plugin.json, marketplace.json)
```

### Key Design Principles

1. **Fail-Safe Hooks**: Every hook catches errors and outputs JSON, never throws
2. **State Isolation**: Per-orchestrator checkpoint, transient state files in `.ao/state/`
3. **Wisdom Persistence**: Cross-session learnings in `.ao/wisdom.jsonl` (JSONL format)
4. **Checkpoint Recovery**: 24-hour TTL; resume from any phase after interruption
5. **Zero Dependencies**: Node.js ≥ 20.0 only; no npm packages at runtime

### Session State Management

**Checkpoints** (`.ao/state/checkpoint-<orchestrator>.json`):
- Saved after each phase transition
- Contains: orchestrator, phase, prdSnapshot, completedStories, activeWorkers, taskDescription
- TTL: 24 hours (auto-cleared if stale)
- Purpose: Resume interrupted sessions

**PRD** (`.ao/prd.json`):
- User stories with acceptance criteria
- Story status: `passes: true/false`
- Story assignment: `assignTo`, `model`, `parallelGroup`
- Purpose: Track execution progress against requirements

**Wisdom** (`.ao/wisdom.jsonl`):
- JSONL format (one entry per line)
- Categories: test, build, architecture, pattern, debug, performance, general
- Entries survive across sessions (never auto-delete)
- Automatically pruned to 200 most recent entries after completion
- Purpose: Cross-session learnings reduce friction in future runs

**Teams** (`.ao/teams/<slug>/`) — Athena only:
- Per-worker inbox/outbox directories for Codex communication
- Cleaned up after team completion

## Session Recovery

If Claude Code crashes or closes during an orchestration:

1. Run `/atlas [previous task]` or `/athena [previous task]`
2. Orchestrator detects stale checkpoint (< 24h old)
3. Presents options: **Resume** or **Restart**
   - **Resume** → Skip completed phases, restore story state, continue from where you left off
   - **Restart** → Clear checkpoint, start fresh

This works because checkpoints are saved after each phase transition and store PRD snapshots.

## Wisdom System

Agent Olympus learns from every execution. After each story, agents contribute learnings:

```javascript
addWisdom({
  category: 'pattern',
  lesson: 'Codebase uses snake_case for API response keys',
  confidence: 'high'
})

addWisdom({
  category: 'debug',
  lesson: 'TypeScript strict mode requires explicit return types on async functions',
  confidence: 'high'
})
```

**Categories:**
- `test` — Test framework quirks, patterns that work
- `build` — Build tool behavior, compilation requirements
- `architecture` — Structural decisions, module boundaries
- `pattern` — Codebase conventions, naming, error handling
- `debug` — Pitfalls, root causes, antipatterns
- `performance` — Optimization findings
- `general` — Everything else

**Persistence:**
- Stored in `.ao/wisdom.jsonl` (JSONL format)
- Survives across sessions indefinitely
- Automatically pruned to 200 most recent entries + auto-cleanup of entries older than 90 days
- Never auto-deleted (you choose when to clear)

Later sessions query wisdom to accelerate analysis, avoid repeating mistakes, and leverage codebase knowledge.

## Multi-Model Support

### Claude Models

- **Haiku** — Fast exploratory tasks (codebase scans, documentation)
- **Sonnet** — Standard implementation (most executor, designer, test work)
- **Opus** — Complex reasoning (analysis, planning, architecture, security review)

### Codex / Gemini (via tmux)

For algorithmic work, large refactoring, or exploratory coding, orchestrators spawn Codex workers via tmux:

```bash
tmux new-session -d -s "atlas-codex-<N>" -c "<cwd>"
tmux send-keys -t "atlas-codex-<N>" 'codex exec "<prompt>"' Enter
tmux capture-pane -pt "atlas-codex-<N>" -S -200  # monitor output
tmux kill-session -t "atlas-codex-<N>"            # cleanup
```

Session naming convention:
- Atlas: `atlas-codex-<N>`
- Athena: `athena-<slug>-codex-<N>`

## Requirements

- **Node.js** ≥ 20.0.0 (for ESM support)
- **Optional**: tmux (required for Codex/Gemini integration and Athena team mode)
- **Optional**: codex CLI or equivalent (if invoking Codex directly)
- **npm packages**: None (zero runtime dependencies)

## Project Structure for Contributors

### Adding a New Agent

1. Create `agents/<name>.md` with frontmatter:

```yaml
---
model: sonnet  # haiku | sonnet | opus
description: One-line description
---
```

2. Write the persona prompt below the frontmatter
3. Reference it in skills/SKILL.md as `agent-olympus:<name>`

### Adding a New Skill

1. Create `skills/<name>/SKILL.md` with frontmatter:

```yaml
---
name: <name>
description: One-line description
level: 1-5
aliases: [trigger, words, 한국어도가능]
---
```

2. Write workflow steps
3. Reference agents via `Task(subagent_type="agent-olympus:<agent>", model="<tier>", prompt="...")`

### Adding a New Hook

1. Create `scripts/<hook-name>.mjs` following the fail-safe pattern:

```javascript
import { readStdin } from './lib/stdin.mjs';
async function main() {
  try {
    const raw = await readStdin(3000);
    const data = JSON.parse(raw);
    // ... hook logic ...
    process.stdout.write(JSON.stringify({ /* output */ }));
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}
main();
```

2. Register in `hooks/hooks.json` under the appropriate event
3. Use `run.cjs` as the command wrapper for version-safe resolution

### Syntax Checking

Verify all scripts are valid:

```bash
for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f" && echo "OK: $f"; done
```

Check for stale namespace references:

```bash
grep -r "oh-my-claude:" agents/ skills/ scripts/ config/
grep -r "oh-my-claudecode:" skills/ agents/
grep -r '\.omc/' scripts/ skills/ agents/
```

## Testing Notes

A `node:test` based test suite (372+ tests across 25 files) covers the core hook libraries. To run:

```bash
node --test 'scripts/test/**/*.test.mjs'
# or
npm test
```

Additional integration verification:

1. Syntax check all scripts (see above)
2. Run a trivial `/atlas` task in Claude Code
3. Run an `/athena` task if tmux is available
4. Check `.ao/wisdom.jsonl` is populated after completion
5. Verify checkpoints can be resumed after interruption

## Philosophy

Agent Olympus embodies three core principles:

1. **Autonomy**: You describe the goal; the orchestrator handles the details. No babysitting.
2. **Verification**: Loops until every criterion is met. Failures are fixed, not ignored.
3. **Learning**: Wisdom persists across sessions. Each run makes the next run faster.

The name is deliberate. Atlas carries the world. Athena leads the team. Together, they complete any task you ask.

## Acknowledgements

This project was inspired by and references ideas from:

- [Oh My Claude Code](https://github.com/Yeachan-Heo/oh-my-claudecode) — Multi-agent orchestration plugin for Claude Code
- [Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent) — Batteries-included agent harness with multi-model orchestration
- [Kimoring AI Skills](https://github.com/codefactory-co/kimoring-ai-skills) — SessionStart/Stop hook patterns, coverage gap detection concept
- [Superpowers](https://github.com/obra/superpowers) — TDD discipline, systematic debugging methodology, brainstorm-first gate, verification-before-completion iron law, two-stage code review protocol (v0.7.0)

## License

MIT

## Author

Karnian

## Links

- **Repository**: [https://github.com/Karnian/agent-olympus](https://github.com/Karnian/agent-olympus)
- **Issues**: [https://github.com/Karnian/agent-olympus/issues](https://github.com/Karnian/agent-olympus/issues)

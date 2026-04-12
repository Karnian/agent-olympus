---
name: ui-remediate
description: Sequential frontend remediation chain — audit → normalize → polish → re-audit with convergence verification
---

<UI_Remediate_Skill>

## Purpose

`/ui-remediate` runs a deterministic four-stage pipeline on a frontend target:

1. **audit** — baseline UI-review smell count (via `/ui-review`)
2. **normalize** — replace hardcoded values with design tokens (via `/normalize`)
3. **polish** — final micro-refinements (via `/polish`)
4. **re-audit** — compare final smell count against baseline for convergence

The chain runs **exactly once** — no retry loop. Re-audit is a convergence gate,
not a trigger for another pass. If you want another pass, invoke `/ui-remediate`
again manually.

**NO harden stage** — security hardening is out of scope for v1.0.2. Use
`/a11y-audit`, `/security-reviewer`, or `impeccable:audit` for that concern.

## Use_When

- After receiving a `/ui-review` report and wanting automated fixes applied
- As part of a design-quality gate before `/finish-branch`
- When you want auditable proof that the UI improved (not just changed)

## Do_Not_Use_When

- Target is backend-only code (no UI files)
- You want a single-stage surgical pass → use `/normalize`, `/polish`, `/typeset`, or `/arrange` directly
- You want interactive review without automation

## Dependency Check

This skill depends on US-004 micro-skills. Before running, verify:

```bash
# Confirm skills exist
ls skills/normalize/SKILL.md skills/polish/SKILL.md
```

If either is missing, the chain fails fast with a clear error.

## Workflow

### Step 1 — Validate target

Identify the target file(s) or component directory:

```
Target: <file or directory>
  e.g. src/components/Button.tsx
       src/features/auth/
```

Generate a `runId` for artifact tracking:
```bash
RUN_ID=$(node -e 'const {randomUUID}=require("crypto"); process.stdout.write(Date.now()+"-"+randomUUID().slice(0,8))')
```

### Step 2 — Stage 1: AUDIT (baseline)

Run the ui-review skill and capture the initial smell count:

```
Task(subagent_type="agent-olympus:designer", model="sonnet",
  prompt="UI AUDIT pass on: <target>

  Run a structured smell scan against the target file(s).
  Count and list each violation found.
  Output a JSON block: { smellCount: N, violations: [...], summary: '...' }

  Focus on: LLM defaults (Inter font, pure black, card-nesting, bounce easing, gray-on-color),
  spacing rhythm, token usage, alignment issues.

  Output format: structured JSON then human-readable summary.")
```

Record `initialSmellCount` from the audit output.

### Step 3 — Stage 2: NORMALIZE (design token pass)

Pass audit outbox to normalize:

```
Task(subagent_type="agent-olympus:designer", model="sonnet",
  prompt="NORMALIZE pass on: <target>

  Prior audit found <N> smells. Focus on replacing hardcoded values with tokens.
  Prior audit summary: <audit outbox>

  Replace hardcoded hex/rgb/px/em values with var(--token) references.
  Do NOT change layout, structure, font family, or copy.
  Output: { ok: true, filesTouched: [...], summary: '...' }")
```

If this stage returns `ok: false` → halt chain, record failure.

### Step 4 — Stage 3: POLISH (final refinements)

Pass normalize outbox to polish:

```
Task(subagent_type="agent-olympus:designer", model="sonnet",
  prompt="POLISH pass on: <target>

  Prior stages: audit (<N> smells) + normalize (tokens replaced).
  Prior normalize summary: <normalize outbox>

  Apply final micro-refinements: alignment, spacing rhythm, micro-detail.
  Do NOT introduce structural changes or new copy.
  Output: { ok: true, filesTouched: [...], summary: '...' }")
```

If this stage returns `ok: false` → halt chain, record failure.

### Step 5 — Stage 4: RE-AUDIT (convergence check)

Run a second ui-review and compare smell counts:

```
Task(subagent_type="agent-olympus:designer", model="sonnet",
  prompt="UI RE-AUDIT pass on: <target>

  Initial audit found <N> smells. We ran normalize + polish.
  Count current violations against the same criteria as the initial audit.
  Output a JSON block: { smellCount: N, violations: [...], summary: '...' }

  This is a convergence verification pass.")
```

Compute convergence:

```javascript
const convergence = computeConvergence({ initialSmellCount, finalSmellCount });
// status: 'improved' | 'unchanged' | 'regressed'
```

**Convergence rules:**
- `improved` (finalCount < initialCount) → SUCCESS
- `unchanged` (finalCount === initialCount) → WARN, still continue
- `regressed` (finalCount > initialCount) → ABORT with regression warning

### Step 6 — Write artifact

Use `runChain` from `scripts/lib/ui-remediate.mjs` to coordinate steps 2–5
and write the artifact automatically:

```javascript
import { runChain } from './scripts/lib/ui-remediate.mjs';

const result = await runChain({
  target,
  runId,
  artifactBase: '.ao/artifacts/runs',
  executor: async ({ stage, target, inbox }) => {
    // dispatch to subagent per stage, return { ok, smellCount, summary, filesTouched, outbox }
  },
});
```

Artifact written to: `.ao/artifacts/runs/<runId>/ui-remediation.json`

### Step 7 — Report

```
## UI Remediation: <target>

| Stage | Status | Smells | Summary |
|-------|--------|--------|---------|
| audit | ✅ done | <N> | baseline established |
| normalize | ✅ done | — | <tokens replaced> |
| polish | ✅ done | — | <refinements applied> |
| re-audit | ✅ done | <M> | convergence: improved (Δ-<diff>) |

**Convergence**: improved — smell count reduced from <N> to <M>

Artifact: .ao/artifacts/runs/<runId>/ui-remediation.json
```

If chain halted:
```
## UI Remediation: HALTED at <stage>

Chain halted at stage "<stage>": <error>
Partial results recorded to: .ao/artifacts/runs/<runId>/ui-remediation.json

To continue: fix the issue and re-invoke /ui-remediate.
```

If regression detected:
```
## UI Remediation: REGRESSION DETECTED

⚠️  Re-audit found MORE smells than the initial audit:
  Initial smell count: <N>
  Final smell count:   <M>
  Delta:               +<diff>

This is unexpected. Check the normalize/polish diffs for scope violations.
Artifact: .ao/artifacts/runs/<runId>/ui-remediation.json
```

## finish-branch Integration

When invoked from finish-branch, this skill runs as a blocking step before the
merge gate:

```
Step 2.7 — UI REMEDIATE (optional, if /ui-remediate was invoked):
  Await runChain completion.
  If ok: continue to Step 3
  If halted/regressed: STOP, report to user
```

finish-branch waits for `/ui-remediate` to complete before proceeding.

## Iron Laws

1. **Strict order** — audit → normalize → polish → re-audit. No skipping.
2. **Once only** — runs exactly once. Re-invoke manually for another pass.
3. **No harden** — not in scope for v1.0.2.
4. **Halt on failure** — any stage failure stops the chain.
5. **Abort on regression** — finalCount > initialCount is a failure.
6. **Sequential workers** — never spawns parallel subagents.
7. **Always write artifact** — even on halt or regression.

## Guardrails

| Guard | Behaviour |
|-------|-----------|
| Stage failure | Halt chain, write partial artifact, report error |
| Regression detected | Abort, write artifact with status=regressed, warn user |
| Missing micro-skills | Fail fast with clear error before chain starts |
| Executor throw | Treat as stage failure, halt chain |

</UI_Remediate_Skill>

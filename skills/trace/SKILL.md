---
name: trace
description: Evidence-driven root-cause analysis with competing hypotheses and rebuttal
---

<Trace>

## Purpose

When something fails ambiguously (build broke, test flaky, sub-agent returned unexpected result),
Trace spawns parallel investigation lanes with competing hypotheses, runs a rebuttal round,
and produces a ranked explanation with a discriminating probe.

## Use_When

- User says "trace", "추적", "왜 이러지", "원인 찾아"
- Build/test fails and the cause isn't obvious
- Atlas/Athena's debugger agent failed to fix after 2 attempts
- Need structured investigation, not blind retry

## Steps

### Phase 1 — HYPOTHESIS GENERATION

Analyze the failure and generate 3 competing hypotheses:

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Given this failure, generate exactly 3 competing hypotheses:
  Lane A: Code-path cause (logic bug, wrong function, missing case)
  Lane B: Config/environment cause (wrong env var, missing dep, version mismatch)
  Lane C: Data/state cause (stale cache, race condition, corrupt input)

  For each: state the hypothesis, predict what evidence would confirm/deny it.
  Failure: <error_output>")
```

### Phase 2 — PARALLEL INVESTIGATION

Spawn 3 tracer agents **simultaneously**, one per hypothesis:

```
Lane A: Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Investigate hypothesis: <lane_A_hypothesis>
  Search for evidence that CONFIRMS or DENIES this.
  Read relevant code, check git blame, trace execution path.
  Report: EVIDENCE_FOR: [...], EVIDENCE_AGAINST: [...], CONFIDENCE: 0-100")

Lane B: Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Investigate hypothesis: <lane_B_hypothesis> ...")

Lane C: Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Investigate hypothesis: <lane_C_hypothesis> ...")
```

### Phase 3 — REBUTTAL ROUND

Each lane sees the other lanes' findings and must argue why their hypothesis
is still the best explanation:

```
Task(subagent_type="agent-olympus:momus", model="opus",
  prompt="Given three investigation results:
  Lane A: <findings_A>
  Lane B: <findings_B>
  Lane C: <findings_C>

  Rank hypotheses by evidence strength.
  Identify the DISCRIMINATING PROBE — one test/check that would
  definitively confirm the top hypothesis and rule out the others.

  Output:
  RANKED: 1. <hypothesis> (confidence: X%)
          2. <hypothesis> (confidence: X%)
          3. <hypothesis> (confidence: X%)
  DISCRIMINATING_PROBE: <specific action to confirm #1>")
```

### Phase 4 — EXECUTE PROBE

Run the discriminating probe:
```
Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Execute this specific check: <discriminating_probe>
  Report: confirmed/denied, with evidence.")
```

### Phase 5 — FIX

If root cause confirmed, fix it:
```
Task(subagent_type="agent-olympus:executor", model="sonnet",
  prompt="Fix this root cause: <confirmed_cause>
  Evidence: <probe_result>
  Apply minimal fix, verify build + tests pass.")
```

## Output Format

```
## Trace Report
### Failure: <description>
### Root Cause: <confirmed hypothesis>
### Evidence: <key evidence points>
### Fix Applied: <what was changed>
### Verification: build PASS, tests PASS
```

## Integration

Atlas/Athena escalate to Trace when:
- debugger agent fails to fix after 2 attempts
- Same error appears in different forms across iterations
- Error message is ambiguous or misleading

**Boundary with systematic-debug:**
- Use `systematic-debug` when the bug is known and reproducible (single-bug focus).
- Use `trace` when the failure is ambiguous, involves multiple possible causes,
  or the debugger agent has already failed twice.
- systematic-debug is the first-line tool; trace is the escalation path.

</Trace>

# Systematic Debugging

## User Stories

### US-006: Systematic Debug Skill
**As a** developer debugging a failure, **I want to** invoke /systematic-debug to follow structured investigation protocol, **so that** root causes are identified before any fix is attempted.

**Acceptance Criteria:**
- GIVEN user invokes /systematic-debug WHEN skill starts THEN enters INVESTIGATE phase: reproduces error, collects stack trace, identifies file:line
- GIVEN INVESTIGATE completes WHEN HYPOTHESIZE phase begins THEN generates 3 ranked hypotheses with predicted evidence
- GIVEN hypotheses ranked WHEN PROBE phase begins THEN executes top hypothesis confirmation check, reports confirmed/denied with evidence
- GIVEN root cause confirmed WHEN FIX phase begins THEN applies minimal fix, re-runs failing test, confirms pass
- GIVEN fix passes WHEN VERIFY phase begins THEN runs full test suite, confirms zero regressions
- GIVEN user invokes without error description WHEN skill starts THEN reads last 50 lines of terminal to auto-detect error

### US-007: Systematic Debug Integration in Debugger Agent
**As a** developer, **I want** debugger agent to follow systematic investigation protocol, **so that** it stops trial-and-error and finds root causes first.

**Acceptance Criteria:**
- GIVEN debugger agent receives fix request WHEN it starts THEN persona mandates root-cause-first protocol
- GIVEN debugger invoked by Atlas/Athena Phase 4 WHEN error output provided THEN response includes: confirmed root cause, evidence, minimal fix, full test result
- GIVEN debugger cannot confirm root cause after 3 hypotheses WHEN all denied THEN escalates to trace skill

### US-008: Trace Skill Enhancement -- Systematic Debug Protocol
**As a** developer, **I want** trace skill to use systematic debug methodology in investigation lanes, **so that** each lane follows evidence-based investigation.

**Acceptance Criteria:**
- GIVEN trace Phase 2 spawns lanes WHEN debugger prompted THEN includes systematic debug protocol instruction
- GIVEN trace Phase 3 rebuttal completes WHEN probe identified THEN spec includes exact command, expected output if correct, expected output if wrong
- GIVEN trace Phase 4 probe confirms cause WHEN Phase 5 fix begins THEN fix agent receives full evidence chain

### US-014: Debugger Agent Enrichment -- Mandatory Root-Cause Protocol
**As a** orchestrator, **I want** debugger agent to have explicit ban on trial-and-error, **so that** every debug session produces root-cause analysis before code change.

**Acceptance Criteria:**
- GIVEN agents/debugger.md updated WHEN read THEN contains IRON RULE about confirming root cause before fix
- GIVEN process section updated WHEN read THEN follows 5-step: Reproduce, Hypothesize(3), Probe, Fix, Verify
- GIVEN process section updated WHEN read THEN includes escalation to trace if all 3 hypotheses denied

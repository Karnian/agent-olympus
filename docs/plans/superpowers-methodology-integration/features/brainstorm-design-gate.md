# Brainstorm Design Gate

## User Stories

### US-004: Brainstorm Skill -- Design-Before-Code Gate
**As a** solo AI developer, **I want to** invoke /brainstorm to explore design alternatives before implementation, **so that** complex features have a validated design before any code is written.

**Acceptance Criteria:**
- GIVEN user invokes /brainstorm WHEN skill starts THEN generates 3 distinct design alternatives with pros, cons, effort, risk
- GIVEN 3 alternatives generated WHEN presented THEN highlights trade-offs in comparison table and recommends one
- GIVEN user selects approach WHEN finalized THEN writes design brief to .ao/brainstorm-<slug>.md
- GIVEN user invokes /brainstorm then /atlas or /athena WHEN orchestrator starts THEN detects brainstorm artifact and injects into planning

### US-005: Brainstorm Gate in Atlas/Athena for Complex Tasks
**As a** solo AI developer, **I want** Atlas and Athena to auto-invoke brainstorm for complex/architectural tasks, **so that** the system never jumps to code on hard problems without exploring alternatives.

**Acceptance Criteria:**
- GIVEN Atlas classifies task as complex/architectural WHEN no brainstorm artifact exists THEN invokes brainstorm skill
- GIVEN Athena classifies task as complex/architectural WHEN no brainstorm artifact exists THEN invokes brainstorm skill
- GIVEN brainstorm completes WHEN orchestrator resumes THEN chosen design passed as design_context to planning
- GIVEN task is trivial/moderate WHEN triage completes THEN brainstorm NOT invoked

### US-016: Plan Skill Enhancement -- Brainstorm Integration
**As a** developer using /plan, **I want** plan to invoke brainstorm automatically for L-scale tasks, **so that** large plans have a validated design foundation.

**Acceptance Criteria:**
- GIVEN L-scale detected WHEN no brainstorm artifact exists THEN invokes brainstorm between Phase 0 and Phase 1
- GIVEN brainstorm completes WHEN Phase 1 begins THEN output passed as design_context to Hermes
- GIVEN S or M scale WHEN Phase 0 completes THEN brainstorm NOT invoked

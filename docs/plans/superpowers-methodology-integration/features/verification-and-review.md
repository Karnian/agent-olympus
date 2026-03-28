# Verification and Review

## User Stories

### US-009: Verification-Before-Completion Iron Law
**As a** solo AI developer, **I want** Atlas and Athena to enforce no-done-without-evidence rule, **so that** I never encounter done tasks that are actually broken.

**Acceptance Criteria:**
- GIVEN Atlas Phase 4 VERIFY passes WHEN checkpoint saved THEN includes verificationEvidence with buildLog, testOutput, lintResult
- GIVEN Athena Phase 4 INTEGRATE passes WHEN checkpoint saved THEN includes same verificationEvidence
- GIVEN Phase 5 REVIEW approved WHEN completion report generated THEN includes verificationEvidence block
- GIVEN ambiguous verification output WHEN evaluated THEN treated as FAILED, re-runs with explicit count extraction
- GIVEN story about to be marked passes:true WHEN verification runs THEN requires: test file exists, 0 failures, build exit code 0

### US-010: Finish-Branch Skill -- Pre-Merge Checklist
**As a** developer working on a feature branch, **I want to** invoke /finish-branch to run complete pre-merge checklist, **so that** I never merge with failing tests or incomplete reviews.

**Acceptance Criteria:**
- GIVEN user invokes /finish-branch WHEN skill starts THEN runs: test suite, build, lint, verify-coverage, two-stage review
- GIVEN all 5 checks pass WHEN skill completes THEN outputs summary with GO/NO-GO recommendation
- GIVEN any check fails WHEN detected THEN stops with actionable detail (fail-fast)
- GIVEN user on main branch WHEN detected THEN warns and requires confirmation
- GIVEN GO recommendation confirmed WHEN proceeding THEN offers to create PR

### US-011: Two-Stage Code Review in Atlas/Athena Phase 5
**As a** solo AI developer, **I want** two-stage review: spec compliance first, code quality second, **so that** reviews catch both wrong-feature and bad-code problems.

**Acceptance Criteria:**
- GIVEN Atlas Phase 5 begins WHEN reviewers spawned THEN Stage 1 runs first: spec-compliance check per story
- GIVEN Stage 1 all COMPLIANT WHEN Stage 2 begins THEN existing reviewers run in parallel
- GIVEN Stage 1 finds NON-COMPLIANT WHEN verdict returned THEN executor fixes before Stage 2
- GIVEN Athena Phase 5 begins WHEN same protocol applies THEN behavior matches Atlas

### US-012: Quality-Gate Agent
**As a** orchestrator, **I want** a quality-gate agent that verifies story completion with machine evidence, **so that** verification is consistent.

**Acceptance Criteria:**
- GIVEN agents/quality-gate.md created WHEN receives story and criteria THEN runs each as specific check with PASS/FAIL and evidence
- GIVEN reports FAIL WHEN returned THEN orchestrator knows exactly which criterion failed
- GIVEN unverifiable criterion WHEN detected THEN flags MANUAL_REVIEW_NEEDED, does not block
- GIVEN model tier WHEN frontmatter set THEN model is sonnet

### US-013: Code-Reviewer Agent Enrichment
**As a** orchestrator, **I want** code-reviewer to be aware of spec compliance context, **so that** it distinguishes spec-mismatch from quality issues.

**Acceptance Criteria:**
- GIVEN prompt with specContext WHEN reviewing THEN prioritizes spec-noncompliance as CRITICAL
- GIVEN prompt WITHOUT specContext WHEN reviewing THEN current behavior preserved
- GIVEN checklist updated WHEN read THEN includes Spec alignment item

### US-015: Verify-Coverage Enhancement -- Shallow Coverage Detection
**As a** developer, **I want** verify-coverage to detect shallow coverage, **so that** gaps include insufficient test depth.

**Acceptance Criteria:**
- GIVEN test file exists with <2 cases for file with 3+ exports WHEN mapped THEN flagged SHALLOW COVERAGE
- GIVEN gap report generated WHEN rendered THEN includes Shallow Coverage section
- GIVEN skill completes WHEN summary rendered THEN includes coverage percentage

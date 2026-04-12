---
name: deep-interview
description: Socratic interview to clarify ambiguous requirements before autonomous execution
---

<Deep_Interview>

## Purpose

When a request is vague or ambiguous, Deep Interview conducts a structured Socratic interview
to crystallize requirements BEFORE handing off to Atlas/Athena for execution.
This prevents wasted work from misunderstood requirements.

## Use_When

- User says "deep-interview", "인터뷰", "clarify", "명확하게 해줘"
- Request is vague: "make it better", "fix the UI", "add authentication"
- Multiple valid interpretations exist
- High-risk task where getting requirements wrong is expensive

## Do_Not_Use_When

- Requirements are already crystal clear
- User explicitly says "just do it" (use atlas directly)
- Trivial task with obvious implementation

## Steps

### Phase 1 — AMBIGUITY DETECTION

Analyze the user's request for ambiguity:

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Analyze this request for ambiguity:
  1. List all assumptions you'd need to make
  2. Identify decision points with multiple valid options
  3. Score overall ambiguity 0-100 (0=crystal clear, 100=completely vague)
  4. List the TOP 3 questions that would most reduce ambiguity
  Request: <user_request>")
```

If ambiguity < 20: Skip interview, hand off to Atlas directly.
If ambiguity >= 20: Proceed with interview.

### Phase 2 — SOCRATIC INTERVIEW

Ask questions ONE AT A TIME. Each question should:
- Be specific and answerable
- Offer concrete options where possible
- Build on previous answers

Interview protocol:
1. Ask the MOST important question first
2. Wait for user's answer
3. Based on answer, ask the next most important question
4. Repeat until ambiguity is sufficiently reduced (max 5 questions)
5. After each answer, internally update your understanding

Example questions:
- "Should authentication use JWT tokens or session cookies?"
- "When you say 'fix the UI', do you mean: (a) visual redesign, (b) fix broken functionality, (c) improve responsiveness?"
- "What's the expected scale? Hundreds or millions of users?"

### Phase 3 — REQUIREMENTS SUMMARY

After interview, produce a crystallized requirements document:

```markdown
## Requirements Summary

### Goal
<one sentence>

### Scope
- Files/modules affected: <list>
- Out of scope: <list>

### Decisions Made
1. <question> → <answer> → <implication>
2. ...

### Acceptance Criteria
1. <specific, testable criterion>
2. ...

### Constraints
- <technical constraints>
- <time/resource constraints>
```

Present to user: "Here's what I understood. Should I proceed with Atlas/Athena?"

### Phase 4 — HANDOFF

If user confirms:
- For independent tasks → invoke `/atlas` with crystallized requirements
- For interdependent tasks → invoke `/athena` with crystallized requirements

The handoff includes the full requirements summary as context,
so the orchestrator starts with zero ambiguity.

## Integration_With_Atlas_Athena

Deep Interview is the **pre-processor**. The pipeline is:

```
Vague Request → Deep Interview → Crystallized Requirements → Atlas/Athena → Done
```

Atlas/Athena can also invoke Deep Interview internally if they detect
high ambiguity during their triage phase (ambiguity > 60).

</Deep_Interview>

---
name: research
description: Parallel web research with facet decomposition and synthesis — for external docs, APIs, best practices
level: 3
aliases: [research, 조사, 리서치, lookup]
---

<Research>

## Purpose

When a task requires external knowledge (API docs, library usage, best practices),
Research decomposes the query into independent facets, spawns parallel research agents,
and synthesizes results with citations.

## Use_When

- User says "research", "조사해", "찾아봐"
- Task involves unfamiliar third-party API or library
- Need current best practices or documentation
- Atlas/Athena's metis agent identifies external knowledge gaps

## Steps

### Phase 1 — DECOMPOSE

Break the research question into 2-5 independent facets:

```
Task(subagent_type="agent-olympus:metis", model="sonnet",
  prompt="Decompose this research question into 2-5 independent facets.
  Each facet should be answerable via a single web search.

  Example: 'How to implement OAuth with Next.js?'
  → Facet 1: Next.js App Router authentication patterns
  → Facet 2: OAuth 2.0 PKCE flow implementation
  → Facet 3: next-auth vs lucia vs custom OAuth comparison

  Question: <user_question>")
```

### Phase 2 — PARALLEL RESEARCH

Spawn one researcher per facet **simultaneously**:

```
For each facet:
  Task(subagent_type="agent-olympus:explore", model="sonnet",
    prompt="Research this specific topic:
    <facet>

    Use WebSearch and WebFetch to find:
    1. Official documentation
    2. Current best practices (2025-2026)
    3. Common pitfalls
    4. Code examples

    Report with sources (URLs) for every claim.
    Format: FINDING: <what>, SOURCE: <url>, CONFIDENCE: high/medium/low")
```

### Phase 3 — SYNTHESIZE

Merge all facet results into a unified brief:

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Synthesize these research results into a unified brief:

  <all_facet_results>

  Output:
  ## Summary
  <key findings in 3-5 bullets>

  ## Recommended Approach
  <specific recommendation with reasoning>

  ## Sources
  <cited URLs>

  ## Conflicts
  <any contradictory findings between sources>")
```

### Phase 4 — DELIVER

Present the synthesized brief to the user or feed it into Atlas/Athena's
analyze phase as external context.

## Integration

Atlas invokes Research during Phase 1 (Analyze) when metis identifies
external knowledge gaps. The research brief becomes input for Phase 2 (Plan).

</Research>

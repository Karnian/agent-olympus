---
name: external-context
description: Parallel web research with facet decomposition — enrich task context with external docs and best practices
level: 3
aliases: [external-context, 외부컨텍스트, 외부조사, context-research]
---

<External_Context>

## Purpose

When a task requires external knowledge before implementation begins, External_Context
decomposes the query into independent research facets, spawns parallel explore agents,
and synthesizes a structured brief with citations. The output enriches Atlas/Athena
context or stands alone as a research artifact.

## Use_When

- User says "external-context", "외부컨텍스트", "외부조사", "context-research"
- Task involves an unfamiliar API, library, or protocol where current docs matter
- Atlas Phase 1 (Analyze) or Athena identifies an external knowledge gap
- Best practices or version-specific behavior must be confirmed before planning

## Do_Not_Use_When

- All required knowledge is already in the codebase or AGENTS.md
- Task is trivial and needs no external validation
- Use `agent-olympus:research` instead when the user simply asks to "research" a topic

## Steps

### Phase 1 — DECOMPOSE

Use metis to break the query into 2-5 independent, self-contained facets.
Each facet must be answerable by a single focused web search with no dependency
on any other facet.

```
Task(subagent_type="agent-olympus:metis", model="sonnet",
  prompt="Decompose this query into 2-5 independent research facets.
  Each facet must be answerable via a single focused web search.
  Return a JSON array: [{ 'facet': '<title>', 'searchQuery': '<query string>' }, ...]
  Max 5 facets. Prefer fewer, broader facets over many narrow ones.

  Example query: 'Add OAuth2 to Express API'
  Example output:
  [
    { 'facet': 'OAuth2 PKCE flow', 'searchQuery': 'OAuth2 PKCE authorization code flow 2025' },
    { 'facet': 'Passport.js Express setup', 'searchQuery': 'passport.js express oauth2 setup guide' },
    { 'facet': 'JWT token storage best practices', 'searchQuery': 'JWT storage security best practices 2025' },
    { 'facet': 'OAuth2 security hardening', 'searchQuery': 'OAuth2 API security CSRF PKCE 2025' }
  ]

  Query: <user_query>")
```

### Phase 2 — PARALLEL RESEARCH

Spawn one explore agent per facet **simultaneously**. Do not wait for one to finish
before starting the next.

```
For each facet in decomposition result:
  Task(subagent_type="agent-olympus:explore", model="sonnet",
    prompt="Research this specific facet using WebSearch and WebFetch.

    Facet: <facet.facet>
    Suggested search: <facet.searchQuery>

    Find:
    1. Official documentation or spec (prefer docs over blog posts)
    2. Current best practices (2025-2026)
    3. Common pitfalls or gotchas
    4. Concrete code examples or patterns

    For every claim, record the source URL and your confidence level.

    Return a JSON object:
    {
      'facet': '<facet title>',
      'findings': [
        { 'fact': '<specific finding>', 'source': '<URL>', 'confidence': 0-100 }
      ],
      'codeExamples': ['<short snippet or pattern>'],
      'gotchas': ['<pitfall or warning>'],
      'sources': ['<URL>']
    }")
```

### Phase 3 — SYNTHESIZE

After all explore agents return, merge results into a unified brief.
Resolve contradictions by preferring higher-confidence sources and official docs.

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Synthesize these parallel research results into a structured brief.

  Research results:
  <all_facet_results_as_json>

  Rules:
  - Deduplicate overlapping findings across facets
  - When sources contradict, prefer the higher-confidence official source and note the conflict
  - Keep executive summary to 2-3 sentences
  - Include every source URL that was cited

  Output this exact JSON structure:
  {
    'query': '<original query>',
    'executiveSummary': '<2-3 sentences>',
    'facets': [
      {
        'facet': '<title>',
        'keyFindings': ['<finding>'],
        'codeExamples': ['<snippet>'],
        'gotchas': ['<warning>']
      }
    ],
    'recommendedApproach': '<specific recommendation with reasoning>',
    'conflicts': ['<contradictory findings and resolution>'],
    'sources': ['<URL>']
  }")
```

### Phase 4 — DELIVER

1. Write the synthesized JSON to `.ao/external-context.json`

2. Render a markdown summary for the user or calling agent:

```
## External Context: <query>

### Summary
<executiveSummary>

### Key Findings by Facet
For each facet:
**<facet title>**
- <keyFindings as bullets>
- Gotchas: <gotchas>

### Recommended Approach
<recommendedApproach>

### Conflicts Resolved
<conflicts — omit section if empty>

### Sources
<sources as numbered list with URLs>
```

3. If invoked from Atlas or Athena, return the markdown summary as the task result
   so it flows directly into the calling agent's context.

## Integration

**Standalone** (`/external-context <query>`): runs all four phases and presents
the markdown summary to the user.

**Atlas Phase 1**: metis invokes External_Context when it detects an external
knowledge gap during analysis. The markdown output is injected into the Phase 2
(Plan) prompt as `<external_context>` before prometheus generates the plan.

**Athena**: any team member can invoke External_Context as a blocking subtask;
the result is broadcast to the team inbox before implementation begins.

## Constraints

- Max 5 facets — more than 5 dilutes focus and wastes tokens
- Facets must be independent — no facet should depend on another facet's result
- All findings must carry a source URL — unsourced claims are excluded from output
- `.ao/external-context.json` is overwritten on each run (not appended)
- explore agents run at sonnet tier (haiku lacks sufficient web reasoning depth)
- Synthesis runs at opus tier (contradiction resolution and ranking require it)

</External_Context>

# C3-R Pragmatic Memory — Revised Spec (R1)

**Status**: Approved (Consensus R1 — Architect APPROVE + Momus APPROVE)
**Last Updated**: 2026-04-04
**Tracks**: Improvement Tracker C3 (Redefine)
**Revision Cycle**: R1 — addresses 9 mandatory reviewer findings (Architect + Momus)

---

## Overview

Improve `scripts/lib/wisdom.mjs` text similarity and query scoring without adding npm dependencies. Three changes:

1. **Token normalization** — stop word removal + suffix stripping with minimum stem length guard
2. **Multi-dimensional scoring** — weighted scoring across 5 dimensions when query specifies them
3. **Wisdom export/import** — CLI-accessible JSON export and import for cross-project sharing

This revision explicitly addresses all 9 reviewer findings from the Architect (Codex) and Momus (Gemini) perspectives.

---

## 1. Token Normalization

### 1.1 Stop Word List (Exhaustive)

The following 47 English stop words are removed before Jaccard set construction. These are high-frequency function words that carry no discriminative meaning for lesson similarity:

```javascript
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
  'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has',
  'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see',
  'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too',
  'use', 'that', 'with', 'have', 'this', 'will', 'your',
  'from', 'they', 'been', 'each', 'make', 'when', 'than',
]);
```

Rationale: limited to words that appear in >50% of typical English technical prose. Domain terms (e.g., "test", "build", "hook") are intentionally excluded. The list is a constant, not configurable, to maintain zero-config simplicity.

### 1.2 Suffix Stripping Rules

A minimal suffix stripper (not a full stemmer) that removes common English suffixes. The **minimum stem length after stripping is 4 characters** to prevent degenerate conflation.

```javascript
const SUFFIX_RULES = [
  // Order matters: longest suffixes first
  { suffix: 'tion', minBefore: 4 },   // "validation" -> "valida" (6 >= 4, OK)
  { suffix: 'sion', minBefore: 4 },   // "expression" -> "expres" (6 >= 4, OK)
  { suffix: 'ness', minBefore: 4 },   // "readiness" -> "readi" (5 >= 4, OK)
  { suffix: 'ment', minBefore: 4 },   // "deployment" -> "deploy" (6 >= 4, OK)
  { suffix: 'able', minBefore: 4 },   // "testable" -> "test" (4 >= 4, OK)
  { suffix: 'ible', minBefore: 4 },   // "accessible" -> "access" (6 >= 4, OK)
  { suffix: 'ally', minBefore: 4 },   // "typically" -> "typic" (5 >= 4, OK)
  { suffix: 'ing',  minBefore: 4 },   // "testing" -> "test" (4 >= 4, OK)
                                       // "sing" -> "s" (1 < 4, BLOCKED)
                                       // "being" -> "be" (2 < 4, BLOCKED)
  { suffix: 'ies',  minBefore: 4 },   // "dependencies" -> "dependenc" (9 >= 4, OK)
  { suffix: 'ed',   minBefore: 4 },   // "configured" -> "configur" (8 >= 4, OK)
                                       // "used" -> "us" (2 < 4, BLOCKED -> kept as "used")
  { suffix: 'er',   minBefore: 4 },   // "worker" -> "work" (4 >= 4, OK)
                                       // "user" -> "us" (2 < 4, BLOCKED -> kept as "user")
  { suffix: 'ly',   minBefore: 4 },   // "strictly" -> "strict" (6 >= 4, OK)
                                       // "only" -> "on" (2 < 4, BLOCKED -> kept as "only")
  { suffix: 's',    minBefore: 4 },   // "modules" -> "module" (6 >= 4, OK)
                                       // "bus" -> "bu" (2 < 4, BLOCKED -> kept as "bus")
];

function stripSuffix(word) {
  for (const { suffix, minBefore } of SUFFIX_RULES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= minBefore) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}
```

The `minBefore` of 4 prevents:
- "sing" -> "s" (BLOCKED, remains "sing")
- "being" -> "be" (BLOCKED, remains "being")
- "worker" -> "work" (ALLOWED, 4 >= 4)
- "working" -> "work" (ALLOWED, 4 >= 4)
- "used" -> "us" (BLOCKED, remains "used")
- "user" -> "us" (BLOCKED, remains "user")

Note: "worker" and "working" both correctly reduce to "work" because both have stems >= 4 chars. This is **desired** behavior for lesson deduplication (lessons about "workers" and "working" with them are topically related). The min-length guard only prevents **false** conflation where the remaining stem is too short to be meaningful.

### 1.3 Normalized Tokenization Function

```javascript
function tokenize(text) {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2)           // existing: drop 1-2 char words
    .filter(w => !STOP_WORDS.has(w))     // new: drop stop words
    .map(stripSuffix);                   // new: reduce suffixes
}
```

This replaces the inline `a.toLowerCase().split(/\s+/).filter(w => w.length > 2)` in `jaccardSimilarity()`.

---

## 2. Jaccard Threshold Validation

Below are 5 concrete before/after calculations proving the 0.7 threshold remains valid after normalization. Each pair shows the current (raw) Jaccard and the new (normalized) Jaccard.

### Pair 1: Near-duplicate (SHOULD deduplicate)

```
A: "Use dependency injection to decouple modules and improve testability in the application"
B: "Use dependency injection to decouple modules and improve testability throughout the application"

BEFORE (raw, words > 2 chars):
  setA: {use, dependency, injection, decouple, modules, and, improve, testability, the, application}  (10)
  setB: {use, dependency, injection, decouple, modules, and, improve, testability, throughout, the, application}  (11)
  intersection: 10, union: 11
  Jaccard = 10/11 = 0.909  (>= 0.7, dedup)

AFTER (normalized):
  setA: {dependency, injection, decouple, module, improve, testability, applica}  (7)
    dropped: "use"(stop), "and"(stop), "the"(stop), "in"(2 chars)
    stripped: "modules"->"module", "application"->"applica" (tion rule)
    unchanged: "testability" (no suffix rule matches — not -able, not -tion)
  setB: {dependency, injection, decouple, module, improve, testability, throughout, applica}  (8)
    dropped: "use"(stop), "and"(stop), "the"(stop)
  intersection: 7, union: 8
  Jaccard = 7/8 = 0.875  (>= 0.7, dedup) CORRECT
```

### Pair 2: Near-duplicate with word reordering (SHOULD deduplicate)

```
A: "Always run linting as a pre-commit hook to catch issues early"
B: "Run pre-commit linting hooks to catch issues early and reliably"

BEFORE:
  setA: {always, run, linting, pre-commit, hook, catch, issues, early}  (8)
  setB: {run, pre-commit, linting, hooks, catch, issues, early, and, reliably}  (9)
  intersection: {run, linting, pre-commit, catch, issues, early} = 6, union: 11
  Jaccard = 6/11 = 0.545  (< 0.7, NOT deduped — false negative)

AFTER:
  setA: {always, linting, pre-commit, hook, catch, issue, early}  (7)
    dropped: "run"(3 chars, kept actually — "run" is 3 chars > 2, not a stop word)
    Correction: "run" has 3 chars > 2, not in stop list. Kept.
  setA: {always, run, linting, pre-commit, hook, catch, issue, early}  (8)
    stripped: "issues"->"issue" (wait, "issues" - "s" -> "issue", 5 >= 4, OK)
  setB: {run, pre-commit, linting, hook, catch, issue, early, reliably}  (8)
    dropped: "and"(stop), "to"(2 chars)
    stripped: "hooks"->"hook", "issues"->"issue", "reliably" -> "reliab" (wait: "reliably" - "ly" -> "reliab", 6 >= 4, OK)
  setB: {run, pre-commit, linting, hook, catch, issue, early, reliab}  (8)
  intersection: {run, pre-commit, linting, hook, catch, issue, early} = 7, union: 9
  Jaccard = 7/9 = 0.778  (>= 0.7, dedup) CORRECT — normalization FIXED a false negative
```

### Pair 3: Distinct lessons (SHOULD NOT deduplicate)

```
A: "Pin all transitive dependencies for deterministic builds"
B: "Configure eslint with strict TypeScript rules for type safety"

BEFORE:
  setA: {pin, all, transitive, dependencies, for, deterministic, builds}  (7)
  setB: {configure, eslint, with, strict, typescript, rules, for, type, safety}  (9)
  intersection: {for} = 1, union: 15
  Jaccard = 1/15 = 0.067  (< 0.7, kept) CORRECT

AFTER:
  setA: {pin, transitive, dependency, deterministic, build}  (5)
    dropped: "all"(stop), "for"(stop)
  setB: {configure, eslint, strict, typescript, rule, type, safety}  (7)
    dropped: "with"(stop), "for"(stop)
  intersection: 0, union: 12
  Jaccard = 0/12 = 0.0  (< 0.7, kept) CORRECT
```

### Pair 4: Same-topic different advice (SHOULD NOT deduplicate)

```
A: "Use isolated temp dirs for each test to prevent cross-test pollution"
B: "Tag integration tests so they can be skipped in fast mode"

BEFORE:
  setA: {use, isolated, temp, dirs, for, each, test, prevent, cross-test, pollution}  (10)
  setB: {tag, integration, tests, they, can, skipped, fast, mode}  (8)
  intersection: 0, union: 18
  Jaccard = 0/18 = 0.0  (< 0.7, kept) CORRECT

AFTER:
  setA: {isolat, temp, dirs, test, prevent, cross-test, pollu}  (7)
    dropped: "use"(stop), "for"(stop), "each"(stop)
    stripped: "isolated"->"isolat"(ed rule), "pollution"->"pollu"(tion rule)
  setB: {tag, integra, test, they, skip, fast, mode}  (7)
    dropped: "can"(stop)
    stripped: "integration"->"integra"(tion rule), "tests"->"test"(s rule), "skipped"->"skip"(ped? no — "ed" rule: "skipped"->"skipp" wait)
    Let me redo: "skipped" -> strip "ed" -> "skipp" (5 >= 4, OK)
  setB: {tag, integra, test, they, skipp, fast, mode}  (7)
  intersection: {test} = 1, union: 13
  Jaccard = 1/13 = 0.077  (< 0.7, kept) CORRECT
```

### Pair 5: Moderately similar (SHOULD NOT deduplicate — different actionable advice)

```
A: "Validate all external inputs at the service boundary before processing"
B: "Validate API request parameters with JSON schema at the gateway"

BEFORE:
  setA: {validate, all, external, inputs, the, service, boundary, before, processing}  (9)
  setB: {validate, api, request, parameters, with, json, schema, the, gateway}  (9)
  intersection: {validate, the} = 2, union: 16
  Jaccard = 2/16 = 0.125  (< 0.7, kept) CORRECT

AFTER:
  setA: {validate, external, input, service, boundary, before, process}  (7)
    dropped: "all"(stop), "the"(stop)
    stripped: "inputs"->"input"(s rule), "processing"->"process"(ing rule)
  setB: {validate, api, request, parameter, json, schema, gateway}  (7)
    dropped: "with"(stop), "the"(stop)
    stripped: "parameters"->"parameter"(s rule)
  intersection: {validate} = 1, union: 13
  Jaccard = 1/13 = 0.077  (< 0.7, kept) CORRECT
```

**Conclusion**: The 0.7 threshold remains valid. Normalization improves true positive deduplication (Pair 2) while preserving correct separation of distinct lessons (Pairs 3-5). No threshold change needed.

---

## 3. Multi-Dimensional Scoring (queryWisdom enhancement)

### 3.1 When Scoring Activates

Scoring ONLY activates when `queryWisdom` receives an options object with at least one **scoring dimension** present: `category`, `intent`, or `filePattern`. The presence of `minConfidence` or `limit` alone does NOT activate scoring.

When scoring is NOT activated (no scoring dimension in query), the existing `toReversed()` recency-only behavior is preserved exactly.

### 3.2 Legacy Signature Backward Compatibility

**[REVIEWER POINT #3]** The legacy `queryWisdom(string, number)` signature MUST bypass the scorer entirely. Detection:

```javascript
if (typeof categoryOrOptions === 'string' || categoryOrOptions === null) {
  // LEGACY PATH: filter + toReversed() + slice — NO scoring
}
```

This preserves the exact existing behavior for all current callers.

### 3.3 Existing Caller Impact

**[REVIEWER POINT #7]** The two existing callers are:

1. `session-start.mjs`: `queryWisdom({ minConfidence: 'medium', limit: 15 })`
2. `subagent-start.mjs`: `queryWisdom({ minConfidence: 'medium', limit: 10 })`

Neither passes `category`, `intent`, or `filePattern`. Therefore:
- These calls have **zero scoring dimensions** present
- They follow the **recency-only path** (filter by minConfidence, then `toReversed().slice()`)
- **No behavioral change** for existing callers

This is guaranteed by the activation rule: scoring requires at least one of `{category, intent, filePattern}` in the query object.

### 3.4 Score Dimensions and Normalization Functions

**[REVIEWER POINT #5]** Each dimension has a specific normalization formula mapping entry properties to a 0.0-1.0 score:

| # | Dimension | Type | Normalization Formula | Notes |
|---|-----------|------|----------------------|-------|
| 1 | `recency` | Continuous | `max(0, 1 - ageMs / (90 * 86400000))` | Linear decay over 90 days. Entry from today = 1.0, 45 days ago = 0.5, 90+ days = 0.0 |
| 2 | `category` | Binary | `entry.category === query.category ? 1.0 : 0.0` | Exact match only. No partial/fuzzy matching |
| 3 | `intent` | Binary | `entry.intent === query.intent ? 1.0 : 0.0` | Exact match only. Entries without intent field score 0.0 |
| 4 | `filePattern` | Binary | `(entry.filePatterns ?? []).some(p => p.includes(query.filePattern)) ? 1.0 : 0.0` | Substring match against any element in filePatterns array. Entries without filePatterns score 0.0 |
| 5 | `confidence` | Ordinal | `{ high: 1.0, medium: 0.66, low: 0.33 }[entry.confidence] ?? 0.33` | Three-level ordinal mapping. Unknown confidence maps to low |

```javascript
function scoreRecency(entry) {
  try {
    const ageMs = Date.now() - new Date(entry.timestamp).getTime();
    return Math.max(0, 1 - ageMs / (90 * 24 * 60 * 60 * 1000));
  } catch {
    return 0;
  }
}

function scoreCategory(entry, queryCategory) {
  return entry.category === queryCategory ? 1.0 : 0.0;
}

function scoreIntent(entry, queryIntent) {
  return entry.intent === queryIntent ? 1.0 : 0.0;
}

function scoreFilePattern(entry, queryFilePattern) {
  const patterns = entry.filePatterns ?? [];
  return patterns.some(p => p.includes(queryFilePattern)) ? 1.0 : 0.0;
}

function scoreConfidence(entry) {
  const CONF_SCORES = { high: 1.0, medium: 0.66, low: 0.33 };
  return CONF_SCORES[entry.confidence] ?? 0.33;
}
```

### 3.5 Weight Assignment and Neutral-Weight Renormalization

**[REVIEWER POINT #1]** Base weights (before renormalization):

| Dimension | Base Weight | Condition for Activation |
|-----------|------------|-------------------------|
| recency | 0.3 | Always active |
| confidence | 0.1 | Always active |
| category | 0.25 | Active when `query.category` is provided |
| intent | 0.2 | Active when `query.intent` is provided |
| filePattern | 0.15 | Active when `query.filePattern` is provided |

**Neutral-weight policy**: When a query dimension is NOT specified, that dimension scores 1.0 (neutral) for all entries and its weight is redistributed proportionally among the remaining active dimensions.

Implementation: dimensions not specified in the query are excluded from the weighted sum entirely, and the active weights are renormalized to sum to 1.0.

```javascript
function scoreEntry(entry, query) {
  // Build active dimensions with their base weights
  const dims = [
    { weight: 0.3, score: scoreRecency(entry) },           // always active
    { weight: 0.1, score: scoreConfidence(entry) },         // always active
  ];

  if (query.category) {
    dims.push({ weight: 0.25, score: scoreCategory(entry, query.category) });
  }
  if (query.intent) {
    dims.push({ weight: 0.2, score: scoreIntent(entry, query.intent) });
  }
  if (query.filePattern) {
    dims.push({ weight: 0.15, score: scoreFilePattern(entry, query.filePattern) });
  }

  // Renormalize weights to sum to 1.0
  const totalWeight = dims.reduce((sum, d) => sum + d.weight, 0);
  return dims.reduce((sum, d) => sum + (d.weight / totalWeight) * d.score, 0);
}
```

**Renormalization examples**:

- Query has `category` only: active weights = 0.3 + 0.1 + 0.25 = 0.65. After renorm: recency=0.462, confidence=0.154, category=0.385
- Query has `category` + `intent`: active weights = 0.3 + 0.1 + 0.25 + 0.2 = 0.85. After renorm: recency=0.353, confidence=0.118, category=0.294, intent=0.235
- Query has all three: active weights = 0.3 + 0.1 + 0.25 + 0.2 + 0.15 = 1.0. No renorm needed
- No scoring dimensions (existing callers): scoring path is NOT entered at all; recency-only `toReversed()` is used

### 3.6 Revised queryWisdom Flow

```
queryWisdom(categoryOrOptions, limit)
  |
  +-- typeof === 'string' || === null?  --> LEGACY PATH (no scoring, toReversed)
  |
  +-- typeof === 'object'?
        |
        +-- has category || intent || filePattern?
        |     |
        |     YES --> SCORING PATH:
        |             1. Filter by minConfidence (hard filter, not scored)
        |             2. Score each entry via scoreEntry()
        |             3. Sort by score DESC, break ties by timestamp DESC
        |             4. Slice to limit
        |
        NO --> RECENCY PATH (existing behavior):
               1. Filter by minConfidence
               2. toReversed().slice(0, limit)
```

The `minConfidence` filter remains a hard pre-filter in ALL paths (entries below the threshold are excluded before scoring or ordering).

---

## 4. Wisdom Export/Import

### 4.1 Export

```javascript
export async function exportWisdom() {
  const entries = await readAllEntries();
  return JSON.stringify(entries, null, 2);
}
```

Returns a JSON array of all wisdom entries. Caller writes to file.

### 4.2 Import

```javascript
export async function importWisdom(jsonString, { merge = true } = {}) {
  const incoming = JSON.parse(jsonString);
  if (!Array.isArray(incoming)) throw new Error('Expected JSON array');

  if (!merge) {
    await writeAllEntries(incoming);
    return { imported: incoming.length, duplicatesSkipped: 0 };
  }

  const existing = await readAllEntries();
  let duplicatesSkipped = 0;

  for (const entry of incoming) {
    if (!entry.lesson || typeof entry.lesson !== 'string') continue;
    const isDup = existing.some(e => jaccardSimilarity(e.lesson, entry.lesson) >= 0.7);
    if (isDup) {
      duplicatesSkipped++;
      continue;
    }
    existing.push({
      timestamp: entry.timestamp || new Date().toISOString(),
      project: entry.project || path.basename(process.cwd()),
      category: entry.category || 'general',
      lesson: entry.lesson,
      ...(entry.filePatterns ? { filePatterns: entry.filePatterns } : {}),
      confidence: entry.confidence || 'medium',
      ...(entry.intent ? { intent: entry.intent } : {}),
    });
  }

  await writeAllEntries(existing);
  return { imported: incoming.length - duplicatesSkipped, duplicatesSkipped };
}
```

Merge mode (default) skips entries with >= 0.7 Jaccard similarity to existing lessons.

---

## 5. User Stories and Acceptance Criteria

### US-C3R-001: Token Normalization for Jaccard Similarity

**As** the wisdom deduplication system, **I want** to normalize tokens before computing Jaccard similarity **so that** near-duplicate lessons with trivial word variations are correctly identified.

**Acceptance Criteria** (all testable):

1. **AC-001-1**: `jaccardSimilarity("testing the modules", "tested those module")` returns a value > 0.7 (both normalize to approximately `{test, module}` overlap). Currently returns < 0.5 due to raw word mismatch.

2. **AC-001-2**: `jaccardSimilarity("sing along", "singing together")` — "sing" is NOT stripped (stem "s" would be < 4 chars). "singing" IS stripped to "sing" (stem "sing" is 4 chars). Both contain "sing" after normalization.

3. **AC-001-3**: Stop words "the", "and", "for", "with", "that", "this", "from", "have", "will", "your" do not appear in the token set for any input string.

4. **AC-001-4**: All 47 stop words listed in Section 1.1 are removed. No more, no fewer.

5. **AC-001-5**: Words that would reduce to stems shorter than 4 characters are kept unchanged. Specifically: `stripSuffix("used")` returns `"used"` (not `"us"`), `stripSuffix("only")` returns `"only"` (not `"on"`), `stripSuffix("being")` returns `"being"` (not `"be"`).

6. **AC-001-6**: The deduplication threshold of 0.7 is unchanged. The 5 pairs documented in Section 2 produce the documented results.

7. **AC-001-7**: `pruneWisdom()` uses the same normalized Jaccard for its deduplication pass.

8. **AC-001-8**: All 17 existing tests in `wisdom.test.mjs` continue to pass without modification (normalization should not change whether existing test fixtures are considered duplicates or distinct, since those fixtures were chosen with large similarity gaps).

### US-C3R-002: Multi-Dimensional Query Scoring

**As** the wisdom query system, **I want** to score entries across multiple dimensions when the caller specifies category, intent, or filePattern **so that** the most contextually relevant entries are returned first instead of purely most-recent.

**Acceptance Criteria** (all testable):

1. **AC-002-1**: `queryWisdom('test', 5)` (legacy string signature) returns entries in reverse chronological order, identical to current behavior. The scorer is NOT invoked.

2. **AC-002-2**: `queryWisdom({ minConfidence: 'medium', limit: 15 })` (session-start.mjs pattern) returns entries in reverse chronological order. The scorer is NOT invoked.

3. **AC-002-3**: `queryWisdom({ minConfidence: 'medium', limit: 10 })` (subagent-start.mjs pattern) returns entries in reverse chronological order. The scorer is NOT invoked.

4. **AC-002-4**: `queryWisdom({ category: 'test' })` returns entries sorted by composite score (category match weighted, not just recency). An entry with `category: 'test'` from 30 days ago ranks higher than an entry with `category: 'build'` from 1 day ago.

5. **AC-002-5**: `queryWisdom({ category: 'build', intent: 'deep', filePattern: 'scripts/' })` activates all 5 scoring dimensions with renormalized weights summing to 1.0.

6. **AC-002-6**: When only `category` is specified, the renormalized weights are: recency ~0.462, confidence ~0.154, category ~0.385 (derived from 0.3/0.65, 0.1/0.65, 0.25/0.65).

7. **AC-002-7**: `minConfidence` remains a hard pre-filter in all paths. `queryWisdom({ category: 'test', minConfidence: 'high' })` excludes medium/low entries entirely, then scores the remaining high-confidence entries.

8. **AC-002-8**: Score ties are broken by timestamp descending (most recent first).

9. **AC-002-9**: `queryWisdom(null)` (legacy null) returns all entries in reverse chronological order, scorer NOT invoked.

### US-C3R-003: Wisdom Export/Import

**As** a user, **I want** to export wisdom from one project and import it into another **so that** learnings are portable across codebases.

**Acceptance Criteria**:

1. **AC-003-1**: `exportWisdom()` returns a valid JSON string that `JSON.parse()` can parse into an array.
2. **AC-003-2**: `importWisdom(json, { merge: true })` skips entries with >= 0.7 Jaccard similarity to existing entries and returns `{ imported, duplicatesSkipped }`.
3. **AC-003-3**: `importWisdom(json, { merge: false })` replaces all existing entries.
4. **AC-003-4**: Imported entries missing `timestamp`, `category`, or `confidence` receive defaults.
5. **AC-003-5**: Entries missing `lesson` field are silently skipped.

---

## 6. Implementation Plan

### Phase 1: Token Normalization (non-breaking)

**Files modified**:
- `scripts/lib/wisdom.mjs` — add `STOP_WORDS`, `SUFFIX_RULES`, `stripSuffix()`, `tokenize()`, update `jaccardSimilarity()` to use `tokenize()`

**Files added**:
- `scripts/test/wisdom-normalization.test.mjs` — tests for stop words, suffix stripping, min-stem guard, threshold validation (the 5 pairs from Section 2)

**Estimated test count**: +12 tests

### Phase 2: Multi-Dimensional Scoring (backward-compatible)

**Files modified**:
- `scripts/lib/wisdom.mjs` — add `scoreRecency()`, `scoreCategory()`, `scoreIntent()`, `scoreFilePattern()`, `scoreConfidence()`, `scoreEntry()`, modify `queryWisdom()` to branch on scoring activation

**Files added**:
- `scripts/test/wisdom-scoring.test.mjs` — tests for all 9 AC-002-* acceptance criteria

**Estimated test count**: +15 tests

### Phase 3: Export/Import

**Files modified**:
- `scripts/lib/wisdom.mjs` — add `exportWisdom()`, `importWisdom()`

**Files added**:
- `scripts/test/wisdom-export-import.test.mjs` — tests for all 5 AC-003-* acceptance criteria

**Estimated test count**: +8 tests

### Verification

After all phases:
- All 17 existing wisdom.test.mjs tests pass (no modifications)
- All ~35 new tests pass
- `session-start.mjs` and `subagent-start.mjs` behavior is unchanged (verified by AC-002-2 and AC-002-3)
- Zero npm dependencies added
- `node --check scripts/lib/wisdom.mjs` passes

---

## 7. Reviewer Finding Traceability

| # | Finding | Source | Resolution | Section |
|---|---------|--------|------------|---------|
| 1 | Define neutral-weight policy | Architect | Unspecified dimensions excluded from weighted sum; active weights renormalized to sum to 1.0 | 3.5 |
| 2 | Minimum stem length >= 4 chars | Architect | `minBefore: 4` on all suffix rules; degenerate cases documented | 1.2 |
| 3 | Legacy queryWisdom(string, number) bypasses scorer | Architect | typeof check routes to legacy path with no scoring | 3.2 |
| 4 | 3-5 concrete before/after Jaccard calculations | Momus | 5 pairs with full set arithmetic | 2 |
| 5 | scoreEntry normalization function per dimension | Momus | Formula table + code for all 5 dimensions | 3.4 |
| 6 | Explicit acceptance criteria for US-C3R-001 and US-C3R-002 | Momus | 8 criteria for 001, 9 criteria for 002, all testable | 5 |
| 7 | Acknowledge impact on existing callers | Momus | session-start.mjs and subagent-start.mjs analyzed; zero behavioral change guaranteed | 3.3 |
| 8 | Specify exact stop word list | Momus | 47 words enumerated | 1.1 |
| 9 | Address suffix stripping edge cases | Momus | "sing", "being", "used", "only" guarded; min stem length 4 | 1.2 |

---

## 8. PRD JSON

```json
{
  "id": "C3R-pragmatic-memory",
  "title": "C3-R Pragmatic Memory",
  "version": "1.1.0",
  "revision": 1,
  "status": "plan",
  "priority": "low",
  "tracks": "C3",
  "stories": [
    {
      "id": "US-C3R-001",
      "title": "Token Normalization for Jaccard Similarity",
      "phase": 1,
      "effort": "small",
      "files": [
        "scripts/lib/wisdom.mjs",
        "scripts/test/wisdom-normalization.test.mjs"
      ],
      "acceptanceCriteria": [
        "AC-001-1: jaccardSimilarity with suffix variants returns > 0.7",
        "AC-001-2: 'sing' not stripped (stem < 4), 'singing' stripped to 'sing' (stem = 4)",
        "AC-001-3: All 47 stop words removed from token sets",
        "AC-001-4: Exactly 47 stop words, no more no fewer",
        "AC-001-5: stripSuffix('used')='used', stripSuffix('only')='only', stripSuffix('being')='being'",
        "AC-001-6: Dedup threshold remains 0.7; 5 documented pairs produce documented results",
        "AC-001-7: pruneWisdom() uses normalized Jaccard",
        "AC-001-8: All 17 existing wisdom.test.mjs tests pass unmodified"
      ]
    },
    {
      "id": "US-C3R-002",
      "title": "Multi-Dimensional Query Scoring",
      "phase": 2,
      "effort": "medium",
      "files": [
        "scripts/lib/wisdom.mjs",
        "scripts/test/wisdom-scoring.test.mjs"
      ],
      "acceptanceCriteria": [
        "AC-002-1: queryWisdom('test', 5) returns reverse-chronological, scorer NOT invoked",
        "AC-002-2: queryWisdom({ minConfidence: 'medium', limit: 15 }) returns reverse-chronological",
        "AC-002-3: queryWisdom({ minConfidence: 'medium', limit: 10 }) returns reverse-chronological",
        "AC-002-4: queryWisdom({ category: 'test' }) ranks category match above recency-only",
        "AC-002-5: All 5 dimensions active when category+intent+filePattern specified",
        "AC-002-6: Category-only query renormalizes to recency=0.462, confidence=0.154, category=0.385",
        "AC-002-7: minConfidence is hard pre-filter in all paths",
        "AC-002-8: Score ties broken by timestamp descending",
        "AC-002-9: queryWisdom(null) returns reverse-chronological, scorer NOT invoked"
      ]
    },
    {
      "id": "US-C3R-003",
      "title": "Wisdom Export/Import",
      "phase": 3,
      "effort": "small",
      "files": [
        "scripts/lib/wisdom.mjs",
        "scripts/test/wisdom-export-import.test.mjs"
      ],
      "acceptanceCriteria": [
        "AC-003-1: exportWisdom() returns valid JSON array string",
        "AC-003-2: importWisdom merge mode skips duplicates and returns counts",
        "AC-003-3: importWisdom replace mode overwrites all entries",
        "AC-003-4: Missing fields receive defaults (timestamp, category, confidence)",
        "AC-003-5: Entries without lesson field silently skipped"
      ]
    }
  ],
  "constraints": [
    "Zero npm dependencies",
    "ESM only (.mjs)",
    "Fail-safe pattern (catch -> empty result, never throw)",
    "All existing 17 wisdom.test.mjs tests pass unmodified",
    "session-start.mjs and subagent-start.mjs behavior unchanged",
    "Legacy queryWisdom(string, number) bypasses scorer entirely"
  ],
  "dependencies": [],
  "estimatedTests": 35,
  "reviewerFindings": {
    "architect": [1, 2, 3],
    "momus": [4, 5, 6, 7, 8, 9],
    "allAddressed": true,
    "revision": 1
  }
}
```

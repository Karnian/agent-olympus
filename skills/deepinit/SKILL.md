---
name: deepinit
description: Generate hierarchical AGENTS.md documentation across entire codebase for agent orientation
level: 2
aliases: [deepinit, init, 초기화, map-codebase]
---

<Deepinit>

## Purpose

Crawl an entire codebase and generate AGENTS.md files at every directory level.
These files help all sub-agents quickly understand what each module does,
reducing onboarding cost for every subsequent task.

Run once per new project. Update when project structure changes significantly.

## Use_When

- First time working on an unfamiliar codebase
- User says "deepinit", "초기화", "map the codebase"
- Atlas/Athena's explore agent reports low familiarity with project structure

## Steps

### Phase 1 — SCAN

```
Task(subagent_type="agent-olympus:explore", model="haiku",
  prompt="Scan the entire project structure:
  1. List all directories with file counts
  2. Identify: src/, test/, config/, docs/ patterns
  3. Note: package.json, Cargo.toml, go.mod, pyproject.toml locations
  4. Report tech stack per directory")
```

### Phase 2 — GENERATE

For each significant directory (has 2+ code files), generate AGENTS.md:

```
Task(subagent_type="agent-olympus:writer", model="haiku",
  prompt="Create AGENTS.md for directory: <dir_path>

  Format:
  # <directory-name>
  <!-- parent: <relative-path-to-parent-AGENTS.md> -->

  ## Purpose
  <1-2 sentences: what this module/directory does>

  ## Key Files
  - <file>: <one-line description>

  ## Dependencies
  - Imports from: <list>
  - Imported by: <list>

  ## Conventions
  - <naming patterns, test patterns, etc.>

  Files in directory: <file_list>")
```

### Phase 3 — ROOT SUMMARY

Generate root AGENTS.md with project overview:
```
# <project-name>

## Architecture
<high-level description>

## Directory Map
- src/ — <purpose>
  - src/api/ — <purpose>
  - src/core/ — <purpose>
- tests/ — <purpose>

## Tech Stack
<languages, frameworks, build tools>

## Getting Started
<build, test, run commands>
```

### Phase 4 — VERIFY

```bash
find . -name "AGENTS.md" | head -20  # confirm files created
```

## Update Mode

When re-running on an existing project:
- Preserve `<!-- MANUAL -->` sections (user-written content)
- Update auto-generated sections with current file lists
- Add new directories, remove deleted ones

## Integration

Atlas can invoke deepinit as Phase 0.5 (after triage, before analyze)
when the explore agent reports unfamiliar project structure.

</Deepinit>

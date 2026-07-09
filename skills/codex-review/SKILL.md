---
name: codex-review
description: Use when Codex should review the diff, run a code review by Codex, 코덱스 코드리뷰, or 코덱스에 리뷰 위임 as an independent review gate.
---

<Codex_Review_Gate>

## Purpose

Use OpenAI Codex as an independent, machine-parseable code-review gate for the
current diff. This is the inverse of `codex-goal`: `codex-goal` delegates
implementation to Codex, while `agent-olympus:codex-review` asks Codex to
review a diff and return a structured PASS/FAIL verdict.

Gate mode is authoritative for this skill. Challenge and consult modes are
advisory and must not override the structured gate verdict.

## Use_When

- User asks Codex to review the current diff, branch, or uncommitted work.
- User wants an independent code-review gate before merge or handoff.
- User asks for "codex reviews the diff", "code review by codex",
  "코덱스 코드리뷰", or "코덱스에 리뷰 위임".

## Modes

### review (default)

Run the machine-parseable PASS/FAIL gate. Prefer reviewing against the default
branch when the task is branch-shaped; otherwise review uncommitted changes.

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/codex-review.mjs --base <default-branch>
node "$CLAUDE_PLUGIN_ROOT"/scripts/codex-review.mjs --uncommitted
```

Mode scope: `--base` reviews the COMMITTED branch diff (`git diff --merge-base
<ref> HEAD`) and does NOT include uncommitted or untracked working-tree files —
use it for branch-shaped review of committed work. `--uncommitted` reviews the
working tree (`git diff HEAD` plus untracked file contents) — use it to gate
local changes before they are committed. If the assembled target is truncated
(very large change), the gate refuses to certify PASS: the envelope sets
`truncated:true` and the process exits non-zero even if Codex returned PASS.

The runner assembles the diff, appends untracked file contents in uncommitted
mode, and spawns Codex read-only:

```bash
codex -s read-only -a never exec --json --output-schema <schema> -C <cwd>
```

The envelope is:

```json
{
  "status": "ok",
  "verdict": "PASS",
  "findings": [],
  "summary": "string",
  "threadId": "string"
}
```

Blocking rule: FAIL if Codex returns `verdict:"FAIL"` or any finding has
severity `critical` or `P1`. Findings with only `P2`, `P3`, or `nit` severity
do not fail the gate.

If Codex fails to spawn, exits non-zero, or returns output that cannot be parsed
against `schemas/codex-review-result.schema.json`, treat the gate as fail-open:
the runner emits `status:"error"`, `verdict:null`, and exits 2.

### challenge

Run an advisory adversarial review without the schema gate. Ask Codex to find
how the change could fail in production:

```bash
codex -s read-only -a never exec --json -C <cwd>
```

Use this for broader thinking before or after the gate. Challenge findings are
advisory; they do not replace the review-mode PASS/FAIL result.

### consult

Use Codex for open Q&A about the diff, architecture, risk, or a prior review
thread. For continuity, resume an existing Codex thread when the review envelope
includes a usable `threadId`:

```bash
codex -s read-only -a never exec resume <threadId>
```

Consult output is advisory. Use review mode whenever the user needs a
machine-readable merge or shell gate.

## Steps

1. Choose mode. Default to `review` unless the user explicitly asks for
   adversarial brainstorming (`challenge`) or open Q&A (`consult`).
2. In review mode, choose `--base <default-branch>` for branch review or
   `--uncommitted` for current working tree review.
3. Run `scripts/codex-review.mjs` from the target worktree.
4. Parse the single JSON envelope from stdout.
5. Treat `status:"ok", verdict:"PASS"` as the only passing gate state.
6. Treat `status:"ok", verdict:"FAIL"` as a blocking review failure and report
   the critical/P1 findings first.
7. Treat `status:"error"` as fail-open infrastructure failure; report the error
   separately from code quality.

## Reporting

For a PASS, report the summary and any advisory P2/P3/nit findings.

For a FAIL, report the blocking findings with severity, file, line when present,
and summary. Keep advisory findings secondary.

For `status:"error"`, report that the Codex review gate did not produce an
authoritative verdict and include the runner error.

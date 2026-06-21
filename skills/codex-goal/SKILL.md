---
name: codex-goal
description: Use to delegate a goal to Codex, run a codex goal, have codex implement, or 코덱스에 목표 위임 with Claude-hosted external verification.
---

<Codex_Goal_Orchestrator>

## Purpose

Delegate one bounded implementation goal to Codex, let Codex use its native
agents where available, then verify the work externally from the Claude host.
The retry loop, trust preflight, worktree boundary, Themis judgment, and budget
caps live in this skill. `scripts/codex-goal.mjs` is only a one-turn
spawn/resume/parse helper.

## Use_When

- User asks to delegate a goal to Codex, run a codex goal, or have Codex implement.
- The task is implementation-shaped and can be verified by exact shell commands.
- The host wants Codex's native explorer/tester/reviewer agents but must keep
  final pass/fail authority outside Codex.

## Steps

### Phase 0 - Trust and Inputs

1. Resolve exact Definition of Done commands before delegation. Do not hand Codex
   vague checks such as "run tests"; record concrete commands with arguments and
   the directory each command runs from.
2. `scripts/codex-goal.mjs` auto-propagates Codex project trust to the
   disposable worktree per run with a global `-c` override, so no manual Codex
   trust step is needed for the worktree. Use `--no-trust` only to opt out.
3. Verify that Codex is loading worktree `.codex` configuration. Treat the check
   as failed if Codex reports an untrusted project, skips project config, or
   cannot confirm the custom agents are loaded.
4. If trust is not confirmed, tell the user:
   `[codex-goal] Codex is not loading project .codex config. Continuing without relying on native subagents.`
   Continue the run, but do not rely on the project `explorer`, `tester`, or
   `reviewer` custom agents.

### Phase 1 - Run Identity and Worktree

Mint a run id and create a disposable git worktree. The worktree is the write
boundary for Codex.

```javascript
import { randomUUID } from 'node:crypto';
import { getActiveRunId } from './scripts/lib/run-artifacts.mjs';
import { createWorkerWorktree } from './scripts/lib/worktree.mjs';

const runId =
  getActiveRunId('atlas') ||
  getActiveRunId('athena') ||
  `codex-goal-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 4)}`;

const { worktreePath, branchName, created } =
  createWorkerWorktree(cwd, runId, 'codex-goal');
```

If `created === false`, the helper returned the cwd fallback. For this skill,
that is not a disposable write boundary; stop before running Codex and report
that git worktree isolation is unavailable.

### Phase 2 - Goal Packet

Build a packet with these sections, then send it on stdin to the helper.

```markdown
# Goal
<one bounded goal, including user-facing behavior>

# Definition of Done
Run and pass these exact verification commands:
1. `<command 1>`
2. `<command 2>`

# Scope (in+out)
In scope:
- <files, modules, behavior Codex may change>

Out of scope:
- <files, modules, behavior Codex must not change>

# Context
- <relevant plan/spec/code notes>
- Native subagents: <trusted|not trusted>
- If trusted, use the project explorer, tester, and reviewer agents where useful.
- If not trusted, do not assume project custom agents are available.

# Environment
- cwd: <worktreePath>
- branch: <branchName>
- sandbox: workspace-write confined to the disposable worktree
- maxExecInvocations: 5
- maxResumes: 4
- per Codex invocation wall-time: 15 minutes
- per verification command timeout: 300 seconds
- overall wall-time: 30 minutes
- subagent budget: agents.max_threads <= 4, agents.max_depth = 1

# Reporting
Return ONLY JSON matching schemas/codex-goal-result.schema.json:
{
  "summary": "string",
  "files_changed": ["path"],
  "verification": { "commands": ["cmd"], "results": ["result"] },
  "unresolved_risks": ["risk"],
  "follow_ups": ["item"]
}
```

Suggest-tier policy: even if host permission resolution says `suggest`, pass
`auto-edit` to Codex for this skill so the child runs with `workspace-write`
inside the disposable worktree. Do not run Codex read-only for implementation
goals; read-only lets Codex claim completion without writing and creates a
guaranteed verify-fail loop.

### Phase 3 - Execute One Codex Turn

Run the helper from the host and parse its single JSON stdout line.

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/codex-goal.mjs --cwd <worktreePath> --level <tier>
```

- Stdin is the goal packet.
- `<tier>` is `auto-edit` for host `suggest`; otherwise use the resolved
  `auto-edit` or `full-auto` tier.
- The envelope is `{status:"ok"|"failed", threadId, durationMs, result, rawTail, error?}`.
- Non-zero helper exit, malformed JSON, `status:"failed"`, or missing `threadId`
  is a verification failure input, not a reason to trust Codex's result.

### Phase 4 - External Verification

Never trust Codex's self-report. Run every DoD command from the Claude host in
the worktree and capture command, cwd, exit code, timeout status, stdout, and
stderr. Use workspace-write because tests may write build artifacts, snapshots,
or caches, but keep cwd inside the disposable worktree.

Then ask Themis to judge the captured output only:

```text
Task(subagent_type="agent-olympus:themis", model="sonnet",
  prompt="Judge these already-run verification logs for the Codex goal.
  Do NOT run commands or edit files. The Claude host already ran the commands.
  Return PASS only if every Definition of Done command passed and the outputs
  satisfy the requested behavior. Return FAIL with the concrete failing command
  and evidence otherwise.

  Goal: <goal>
  Definition of Done: <exact commands>
  Codex envelope: <parsed envelope>
  Captured verification logs: <logs>")
```

Themis is read-only judgment. Themis does not run the writing tests itself.

### Phase 5 - Retry Loop on Fail

On every attempt, consult the persistent loop guard and maintain local wall-time
and invocation counters.

```javascript
import { registerIteration, recordError } from './scripts/lib/loop-guard.mjs';

const maxExecInvocations = 5;
const maxResumes = 4;
const startedAt = Date.now();
let execInvocations = 0;
let resumes = 0;
let threadId = null;

while (execInvocations < maxExecInvocations && Date.now() - startedAt < 30 * 60_000) {
  const guard = registerIteration(runId, { cap: 5, cwd: worktreePath });
  if (!guard.allowed) STOP;
  if (guard.degraded && execInvocations >= maxExecInvocations) STOP;

  execInvocations += 1;
  // Run codex-goal.mjs, externally verify, then ask Themis to judge.

  if (themisVerdict === 'PASS') break;

  const sig = firstFailingCommandOrStableErrorLine(verificationLogs, envelope);
  const err = recordError(runId, sig, { cwd: worktreePath });
  if (err.shouldEscalate) STOP;

  if (!threadId || resumes >= maxResumes) STOP;
  resumes += 1;
  // Re-run with --resume and a packet containing the failure output.
}
```

Resume command:

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/codex-goal.mjs --cwd <worktreePath> --level <tier> --resume <threadId>
```

The resume packet must include the prior goal, the captured failing command
output, the Themis FAIL rationale, and instructions to make the smallest change
that can satisfy the same Definition of Done. Treat any `degraded:true` guard
result as fail-open for that individual call only; the local
`maxExecInvocations` cap is the hard secondary stop.

### Phase 6 - Completion

On PASS, report:

- Codex summary from the parsed result, marked advisory.
- `files_changed` from Codex plus `git -C <worktreePath> diff --name-only` if needed.
- Verification commands and Themis PASS evidence.
- The worktree path and branch name for user review/merge.

Do not auto-merge the worktree, delete it, or commit to the main checkout.

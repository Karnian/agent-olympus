---
name: ask
description: Quick single-shot (sync) or long-running (async) query to Codex or Gemini via the worker-adapter system. Async subcommands (async/status/collect/cancel/list) added in v1.0.4 for jobs that outlive the 120s sync timeout.
---

<Ask>

## Purpose

Fast single-shot query to Codex or Gemini. No planning, no review — just ask
and get an answer. Result is saved as an artifact for later reference.

Routes through the same exec adapters Atlas/Athena uses (`codex-exec` /
`gemini-exec`), with capability detection and process cleanup handled by
`scripts/ask.mjs`. No tmux required.

## Use_When

- User says "ask codex", "codex한테 물어봐", "ask gemini", "quick question"
- Need a second opinion from a different model
- Want to run Codex on a specific coding task without full Atlas pipeline
- Quick exploration or comparison between models

## Requirements

- **codex** ≥ 0.116 (`codex --version`) for codex queries — install/upgrade with
  `npm install -g @openai/codex@latest`
- **gemini** CLI for gemini queries — `npm install -g @google/gemini-cli@latest`
- At least one of the above for `/ask auto`

## Steps

### 1. Parse the request

Determine target model from user input:
- "ask codex <question>" → `<model>` = `codex`
- "ask gemini <question>" → `<model>` = `gemini`
- "ask <question>" → `<model>` = `auto` (codex preferred when both available)

### 2. Run the helper

Pipe the prompt to `scripts/ask.mjs` via a heredoc — no shell quoting needed,
multi-line prompts with backticks/quotes/`$` work as-is.

```bash
mkdir -p .ao/artifacts/ask
node scripts/ask.mjs <model> <<'ASK_PROMPT_EOF'
<the user's full question, as-is>
ASK_PROMPT_EOF
EXIT=$?
```

The helper handles capability detection, adapter selection, the
spawn → collect → shutdown lifecycle, and artifact writing. Output goes to
stdout; the artifact path is logged to stderr.

### 3. Branch on exit code

| Exit | Meaning                                  | Action                                                  |
| ---- | ---------------------------------------- | ------------------------------------------------------- |
| 0    | Success — response on stdout             | Display the response to the user                        |
| 1    | Adapter error (auth/network/crash/timeout) | Show the stderr message + artifact path                 |
| 2    | Requested model not available             | Answer the question directly as Claude, note the limitation, and suggest `/ask auto` or installing the missing CLI |
| 3    | Usage error (missing arg, empty stdin)   | Re-check the command (this is a bug in the skill caller) |

### 4. Report

Display the response to the user. The artifact lives at
`.ao/artifacts/ask/<model>-<timestamp>.md` for later reference.

## Async usage (v1.0.4+)

For long-running queries (Codex code reviews that take 2–5 minutes, deep
research passes, etc.), the sync path's 120-second `COLLECT_TIMEOUT_MS`
would SIGKILL the adapter and discard the output. The async subcommands let
you fire a job, walk away, and collect the answer later from a separate
process — no tmux wrappers, no shell-quoting gymnastics, no truncation.

### Fire a job

```bash
echo "<long review prompt>" | node scripts/ask.mjs async codex
# → {"jobId":"ask-codex-20260409-123456-ab12","artifactPath":".ao/artifacts/ask/ask-codex-20260409-123456-ab12.md","runnerPid":55123}
```

The helper allocates a `jobId`, writes metadata under
`.ao/state/ask-jobs/<jobId>.json`, detach-spawns the runner process, and
exits immediately. The runner owns the adapter lifecycle and flips metadata
when done.

### Check progress

```bash
node scripts/ask.mjs status <jobId>
# → {"status":"running","elapsedSec":47.2,"bytesOut":3012,"runnerAlive":true,...}
```

`status` reconciles against process liveness and the JSONL sentinel, so a
crashed runner that left a valid completion sentinel is still reported as
`completed`.

### Collect the answer

```bash
# Return immediately if done; exit 75 otherwise
node scripts/ask.mjs collect <jobId>

# Block until done (default 600s cap)
node scripts/ask.mjs collect <jobId> --wait

# Custom timeout
node scripts/ask.mjs collect <jobId> --wait --timeout 1800
```

Exit codes: 0 success (body on stdout) / 1 failed or cancelled / 3 unknown
jobId / 75 still running (when `--wait` is omitted or times out).

### Cancel a running job

```bash
node scripts/ask.mjs cancel <jobId>
```

Sends SIGTERM to the runner (or to the adapter directly if the runner has
already died). Idempotent — a second cancel on an already-terminal job
exits 0.

### List jobs

```bash
node scripts/ask.mjs list                          # all jobs
node scripts/ask.mjs list --status running          # only running
node scripts/ask.mjs list --older-than 3600         # older than 1h
```

### When to use async vs sync

- **Sync** (`/ask codex <query>`): quick one-off queries, <2 minutes.
  Default; no state file overhead.
- **Async** (`/ask async codex <query>` + `/ask collect <jobId> --wait`):
  Codex code reviews, deep research, anything the user might want to walk
  away from. Artifacts live at `.ao/artifacts/ask/<jobId>.md` and are
  addressable by jobId.

## Notes

- This is intentionally lightweight — no analysis, no review, no loop. For
  serious work, use `/atlas` or `/athena` instead.
- Single-shot only. The multi-turn adapters (`codex-appserver`, `gemini-acp`)
  are intentionally NOT used here — they're Atlas/Athena territory.
- Explicit model requests (`/ask codex`, `/ask gemini`) do NOT silently
  cross-fall back. If you ask for codex and codex isn't installed, you get
  exit 2 — even if gemini is available. Use `/ask auto` for "whichever works."
- Permission mirroring: both `gemini-exec` and `codex-exec` read
  `.ao/autonomy.json` and Claude's permission allow-list to determine the
  correct sandbox/approval mode. `codex-exec` mirrors host permissions to the
  Codex sandbox axis (`Bash(*)+Write(*)` → `danger-full-access`, `Write(*)` →
  `workspace-write`), with approval policy held at `never` (codex 0.118+ docs:
  *"never for non-interactive runs"*). When the host has neither `Bash(*)` nor
  `Write(*)/Edit(*)`, codex cannot run usefully — `/ask auto` transparently
  falls back to `gemini-exec` if available, and explicit `/ask codex` exits
  with code 2.
- Artifacts persist in `.ao/artifacts/ask/` for later reference.
- Can be used inside Atlas/Athena workflows for quick model consultations.

</Ask>

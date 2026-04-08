---
name: ask
description: Quick single-shot query to Codex or Gemini via the worker-adapter system, with artifact saved
level: 2
aliases: [ask, 물어봐, codex, gemini, quick-ask]
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

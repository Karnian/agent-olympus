---
name: ask
description: Quick single-shot query to Codex or Gemini via tmux, with artifact saved
level: 2
aliases: [ask, 물어봐, codex, gemini, quick-ask]
---

<Ask>

## Purpose

Fast single-shot query to Codex or Gemini. No planning, no review — just ask and get an answer.
Result is saved as an artifact for later reference.

## Use_When

- User says "ask codex", "codex한테 물어봐", "ask gemini", "quick question"
- Need a second opinion from a different model
- Want to run Codex on a specific coding task without full Atlas pipeline
- Quick exploration or comparison between models

## Steps

### 1. Parse the request

Determine target model and prompt from user input:
- "ask codex <question>" → target: codex
- "ask gemini <question>" → target: gemini
- "ask <question>" → default: codex

### 2. Spawn via tmux

```bash
# Generate unique session name
SESSION="ask-<model>-$(date +%s)"

# Spawn
tmux new-session -d -s "$SESSION" -c "<cwd>"
tmux send-keys -t "$SESSION" '<model-binary> exec "<prompt>"' Enter

# Wait and monitor
sleep 5
tmux capture-pane -pt "$SESSION" -S -200
```

Model binaries:
- codex → `codex exec "<prompt>"`
- gemini → `gemini "<prompt>"`

### 3. Collect and save result

```bash
# Capture full output
RESULT=$(tmux capture-pane -pt "$SESSION" -S -500 -p)

# Save artifact
mkdir -p .omc/artifacts/ask
echo "$RESULT" > ".omc/artifacts/ask/<model>-$(date +%Y%m%d-%H%M%S).md"

# Cleanup
tmux kill-session -t "$SESSION"
```

### 4. Report

Display the result to the user and note the saved artifact path.

## Notes

- This is intentionally lightweight — no analysis, no review, no loop
- For serious work, use `/atlas` or `/athena` instead
- Artifacts persist in `.omc/artifacts/ask/` for later reference
- Can be used inside Atlas/Athena workflows for quick model consultations

</Ask>

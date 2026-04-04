#!/bin/sh
# Agent Olympus hook runner — resolves node binary in restricted PATH environments.
# Claude Code hooks execute via /bin/sh where PATH may be minimal (e.g. /usr/bin:/bin).
# This wrapper finds node from common install locations before delegating to run.cjs.
#
# Search order: user's version manager first (nvm/volta/fnm/mise), then system paths.
# This ensures hooks run under the same Node that has codex/gemini installed globally.

# 1. nvm — most common version manager
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)
fi

# 2. volta
if [ -z "$NODE" ] && [ -x "$HOME/.volta/bin/node" ]; then
  NODE="$HOME/.volta/bin/node"
fi

# 3. fnm
if [ -z "$NODE" ] && [ -x "$HOME/.fnm/current/bin/node" ]; then
  NODE="$HOME/.fnm/current/bin/node"
fi

# 4. mise (formerly rtx)
if [ -z "$NODE" ] && [ -d "$HOME/.local/share/mise/installs/node" ]; then
  NODE=$(ls -d "$HOME"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | tail -1)
fi

# 5. System paths (homebrew ARM, homebrew Intel / manual, system)
if [ -z "$NODE" ]; then
  for dir in /opt/homebrew/bin /usr/local/bin /usr/bin; do
    if [ -x "$dir/node" ]; then
      NODE="$dir/node"
      break
    fi
  done
fi

# Last resort: bare `node` — if this also fails, hook exits cleanly
if [ -z "$NODE" ]; then
  NODE="node"
fi

# Resolve SCRIPT_DIR for run.cjs (same directory as this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Delegate to run.cjs with all arguments
exec "$NODE" "$SCRIPT_DIR/run.cjs" "$@"

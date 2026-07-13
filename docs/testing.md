# Testing
> Moved verbatim from CLAUDE.md (Codex Interop v1, Ship order 1).

Run `node scripts/check-agents-size.mjs` to verify `AGENTS.md` stays under the 28 KiB shared-instruction budget.

## Testing

```bash
# Run unit tests (2704 tests, 108 files; current branch: 2704/2704 passing)
npm test

# Or invoke the cross-platform Node test enumerator directly
node scripts/run-tests.mjs

# Syntax check all scripts
for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f" && echo "OK: $f"; done

# Check for stale namespace references
grep -r "oh-my-claude:" agents/ skills/ scripts/ config/   # should return nothing
grep -r "oh-my-claudecode:" skills/ agents/                 # should return nothing
grep -r '\.omc/' scripts/ skills/ agents/                   # should return nothing
```

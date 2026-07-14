# Testing
> Moved verbatim from CLAUDE.md (Codex Interop v1, Ship order 1).

Run `node scripts/check-agents-size.mjs` to verify `AGENTS.md` stays under the 28 KiB shared-instruction budget.

## Testing

```bash
# Run unit tests (2851 tests, 108 files; v1.5.1: 2851/2851 passing)
npm test

# Or invoke the cross-platform Node test enumerator directly
node scripts/run-tests.mjs

# Syntax check all scripts
npm run check

# Verify the committed hermetic eval contract (never spawns live workers)
node evals/verify-baseline.mjs
node evals/verify-fixtures.mjs

# Release metadata and shared-instruction gates
node scripts/check-version-sync.mjs
claude plugin validate .
node scripts/check-agents-size.mjs
git diff --check

# Check for stale namespace references
grep -r "oh-my-claude:" agents/ skills/ scripts/ config/   # should return nothing
grep -r "oh-my-claudecode:" skills/ agents/                 # should return nothing
grep -r '\.omc/' scripts/ skills/ agents/                   # should return nothing
```

The pull-request workflow runs the same unit, baseline, and fixture gates when
the PR has the `run-evals` label. Live Atlas/Athena evals are paid,
operator-controlled runs and are intentionally excluded from CI.

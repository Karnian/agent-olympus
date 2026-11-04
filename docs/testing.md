# Testing
> Moved verbatim from CLAUDE.md (Codex Interop v1, Ship order 1).

Run `node scripts/check-agents-size.mjs` to verify `AGENTS.md` stays under the 28 KiB shared-instruction budget.

## Testing

```bash
# Run unit tests (v1.6.2: 3376 tests, 142 files; v1.6.1: 3354 tests, 135 files)
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

The v1.6.2 local suite passed all 3376 tests. Linux CI passed 3375 and skipped
one platform-specific test, with zero failures. Managed runtime regressions cover
fresh batch MCP attachments, cross-provider option isolation, failed-wave cleanup
without replay, orphan reconciliation, parallel child admission, and parent-death
cancellation. Provider startup/transport checks did not start model task turns;
full model-driven delegation and attempted native spawning remain separate checks.

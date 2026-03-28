#!/usr/bin/env node

/**
 * Agent Olympus Stop Hook - automatic WIP commit on session end
 *
 * When Claude Code terminates a session, this hook checks for uncommitted
 * changes and creates a WIP commit so work-in-progress is never lost.
 *
 * Role boundary:
 *   - This hook: temporary save (ao-wip commits)
 *   - git-master agent: final clean commit after task completion
 *
 * Never blocks session termination: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { loadCheckpoint } from './lib/checkpoint.mjs';
import { execSync, execFileSync } from 'child_process';

async function main() {
  try {
    await readStdin(2000); // Stop event data (not needed)

    // 1. Confirm we are inside a git repo
    try {
      execSync('git rev-parse --git-dir', { stdio: 'pipe' });
    } catch {
      process.stdout.write('{}');
      process.exit(0);
    }

    // 2. Check for any uncommitted changes
    const status = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    if (!status) {
      // Nothing to commit
      process.stdout.write('{}');
      process.exit(0);
    }

    // 3. Skip if Atlas/Athena is in a final phase (phase >= 5)
    //    git-master will handle the proper commit in that case
    const [atlasCP, athenaCP] = await Promise.all([
      loadCheckpoint('atlas'),
      loadCheckpoint('athena'),
    ]);
    const cp = atlasCP || athenaCP;
    if (cp && cp.phase >= 5) {
      // Final phase — let git-master do the commit
      process.stdout.write('{}');
      process.exit(0);
    }

    // 4. Build commit metadata
    const phase = cp ? `phase-${cp.phase}` : 'manual';
    const fileCount = status.split('\n').filter(Boolean).length;

    // Stage everything
    execSync('git add -A', { stdio: 'pipe' });

    // Verify something is actually staged (edge case: all changes were untrackable)
    const staged = execSync('git diff --cached --name-only', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    if (!staged) {
      process.stdout.write('{}');
      process.exit(0);
    }

    // 5. Create the WIP commit (use execFileSync to avoid shell injection)
    const message = `ao-wip(${phase}): auto-save ${fileCount} file(s) before session end`;
    execFileSync('git', ['commit', '-m', message], { stdio: 'pipe' });

  } catch {
    // Fail-safe: never block session termination under any circumstances
  }

  process.stdout.write('{}');
  process.exit(0);
}

main();

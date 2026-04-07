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
import { execFileSync } from 'child_process';
import { basename } from 'path';

/**
 * Build a descriptive WIP commit message from staged file paths.
 *
 * @param {string} phase - 'manual' or 'phase-N'
 * @param {string} stagedOutput - newline-separated staged file paths (from git diff --cached --name-only)
 * @returns {string} Multi-line commit message: subject + optional body
 */
function buildWipMessage(phase, stagedOutput) {
  try {
    const files = stagedOutput.split('\n').filter(Boolean);
    if (files.length === 0) {
      return `ao-wip(${phase}): auto-save before session end`;
    }

    // Get name-status for richer info (A=added, M=modified, D=deleted)
    let nameStatus;
    try {
      nameStatus = execFileSync('git', ['diff', '--cached', '--name-status'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      nameStatus = '';
    }

    // Parse status entries
    const added = [];
    const modified = [];
    const deleted = [];

    if (nameStatus) {
      for (const line of nameStatus.split('\n').filter(Boolean)) {
        const tab = line.indexOf('\t');
        if (tab === -1) continue;
        const status = line.slice(0, tab).trim();
        const filePath = line.slice(tab + 1).trim();
        const name = basename(filePath);
        if (status.startsWith('A')) added.push(name);
        else if (status.startsWith('D')) deleted.push(name);
        else modified.push(name);
      }
    } else {
      // Fallback: treat all as modified
      for (const f of files) modified.push(basename(f));
    }

    // Build subject line (max ~72 chars)
    const parts = [];
    if (added.length > 0) parts.push(`add ${formatNames(added)}`);
    if (modified.length > 0) parts.push(`update ${formatNames(modified)}`);
    if (deleted.length > 0) parts.push(`remove ${formatNames(deleted)}`);

    let subject = `ao-wip(${phase}): ${parts.join(', ')}`;
    if (subject.length > 72) {
      // Shorten: just use counts
      const counts = [];
      if (added.length > 0) counts.push(`+${added.length} new`);
      if (modified.length > 0) counts.push(`~${modified.length} modified`);
      if (deleted.length > 0) counts.push(`-${deleted.length} deleted`);
      subject = `ao-wip(${phase}): ${files.length} file(s) — ${counts.join(', ')}`;
    }

    // Build body with full file list when more than 3 files
    if (files.length <= 3) return subject;

    const body = files.map(f => `  ${f}`).join('\n');
    return `${subject}\n\nFiles:\n${body}`;
  } catch {
    // Fallback: simple message
    return `ao-wip(${phase}): auto-save before session end`;
  }
}

/**
 * Format a list of file names for the subject line.
 * Shows up to 3 names, then "+N more".
 */
function formatNames(names) {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} (+${names.length - 2} more)`;
}

async function main() {
  try {
    await readStdin(2000); // Stop event data (not needed)

    // 1. Confirm we are inside a git repo
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'pipe' });
    } catch {
      process.stdout.write('{}');
      process.exit(0);
    }

    // 2. Check for any uncommitted changes
    const status = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
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

    // Stage tracked modified/deleted files (safer than git add -A)
    // This avoids staging: .env, secrets, .ao/state/ files
    // Pathspec excludes .claude/worktrees/* gitlinks (HEAD pointer noise from
    // Claude Code worktrees that change every session but aren't real work)
    execFileSync(
      'git',
      ['add', '-u', '--', '.', ':(exclude,glob).claude/worktrees/**'],
      { stdio: 'pipe' }
    );

    // Also stage new files, but exclude sensitive patterns
    const untrackedRaw = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (untrackedRaw) {
      const EXCLUDE_PATTERNS = [
        /^\.env/,
        /^\.ao\/state\//,
        /^\.ao\/teams\//,
        /^\.claude\/worktrees\//,
        /credentials/i,
        /secret/i,
        /\.key$/,
        /\.pem$/,
      ];

      const safeFiles = untrackedRaw.split('\n').filter(f => {
        return f && !EXCLUDE_PATTERNS.some(pat => pat.test(f));
      });

      if (safeFiles.length > 0) {
        execFileSync('git', ['add', '--', ...safeFiles], { stdio: 'pipe' });
      }
    }

    // Verify something is actually staged (edge case: all changes were untrackable)
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!staged) {
      process.stdout.write('{}');
      process.exit(0);
    }

    // 5. Build a descriptive WIP commit message from staged changes
    const message = buildWipMessage(phase, staged);
    execFileSync('git', ['commit', '-m', message], { stdio: 'pipe' });

  } catch {
    // Fail-safe: never block session termination under any circumstances
  }

  process.stdout.write('{}');
  process.exit(0);
}

main();

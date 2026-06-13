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
import { existsSync } from 'fs';
import { basename, join } from 'path';

/**
 * Sensitive / noise path patterns that must never be auto-staged into a WIP
 * commit. Applied identically to tracked modifications, untracked additions,
 * and (as a final net) the already-staged index — a single source of truth so
 * a secret cannot slip through one path while being blocked on another.
 *
 * Erring toward over-exclusion is deliberate: a false positive only leaves a
 * file out of the auto-save (it stays in the working tree), whereas a false
 * negative could commit — and a later autoPush // /finish-branch could push —
 * a live credential.
 *
 * Detection is NAME-based and intentionally case-insensitive for credential
 * file types (a `.PEM`/`.KEY` is as sensitive as a `.pem`). The name filter is
 * backstopped by a CONTENT (blob-hash) net — `unstageStagedStolenBlobs()` —
 * that catches a secret whose bytes are copied/renamed into an innocuously-
 * named file (`mv .env public.txt`): the safe-named blob hash matches a known
 * secret blob and is unstaged. Residual gap: a secret that was NEVER tracked
 * (no HEAD blob to match) and is renamed to a safe name still escapes both
 * nets — out of scope for this throwaway WIP hook.
 */
const EXCLUDE_PATTERNS = [
  /(^|\/)\.env/i,           // .env, .env.local, .env.production … at any depth
  /^\.ao\/state\//,         // transient hook state
  /^\.ao\/teams\//,         // tmux team inbox/outbox
  /^\.claude\/worktrees\//, // Claude Code worktree gitlink noise
  /credentials/i,
  /secret/i,
  /\.key$/i,
  /\.pem$/i,
  /(^|\/)\.npmrc$/i,        // npm authToken
  /(^|\/)\.netrc$/i,        // machine login credentials
  /(^|\/)id_rsa/i,          // SSH private keys (id_rsa, id_rsa.pub …)
  /\.p12$/i,                // PKCS#12 keystore
  /\.pfx$/i,                // PKCS#12 keystore (Windows)
  /token/i,                 // *token* — auth tokens
];

/** True if `file` matches any sensitive/noise exclusion pattern. */
function isExcluded(file) {
  return EXCLUDE_PATTERNS.some(pat => pat.test(file));
}

/** Split NUL-delimited git output (`-z`) into clean path entries. */
function splitZ(raw) {
  return String(raw).split('\0').filter(Boolean);
}

/**
 * Inspect the staged index and return the paths to unstage so no secret CONTENT
 * is committed — an add / modify / type-change / rename-or-copy target whose
 * path matches EXCLUDE_PATTERNS, OR a rename/copy whose ORIGINAL path did (a
 * secret renamed to an innocuous name still carries secret content while the
 * rename pair is staged; both halves are returned so the deletion diff is
 * dropped too). Standalone deletions are ignored: removing a file exposes no
 * new content, and the user may legitimately be deleting a secret.
 *
 * Uses `--name-status -M -z` so (a) renames are detected regardless of the
 * user's `diff.renames` config and (b) non-ASCII paths stay raw instead of
 * being octal-quoted (which would slip past the suffix patterns). Returns
 * `null` when the index cannot be read, so callers can fail CLOSED.
 *
 * Limitation: once a secret is renamed to an innocuous name AND unstaged, git
 * keeps no rename signal, so a path-pattern hook can no longer recognise it.
 * This catches the staged-rename window, not that residual case.
 */
function listStagedSensitive() {
  let raw;
  try {
    raw = execFileSync('git', ['diff', '--cached', '--name-status', '-M', '-z'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  const tok = raw.split('\0');
  const sensitive = [];
  let i = 0;
  while (i < tok.length) {
    const status = tok[i];
    if (!status) { i++; continue; }
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = tok[i + 1];
      const newPath = tok[i + 2];
      i += 3;
      if (newPath && (isExcluded(newPath) || isExcluded(oldPath))) {
        sensitive.push(newPath);
        // Also unstage the deletion half of a rename so the secret value does
        // not surface as a removed-lines diff in the WIP commit.
        if (oldPath) sensitive.push(oldPath);
      }
    } else {
      const p = tok[i + 1];
      i += 2;
      // 'D' = deletion: removing a file leaks no content, so never flag it.
      if (p && status[0] !== 'D' && isExcluded(p)) sensitive.push(p);
    }
  }
  return sensitive;
}

/**
 * Unstage `paths` from the index, leaving the working tree intact. Handles an
 * unborn HEAD (no commits yet) where `git reset HEAD` is unavailable; there,
 * `git rm -f --cached` force-removes the entry (`-f` overrides git's
 * "staged content differs" guard that otherwise leaves the secret staged).
 */
function unstagePaths(paths) {
  if (!paths || paths.length === 0) return;
  let hasHead = true;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { stdio: 'pipe' });
  } catch {
    hasHead = false;
  }
  try {
    if (hasHead) {
      execFileSync('git', ['reset', '-q', 'HEAD', '--', ...paths], { stdio: 'pipe' });
    } else {
      execFileSync('git', ['rm', '-q', '-f', '--cached', '--', ...paths], { stdio: 'pipe' });
    }
  } catch {
    // Best-effort; the fail-closed re-check in main() is the real guarantee.
  }
}

/**
 * Content-identity net for the rename/copy-to-safe-name bypass: a tracked
 * secret whose BYTES are moved into an innocuously-named file escapes the
 * name filter (the safe name matches no EXCLUDE_PATTERN, and the rename pair is
 * not both staged so `-M` can't pair them). Collect the blob hashes of every
 * EXCLUDE_PATTERNS file in HEAD, then unstage any staged entry whose blob hash
 * matches but whose PATH is not itself excluded — i.e. secret content surfacing
 * under a safe name. Catches `mv .env safe.txt` and `cp .env safe.txt`
 * (byte-identical content).
 *
 * Fail-safe: returns [] on any git error (the name net + fail-closed re-check
 * in main() still apply); never throws.
 *
 * @returns {string[]} paths unstaged
 */
function unstageStagedStolenBlobs() {
  let secretShas;
  try {
    // Every blob in HEAD whose path matches an exclusion pattern. `-z` keeps
    // paths raw (no octal quoting); format: "<mode> <type> <sha>\t<path>".
    const tree = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    secretShas = new Set();
    for (const ent of tree.split('\0')) {
      if (!ent) continue;
      const tab = ent.indexOf('\t');
      if (tab === -1) continue;
      const sha = ent.slice(0, tab).split(' ')[2];
      const path = ent.slice(tab + 1);
      if (sha && isExcluded(path)) secretShas.add(sha);
    }
  } catch {
    return [];
  }
  if (secretShas.size === 0) return [];

  let stagedRaw;
  try {
    // Staged entries with blob shas; format: "<mode> <sha> <stage>\t<path>".
    stagedRaw = execFileSync('git', ['ls-files', '-s', '-z'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  const toUnstage = [];
  for (const ent of stagedRaw.split('\0')) {
    if (!ent) continue;
    const tab = ent.indexOf('\t');
    if (tab === -1) continue;
    const sha = ent.slice(0, tab).split(' ')[1];
    const path = ent.slice(tab + 1);
    // Secret CONTENT under a path the name filter did not catch.
    if (sha && secretShas.has(sha) && !isExcluded(path)) toUnstage.push(path);
  }
  if (toUnstage.length > 0) unstagePaths(toUnstage);
  return toUnstage;
}

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

    // 1. Confirm we are inside a git repo and resolve its git dir
    let gitDir;
    try {
      gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      process.stdout.write('{}');
      process.exit(0);
    }
    if (!gitDir) gitDir = '.git';

    // 1.5 Skip the WIP commit while a merge / rebase / cherry-pick / revert is
    //     in progress. `git commit -m` would otherwise silently finalize a
    //     half-resolved operation. Let the user finish (or abort) it first.
    const IN_PROGRESS_MARKERS = [
      'MERGE_HEAD',
      'rebase-merge',
      'rebase-apply',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
    ];
    if (IN_PROGRESS_MARKERS.some(marker => existsSync(join(gitDir, marker)))) {
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

    // Stage tracked modifications/deletions, EXCLUDING sensitive files.
    // `git add -u` stages EVERY tracked change — including a tracked
    // .env / credentials / *.key that was committed earlier — which previously
    // leaked secrets into the WIP commit (and autoPush // /finish-branch could
    // then push them). Instead, enumerate tracked working-tree changes (`-z`
    // keeps non-ASCII paths raw so the patterns match) and filter them through
    // the shared EXCLUDE_PATTERNS before an explicit add. (.claude/worktrees/
    // gitlink noise is covered by EXCLUDE_PATTERNS too.)
    let trackedChanged = '';
    try {
      trackedChanged = execFileSync('git', ['diff', '--name-only', '-z'], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      trackedChanged = '';
    }
    const safeTracked = splitZ(trackedChanged).filter(f => !isExcluded(f));
    if (safeTracked.length > 0) {
      execFileSync('git', ['add', '--', ...safeTracked], { stdio: 'pipe' });
    }

    // Also stage new (untracked) files, applying the SAME exclusions.
    let untrackedRaw = '';
    try {
      untrackedRaw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      untrackedRaw = '';
    }
    const safeUntracked = splitZ(untrackedRaw).filter(f => !isExcluded(f));
    if (safeUntracked.length > 0) {
      execFileSync('git', ['add', '--', ...safeUntracked], { stdio: 'pipe' });
    }

    // Final safety net (fail CLOSED). Re-examine the staged index — rename pairs
    // and non-ASCII paths included — for anything that would leak secret content
    // by another route: pre-staged by the user, a `git mv` of a secret, etc.
    // Unstage offenders, then re-check. If any sensitive entry still remains, or
    // the index cannot be verified, SKIP the commit entirely rather than risk a
    // leak (this hook is a throwaway save, not the user's deliberate commit).
    // Content-identity net (runs BEFORE the name/rename net): unstage secret
    // BYTES surfacing under a safe name (mv/cp of a tracked secret), which the
    // name filter and staged-rename detection both miss. Best-effort.
    unstageStagedStolenBlobs();

    let sensitive = listStagedSensitive();
    if (sensitive && sensitive.length > 0) {
      unstagePaths(sensitive);
      sensitive = listStagedSensitive();
    }
    if (sensitive === null || sensitive.length > 0) {
      process.stdout.write('{}');
      process.exit(0);
    }

    // Verify something is actually staged (edge case: everything was excluded).
    let stagedZ = '';
    try {
      stagedZ = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      stagedZ = '';
    }
    const stagedList = splitZ(stagedZ);
    if (stagedList.length === 0) {
      process.stdout.write('{}');
      process.exit(0);
    }

    // 5. Build a descriptive WIP commit message from staged changes
    const message = buildWipMessage(phase, stagedList.join('\n'));
    execFileSync('git', ['commit', '-m', message], { stdio: 'pipe' });

  } catch {
    // Fail-safe: never block session termination under any circumstances
  }

  process.stdout.write('{}');
  process.exit(0);
}

main();

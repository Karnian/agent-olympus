/**
 * PR Create — helpers for creating GitHub pull requests via the gh CLI.
 *
 * All execFileSync calls are wrapped in try/catch. No function ever throws.
 * Callers receive structured result objects on both success and failure.
 */

import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a command with execFileSync and return its stdout as a trimmed string.
 * Returns null on any error.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string|null}
 */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Verify that the environment satisfies all preconditions for opening a PR:
 *   1. gh CLI is on PATH
 *   2. gh is authenticated
 *   3. A git remote named "origin" exists
 *   4. The current branch is not "main" or "master"
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function preflightCheck() {
  try {
    const errors = [];

    // 1. gh CLI present
    const ghPath = run('which', ['gh']);
    if (!ghPath) {
      errors.push('gh CLI not found');
    }

    // 2. gh authenticated (only check if gh exists)
    if (ghPath) {
      const authOut = run('gh', ['auth', 'status']);
      if (authOut === null) {
        errors.push('gh not authenticated');
      }
    }

    // 3. git remote origin exists
    const remoteUrl = run('git', ['remote', 'get-url', 'origin']);
    if (remoteUrl === null) {
      errors.push('no git remote');
    }

    // 4. not on base branch
    const branch = run('git', ['branch', '--show-current']);
    if (branch === 'main' || branch === 'master') {
      errors.push('on base branch');
    }

    return { ok: errors.length === 0, errors };
  } catch {
    return { ok: false, errors: ['preflightCheck threw an unexpected error'] };
  }
}

/**
 * Parse text for GitHub issue references and return a deduplicated, sorted
 * array of issue numbers.
 *
 * Recognised patterns:
 *   - Inline: #42, fixes #42, closes #42, resolves #42  (case-insensitive)
 *   - Branch-style: feat/42-description → 42
 *
 * @param {string} text
 * @returns {number[]}
 */
export function extractIssueRefs(text) {
  try {
    if (!text || typeof text !== 'string') return [];

    const found = new Set();

    // Inline patterns: optional keyword + #N
    const inlineRe = /(?:(?:fixes|closes|resolves)\s+)?#(\d+)/gi;
    let m;
    while ((m = inlineRe.exec(text)) !== null) {
      found.add(Number(m[1]));
    }

    // Branch-style: word/NUMBER-anything  e.g. feat/42-some-description
    const branchRe = /\b[a-z][\w-]*\/(\d+)-/gi;
    while ((m = branchRe.exec(text)) !== null) {
      found.add(Number(m[1]));
    }

    return [...found].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Build a markdown PR body from structured data.
 *
 * @param {{
 *   prd: { projectName: string, userStories: Array<{ id: string|number, title: string, passes: boolean }> },
 *   diffStat: string,
 *   verifyResults: string
 * }} opts
 * @returns {string}
 */
export function buildPRBody({ prd, diffStat, verifyResults }) {
  try {
    const projectName = prd?.projectName ?? 'Unnamed Project';
    const userStories = Array.isArray(prd?.userStories) ? prd.userStories : [];

    const storiesSection = userStories.length > 0
      ? userStories.map(s => {
          const icon = s.passes ? '[x]' : '[ ]';
          return `- ${icon} **${s.id}**: ${s.title}`;
        }).join('\n')
      : '_No user stories recorded._';

    const changesSection = diffStat
      ? '```\n' + diffStat.trim() + '\n```'
      : '_No diff stat available._';

    const verifySection = verifyResults
      ? '```\n' + verifyResults.trim() + '\n```'
      : '_No verification results available._';

    return [
      `## Summary`,
      ``,
      `Changes for **${projectName}**.`,
      ``,
      `## Stories`,
      ``,
      storiesSection,
      ``,
      `## Changes`,
      ``,
      changesSection,
      ``,
      `## Verification`,
      ``,
      verifySection,
    ].join('\n');
  } catch {
    return '## Summary\n\n_PR body generation failed._';
  }
}

/**
 * Check whether an open PR already exists for the given branch.
 *
 * @param {string} branch
 * @returns {{ found: boolean, prUrl?: string, prNumber?: number }}
 */
export function findExistingPR(branch) {
  try {
    const output = run('gh', [
      'pr', 'list',
      '--head', branch,
      '--json', 'number,url',
      '--limit', '1',
    ]);

    if (output === null) return { found: false };

    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      return { found: false };
    }

    if (!Array.isArray(parsed) || parsed.length === 0) return { found: false };

    const { number: prNumber, url: prUrl } = parsed[0];
    return { found: true, prUrl, prNumber };
  } catch {
    return { found: false };
  }
}

/**
 * Create a new pull request via `gh pr create`.
 *
 * @param {{
 *   title: string,
 *   body: string,
 *   baseBranch: string,
 *   draft?: boolean,
 *   labels?: string[]
 * }} opts
 * @returns {{ ok: boolean, prUrl?: string, error?: string }}
 */
export function createPR({ title, body, baseBranch, draft = false, labels = [] }) {
  try {
    const args = [
      'pr', 'create',
      '--title', title,
      '--body', body,
      '--base', baseBranch,
    ];

    if (draft) {
      args.push('--draft');
    }

    // Add one --label flag per label entry
    for (const label of (labels ?? [])) {
      args.push('--label', label);
    }

    let output;
    try {
      output = execFileSync('gh', args, { encoding: 'utf8' }).trim();
    } catch (err) {
      const message = err?.stderr?.trim() || err?.message || 'gh pr create failed';
      return { ok: false, error: message };
    }

    // gh pr create outputs the PR URL as the last line
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
    const prUrl = lines.find(l => l.startsWith('https://')) ?? lines[lines.length - 1];

    return { ok: true, prUrl };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'createPR threw an unexpected error' };
  }
}

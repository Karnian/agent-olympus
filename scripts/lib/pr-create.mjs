/**
 * PR Create — helpers for creating GitHub pull requests via the gh CLI.
 *
 * All execFileSync calls are wrapped in try/catch. No function ever throws.
 * Callers receive structured result objects on both success and failure.
 */

import { execFileSync as nodeExecFileSync } from 'child_process';
import {
  resolveTrustedVcsBinary,
  sanitizedVcsEnvironment,
} from './trusted-vcs.mjs';

let _execFileSync = nodeExecFileSync;

function executable(command) {
  return _execFileSync === nodeExecFileSync
    ? resolveTrustedVcsBinary(command)
    : command;
}

function commandOptions(command, cwd, extra = {}) {
  return {
    encoding: 'utf8',
    cwd,
    ...(_execFileSync === nodeExecFileSync
      ? { env: sanitizedVcsEnvironment({ git: command === 'git' }) }
      : {}),
    ...extra,
  };
}

/** @param {typeof nodeExecFileSync} fn */
export function __setExecFileSyncForTest(fn) {
  _execFileSync = fn;
}

export function __resetForTest() {
  _execFileSync = nodeExecFileSync;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a command with execFileSync and return its stdout as a trimmed string.
 * Returns null on any error.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string|null}
 */
function run(cmd, args, cwd) {
  try {
    const repoCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    return _execFileSync(
      executable(cmd),
      args,
      commandOptions(cmd, repoCwd),
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Parse a Git remote URL into the explicit repository selector accepted by
 * `gh --repo`. Keeping this derived from origin prevents GH_REPO or ambient gh
 * state from silently redirecting PR operations to a different repository.
 *
 * @param {unknown} originUrl
 * @returns {{ host: string, nameWithOwner: string, repository: string, canonicalOriginUrl: string }|null}
 */
function parseOriginRepository(originUrl) {
  try {
    if (typeof originUrl !== 'string' || !originUrl.trim()) return null;
    const value = originUrl.trim();
    let host = '';
    let pathname = '';
    let urlRecord = null;
    let scpUser = '';

    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      urlRecord = new URL(value);
      if (!new Set(['https:', 'http:', 'ssh:', 'git:']).has(urlRecord.protocol.toLowerCase())) {
        return null;
      }
      host = urlRecord.host;
      pathname = urlRecord.pathname;
    } else {
      const scpLike = value.match(/^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/);
      if (!scpLike) return null;
      [, scpUser = '', host, pathname] = scpLike;
    }

    const segments = pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (!host || segments.length !== 2 || segments.some(part => /\s/.test(part))) {
      return null;
    }

    const normalizedHost = host.toLowerCase();
    const nameWithOwner = `${segments[0]}/${segments[1]}`;
    const repository = `${normalizedHost}/${nameWithOwner}`;
    let canonicalOriginUrl;
    if (urlRecord) {
      const protocol = urlRecord.protocol.toLowerCase();
      // HTTP credentials are secrets and must never enter run artifacts. SSH
      // user names are routing data, so retain them while dropping passwords.
      const sshUser = protocol === 'ssh:' && urlRecord.username
        ? `${urlRecord.username}@`
        : '';
      canonicalOriginUrl = `${protocol}//${sshUser}${urlRecord.host.toLowerCase()}/${nameWithOwner}.git`;
    } else {
      canonicalOriginUrl = `${scpUser ? `${scpUser}@` : ''}${normalizedHost}:${nameWithOwner}.git`;
    }
    return {
      host: normalizedHost,
      nameWithOwner,
      repository,
      canonicalOriginUrl,
    };
  } catch {
    return null;
  }
}

/**
 * Read GitHub metadata for the repository named by origin, never by ambient
 * GH_REPO state. The returned repository spelling is canonicalized through gh.
 *
 * @param {string} repoCwd
 * @param {string|null} originUrl
 * @param {string|null} [pushUrls]
 * @returns {{ defaultBranch: string, repoIdentity: { originUrl: string, pushUrl: string, repository: string, defaultBranch: string } }|null}
 */
function readGitHubRepositoryMetadata(repoCwd, originUrl, pushUrls = originUrl) {
  try {
    const parsedOrigin = parseOriginRepository(originUrl);
    const pushUrlList = typeof pushUrls === 'string'
      ? pushUrls.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
      : [];
    if (!parsedOrigin || pushUrlList.length !== 1) return null;
    const parsedPush = parseOriginRepository(pushUrlList[0]);
    if (!parsedPush
      || parsedPush.repository.toLowerCase() !== parsedOrigin.repository.toLowerCase()) {
      return null;
    }
    const output = run('gh', [
      'repo', 'view', parsedOrigin.repository,
      '--json', 'defaultBranchRef,nameWithOwner',
    ], repoCwd);
    if (!output) return null;

    const metadata = JSON.parse(output);
    const defaultBranch = metadata?.defaultBranchRef?.name;
    const canonicalName = metadata?.nameWithOwner;
    if (typeof defaultBranch !== 'string' || !defaultBranch.trim()
      || typeof canonicalName !== 'string' || !canonicalName.trim()
      || canonicalName.toLowerCase() !== parsedOrigin.nameWithOwner.toLowerCase()) {
      return null;
    }

    const repository = `${parsedOrigin.host}/${canonicalName.trim()}`;
    return {
      defaultBranch: defaultBranch.trim(),
      repoIdentity: {
        originUrl: parsedOrigin.canonicalOriginUrl,
        pushUrl: parsedPush.canonicalOriginUrl,
        repository,
        defaultBranch: defaultBranch.trim(),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the current origin plus canonical GitHub repository identity.
 * Returns null on missing/unsupported remotes, gh failures, or identity drift.
 *
 * @param {string} [cwd]
 * @returns {{ originUrl: string, pushUrl: string, repository: string, defaultBranch: string }|null}
 */
export function detectRepositoryIdentity(cwd) {
  try {
    const repoCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    const originUrl = run('git', ['remote', 'get-url', 'origin'], repoCwd);
    const pushUrls = run('git', ['remote', 'get-url', '--push', '--all', 'origin'], repoCwd);
    return readGitHubRepositoryMetadata(repoCwd, originUrl, pushUrls)?.repoIdentity ?? null;
  } catch {
    return null;
  }
}

/** @param {unknown} left @param {unknown} right @returns {boolean} */
export function repositoryIdentitiesEqual(left, right) {
  try {
    return typeof left?.originUrl === 'string'
      && typeof left?.repository === 'string'
      && typeof left?.defaultBranch === 'string'
      && typeof left?.pushUrl === 'string'
      && left.originUrl.length > 0
      && left.repository.length > 0
      && left.defaultBranch.length > 0
      && left.pushUrl.length > 0
      && left.originUrl === right?.originUrl
      && left.pushUrl === right?.pushUrl
      && left.repository === right?.repository
      && left.defaultBranch === right?.defaultBranch;
  } catch {
    return false;
  }
}

/**
 * Validate that a gh-returned URL is a pull request in the pinned repository.
 * A host-qualified selector is preferred; owner/repo remains accepted as a
 * compatibility shorthand for github.com.
 *
 * @param {unknown} candidateUrl
 * @param {unknown} repository
 * @returns {boolean}
 */
function isPullRequestUrl(candidateUrl, repository) {
  try {
    if (typeof candidateUrl !== 'string' || !candidateUrl.trim()) return false;
    if (typeof repository !== 'string' || !repository.trim() || /\s/.test(repository)) {
      return false;
    }
    const parsedUrl = new URL(candidateUrl.trim());
    if (parsedUrl.protocol !== 'https:') return false;
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    if (pathParts.length !== 4 || pathParts[2] !== 'pull' || !/^\d+$/.test(pathParts[3])) {
      return false;
    }
    const repoParts = repository.split('/').filter(Boolean);
    const target = repoParts.length === 2
      ? ['github.com', repoParts[0], repoParts[1]]
      : repoParts;
    if (target.length !== 3) return false;
    const [expectedHost, expectedOwner, expectedRepo] = target;
    return parsedUrl.host.toLowerCase() === expectedHost.toLowerCase()
      && pathParts[0].toLowerCase() === expectedOwner.toLowerCase()
      && pathParts[1].toLowerCase() === expectedRepo.toLowerCase();
  } catch {
    return false;
  }
}

/** @param {string} repoCwd @param {unknown} repository @returns {string|null} */
function resolvePinnedRepository(repoCwd, repository) {
  if (repository !== null && repository !== undefined) {
    if (typeof repository !== 'string' || !repository.trim() || /\s/.test(repository)) {
      return null;
    }
    const parts = repository.trim().split('/').filter(Boolean);
    if (parts.length === 2) return `github.com/${parts.join('/')}`;
    return parts.length === 3 ? parts.join('/') : null;
  }
  return detectRepositoryIdentity(repoCwd)?.repository ?? null;
}

/**
 * Normalize a same-repository Git branch name for outbound PR creation.
 * This mirrors the safety-relevant `git check-ref-format --branch` rules
 * without consulting checkout state or allowing gh's `owner:branch` syntax.
 *
 * @param {unknown} branch
 * @returns {string|null}
 */
function normalizeHeadBranch(branch) {
  if (typeof branch !== 'string') return null;
  const normalized = branch.trim();
  if (!normalized
    || normalized === 'HEAD'
    || normalized.startsWith('-')
    || normalized.startsWith('/')
    || normalized.endsWith('/')
    || normalized.endsWith('.')
    || normalized.includes('..')
    || normalized.includes('@{')
    || normalized.includes('//')
    || normalized.includes('[')
    || normalized.includes('\\')
    || /[\x00-\x20\x7f~^:?*]/.test(normalized)) {
    return null;
  }
  const components = normalized.split('/');
  if (components.some(component => (
    !component
    || component.startsWith('.')
    || component.endsWith('.lock')
  ))) {
    return null;
  }
  return normalized;
}

/** @param {string} repoCwd @returns {string|null} */
function detectOriginDefaultBranch(repoCwd) {
  const symbolicRef = run(
    'git',
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    repoCwd,
  );
  const prefix = 'refs/remotes/origin/';
  if (!symbolicRef?.startsWith(prefix)) return null;
  const branch = symbolicRef.slice(prefix.length).trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

/**
 * Detect the pull request base branch without throwing.
 *
 * Resolution order: explicit override, GitHub default branch, origin/HEAD,
 * then the conservative historical fallback `main`. GitHub is authoritative
 * when available because the local origin/HEAD symbolic ref can be stale after
 * a repository default-branch change.
 *
 * @param {string} [cwd]
 * @param {string|null} [override]
 * @returns {string}
 */
export function detectBaseBranch(cwd, override = null) {
  try {
    if (typeof override === 'string' && override.trim()) return override.trim();
    const repoCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();

    const originUrl = run('git', ['remote', 'get-url', 'origin'], repoCwd);
    const githubMetadata = readGitHubRepositoryMetadata(repoCwd, originUrl, originUrl);
    if (githubMetadata) return githubMetadata.defaultBranch;

    const originDefault = detectOriginDefaultBranch(repoCwd);
    if (originDefault) return originDefault;
  } catch {
    // Fall through to the safe historical default.
  }
  return 'main';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Verify that the environment satisfies all preconditions for opening a PR:
 *   1. gh CLI is on PATH
 *   2. gh is authenticated
 *   3. A git remote named "origin" exists
 *   4. origin has exactly one credential-free, same-repository push target
 *   5. The current branch can be determined and is not the resolved PR base
 *
 * The object form is preferred. The legacy positional form
 * `preflightCheck(cwd, baseBranch)` remains supported for compatibility.
 *
 * @param {{ cwd?: string, baseBranch?: string|null }|string} [options]
 * @param {string|null} [legacyBaseBranch]
 * @returns {{ ok: boolean, errors: string[], repoIdentity?: { originUrl: string, pushUrl: string, repository: string, defaultBranch: string } }}
 */
export function preflightCheck(options = {}, legacyBaseBranch = null) {
  try {
    const errors = [];
    const objectOptions = options && typeof options === 'object' ? options : {};
    const cwd = typeof options === 'string' ? options : objectOptions.cwd;
    const baseBranch = typeof options === 'string'
      ? legacyBaseBranch
      : (objectOptions.baseBranch ?? null);
    const repoCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    const explicitBaseBranch = typeof baseBranch === 'string' && baseBranch.trim()
      ? baseBranch.trim()
      : null;
    // 1. gh CLI present
    const ghPath = run('which', ['gh'], repoCwd);
    if (!ghPath) {
      errors.push('gh CLI not found');
    }

    // 2. gh authenticated (only check if gh exists)
    let ghAuthenticated = false;
    if (ghPath) {
      const authOut = run('gh', ['auth', 'status'], repoCwd);
      ghAuthenticated = authOut !== null;
      if (!ghAuthenticated) {
        errors.push('gh not authenticated');
      }
    }

    // 3. git remote origin exists
    const remoteUrl = run('git', ['remote', 'get-url', 'origin'], repoCwd);
    if (remoteUrl === null) {
      errors.push('no git remote');
    }

    // 4. Bind all later writes to the origin-derived canonical repository and
    // authoritative default branch. A local origin/HEAD fallback is not enough
    // to authorize an outward action.
    const pushUrls = remoteUrl
      ? run('git', ['remote', 'get-url', '--push', '--all', 'origin'], repoCwd)
      : null;
    const repositoryMetadata = ghPath && ghAuthenticated && remoteUrl && pushUrls
      ? readGitHubRepositoryMetadata(repoCwd, remoteUrl, pushUrls)
      : null;
    const repositoryDefaultBranch = repositoryMetadata?.defaultBranch ?? null;
    const repoIdentity = repositoryMetadata?.repoIdentity ?? null;
    if (!repositoryDefaultBranch || !repoIdentity) {
      errors.push('unable to determine GitHub repository identity/default branch');
    }
    const resolvedBaseBranch = explicitBaseBranch
      ?? repositoryDefaultBranch
      ?? detectOriginDefaultBranch(repoCwd)
      ?? 'main';

    // 5. current branch must be known and distinct from the resolved base.
    // A detached HEAD or otherwise blank branch is not safe to publish.
    const branch = run('git', ['branch', '--show-current'], repoCwd);
    if (!branch) {
      errors.push('unable to determine current branch');
    } else if (new Set([
      'main',
      'master',
      resolvedBaseBranch,
      repositoryDefaultBranch,
    ]).has(branch)) {
      errors.push('on base branch');
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, errors: [], repoIdentity };
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
 * The object form is preferred. The legacy positional form
 * `findExistingPR(branch, cwd, baseBranch)` remains supported for compatibility.
 *
 * @param {string} branch
 * @param {{ cwd?: string, baseBranch?: string|null, repository?: string|null }|string} [options]
 * @param {string|null} [legacyBaseBranch]
 * @returns {{ ok: boolean, found: boolean, error?: string, prUrl?: string, prNumber?: number, baseRefName?: string, baseMatches?: boolean }}
 */
export function findExistingPR(branch, options = {}, legacyBaseBranch = null) {
  try {
    if (typeof branch !== 'string' || !branch.trim()) {
      return { ok: false, found: false, error: 'invalid branch' };
    }

    const objectOptions = options && typeof options === 'object' ? options : {};
    const cwd = typeof options === 'string' ? options : objectOptions.cwd;
    const baseBranch = typeof options === 'string'
      ? legacyBaseBranch
      : (objectOptions.baseBranch ?? null);
    const repoCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    const repository = resolvePinnedRepository(
      repoCwd,
      typeof options === 'string' ? null : (objectOptions.repository ?? null),
    );
    if (!repository) return { ok: false, found: false, error: 'invalid repository' };
    const resolvedBaseBranch = detectBaseBranch(repoCwd, baseBranch);
    const args = [
      'pr', 'list',
      '--head', branch.trim(),
      '--state', 'open',
      '--json', 'number,url,baseRefName,isCrossRepository',
      '--limit', '100',
      '--repo', repository,
    ];
    const output = run('gh', args, repoCwd);

    if (output === null) {
      return { ok: false, found: false, error: 'gh pr list failed' };
    }

    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      return { ok: false, found: false, error: 'invalid gh pr list JSON' };
    }

    if (!Array.isArray(parsed)) {
      return { ok: false, found: false, error: 'unexpected gh pr list response' };
    }
    if (parsed.length === 0) return { ok: true, found: false };

    const validRows = parsed.every(pr => (
      pr
      && Number.isInteger(pr.number)
      && typeof pr.url === 'string'
      && typeof pr.baseRefName === 'string'
      && typeof pr.isCrossRepository === 'boolean'
    ));
    if (!validRows) {
      return { ok: false, found: false, error: 'invalid gh pr list rows' };
    }

    const candidates = parsed.filter(pr => pr.isCrossRepository === false);
    if (candidates.length === 0) return { ok: true, found: false };
    if (candidates.some(pr => !isPullRequestUrl(pr.url, repository))) {
      return { ok: false, found: false, error: 'PR URL does not match pinned repository' };
    }

    // Prefer a PR that already targets the requested base. If only a PR for a
    // different base exists, return it explicitly as a retarget candidate.
    const exactBaseCandidates = candidates.filter(pr => pr.baseRefName === resolvedBaseBranch);
    if (exactBaseCandidates.length > 1
      || (exactBaseCandidates.length === 0 && candidates.length > 1)) {
      return { ok: false, found: false, error: 'ambiguous same-repository PR candidates' };
    }
    const matchingPR = exactBaseCandidates[0] ?? candidates[0];

    const {
      number: prNumber,
      url: prUrl,
      baseRefName,
    } = matchingPR;
    return {
      ok: true,
      found: true,
      prUrl,
      prNumber,
      baseRefName,
      baseMatches: baseRefName === resolvedBaseBranch,
    };
  } catch (err) {
    return {
      ok: false,
      found: false,
      error: err?.message ?? 'findExistingPR threw an unexpected error',
    };
  }
}

/**
 * Update an existing pull request without invoking a shell.
 *
 * @param {{
 *   prNumber: number|string,
 *   title?: string,
 *   body?: string,
 *   baseBranch?: string|null,
 *   labels?: string[],
 *   repository?: string|null,
 *   cwd?: string
 * }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function updateExistingPR({
  prNumber,
  title,
  body,
  baseBranch = null,
  labels = [],
  repository = null,
  cwd,
} = {}) {
  try {
    const normalizedPRNumber = String(prNumber ?? '').trim();
    if (!/^\d+$/.test(normalizedPRNumber) || Number(normalizedPRNumber) < 1) {
      return { ok: false, error: 'invalid PR number' };
    }
    const repoCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    const pinnedRepository = resolvePinnedRepository(repoCwd, repository);
    if (!pinnedRepository) return { ok: false, error: 'invalid repository' };
    const resolvedBaseBranch = detectBaseBranch(repoCwd, baseBranch);
    const args = [
      'pr', 'edit', normalizedPRNumber,
      '--base', resolvedBaseBranch,
    ];

    if (typeof title === 'string') args.push('--title', title);
    if (typeof body === 'string') args.push('--body', body);

    for (const label of (labels ?? [])) {
      if (typeof label === 'string' && label.trim()) {
        args.push('--add-label', label);
      }
    }
    args.push('--repo', pinnedRepository);

    try {
      _execFileSync(executable('gh'), args, commandOptions('gh', repoCwd));
    } catch (err) {
      const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
      return {
        ok: false,
        error: stderr || err?.message || 'gh pr edit failed',
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err?.message ?? 'updateExistingPR threw an unexpected error',
    };
  }
}

/**
 * Create a new pull request via `gh pr create`.
 *
 * @param {{
 *   title: string,
 *   body: string,
 *   headBranch: string,
 *   baseBranch?: string|null,
 *   draft?: boolean,
 *   labels?: string[],
 *   repository?: string|null,
 *   cwd?: string
 * }} opts
 * @returns {{ ok: boolean, prUrl?: string, error?: string }}
 */
export function createPR({
  title,
  body,
  headBranch,
  baseBranch = null,
  draft = false,
  labels = [],
  repository = null,
  cwd,
} = {}) {
  try {
    const normalizedHeadBranch = normalizeHeadBranch(headBranch);
    if (!normalizedHeadBranch) return { ok: false, error: 'invalid head branch' };
    const repoCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    const pinnedRepository = resolvePinnedRepository(repoCwd, repository);
    if (!pinnedRepository) return { ok: false, error: 'invalid repository' };
    const resolvedBaseBranch = detectBaseBranch(repoCwd, baseBranch);
    const args = [
      'pr', 'create',
      '--title', title,
      '--body', body,
      '--base', resolvedBaseBranch,
      '--head', normalizedHeadBranch,
    ];

    if (draft) {
      args.push('--draft');
    }

    // Add one --label flag per label entry
    for (const label of (labels ?? [])) {
      args.push('--label', label);
    }
    args.push('--repo', pinnedRepository);

    let output;
    try {
      output = _execFileSync(
        executable('gh'),
        args,
        commandOptions('gh', repoCwd),
      ).trim();
    } catch (err) {
      const message = err?.stderr?.trim() || err?.message || 'gh pr create failed';
      return { ok: false, error: message };
    }

    // gh pr create outputs the PR URL; accept only the pinned repository.
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
    const prUrl = lines.find(line => isPullRequestUrl(line, pinnedRepository));
    if (!prUrl) {
      return { ok: false, error: 'gh pr create returned no matching PR URL' };
    }

    return { ok: true, prUrl };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'createPR threw an unexpected error' };
  }
}

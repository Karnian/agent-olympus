import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSafeRepoRelativePath } from './review-contract.mjs';
import {
  resolveTrustedVcsBinary,
  sanitizedVcsEnvironment,
} from './trusted-vcs.mjs';

export const REVIEW_PACKAGE_SCHEMA_VERSION = 1;
export const MAX_REVIEW_PATCH_BYTES = 6 * 1024 * 1024;
export const MAX_REVIEW_PACKAGE_BYTES = 12 * 1024 * 1024;
export const MAX_REVIEW_PATHS = 10_000;

const MAX_GIT_OUTPUT_BYTES = MAX_REVIEW_PATCH_BYTES + 64 * 1024;
const MAX_PATH_LIST_BYTES = 1024 * 1024;
const MAX_COMMIT_HEADER_BYTES = 64 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const FINAL_COMMIT_AUTOMATION_IDENTITY = 'Agent Olympus <agent-olympus@localhost>';
const SAFE_BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATCH_FIELDS = Object.freeze(['baseToHead', 'staged', 'unstaged', 'headToWorktree']);
const FINAL_COMMIT_PROPOSAL_FIELDS = Object.freeze([
  'schemaVersion',
  'objectFormat',
  'objectId',
  'tree',
  'parent',
  'author',
  'committer',
  'extraHeaders',
  'message',
]);
const REVIEW_BASE_ENV_KEYS = Object.freeze([
  'GITHUB_BASE_REF',
  'CI_MERGE_REQUEST_TARGET_BRANCH_NAME',
  'CHANGE_TARGET',
  'SYSTEM_PULLREQUEST_TARGETBRANCH',
]);
const AO_RUNTIME_UNTRACKED_PREFIXES = Object.freeze([
  '.ao/artifacts/',
  '.ao/state/',
  '.ao/sessions/',
  '.ao/teams/',
  '.ao/worktrees/',
  '.ao/memory/',
]);
const AO_RUNTIME_UNTRACKED_FILES = new Set([
  '.ao/prd.json',
  '.ao/spec.md',
  '.ao/wisdom.jsonl',
  '.ao/deep-dive-report.json',
  '.ao/harness-context.json',
]);

export class ReviewPackageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ReviewPackageError';
    this.code = code;
  }
}

function gitEnvironment(overrides = {}) {
  return sanitizedVcsEnvironment({ git: true, overrides });
}

function hookExecutionPath() {
  const value = process.env.PATH;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new ReviewPackageError(
      'INVALID_HOOK_ENVIRONMENT',
      'normal Git commit hooks require a non-empty NUL-free user PATH',
    );
  }
  return value;
}

function runGit(cwd, args, options = {}) {
  try {
    const output = execFileSync(resolveTrustedVcsBinary('git'), args, {
      cwd,
      env: gitEnvironment(options.env),
      input: options.input,
      encoding: null,
      maxBuffer: options.maxBuffer || MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (output.length > (options.maxBytes || MAX_GIT_OUTPUT_BYTES)) {
      throw new ReviewPackageError(
        'EVIDENCE_TOO_LARGE',
        `git evidence exceeded ${options.maxBytes || MAX_GIT_OUTPUT_BYTES} bytes`,
      );
    }
    return output;
  } catch (error) {
    if (error instanceof ReviewPackageError) throw error;
    const overflow = error?.code === 'ENOBUFS' || /maxBuffer/i.test(String(error?.message || ''));
    throw new ReviewPackageError(
      overflow ? 'EVIDENCE_TOO_LARGE' : 'GIT_COMMAND_FAILED',
      overflow
        ? 'git evidence exceeded the configured output cap'
        : `git ${args[0] || 'command'} failed while building review evidence`,
      { cause: error },
    );
  }
}

function tryGitText(cwd, args) {
  try {
    return decodeUtf8(runGit(cwd, args, { maxBytes: MAX_PATH_LIST_BYTES }), args[0]).trim();
  } catch {
    return null;
  }
}

function exactRepositoryRoot(requestedCwd) {
  if (tryGitText(requestedCwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new ReviewPackageError('NOT_A_REPOSITORY', 'cwd is not inside a Git worktree');
  }
  const reportedRoot = tryGitText(requestedCwd, ['rev-parse', '--show-toplevel']);
  if (!reportedRoot || !path.isAbsolute(reportedRoot)) {
    throw new ReviewPackageError('NOT_A_REPOSITORY', 'Git did not return an absolute worktree root');
  }
  let canonicalCwd;
  let canonicalRoot;
  try {
    canonicalCwd = realpathSync(requestedCwd);
    canonicalRoot = realpathSync(reportedRoot);
  } catch (cause) {
    throw new ReviewPackageError(
      'INVALID_CWD',
      'cwd and the Git worktree root must resolve canonically',
      { cause },
    );
  }
  if (canonicalCwd !== canonicalRoot) {
    throw new ReviewPackageError(
      'REPOSITORY_ROOT_MISMATCH',
      'cwd must be the exact canonical Git worktree root',
    );
  }
  return canonicalRoot;
}

function decodeUtf8(buffer, label) {
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new ReviewPackageError('INVALID_ENCODING', `${label} evidence is not valid UTF-8`);
  }
  return text;
}

function parseNullPaths(buffer, label) {
  if (buffer.length === 0) return [];
  if (buffer.length > MAX_PATH_LIST_BYTES) {
    throw new ReviewPackageError('EVIDENCE_TOO_LARGE', `${label} path list exceeds the output cap`);
  }
  if (buffer[buffer.length - 1] !== 0) {
    throw new ReviewPackageError('INVALID_EVIDENCE', `${label} path list is not NUL terminated`);
  }

  const paths = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    const entry = decodeUtf8(buffer.subarray(start, index), `${label} path`);
    if (!isSafeRepoRelativePath(entry)) {
      throw new ReviewPackageError('UNSAFE_PATH', `${label} contains an unsafe repo-relative path`);
    }
    paths.push(entry);
    start = index + 1;
  }
  if (paths.length > MAX_REVIEW_PATHS) {
    throw new ReviewPackageError('EVIDENCE_TOO_LARGE', `${label} contains too many paths`);
  }
  return paths;
}

/**
 * Identify only untracked files owned by the AO runtime. Tracked files remain
 * reviewable, and project inputs such as `.ao/autonomy.json` are deliberately
 * outside this exclusion.
 */
export function isReviewExcludedUntrackedPath(value) {
  return typeof value === 'string'
    && (AO_RUNTIME_UNTRACKED_FILES.has(value)
      || AO_RUNTIME_UNTRACKED_PREFIXES.some(prefix => value.startsWith(prefix)));
}

function untrackedReviewPaths(cwd) {
  const all = parseNullPaths(
    runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], {
      maxBytes: MAX_PATH_LIST_BYTES,
      maxBuffer: MAX_PATH_LIST_BYTES + 1,
    }),
    'untracked',
  );
  return {
    reviewable: all.filter(value => !isReviewExcludedUntrackedPath(value)),
    excluded: all.filter(isReviewExcludedUntrackedPath),
  };
}

function changedTrackedPaths(cwd, args, label) {
  return parseNullPaths(
    runGit(cwd, args, {
      maxBytes: MAX_PATH_LIST_BYTES,
      maxBuffer: MAX_PATH_LIST_BYTES + 1,
    }),
    label,
  );
}

/**
 * Return the reviewable dirty set while ignoring only untracked AO-owned
 * runtime artifacts. This is the shared cleanliness boundary used before a
 * new Atlas run and again when a reviewed final tree is committed.
 */
export function getReviewWorktreeState({ cwd } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) {
    throw new ReviewPackageError('INVALID_CWD', 'cwd must be a non-empty filesystem path');
  }
  const requestedCwd = path.resolve(cwd);
  const repositoryRoot = exactRepositoryRoot(requestedCwd);
  resolveCommit(repositoryRoot, 'HEAD', 'HEAD');

  const paths = new Set([
    ...changedTrackedPaths(
      repositoryRoot,
      ['diff', '--name-only', '-z', '--'],
      'unstaged',
    ),
    ...changedTrackedPaths(
      repositoryRoot,
      ['diff', '--cached', '--name-only', '-z', 'HEAD', '--'],
      'staged',
    ),
    ...untrackedReviewPaths(repositoryRoot).reviewable,
  ]);
  return Object.freeze({
    repositoryRoot,
    dirty: paths.size > 0,
    paths: Object.freeze([...paths].sort()),
  });
}

function resolveCommit(cwd, revision, label) {
  const value = decodeUtf8(
    runGit(cwd, ['rev-parse', '--verify', `${revision}^{commit}`], { maxBytes: 256 }),
    label,
  ).trim();
  if (!OBJECT_ID.test(value)) {
    throw new ReviewPackageError('INVALID_OBJECT_ID', `${label} did not resolve to a commit object`);
  }
  return value;
}

function parseIdentityHeader(value, label) {
  if (typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 4096
    || /[\0\r\n]/.test(value)) {
    throw new ReviewPackageError('INVALID_COMMIT_METADATA', `${label} identity header is invalid`);
  }
  const match = /^(.*\S) ([0-9]+) ([+-][0-9]{4})$/.exec(value);
  if (!match || !match[1].includes('<') || !match[1].endsWith('>')) {
    throw new ReviewPackageError('INVALID_COMMIT_METADATA', `${label} identity header is invalid`);
  }
  return {
    identity: match[1],
    timestamp: BigInt(match[2]),
    timezone: match[3],
  };
}

function parentCommitLogicalClock(cwd, parentCommit) {
  const raw = runGit(cwd, ['cat-file', 'commit', parentCommit], {
    maxBytes: MAX_COMMIT_HEADER_BYTES,
    maxBuffer: MAX_COMMIT_HEADER_BYTES + 1,
  });
  const separator = raw.indexOf(Buffer.from('\n\n'));
  if (separator < 0 || separator > MAX_COMMIT_HEADER_BYTES) {
    throw new ReviewPackageError(
      'INVALID_COMMIT_METADATA',
      'parent commit has no bounded canonical header section',
    );
  }
  const headerText = decodeUtf8(raw.subarray(0, separator), 'parent commit headers');
  const headerLines = headerText.split('\n');
  const headerValue = (name) => {
    const matches = headerLines.filter(line => line.startsWith(`${name} `));
    if (matches.length !== 1) {
      throw new ReviewPackageError(
        'INVALID_COMMIT_METADATA',
        `parent commit must contain exactly one ${name} header`,
      );
    }
    return matches[0].slice(name.length + 1);
  };
  return parseIdentityHeader(headerValue('committer'), 'parent committer');
}

function automationIdentityHeader(timestamp) {
  return `${FINAL_COMMIT_AUTOMATION_IDENTITY} ${timestamp} +0000`;
}

function canonicalFinalCommitMessage(reviewTreeOid) {
  return `chore(agent-olympus): finalize reviewed tree ${reviewTreeOid.slice(0, 12)}\n`;
}

function finalCommitRaw(proposal) {
  return Buffer.from([
    `tree ${proposal.tree}`,
    `parent ${proposal.parent}`,
    `author ${proposal.author}`,
    `committer ${proposal.committer}`,
    ...proposal.extraHeaders,
    '',
    proposal.message,
  ].join('\n'), 'utf8');
}

function gitObjectId(raw, objectFormat) {
  const prefix = Buffer.from(`commit ${raw.length}\0`, 'utf8');
  return createHash(objectFormat).update(prefix).update(raw).digest('hex');
}

function buildFinalCommitProposal(cwd, parentCommit, reviewTreeOid) {
  const logicalClock = parentCommitLogicalClock(cwd, parentCommit);
  const timestamp = [
    BigInt(Math.floor(Date.now() / 1000)),
    logicalClock.timestamp + 1n,
  ].reduce((latest, candidate) => candidate > latest ? candidate : latest);
  const automationIdentity = automationIdentityHeader(timestamp);
  const objectFormat = parentCommit.length === 64 ? 'sha256' : 'sha1';
  const proposal = {
    schemaVersion: 1,
    objectFormat,
    objectId: '',
    tree: reviewTreeOid,
    parent: parentCommit,
    author: automationIdentity,
    committer: automationIdentity,
    extraHeaders: [],
    message: canonicalFinalCommitMessage(reviewTreeOid),
  };
  proposal.objectId = gitObjectId(finalCommitRaw(proposal), objectFormat);
  return proposal;
}

function assertFinalCommitProposalIntegrity(reviewPackage) {
  const proposal = reviewPackage.finalCommitProposal;
  if (!isPlainObject(proposal)
    || Object.keys(proposal).length !== FINAL_COMMIT_PROPOSAL_FIELDS.length
    || !FINAL_COMMIT_PROPOSAL_FIELDS.every(field => Object.hasOwn(proposal, field))
    || proposal.schemaVersion !== 1
    || !['sha1', 'sha256'].includes(proposal.objectFormat)
    || !OBJECT_ID.test(proposal.objectId || '')
    || proposal.objectId.length !== (proposal.objectFormat === 'sha1' ? 40 : 64)
    || proposal.tree !== reviewPackage.reviewTreeOid
    || proposal.parent !== reviewPackage.headCommit
    || !Array.isArray(proposal.extraHeaders)
    || proposal.extraHeaders.length !== 0
    || proposal.message !== canonicalFinalCommitMessage(reviewPackage.reviewTreeOid)
    || Buffer.byteLength(proposal.message, 'utf8') > 1024) {
    throw new ReviewPackageError(
      'INVALID_COMMIT_METADATA',
      'final commit proposal is missing, non-canonical, or has forbidden extra headers',
    );
  }
  const author = parseIdentityHeader(proposal.author, 'proposed author');
  const committer = parseIdentityHeader(proposal.committer, 'proposed committer');
  if (author.identity !== FINAL_COMMIT_AUTOMATION_IDENTITY
    || committer.identity !== FINAL_COMMIT_AUTOMATION_IDENTITY
    || proposal.author !== proposal.committer
    || author.timezone !== '+0000'
    || committer.timezone !== '+0000') {
    throw new ReviewPackageError(
      'INVALID_COMMIT_METADATA',
      'final commit author and committer must use the exact Agent Olympus automation identity',
    );
  }
  if (proposal.objectId !== gitObjectId(finalCommitRaw(proposal), proposal.objectFormat)) {
    throw new ReviewPackageError(
      'INVALID_COMMIT_METADATA',
      'final commit proposal object id does not match its exact raw commit bytes',
    );
  }
  return true;
}

function assertFinalCommitProposalCanonical(reviewPackage, cwd) {
  assertFinalCommitProposalIntegrity(reviewPackage);
  const parentClock = parentCommitLogicalClock(cwd, reviewPackage.headCommit);
  const proposed = parseIdentityHeader(
    reviewPackage.finalCommitProposal.committer,
    'proposed committer',
  );
  const latestAllowed = [
    BigInt(Math.floor(Date.now() / 1000) + 60),
    parentClock.timestamp + 1n,
  ].reduce((latest, candidate) => candidate > latest ? candidate : latest);
  if (proposed.timestamp <= parentClock.timestamp
    || proposed.timestamp > latestAllowed
    || proposed.timezone !== '+0000') {
    throw new ReviewPackageError(
      'INVALID_COMMIT_METADATA',
      'final commit proposal does not use the canonical current UTC logical clock',
    );
  }
  return true;
}

function validateBaseRef(value, label = 'baseRef') {
  if (typeof value !== 'string' || !SAFE_BASE_REF.test(value)) {
    throw new ReviewPackageError('UNSAFE_BASE_REF', `${label} must be a safe branch, remote ref, or commit`);
  }
  return value;
}

function firstResolvableBase(cwd, candidates) {
  for (const candidate of candidates) {
    if (!candidate || !SAFE_BASE_REF.test(candidate)) continue;
    const commit = tryGitText(cwd, ['rev-parse', '--verify', `${candidate}^{commit}`]);
    if (commit && OBJECT_ID.test(commit)) return { baseRef: candidate, baseRefCommit: commit };
  }
  return null;
}

/**
 * Resolve a review target once so orchestrators can durably pin the returned
 * commit in their run ledger. CI target-branch metadata takes precedence over
 * repository defaults; ambiguous repositories fail closed instead of guessing.
 *
 * @param {object} options
 * @param {string} options.cwd path inside the repository
 * @param {string} [options.baseRef] explicit branch, remote ref, or pinned commit
 * @param {object} [options.env] environment used for CI base-target discovery
 * @returns {Readonly<{baseRef:string,baseRefCommit:string,source:string}>}
 */
export function resolveReviewBase({ cwd, baseRef, env = process.env } = {}) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0 || cwd.includes('\0')) {
    throw new ReviewPackageError('INVALID_CWD', 'cwd must be a non-empty filesystem path');
  }
  const requestedCwd = path.resolve(cwd);
  const repoRoot = exactRepositoryRoot(requestedCwd);

  if (baseRef !== undefined) {
    const explicit = validateBaseRef(baseRef);
    return Object.freeze({
      baseRef: explicit,
      baseRefCommit: resolveCommit(repoRoot, explicit, 'baseRef'),
      source: 'explicit',
    });
  }

  for (const key of REVIEW_BASE_ENV_KEYS) {
    const raw = env?.[key];
    if (raw === undefined || raw === '') continue;
    const value = validateBaseRef(raw, key);
    const candidates = value.startsWith('refs/')
      ? [value]
      : [`origin/${value}`, value];
    const resolved = firstResolvableBase(repoRoot, candidates);
    if (!resolved) {
      throw new ReviewPackageError(
        'BASE_REF_REQUIRED',
        `${key} did not resolve to a commit; pass baseRef explicitly`,
      );
    }
    return Object.freeze({ ...resolved, source: `env:${key}` });
  }

  const remoteHead = tryGitText(
    repoRoot,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
  );
  if (remoteHead) {
    validateBaseRef(remoteHead, 'origin/HEAD');
    const resolved = firstResolvableBase(repoRoot, [remoteHead]);
    if (resolved) return Object.freeze({ ...resolved, source: 'origin-head' });
  }

  const resolved = firstResolvableBase(repoRoot, [
    'origin/main',
    'main',
    'origin/master',
    'master',
    'origin/develop',
    'develop',
    'origin/trunk',
    'trunk',
  ]);
  if (resolved) return Object.freeze({ ...resolved, source: 'conventional' });

  throw new ReviewPackageError(
    'BASE_REF_REQUIRED',
    'unable to determine a review base; pass baseRef explicitly',
  );
}

function patchArgs(...range) {
  return [
    'diff',
    '--binary',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--full-index',
    '--find-renames',
    ...range,
    '--',
  ];
}

function buildWorktreeSnapshot(cwd, headCommit, excludedUntrackedPaths = []) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ao-review-index-'));
  const indexPath = path.join(tempDir, 'index');
  const env = { GIT_INDEX_FILE: indexPath };

  try {
    runGit(cwd, ['read-tree', headCommit], { env, maxBytes: 64 * 1024 });
    // Populate only the temporary index. This binds the exact checked-out
    // filesystem tree (tracked edits/deletes plus non-ignored untracked files)
    // without changing the caller's index or worktree.
    runGit(cwd, ['add', '-A', '--'], { env, maxBytes: 64 * 1024 });
    if (excludedUntrackedPaths.length > 0) {
      runGit(cwd, ['update-index', '--force-remove', '-z', '--stdin'], {
        env,
        input: Buffer.from(`${excludedUntrackedPaths.join('\0')}\0`, 'utf8'),
        maxBytes: 64 * 1024,
      });
    }
    const reviewTreeOid = decodeUtf8(
      runGit(cwd, ['write-tree'], { env, maxBytes: 256 }),
      'review tree',
    ).trim();
    if (!OBJECT_ID.test(reviewTreeOid)) {
      throw new ReviewPackageError('INVALID_OBJECT_ID', 'review tree did not resolve to a tree object');
    }
    return {
      patch: runGit(cwd, patchArgs('--cached', headCommit), {
        env,
        maxBytes: MAX_REVIEW_PATCH_BYTES,
      }),
      reviewTreeOid,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Capture the exact current checked-out tree even when it is clean relative to
 * the eventual review base. Atlas uses two captures around a sequential
 * shared-root worker and diffs the tree OIDs with NUL framing for scope proof.
 */
export function captureCurrentReviewTree({ cwd } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) {
    throw new ReviewPackageError('INVALID_CWD', 'cwd must be a non-empty filesystem path');
  }
  const requestedCwd = path.resolve(cwd);
  const repositoryRoot = exactRepositoryRoot(requestedCwd);
  const headCommit = resolveCommit(repositoryRoot, 'HEAD', 'HEAD');
  const { excluded } = untrackedReviewPaths(repositoryRoot);
  const { reviewTreeOid } = buildWorktreeSnapshot(
    repositoryRoot,
    headCommit,
    excluded,
  );
  return Object.freeze({
    schemaVersion: REVIEW_PACKAGE_SCHEMA_VERSION,
    repositoryRoot,
    headCommit,
    reviewTreeOid,
  });
}

export function assertCurrentReviewTree(capture, { cwd } = {}) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)
    || capture.schemaVersion !== REVIEW_PACKAGE_SCHEMA_VERSION
    || typeof capture.repositoryRoot !== 'string'
    || !path.isAbsolute(capture.repositoryRoot)
    || !OBJECT_ID.test(capture.headCommit || '')
    || !OBJECT_ID.test(capture.reviewTreeOid || '')) {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'current review-tree capture is invalid');
  }
  const current = captureCurrentReviewTree({ cwd });
  if (current.repositoryRoot !== capture.repositoryRoot
    || current.headCommit !== capture.headCommit
    || current.reviewTreeOid !== capture.reviewTreeOid) {
    throw new ReviewPackageError('WORKTREE_CHANGED', 'current worktree changed after its tree capture');
  }
  return true;
}

function joinPatchSeries(...patches) {
  const present = patches.filter((patch) => patch.length > 0);
  return present.reduce(
    (combined, patch) => combined === ''
      ? patch
      : `${combined}${combined.endsWith('\n') ? '' : '\n'}${patch}`,
    '',
  );
}

function digestMaterial(reviewPackage) {
  return {
    schemaVersion: reviewPackage.schemaVersion,
    baseRef: reviewPackage.baseRef,
    baseRefCommit: reviewPackage.baseRefCommit,
    mergeBaseCommit: reviewPackage.mergeBaseCommit,
    headCommit: reviewPackage.headCommit,
    reviewTreeOid: reviewPackage.reviewTreeOid,
    diffPaths: reviewPackage.diffPaths,
    untrackedPaths: reviewPackage.untrackedPaths,
    patches: reviewPackage.patches,
  };
}

/**
 * Compute the canonical SHA-256 for the Git evidence boundary.
 *
 * @param {object} reviewPackage
 * @returns {string} lowercase hexadecimal SHA-256
 */
export function computeReviewPackageDigest(reviewPackage) {
  return createHash('sha256')
    .update(JSON.stringify(digestMaterial(reviewPackage)), 'utf8')
    .digest('hex');
}

/**
 * Throw unless a serialized review package still matches its evidence digest.
 *
 * @param {object} reviewPackage
 * @returns {true}
 */
export function assertReviewPackageIntegrity(reviewPackage) {
  if (!reviewPackage || typeof reviewPackage !== 'object' || Array.isArray(reviewPackage)) {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'review package must be an object');
  }
  if (reviewPackage.schemaVersion !== REVIEW_PACKAGE_SCHEMA_VERSION) {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'unsupported review package schemaVersion');
  }
  for (const field of ['baseRefCommit', 'mergeBaseCommit', 'headCommit', 'reviewTreeOid']) {
    if (!OBJECT_ID.test(reviewPackage[field])) {
      throw new ReviewPackageError('INVALID_OBJECT_ID', `${field} is not a commit object id`);
    }
  }
  assertFinalCommitProposalIntegrity(reviewPackage);
  if (!SAFE_BASE_REF.test(reviewPackage.baseRef || '')) {
    throw new ReviewPackageError('UNSAFE_BASE_REF', 'review package baseRef is unsafe');
  }
  if (!Array.isArray(reviewPackage.diffPaths) || reviewPackage.diffPaths.length === 0) {
    throw new ReviewPackageError('EMPTY_DIFF', 'review package contains no changed paths');
  }
  if (reviewPackage.diffPaths.length > MAX_REVIEW_PATHS
    || new Set(reviewPackage.diffPaths).size !== reviewPackage.diffPaths.length) {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'diffPaths is oversized or contains duplicates');
  }
  if (!Array.isArray(reviewPackage.untrackedPaths)) {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'untrackedPaths must be an array');
  }
  for (const value of [...reviewPackage.diffPaths, ...reviewPackage.untrackedPaths]) {
    if (!isSafeRepoRelativePath(value)) {
      throw new ReviewPackageError('UNSAFE_PATH', 'review package contains an unsafe path');
    }
  }
  const diffPathSet = new Set(reviewPackage.diffPaths);
  if (new Set(reviewPackage.untrackedPaths).size !== reviewPackage.untrackedPaths.length
    || reviewPackage.untrackedPaths.some((value) => !diffPathSet.has(value))) {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'untrackedPaths must be unique members of diffPaths');
  }
  if (!reviewPackage.patches || typeof reviewPackage.patches !== 'object') {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'patches must be an object');
  }
  if (!PATCH_FIELDS.every((field) => typeof reviewPackage.patches[field] === 'string')
    || Object.keys(reviewPackage.patches).some((field) => !PATCH_FIELDS.includes(field))) {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'patches has an invalid shape');
  }

  const expectedDiff = joinPatchSeries(...PATCH_FIELDS.map(
    (field) => reviewPackage.patches[field],
  ));
  if (typeof reviewPackage.diff !== 'string' || reviewPackage.diff.length === 0
    || reviewPackage.diff !== expectedDiff) {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'combined diff does not match its patch series');
  }
  const patchBytes = PATCH_FIELDS.reduce(
    (sum, field) => sum + Buffer.byteLength(reviewPackage.patches[field], 'utf8'),
    0,
  );
  if (patchBytes > MAX_REVIEW_PATCH_BYTES
    || Buffer.byteLength(JSON.stringify(reviewPackage), 'utf8') > MAX_REVIEW_PACKAGE_BYTES) {
    throw new ReviewPackageError('EVIDENCE_TOO_LARGE', 'review package exceeds its evidence cap');
  }
  if (reviewPackage.evidenceDigest?.algorithm !== 'sha256'
    || !/^[0-9a-f]{64}$/.test(reviewPackage.evidenceDigest?.value || '')
    || reviewPackage.evidenceDigest.value !== computeReviewPackageDigest(reviewPackage)) {
    throw new ReviewPackageError('DIGEST_MISMATCH', 'review package evidence digest does not match');
  }
  return true;
}

/**
 * Carry the one proposal durably selected at verification start across later
 * freshness rebuilds. Git tree/patch freshness remains represented by the
 * evidence digest; attachReviewContext() subsequently binds this proposal into
 * the reviewer-facing review digest.
 */
export function bindFinalCommitProposal(gitEvidence, finalCommitProposal) {
  assertReviewPackageIntegrity(gitEvidence);
  const rebound = {
    ...gitEvidence,
    finalCommitProposal: structuredClone(finalCommitProposal),
  };
  assertReviewPackageIntegrity(rebound);
  return deepFreeze(rebound);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function contextDigestMaterial(reviewPackage) {
  return {
    schemaVersion: reviewPackage.schemaVersion,
    evidenceDigest: reviewPackage.evidenceDigest,
    finalCommitProposal: reviewPackage.finalCommitProposal,
    prd: reviewPackage.prd,
    verification: reviewPackage.verification,
  };
}

function computeReviewContextDigest(reviewPackage) {
  return createHash('sha256')
    .update(JSON.stringify(contextDigestMaterial(reviewPackage)), 'utf8')
    .digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateCriterionEvidence(record, acceptanceCriteria) {
  if (!Array.isArray(record.criteria)
    || record.criteria.length !== acceptanceCriteria.length) {
    throw new ReviewPackageError(
      'INVALID_VERIFICATION',
      `verification for ${record.story_id} must cover every acceptance criterion`,
    );
  }

  const byIndex = new Map();
  for (const criterion of record.criteria) {
    if (!isPlainObject(criterion)
      || !Number.isSafeInteger(criterion.criterion_index)
      || criterion.criterion_index < 0
      || criterion.criterion_index >= acceptanceCriteria.length
      || byIndex.has(criterion.criterion_index)
      || !['pass', 'fail', 'skip'].includes(criterion.verdict)
      || !nonEmptyString(criterion.evidence)) {
      throw new ReviewPackageError(
        'INVALID_VERIFICATION',
        `verification for ${record.story_id} has invalid or missing criterion evidence`,
      );
    }
    const expectedText = acceptanceCriteria[criterion.criterion_index];
    if (Object.hasOwn(criterion, 'criterion_text')
      && criterion.criterion_text !== expectedText) {
      throw new ReviewPackageError(
        'INCONSISTENT_VERIFICATION',
        `verification criterion text for ${record.story_id} does not match the PRD`,
      );
    }
    byIndex.set(criterion.criterion_index, criterion);
  }

  for (let index = 0; index < acceptanceCriteria.length; index += 1) {
    if (!byIndex.has(index)) {
      throw new ReviewPackageError(
        'INVALID_VERIFICATION',
        `verification for ${record.story_id} is missing criterion ${index}`,
      );
    }
  }

  const criteria = [...byIndex.values()];
  const rollup = criteria.some((criterion) => criterion.verdict === 'fail')
    ? 'fail'
    : criteria.some((criterion) => criterion.verdict === 'skip')
      ? 'skip'
      : 'pass';
  if (record.verdict !== rollup) {
    throw new ReviewPackageError(
      'INCONSISTENT_VERIFICATION',
      `top-level verdict for ${record.story_id} disagrees with criterion evidence`,
    );
  }
}

function validateReviewContext(reviewPackage) {
  assertReviewPackageIntegrity(reviewPackage);
  const prd = reviewPackage.prd;
  if (!isPlainObject(prd)
    || !Array.isArray(prd.userStories) || prd.userStories.length === 0) {
    throw new ReviewPackageError('INVALID_PRD', 'review PRD must contain userStories');
  }
  const stories = new Map();
  for (const story of prd.userStories) {
    if (!isPlainObject(story)
      || typeof story.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(story.id)
      || stories.has(story.id) || story.passes !== true
      || !Array.isArray(story.acceptanceCriteria) || story.acceptanceCriteria.length === 0
      || story.acceptanceCriteria.some((criterion) => !nonEmptyString(criterion))) {
      throw new ReviewPackageError(
        'INVALID_PRD',
        'review PRD stories need unique safe IDs, passes:true, and non-empty acceptanceCriteria',
      );
    }
    stories.set(story.id, story);
  }
  if (!Array.isArray(reviewPackage.verification) || reviewPackage.verification.length === 0) {
    throw new ReviewPackageError('INVALID_VERIFICATION', 'review verification evidence is empty');
  }
  const latest = new Map();
  for (const record of reviewPackage.verification) {
    if (!isPlainObject(record)
      || typeof record.story_id !== 'string' || !stories.has(record.story_id)
      || !['pass', 'fail', 'skip'].includes(record.verdict)
      || !nonEmptyString(record.evidence)
      || !nonEmptyString(record.verifiedBy)) {
      throw new ReviewPackageError(
        'INVALID_VERIFICATION',
        'verification records must identify a PRD story, verdict, evidence, and verifier',
      );
    }
    latest.set(record.story_id, record);
  }
  for (const storyId of stories.keys()) {
    const record = latest.get(storyId);
    if (record) {
      // Historical records remain useful audit evidence and legacy runs may
      // predate criterion-level capture. The terminal record alone authorizes
      // the gate, so require exact criterion coverage and a consistent rollup
      // there rather than retroactively invalidating every prior attempt.
      validateCriterionEvidence(record, stories.get(storyId).acceptanceCriteria);
      if (!OBJECT_ID.test(record.reviewTreeOid || '')
        || record.reviewTreeOid !== reviewPackage.reviewTreeOid) {
        throw new ReviewPackageError(
          'STALE_VERIFICATION',
          `terminal verification for ${storyId} is not bound to the reviewed filesystem tree`,
        );
      }
    }
    if (!record || !['pass', 'skip'].includes(record.verdict)) {
      throw new ReviewPackageError(
        'INCOMPLETE_VERIFICATION',
        `story ${storyId} lacks terminal passing or explicit-skip verification`,
      );
    }
  }
  if (reviewPackage.reviewDigest?.algorithm !== 'sha256'
    || reviewPackage.reviewDigest.value !== computeReviewContextDigest(reviewPackage)) {
    throw new ReviewPackageError('DIGEST_MISMATCH', 'review context digest does not match');
  }
  if (Buffer.byteLength(JSON.stringify(reviewPackage), 'utf8') > MAX_REVIEW_PACKAGE_BYTES) {
    throw new ReviewPackageError('EVIDENCE_TOO_LARGE', 'complete review package exceeds its cap');
  }
  return true;
}

/**
 * Bind the immutable Git evidence to the exact PRD and terminal verification
 * records supplied to reviewers. Missing, failed, or stale story evidence is a
 * review blocker rather than an empty field a reviewer can accidentally ignore.
 *
 * @param {object} gitEvidence output from buildReviewPackage()
 * @param {{prd:object, verification:object[]}} context
 * @returns {Readonly<object>}
 */
export function attachReviewContext(gitEvidence, { prd, verification } = {}) {
  assertReviewPackageIntegrity(gitEvidence);
  const reviewPackage = {
    ...gitEvidence,
    prd: structuredClone(prd),
    verification: structuredClone(verification),
  };
  reviewPackage.reviewDigest = {
    algorithm: 'sha256',
    value: computeReviewContextDigest(reviewPackage),
  };
  validateReviewContext(reviewPackage);
  return deepFreeze(reviewPackage);
}

export function assertCompleteReviewPackageIntegrity(reviewPackage) {
  return validateReviewContext(reviewPackage);
}

/**
 * Prove that an approved package still describes the repository's exact
 * base-ref, HEAD, index, worktree, and untracked-file evidence boundary.
 * Complete packages are context-validated first so a caller cannot preserve
 * the Git digest while replacing the PRD or verification evidence.
 *
 * @param {object} reviewPackage output from buildReviewPackage() or attachReviewContext()
 * @param {object} options
 * @param {string} options.cwd path inside the repository
 * @returns {true}
 * @throws {ReviewPackageError} when integrity or freshness cannot be proven
 */
export function assertReviewPackageCurrent(reviewPackage, { cwd } = {}) {
  const contextFields = ['prd', 'verification', 'reviewDigest'];
  const hasReviewContext = reviewPackage
    && typeof reviewPackage === 'object'
    && contextFields.some((field) => Object.hasOwn(reviewPackage, field));
  if (hasReviewContext) validateReviewContext(reviewPackage);
  else assertReviewPackageIntegrity(reviewPackage);

  const current = buildReviewPackage({ cwd, baseRef: reviewPackage.baseRef });
  if (current.evidenceDigest.value !== reviewPackage.evidenceDigest.value) {
    throw new ReviewPackageError(
      'STALE_EVIDENCE',
      'review package no longer matches the current base, HEAD, index, or worktree',
    );
  }
  return true;
}

/**
 * After committing an approved package, prove that HEAD contains exactly the
 * filesystem tree and canonical commit metadata reviewers saw and that it is
 * exactly one new commit on top of the pre-commit HEAD captured by the
 * final-review package. Merge commits, alternate ancestry, changed identity or
 * message fields, and extra commit headers are rejected.
 *
 * @param {object} reviewPackage output from buildReviewPackage() or attachReviewContext()
 * @param {object} options
 * @param {string} options.cwd path inside the repository
 * @returns {true}
 */
export function assertReviewPackageHeadTree(reviewPackage, { cwd } = {}) {
  const contextFields = ['prd', 'verification', 'reviewDigest'];
  const hasReviewContext = reviewPackage
    && typeof reviewPackage === 'object'
    && contextFields.some((field) => Object.hasOwn(reviewPackage, field));
  if (hasReviewContext) validateReviewContext(reviewPackage);
  else assertReviewPackageIntegrity(reviewPackage);
  if (typeof cwd !== 'string' || cwd.trim().length === 0 || cwd.includes('\0')) {
    throw new ReviewPackageError('INVALID_CWD', 'cwd must be a non-empty filesystem path');
  }
  const repositoryRoot = exactRepositoryRoot(path.resolve(cwd));
  const headTree = decodeUtf8(
    runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{tree}'], { maxBytes: 256 }),
    'HEAD tree',
  ).trim();
  if (!OBJECT_ID.test(headTree)) {
    throw new ReviewPackageError('INVALID_OBJECT_ID', 'HEAD did not resolve to a tree object');
  }
  if (headTree !== reviewPackage.reviewTreeOid) {
    throw new ReviewPackageError(
      'COMMITTED_TREE_MISMATCH',
      'HEAD tree does not match the filesystem tree approved by reviewers',
    );
  }
  const ancestry = decodeUtf8(
    runGit(repositoryRoot, ['rev-list', '--parents', '-n', '1', 'HEAD'], { maxBytes: 512 }),
    'HEAD ancestry',
  ).trim().split(/\s+/);
  if (ancestry.length !== 2
    || !OBJECT_ID.test(ancestry[0] || '')
    || ancestry[1] !== reviewPackage.headCommit) {
    throw new ReviewPackageError(
      'COMMITTED_PARENT_MISMATCH',
      'HEAD must be exactly one non-merge commit on top of the final-review HEAD',
    );
  }
  assertFinalCommitProposalCanonical(reviewPackage, repositoryRoot);
  if (ancestry[0] !== reviewPackage.finalCommitProposal.objectId) {
    throw new ReviewPackageError(
      'COMMITTED_METADATA_MISMATCH',
      'HEAD object id does not match the commit metadata approved by reviewers',
    );
  }
  const actualRaw = runGit(repositoryRoot, ['cat-file', 'commit', ancestry[0]], {
    maxBytes: MAX_COMMIT_HEADER_BYTES,
    maxBuffer: MAX_COMMIT_HEADER_BYTES + 1,
  });
  const approvedRaw = finalCommitRaw(reviewPackage.finalCommitProposal);
  if (!actualRaw.equals(approvedRaw)) {
    throw new ReviewPackageError(
      'COMMITTED_METADATA_MISMATCH',
      'HEAD raw commit bytes do not match the metadata approved by reviewers',
    );
  }
  return true;
}

function symbolicHeadRef(cwd) {
  const ref = tryGitText(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
  if (!ref || !ref.startsWith('refs/heads/')) return null;
  try {
    runGit(cwd, ['check-ref-format', ref], { maxBytes: 256 });
    return ref;
  } catch {
    return null;
  }
}

function isRollbackSafeAttempt(cwd, commit, proposal, expectedRef) {
  if (!expectedRef || symbolicHeadRef(cwd) !== expectedRef) return false;
  try {
    const ancestry = decodeUtf8(
      runGit(cwd, ['rev-list', '--parents', '-n', '1', commit], { maxBytes: 512 }),
      'attempted commit ancestry',
    ).trim().split(/\s+/);
    if (ancestry.length !== 2 || ancestry[0] !== commit || ancestry[1] !== proposal.parent) {
      return false;
    }
    const raw = runGit(cwd, ['cat-file', 'commit', commit], {
      maxBytes: MAX_COMMIT_HEADER_BYTES,
      maxBuffer: MAX_COMMIT_HEADER_BYTES + 1,
    });
    const separator = raw.indexOf(Buffer.from('\n\n'));
    if (separator < 0) return false;
    const headers = decodeUtf8(raw.subarray(0, separator), 'attempted commit headers')
      .split('\n');
    const expectedHeaders = [
      `tree ${proposal.tree}`,
      `parent ${proposal.parent}`,
      `author ${proposal.author}`,
      `committer ${proposal.committer}`,
    ];
    if (headers.length !== expectedHeaders.length
      || headers.some((header, index) => header !== expectedHeaders[index])) return false;
    const message = raw.subarray(separator + 2);
    return message.subarray(0, Buffer.byteLength(proposal.message, 'utf8'))
      .equals(Buffer.from(proposal.message, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Materialize the exact reviewer-approved unsigned automation commit through
 * normal trusted `git commit`. This deliberately runs repository commit hooks;
 * any hook mutation of the approved tree or message changes the object id and
 * is rejected before shipping. Signing is disabled because a signature header
 * cannot be known by pre-commit reviewers. The approved worktree is revalidated
 * before staging, and replay after a successful commit is idempotent.
 *
 * @param {object} reviewPackage approved complete final-review package
 * @param {{cwd:string}} options exact canonical repository root
 * @returns {{finalCommit:string, created:boolean}}
 */
export function materializeApprovedReviewCommit(reviewPackage, { cwd } = {}) {
  const contextFields = ['prd', 'verification', 'reviewDigest'];
  const hasReviewContext = reviewPackage
    && typeof reviewPackage === 'object'
    && contextFields.some(field => Object.hasOwn(reviewPackage, field));
  if (hasReviewContext) validateReviewContext(reviewPackage);
  else assertReviewPackageIntegrity(reviewPackage);
  if (typeof cwd !== 'string' || cwd.trim().length === 0 || cwd.includes('\0')) {
    throw new ReviewPackageError('INVALID_CWD', 'cwd must be a non-empty filesystem path');
  }
  const repositoryRoot = exactRepositoryRoot(path.resolve(cwd));
  assertFinalCommitProposalCanonical(reviewPackage, repositoryRoot);
  const proposal = reviewPackage.finalCommitProposal;
  const currentHead = resolveCommit(repositoryRoot, 'HEAD', 'HEAD');
  if (currentHead === proposal.objectId) {
    // Replay is validation-only. In particular, never reset the real index:
    // staged-only user work must remain visible and block finalization.
    assertReviewPackageHeadTree(reviewPackage, { cwd: repositoryRoot });
    const replayState = getReviewWorktreeState({ cwd: repositoryRoot });
    if (replayState.dirty) {
      throw new ReviewPackageError(
        'WORKTREE_CHANGED',
        'worktree changed or index changed after the reviewer-approved commit was materialized',
      );
    }
    return Object.freeze({ finalCommit: proposal.objectId, created: false });
  }
  if (currentHead !== reviewPackage.headCommit) {
    throw new ReviewPackageError(
      'COMMITTED_PARENT_MISMATCH',
      'HEAD moved away from both the approved parent and approved final commit',
    );
  }

  assertReviewPackageCurrent(reviewPackage, { cwd: repositoryRoot });
  const originalIndexTree = decodeUtf8(
    runGit(repositoryRoot, ['write-tree'], { maxBytes: 256 }),
    'original index tree',
  ).trim();
  if (!OBJECT_ID.test(originalIndexTree)) {
    throw new ReviewPackageError('INVALID_OBJECT_ID', 'the original index did not resolve to a tree');
  }
  const originalRef = symbolicHeadRef(repositoryRoot);
  const identity = parseIdentityHeader(proposal.author, 'proposed automation identity');
  const date = `${identity.timestamp} ${identity.timezone}`;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ao-final-commit-index-'));
  const tempIndex = path.join(tempDir, 'index');
  try {
    runGit(repositoryRoot, ['read-tree', proposal.tree], {
      env: { GIT_INDEX_FILE: tempIndex },
      maxBytes: 256,
    });
    runGit(repositoryRoot, [
      '-c',
      'i18n.commitEncoding=UTF-8',
      'commit',
      '--no-gpg-sign',
      '--allow-empty',
      '--cleanup=verbatim',
      '--file=-',
    ], {
      input: Buffer.from(proposal.message, 'utf8'),
      env: {
        PATH: hookExecutionPath(),
        GIT_INDEX_FILE: tempIndex,
        GIT_AUTHOR_NAME: 'Agent Olympus',
        GIT_AUTHOR_EMAIL: 'agent-olympus@localhost',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: 'Agent Olympus',
        GIT_COMMITTER_EMAIL: 'agent-olympus@localhost',
        GIT_COMMITTER_DATE: date,
      },
      maxBytes: MAX_COMMIT_HEADER_BYTES,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const committedHead = resolveCommit(repositoryRoot, 'HEAD', 'HEAD');
  if (committedHead !== proposal.objectId) {
    if (isRollbackSafeAttempt(repositoryRoot, committedHead, proposal, originalRef)) {
      runGit(repositoryRoot, [
        'update-ref',
        '-m',
        'agent-olympus rejected mutated final commit',
        originalRef,
        reviewPackage.headCommit,
        committedHead,
      ], { maxBytes: 256 });
      throw new ReviewPackageError(
        'COMMITTED_METADATA_MISMATCH',
        'Git hooks changed the reviewer-approved commit message envelope',
      );
    }
    throw new ReviewPackageError(
      'COMMITTED_HEAD_DIVERGED',
      'Git hooks or another writer advanced HEAD; history was preserved and finalization stopped',
    );
  }

  const currentIndexTree = decodeUtf8(
    runGit(repositoryRoot, ['write-tree'], { maxBytes: 256 }),
    'current index tree',
  ).trim();
  if (currentIndexTree !== originalIndexTree) {
    throw new ReviewPackageError(
      'WORKTREE_CHANGED',
      'the real index changed while the reviewer-approved commit was materialized',
    );
  }
  runGit(repositoryRoot, ['read-tree', proposal.tree], { maxBytes: 256 });
  assertReviewPackageHeadTree(reviewPackage, { cwd: repositoryRoot });
  const worktree = getReviewWorktreeState({ cwd: repositoryRoot });
  if (worktree.dirty) {
    throw new ReviewPackageError(
      'WORKTREE_CHANGED',
      'worktree changed while the reviewer-approved commit was materialized',
    );
  }
  return Object.freeze({ finalCommit: proposal.objectId, created: true });
}

/**
 * Build immutable, size-capped Git review evidence from the merge-base through
 * HEAD and the current index/worktree. A temporary index stages the checked-out
 * filesystem to produce both the aggregate patch and reviewTreeOid without
 * changing the caller's real index or worktree.
 *
 * @param {object} options
 * @param {string} options.cwd path inside the repository
 * @param {string} [options.baseRef] branch or remote ref; auto-detected when omitted
 * @returns {Readonly<object>}
 * @throws {ReviewPackageError} on empty, incomplete, unsafe, or oversized evidence
 */
export function buildReviewPackage({ cwd, baseRef } = {}) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0 || cwd.includes('\0')) {
    throw new ReviewPackageError('INVALID_CWD', 'cwd must be a non-empty filesystem path');
  }

  const requestedCwd = path.resolve(cwd);
  const repoRoot = exactRepositoryRoot(requestedCwd);

  const resolvedBase = resolveReviewBase({ cwd: repoRoot, baseRef });
  const resolvedBaseRef = resolvedBase.baseRef;
  const baseRefCommit = resolvedBase.baseRefCommit;
  const headCommit = resolveCommit(repoRoot, 'HEAD', 'HEAD');
  const mergeBaseCommit = decodeUtf8(
    runGit(repoRoot, ['merge-base', baseRefCommit, headCommit], { maxBytes: 256 }),
    'merge-base',
  ).trim();
  if (!OBJECT_ID.test(mergeBaseCommit)) {
    throw new ReviewPackageError('NO_MERGE_BASE', 'baseRef and HEAD have no valid merge-base');
  }

  const baseToHeadBuffer = runGit(
    repoRoot,
    patchArgs(mergeBaseCommit, headCommit),
    { maxBytes: MAX_REVIEW_PATCH_BYTES },
  );
  const stagedBuffer = runGit(
    repoRoot,
    patchArgs('--cached', headCommit),
    { maxBytes: MAX_REVIEW_PATCH_BYTES },
  );
  const unstagedBuffer = runGit(
    repoRoot,
    patchArgs(),
    { maxBytes: MAX_REVIEW_PATCH_BYTES },
  );
  const {
    reviewable: untrackedPaths,
    excluded: excludedUntrackedPaths,
  } = untrackedReviewPaths(repoRoot);
  const worktreeSnapshot = buildWorktreeSnapshot(
    repoRoot,
    headCommit,
    excludedUntrackedPaths,
  );
  const headToWorktreeBuffer = worktreeSnapshot.patch;

  const committedPaths = parseNullPaths(
    runGit(repoRoot, ['diff', '--name-only', '-z', mergeBaseCommit, headCommit, '--'], {
      maxBytes: MAX_PATH_LIST_BYTES,
      maxBuffer: MAX_PATH_LIST_BYTES + 1,
    }),
    'committed diff',
  );
  const stagedPaths = parseNullPaths(
    runGit(repoRoot, ['diff', '--cached', '--name-only', '-z', headCommit, '--'], {
      maxBytes: MAX_PATH_LIST_BYTES,
      maxBuffer: MAX_PATH_LIST_BYTES + 1,
    }),
    'staged diff',
  );
  const unstagedPaths = parseNullPaths(
    runGit(repoRoot, ['diff', '--name-only', '-z', '--'], {
      maxBytes: MAX_PATH_LIST_BYTES,
      maxBuffer: MAX_PATH_LIST_BYTES + 1,
    }),
    'unstaged diff',
  );
  const diffPaths = [...new Set([
    ...committedPaths,
    ...stagedPaths,
    ...unstagedPaths,
    ...untrackedPaths,
  ])].sort();
  if (diffPaths.length === 0) {
    throw new ReviewPackageError('EMPTY_DIFF', 'there are no committed or working-tree changes to review');
  }

  const patches = {
    baseToHead: decodeUtf8(baseToHeadBuffer, 'base-to-head patch'),
    staged: decodeUtf8(stagedBuffer, 'staged patch'),
    unstaged: decodeUtf8(unstagedBuffer, 'unstaged patch'),
    headToWorktree: decodeUtf8(headToWorktreeBuffer, 'head-to-worktree patch'),
  };
  const patchBytes = PATCH_FIELDS.reduce(
    (sum, field) => sum + Buffer.byteLength(patches[field], 'utf8'),
    0,
  );
  if (patchBytes > MAX_REVIEW_PATCH_BYTES) {
    throw new ReviewPackageError('EVIDENCE_TOO_LARGE', 'combined patch evidence exceeds the output cap');
  }

  // Preserve every evidence layer in the reviewer-facing diff. A final
  // HEAD-to-worktree snapshot can legitimately be empty for an index-only file
  // that was subsequently deleted from the worktree, while that file would
  // still be committed. Including staged and unstaged patches prevents that
  // divergence from disappearing from routing and review.
  const diff = joinPatchSeries(...PATCH_FIELDS.map((field) => patches[field]));
  if (diff.length === 0) {
    throw new ReviewPackageError('INVALID_EVIDENCE', 'changed paths were found but the review patch is empty');
  }

  const reviewPackage = {
    schemaVersion: REVIEW_PACKAGE_SCHEMA_VERSION,
    baseRef: resolvedBaseRef,
    baseRefCommit,
    mergeBaseCommit,
    headCommit,
    reviewTreeOid: worktreeSnapshot.reviewTreeOid,
    finalCommitProposal: buildFinalCommitProposal(
      repoRoot,
      headCommit,
      worktreeSnapshot.reviewTreeOid,
    ),
    diffPaths,
    untrackedPaths: [...untrackedPaths].sort(),
    patches,
    diff,
  };
  reviewPackage.evidenceDigest = {
    algorithm: 'sha256',
    value: computeReviewPackageDigest(reviewPackage),
  };

  const serializedBytes = Buffer.byteLength(JSON.stringify(reviewPackage), 'utf8');
  if (serializedBytes > MAX_REVIEW_PACKAGE_BYTES) {
    throw new ReviewPackageError('EVIDENCE_TOO_LARGE', 'serialized review package exceeds the output cap');
  }
  assertReviewPackageIntegrity(reviewPackage);
  return deepFreeze(reviewPackage);
}

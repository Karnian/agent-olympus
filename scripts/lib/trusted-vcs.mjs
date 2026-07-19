import {
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const POSIX_CANDIDATES = Object.freeze({
  git: Object.freeze(['/usr/bin/git', '/bin/git']),
  gh: Object.freeze([
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    '/home/linuxbrew/.linuxbrew/bin/gh',
  ]),
  ssh: Object.freeze(['/usr/bin/ssh', '/bin/ssh']),
});

const TRUSTED_PATH_DIRS = Object.freeze([
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/home/linuxbrew/.linuxbrew/bin',
]);

const cache = new Map();

function windowsCandidates(name, env) {
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  if (name === 'git') {
    return [
      join(programFiles, 'Git', 'cmd', 'git.exe'),
      join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    ];
  }
  if (name === 'gh') {
    return [join(programFiles, 'GitHub CLI', 'gh.exe')];
  }
  if (name === 'ssh') {
    return [join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe')];
  }
  return [];
}

function candidates(name, env = process.env, platform = process.platform) {
  return platform === 'win32'
    ? windowsCandidates(name, env)
    : [...(POSIX_CANDIDATES[name] || [])];
}

function validateBinary(candidate, platform = process.platform) {
  if (!isAbsolute(candidate)) return null;
  try {
    const resolved = realpathSync(candidate);
    const stats = statSync(resolved);
    if (!stats.isFile()) return null;
    if (platform !== 'win32') {
      if ((stats.mode & 0o111) === 0 || (stats.mode & 0o022) !== 0) return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Resolve security-sensitive GitHub/Git helpers without consulting PATH.
 * Known system installation roots are tried in a fixed order and the resolved
 * executable must be a regular, executable, non-group/world-writable file.
 */
export function resolveTrustedVcsBinary(name) {
  if (!new Set(['git', 'gh', 'ssh']).has(name)) {
    throw new Error(`unsupported trusted VCS binary: ${name}`);
  }
  if (cache.has(name)) return cache.get(name);
  for (const candidate of candidates(name)) {
    const resolved = validateBinary(candidate);
    if (resolved) {
      cache.set(name, resolved);
      return resolved;
    }
  }
  throw new Error(`trusted ${name} binary is unavailable`);
}

/**
 * Remove Git repository/config redirects and ambient gh repository selectors.
 * Explicit trusted overrides (for example a private temporary index) are
 * applied only after the inherited environment has been filtered.
 */
export function sanitizedVcsEnvironment({
  env = process.env,
  git = false,
  overrides = {},
} = {}) {
  const inherited = Object.fromEntries(
    Object.entries(env || {}).filter(([key]) => (
      !key.startsWith('GIT_')
      && key !== 'GH_REPO'
      && key !== 'GH_HOST'
    )),
  );
  const safePath = process.platform === 'win32'
    ? [
        env?.SystemRoot ? join(env.SystemRoot, 'System32') : null,
        env?.ProgramFiles ? join(env.ProgramFiles, 'Git', 'cmd') : null,
      ].filter(Boolean).join(delimiter)
    : TRUSTED_PATH_DIRS.join(delimiter);
  const result = {
    ...inherited,
    PATH: safePath,
    LC_ALL: 'C',
    ...overrides,
  };
  if (git) {
    result.GIT_OPTIONAL_LOCKS = '0';
    result.GIT_PAGER = 'cat';
    result.GIT_CONFIG_NOSYSTEM = '1';
    result.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    result.GIT_TERMINAL_PROMPT = '0';
    try { result.GIT_SSH = resolveTrustedVcsBinary('ssh'); } catch {}
  }
  return result;
}

export function _clearTrustedVcsCache() {
  cache.clear();
}

export function _createTrustedVcsResolver({
  platform = 'linux',
  env = {},
  resolve = value => value,
  stat = () => ({ isFile: () => true, mode: 0o755 }),
} = {}) {
  return name => {
    for (const candidate of candidates(name, env, platform)) {
      if (!isAbsolute(candidate)) continue;
      try {
        const resolved = resolve(candidate);
        const stats = stat(resolved);
        if (stats.isFile()
          && (platform === 'win32'
            || ((stats.mode & 0o111) !== 0 && (stats.mode & 0o022) === 0))) {
          return resolved;
        }
      } catch {}
    }
    return null;
  };
}

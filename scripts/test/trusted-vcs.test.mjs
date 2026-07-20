import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { describe, it } from 'node:test';

import {
  _createTrustedVcsResolver,
  resolveTrustedVcsBinary,
  sanitizedVcsEnvironment,
} from '../lib/trusted-vcs.mjs';

describe('trusted VCS command boundary', () => {
  it('uses fixed candidates and rejects writable or non-executable files', () => {
    const seen = [];
    const resolve = candidate => {
      seen.push(candidate);
      return candidate;
    };
    const resolver = _createTrustedVcsResolver({
      platform: 'linux',
      resolve,
      stat: candidate => ({
        isFile: () => true,
        mode: candidate === '/usr/bin/git' ? 0o777 : 0o755,
      }),
    });
    assert.equal(resolver('git'), '/bin/git');
    assert.deepEqual(seen, ['/usr/bin/git', '/bin/git']);
  });

  it('does not inherit PATH or Git/gh repository redirects', () => {
    const env = sanitizedVcsEnvironment({
      git: true,
      env: {
        PATH: '/tmp/attacker-bin',
        GIT_DIR: '/tmp/other/.git',
        GIT_WORK_TREE: '/tmp/other',
        GIT_CONFIG_COUNT: '1',
        GH_REPO: 'attacker/other',
        GH_HOST: 'attacker.example',
        GH_TOKEN: 'kept-for-auth',
        HOME: '/tmp/home',
      },
    });
    assert.equal(env.PATH.includes('/tmp/attacker-bin'), false);
    assert.equal(Object.hasOwn(env, 'GIT_DIR'), false);
    assert.equal(Object.hasOwn(env, 'GIT_WORK_TREE'), false);
    assert.equal(Object.hasOwn(env, 'GIT_CONFIG_COUNT'), false);
    assert.equal(Object.hasOwn(env, 'GH_REPO'), false);
    assert.equal(Object.hasOwn(env, 'GH_HOST'), false);
    assert.equal(env.GH_TOKEN, 'kept-for-auth');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  });

  it('resolves installed production Git without consulting a bare command name', () => {
    assert.equal(isAbsolute(resolveTrustedVcsBinary('git')), true);
  });
});

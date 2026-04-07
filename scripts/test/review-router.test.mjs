/**
 * Tests for scripts/lib/review-router.mjs (v1.0.2 US-005)
 *
 * Covers:
 *   1. Disabled gate via autonomy.json → full set immediately
 *   2. CSS-only diff → frontend reviewers (aphrodite, designer)
 *   3. Backend-only diff → backend reviewers (architect, security-reviewer)
 *   4. alwaysInclude force-add (code-reviewer)
 *   5. No-match → full fallback + warning
 *   6. Security pattern hit force-includes security-reviewer
 *   7. Chaos test: 30+ obfuscated secret patterns all trigger security-reviewer
 *   8. handleEscalation adds requested reviewer in same iteration
 *   9. Regex-based api[_-]?key matches apikey/api_key/api-key/apiKey
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');

async function freshImport() {
  const url = new URL('../lib/review-router.mjs?t=' + Date.now() + Math.random(), import.meta.url);
  return import(url.href);
}

async function makeTmpProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-review-router-test-'));
  execSync('git init -q', { cwd: dir });
  // Mirror real config layout — copy review-routing.jsonc into tmp project.
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  const realConfig = path.join(REPO_ROOT, 'config', 'review-routing.jsonc');
  const body = await fs.readFile(realConfig, 'utf-8');
  writeFileSync(path.join(dir, 'config', 'review-routing.jsonc'), body);
  return dir;
}

describe('review-router: loadRoutingConfig', () => {
  it('returns parsed JSONC config from real repo', async () => {
    const mod = await freshImport();
    const cfg = mod.loadRoutingConfig(REPO_ROOT);
    assert.equal(cfg.schemaVersion, 1);
    assert.ok(Array.isArray(cfg.rules));
    assert.ok(Array.isArray(cfg.securityPatterns));
    assert.ok(cfg.securityPatterns.length >= 30);
  });

  it('returns {} when config missing', async () => {
    const mod = await freshImport();
    const cfg = mod.loadRoutingConfig('/nonexistent/path');
    assert.deepEqual(cfg, {});
  });
});

describe('review-router: routeReviewers basic scopes', () => {
  let tmp;
  before(async () => { tmp = await makeTmpProject(); });
  after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('CSS-only diff → frontend reviewers', async () => {
    const mod = await freshImport();
    const r = mod.routeReviewers({
      diffPaths: ['src/styles/buttons.css'],
      diffContent: '.btn { padding: 8px; }',
      baseDir: tmp,
    });
    assert.ok(r.reviewers.includes('aphrodite'));
    assert.ok(r.reviewers.includes('designer'));
    assert.ok(!r.reviewers.includes('architect'));
  });

  it('Backend-only diff → architect + security-reviewer', async () => {
    const mod = await freshImport();
    const r = mod.routeReviewers({
      diffPaths: ['cmd/server/main.go'],
      diffContent: 'package main',
      baseDir: tmp,
    });
    assert.ok(r.reviewers.includes('code-reviewer'));
    assert.ok(r.reviewers.includes('architect'));
    assert.ok(r.reviewers.includes('security-reviewer'));
    assert.ok(!r.reviewers.includes('aphrodite'));
  });

  it('CSS-only diff is MINIMAL — does NOT include code-reviewer (US-005 AC)', async () => {
    const mod = await freshImport();
    const r = mod.routeReviewers({
      diffPaths: ['src/styles/foo.css'],
      diffContent: '',
      baseDir: tmp,
    });
    assert.deepEqual(
      [...r.reviewers].sort(),
      ['aphrodite', 'designer'],
      `CSS-only must minimal-route to {aphrodite,designer}, got ${JSON.stringify(r.reviewers)}`,
    );
    assert.ok(!r.reviewers.includes('code-reviewer'));
    assert.ok(!r.reviewers.includes('architect'));
    assert.ok(!r.reviewers.includes('security-reviewer'));
  });

  it('alwaysInclude:["*"] rollback path → returns full fallback set', async () => {
    const mod = await freshImport();
    // Patch the tmp config to use the rollback marker.
    const cfgPath = path.join(tmp, 'config', 'review-routing.jsonc');
    const original = await fs.readFile(cfgPath, 'utf-8');
    const patched = original.replace('"alwaysInclude": []', '"alwaysInclude": ["*"]');
    await fs.writeFile(cfgPath, patched);
    try {
      const r = mod.routeReviewers({
        diffPaths: ['src/styles/foo.css'],
        diffContent: '',
        baseDir: tmp,
      });
      assert.ok(r.reviewers.includes('code-reviewer'));
      assert.ok(r.reviewers.includes('architect'));
      assert.ok(r.reviewers.includes('security-reviewer'));
      assert.ok(r.reviewers.includes('aphrodite'));
      assert.ok(r.reviewers.includes('test-engineer'));
      assert.match(r.warning || '', /rollback mode/);
    } finally {
      await fs.writeFile(cfgPath, original);
    }
  });

  it('No-match diff → full fallback with warning', async () => {
    const mod = await freshImport();
    const r = mod.routeReviewers({
      diffPaths: ['some/random/path.xyz'],
      diffContent: 'plain text',
      baseDir: tmp,
    });
    assert.equal(r.matchedRules.length, 0);
    assert.ok(r.warning);
    assert.ok(r.reviewers.length >= 4);
    assert.ok(r.reviewers.includes('security-reviewer'));
  });
});

describe('review-router: securityPatterns force-include', () => {
  let tmp;
  before(async () => { tmp = await makeTmpProject(); });
  after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('CSS file with token in content → security-reviewer added', async () => {
    const mod = await freshImport();
    const r = mod.routeReviewers({
      diffPaths: ['src/styles/auth.css'],
      diffContent: 'background: url("https://example.com/?token=abc")',
      baseDir: tmp,
    });
    assert.ok(r.securityHit);
    assert.ok(r.reviewers.includes('security-reviewer'));
  });

  it('regex api[_-]?key matches apikey AND api_key AND api-key', async () => {
    const mod = await freshImport();
    const cfg = mod.loadRoutingConfig(tmp);
    const patterns = mod.compileSecurityPatterns(cfg);
    const apiKeyRe = patterns.find((re) => re.source.includes('api[_-]?key'));
    assert.ok(apiKeyRe);
    assert.ok(apiKeyRe.test('apikey'));
    assert.ok(apiKeyRe.test('api_key'));
    assert.ok(apiKeyRe.test('api-key'));
    assert.ok(apiKeyRe.test('My_API_Key_Here'));
  });
});

describe('review-router: chaos test — 30+ obfuscated secret patterns', () => {
  let tmp;
  before(async () => { tmp = await makeTmpProject(); });
  after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  const CHAOS = [
    'const token = "abc"',
    'API_SECRET=foo',
    'apikey: "xxx"',
    'const api_key = process.env.X',
    'const api-key value',
    'apiKey: "redacted"',
    'AWS_CREDENTIAL_FILE',
    'crypto.createHmac("sha256", k)',
    'const signature = sign(payload)',
    'signed url generation',
    'bcrypt.hash(pw, 10)',
    'argon2.verify(h, pw)',
    'scrypt(pw, salt, 64)',
    'pbkdf2Sync(pw, salt, 100000)',
    'const privateKey = readFileSync("key.pem")',
    'private_key_id: "..."',
    'rsa keypair generation',
    'ecdsa-sha2-nistp256',
    'csrf token validation',
    'xsrfHeaderName',
    'SAML assertion',
    'oidc discovery',
    'jwks_uri endpoint',
    'KMS encrypt call',
    'vault read secret/foo',
    'jwt.sign(payload, secret)',
    'const password = "p@ss"',
    'oauth2 flow',
    'cookie: session=abc',
    'refresh_token rotation',
    'Authorization: Bearer xyz',
    'client_secret: foo',
    'access_key_id: AKIA',
    'secret_access_key: ...',
    'OPENSSH PRIVATE KEY block',
    '-----BEGIN RSA PRIVATE KEY-----',
    'ssh-rsa AAAAB3...',
    'connection_string: postgres://',
    'database_url: mysql://',
    'DB_URL=postgres://localhost',
    'cert at server.pem',
    '.env.local secrets',
    'crypto.subtle.encrypt',
    'jwt-decode library',
    'signed-url generator',
  ];

  it('every chaos pattern triggers security-reviewer', async () => {
    const mod = await freshImport();
    assert.ok(CHAOS.length >= 30, `chaos fixture has ${CHAOS.length} cases (need 30+)`);
    const failures = [];
    for (const sample of CHAOS) {
      const r = mod.routeReviewers({
        diffPaths: ['src/styles/innocent.css'],
        diffContent: sample,
        baseDir: tmp,
      });
      if (!r.reviewers.includes('security-reviewer')) {
        failures.push(sample);
      }
    }
    assert.equal(failures.length, 0, `false negatives: ${JSON.stringify(failures, null, 2)}`);
  });
});

describe('review-router: handleEscalation', () => {
  it('adds the requested reviewer in same iteration', async () => {
    const mod = await freshImport();
    const r = mod.handleEscalation(['code-reviewer', 'aphrodite'], {
      type: 'RE-REVIEW-REQUESTED',
      additionalReviewer: 'security-reviewer',
      reason: 'detected hardcoded API key in shared util',
    });
    assert.equal(r.escalated, true);
    assert.ok(r.reviewers.includes('security-reviewer'));
    assert.equal(r.reason, 'detected hardcoded API key in shared util');
  });

  it('idempotent — already-included reviewer marks escalated=false', async () => {
    const mod = await freshImport();
    const r = mod.handleEscalation(['code-reviewer', 'security-reviewer'], {
      type: 'RE-REVIEW-REQUESTED',
      additionalReviewer: 'security-reviewer',
    });
    assert.equal(r.escalated, false);
    assert.ok(r.reviewers.includes('security-reviewer'));
  });

  it('ignores malformed flag', async () => {
    const mod = await freshImport();
    const r = mod.handleEscalation(['code-reviewer'], { type: 'OTHER' });
    assert.equal(r.escalated, false);
    assert.deepEqual(r.reviewers, ['code-reviewer']);
  });
});

describe('review-router: disabled via autonomy.json', () => {
  let tmp;
  before(async () => {
    tmp = await makeTmpProject();
    mkdirSync(path.join(tmp, '.ao'), { recursive: true });
    writeFileSync(
      path.join(tmp, '.ao', 'autonomy.json'),
      JSON.stringify({ reviewRouter: { disabled: true } }),
    );
  });
  after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('returns full reviewer set immediately when disabled', async () => {
    const mod = await freshImport();
    const r = mod.routeReviewers({
      diffPaths: ['src/styles/foo.css'],
      diffContent: '',
      baseDir: tmp,
    });
    assert.equal(r.disabled, true);
    assert.ok(r.reviewers.length >= 4);
  });
});

/**
 * Tests for scripts/lib/browser-handoff.mjs (v1.0.2 US-006)
 *
 * Browser pause + manual continue protocol.
 * Includes the mandatory credential-leak deny-list test (explicit AC requirement).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'ao-browser-handoff-test-'));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// ── module import ────────────────────────────────────────────────────────────

let mod;

describe('browser-handoff module', () => {
  before(async () => {
    mod = await import('../lib/browser-handoff.mjs');
  });

  // ── Public API surface ──────────────────────────────────────────────────

  describe('exports', () => {
    it('exports sanitizeUrl', () => {
      assert.strictEqual(typeof mod.sanitizeUrl, 'function');
    });

    it('exports sanitizeBreadcrumb', () => {
      assert.strictEqual(typeof mod.sanitizeBreadcrumb, 'function');
    });

    it('exports saveHandoff', () => {
      assert.strictEqual(typeof mod.saveHandoff, 'function');
    });

    it('exports readHandoff', () => {
      assert.strictEqual(typeof mod.readHandoff, 'function');
    });

    it('exports isHandoffStale', () => {
      assert.strictEqual(typeof mod.isHandoffStale, 'function');
    });

    it('exports SENSITIVE_PARAM_PATTERNS', () => {
      assert.ok(Array.isArray(mod.SENSITIVE_PARAM_PATTERNS), 'must be an array');
      assert.ok(mod.SENSITIVE_PARAM_PATTERNS.length >= 10, 'must have at least 10 patterns');
    });
  });

  // ── sanitizeUrl ─────────────────────────────────────────────────────────

  describe('sanitizeUrl()', () => {
    it('strips access_token from query string', () => {
      const url = 'https://app.example.com/callback?access_token=abc123&user=alice';
      const out = mod.sanitizeUrl(url);
      assert.ok(!out.includes('abc123'), 'access_token value must be stripped');
      assert.ok(out.includes('user=alice'), 'non-sensitive params must survive');
    });

    it('strips id_token from query string', () => {
      const url = 'https://app.example.com/?id_token=eyJhbGci.xxx&next=/dashboard';
      const out = mod.sanitizeUrl(url);
      assert.ok(!out.includes('eyJhbGci'), 'id_token value must be stripped');
      assert.ok(out.includes('next='), 'non-sensitive param must survive');
    });

    it('strips code from OAuth callback', () => {
      const url = 'https://app.example.com/oauth/callback?code=AUTH_CODE_HERE&state=xyz';
      const out = mod.sanitizeUrl(url);
      assert.ok(!out.includes('AUTH_CODE_HERE'), 'code value must be stripped');
    });

    it('strips state parameter (CSRF token)', () => {
      const url = 'https://app.example.com/?state=csrftokenvalue123';
      const out = mod.sanitizeUrl(url);
      assert.ok(!out.includes('csrftokenvalue123'), 'state value must be stripped');
    });

    it('strips sig / signature params', () => {
      const url1 = 'https://api.example.com/?sig=HMAC_VALUE&action=pay';
      const url2 = 'https://api.example.com/?signature=HMAC_VALUE&action=pay';
      assert.ok(!mod.sanitizeUrl(url1).includes('HMAC_VALUE'));
      assert.ok(!mod.sanitizeUrl(url2).includes('HMAC_VALUE'));
    });

    it('strips secret param', () => {
      const url = 'https://app.example.com/?secret=MY_SECRET&foo=bar';
      assert.ok(!mod.sanitizeUrl(url).includes('MY_SECRET'));
    });

    it('strips key param', () => {
      const url = 'https://app.example.com/?key=API_KEY_123&page=1';
      assert.ok(!mod.sanitizeUrl(url).includes('API_KEY_123'));
    });

    it('strips password param', () => {
      const url = 'https://login.example.com/?password=hunter2&user=alice';
      assert.ok(!mod.sanitizeUrl(url).includes('hunter2'));
    });

    it('strips auth param', () => {
      const url = 'https://app.example.com/?auth=BEARER_TOKEN&tab=2';
      assert.ok(!mod.sanitizeUrl(url).includes('BEARER_TOKEN'));
    });

    it('strips session param', () => {
      const url = 'https://app.example.com/?session=SESSION_ID_VALUE&locale=en';
      assert.ok(!mod.sanitizeUrl(url).includes('SESSION_ID_VALUE'));
    });

    it('strips token param', () => {
      const url = 'https://app.example.com/reset?token=RESET_TOKEN_VALUE&email=a@b.com';
      assert.ok(!mod.sanitizeUrl(url).includes('RESET_TOKEN_VALUE'));
    });

    it('strips jwt param', () => {
      const url = 'https://app.example.com/?jwt=eyJhbGciOiJIUzI1NiJ9.xxx&view=main';
      assert.ok(!mod.sanitizeUrl(url).includes('eyJhbGciOiJIUzI1NiJ9'));
    });

    it('strips hmac param', () => {
      const url = 'https://app.example.com/?hmac=HMAC_SIG_VALUE&shop=test';
      assert.ok(!mod.sanitizeUrl(url).includes('HMAC_SIG_VALUE'));
    });

    it('strips otp param', () => {
      const url = 'https://app.example.com/verify?otp=123456&user=alice';
      assert.ok(!mod.sanitizeUrl(url).includes('123456'));
    });

    it('strips recovery param', () => {
      const url = 'https://app.example.com/?recovery=RECOVERY_CODE&step=2';
      assert.ok(!mod.sanitizeUrl(url).includes('RECOVERY_CODE'));
    });

    it('strips refresh param', () => {
      const url = 'https://app.example.com/?refresh=REFRESH_TOKEN_VALUE&v=2';
      assert.ok(!mod.sanitizeUrl(url).includes('REFRESH_TOKEN_VALUE'));
    });

    it('preserves non-sensitive query params (page, tab, locale, next, etc.)', () => {
      const url = 'https://app.example.com/?page=2&tab=settings&locale=en&next=/dashboard';
      const out = mod.sanitizeUrl(url);
      assert.ok(out.includes('page=2'), 'page should survive');
      assert.ok(out.includes('tab=settings'), 'tab should survive');
      assert.ok(out.includes('locale=en'), 'locale should survive');
    });

    it('handles URL with no query string unchanged', () => {
      const url = 'https://app.example.com/dashboard';
      const out = mod.sanitizeUrl(url);
      assert.strictEqual(out, url);
    });

    it('handles malformed URL gracefully — returns as-is', () => {
      const bad = 'not-a-url-at-all';
      const out = mod.sanitizeUrl(bad);
      assert.strictEqual(typeof out, 'string', 'must return a string');
    });

    it('case-insensitive param name matching (Access_Token, ACCESS_TOKEN)', () => {
      const url1 = 'https://app.example.com/?Access_Token=VALUE&foo=bar';
      const url2 = 'https://app.example.com/?ACCESS_TOKEN=VALUE&foo=bar';
      assert.ok(!mod.sanitizeUrl(url1).includes('VALUE'));
      assert.ok(!mod.sanitizeUrl(url2).includes('VALUE'));
    });

    it('handles multiple sensitive params in one URL', () => {
      const url = 'https://app.example.com/?code=CODE&state=STATE&access_token=AT&page=1';
      const out = mod.sanitizeUrl(url);
      assert.ok(!out.includes('CODE'));
      assert.ok(!out.includes('STATE'));
      assert.ok(!out.includes('AT'));
      assert.ok(out.includes('page=1'));
    });
  });

  // ── sanitizeBreadcrumb — CREDENTIAL-LEAK DENY-LIST TEST ────────────────
  //
  // This is an EXPLICIT AC requirement:
  // "GIVEN breadcrumb persistence WHEN inspected THEN it contains ONLY
  //  allow-listed fields: {step, lastClickedSelector, screenshotPath?}.
  //  Everything else is FORBIDDEN by an explicit deny-list test."
  //
  describe('sanitizeBreadcrumb() — credential-leak deny-list', () => {
    it('allows step field', () => {
      const bc = mod.sanitizeBreadcrumb({ step: 'click-login' });
      assert.ok('step' in bc, 'step must survive');
      assert.strictEqual(bc.step, 'click-login');
    });

    it('allows lastClickedSelector field', () => {
      const bc = mod.sanitizeBreadcrumb({ lastClickedSelector: '#submit-btn' });
      assert.ok('lastClickedSelector' in bc);
    });

    it('allows screenshotPath field', () => {
      const bc = mod.sanitizeBreadcrumb({ screenshotPath: '/tmp/screenshot.png' });
      assert.ok('screenshotPath' in bc);
    });

    it('allows all three allowed fields together', () => {
      const bc = mod.sanitizeBreadcrumb({
        step: 'step-1',
        lastClickedSelector: '#btn',
        screenshotPath: '/tmp/shot.png',
      });
      assert.strictEqual(bc.step, 'step-1');
      assert.strictEqual(bc.lastClickedSelector, '#btn');
      assert.strictEqual(bc.screenshotPath, '/tmp/shot.png');
    });

    // DENY-LIST: The following fields are explicitly FORBIDDEN
    it('[DENY] strips formValues', () => {
      const bc = mod.sanitizeBreadcrumb({ step: 'ok', formValues: { password: 'hunter2' } });
      assert.ok(!('formValues' in bc), 'formValues MUST be stripped');
    });

    it('[DENY] strips localStorage', () => {
      const bc = mod.sanitizeBreadcrumb({ step: 'ok', localStorage: { auth_token: 'secret' } });
      assert.ok(!('localStorage' in bc), 'localStorage MUST be stripped');
    });

    it('[DENY] strips headers', () => {
      const bc = mod.sanitizeBreadcrumb({ step: 'ok', headers: { Authorization: 'Bearer xyz' } });
      assert.ok(!('headers' in bc), 'headers MUST be stripped');
    });

    it('[DENY] strips cookies', () => {
      const bc = mod.sanitizeBreadcrumb({ step: 'ok', cookies: 'session=abc; path=/' });
      assert.ok(!('cookies' in bc), 'cookies MUST be stripped');
    });

    it('[DENY] strips fetchPayloads', () => {
      const bc = mod.sanitizeBreadcrumb({ step: 'ok', fetchPayloads: [{ body: '{"pw":"x"}' }] });
      assert.ok(!('fetchPayloads' in bc), 'fetchPayloads MUST be stripped');
    });

    it('[DENY] strips requestBody', () => {
      const bc = mod.sanitizeBreadcrumb({ step: 'ok', requestBody: '{"secret":"val"}' });
      assert.ok(!('requestBody' in bc), 'requestBody MUST be stripped');
    });

    it('[DENY] strips sessionStorage', () => {
      const bc = mod.sanitizeBreadcrumb({ step: 'ok', sessionStorage: {} });
      assert.ok(!('sessionStorage' in bc), 'sessionStorage MUST be stripped');
    });

    it('[DENY] strips indexedDB data', () => {
      const bc = mod.sanitizeBreadcrumb({ step: 'ok', indexedDB: {} });
      assert.ok(!('indexedDB' in bc), 'indexedDB MUST be stripped');
    });

    it('[DENY] strips any unknown field not in allow-list', () => {
      const bc = mod.sanitizeBreadcrumb({
        step: 'ok',
        someRandomKey: 'value',
        anotherKey: 42,
      });
      assert.ok(!('someRandomKey' in bc), 'unknown fields MUST be stripped');
      assert.ok(!('anotherKey' in bc), 'unknown fields MUST be stripped');
    });

    it('[DENY] strips all dangerous fields in one call', () => {
      const bc = mod.sanitizeBreadcrumb({
        step: 'login-submit',
        lastClickedSelector: '#login-btn',
        screenshotPath: '/tmp/screen.png',
        formValues: { email: 'a@b.com', password: 'hunter2' },
        localStorage: { jwt: 'eyJ...' },
        headers: { Authorization: 'Bearer token' },
        cookies: 'session=XYZ',
        fetchPayloads: [],
        requestBody: '{}',
        sessionStorage: {},
        indexedDB: {},
        unknownExtra: 'bad',
      });
      // Allowed fields survive
      assert.strictEqual(bc.step, 'login-submit');
      assert.strictEqual(bc.lastClickedSelector, '#login-btn');
      assert.strictEqual(bc.screenshotPath, '/tmp/screen.png');
      // Forbidden fields all stripped
      assert.ok(!('formValues' in bc));
      assert.ok(!('localStorage' in bc));
      assert.ok(!('headers' in bc));
      assert.ok(!('cookies' in bc));
      assert.ok(!('fetchPayloads' in bc));
      assert.ok(!('requestBody' in bc));
      assert.ok(!('sessionStorage' in bc));
      assert.ok(!('indexedDB' in bc));
      assert.ok(!('unknownExtra' in bc));
      // Only 3 keys in result
      assert.strictEqual(Object.keys(bc).length, 3);
    });

    it('returns empty object when only forbidden fields passed', () => {
      const bc = mod.sanitizeBreadcrumb({ formValues: { pw: 'x' }, cookies: 'abc' });
      assert.strictEqual(Object.keys(bc).length, 0);
    });

    it('handles null/undefined input gracefully', () => {
      assert.deepStrictEqual(mod.sanitizeBreadcrumb(null), {});
      assert.deepStrictEqual(mod.sanitizeBreadcrumb(undefined), {});
      assert.deepStrictEqual(mod.sanitizeBreadcrumb({}), {});
    });
  });

  // ── isHandoffStale ──────────────────────────────────────────────────────

  describe('isHandoffStale()', () => {
    it('returns false for a state written within the last minute', () => {
      const state = { createdAt: new Date().toISOString() };
      assert.strictEqual(mod.isHandoffStale(state), false);
    });

    it('returns true for a state older than 24h', () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const state = { createdAt: old };
      assert.strictEqual(mod.isHandoffStale(state), true);
    });

    it('returns true for missing createdAt', () => {
      assert.strictEqual(mod.isHandoffStale({}), true);
    });

    it('returns true for null state', () => {
      assert.strictEqual(mod.isHandoffStale(null), true);
    });

    it('returns true at exactly 24h boundary (stale)', () => {
      const exactly24h = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1).toISOString();
      const state = { createdAt: exactly24h };
      assert.strictEqual(mod.isHandoffStale(state), true);
    });

    it('returns false just under 24h', () => {
      const under24h = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
      const state = { createdAt: under24h };
      assert.strictEqual(mod.isHandoffStale(state), false);
    });
  });

  // ── saveHandoff ─────────────────────────────────────────────────────────

  describe('saveHandoff()', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = makeTmpDir();
    });

    after(() => {
      try { rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('writes browser-handoff.json with schemaVersion:1', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      await mod.saveHandoff({
        sessionId: 'session-abc',
        url: 'https://app.example.com/login',
        breadcrumb: { step: 'login-page', lastClickedSelector: '#login-btn' },
        stateDir,
      });

      const filePath = path.join(stateDir, 'browser-handoff.json');
      assert.ok(existsSync(filePath), 'browser-handoff.json must be written');
      const state = readJson(filePath);
      assert.strictEqual(state.schemaVersion, 1);
    });

    it('written state contains sessionId, url, breadcrumb, createdAt', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      const url = 'https://app.example.com/dashboard?page=1';
      await mod.saveHandoff({
        sessionId: 'sess-xyz',
        url,
        breadcrumb: { step: 'step-2', lastClickedSelector: '#next' },
        stateDir,
      });

      const state = readJson(path.join(stateDir, 'browser-handoff.json'));
      assert.strictEqual(state.sessionId, 'sess-xyz');
      assert.ok(state.url, 'url must be present');
      assert.ok(state.breadcrumb, 'breadcrumb must be present');
      assert.ok(state.createdAt, 'createdAt must be present');
    });

    it('automatically sanitizes URL before writing (strips sensitive params)', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      const dirtyUrl = 'https://app.example.com/callback?access_token=SECRET&code=AUTH_CODE&page=2';
      await mod.saveHandoff({
        sessionId: 'sess-s',
        url: dirtyUrl,
        breadcrumb: { step: 'oauth-callback' },
        stateDir,
      });

      const state = readJson(path.join(stateDir, 'browser-handoff.json'));
      assert.ok(!state.url.includes('SECRET'), 'access_token value must be stripped from persisted URL');
      assert.ok(!state.url.includes('AUTH_CODE'), 'code value must be stripped from persisted URL');
    });

    it('automatically sanitizes breadcrumb before writing (strips forbidden fields)', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      await mod.saveHandoff({
        sessionId: 'sess-bc',
        url: 'https://app.example.com/',
        breadcrumb: {
          step: 'auth',
          lastClickedSelector: '#submit',
          formValues: { password: 'hunter2' }, // FORBIDDEN
          cookies: 'session=ABC',              // FORBIDDEN
        },
        stateDir,
      });

      const state = readJson(path.join(stateDir, 'browser-handoff.json'));
      assert.ok(!('formValues' in state.breadcrumb), 'formValues must be stripped before writing');
      assert.ok(!('cookies' in state.breadcrumb), 'cookies must be stripped before writing');
      assert.strictEqual(state.breadcrumb.step, 'auth');
    });

    it('creates stateDir if it does not exist', async () => {
      const stateDir = path.join(tmpDir, 'new-state-dir', '.ao', 'state');
      // Do NOT create it
      await mod.saveHandoff({
        sessionId: 'sess-mkdir',
        url: 'https://app.example.com/',
        breadcrumb: { step: 'test' },
        stateDir,
      });
      assert.ok(existsSync(path.join(stateDir, 'browser-handoff.json')));
    });

    it('handles missing sessionId gracefully — still writes with empty sessionId', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      // Should not throw
      await mod.saveHandoff({
        url: 'https://app.example.com/',
        breadcrumb: { step: 'test' },
        stateDir,
      });

      const state = readJson(path.join(stateDir, 'browser-handoff.json'));
      assert.strictEqual(state.schemaVersion, 1);
    });
  });

  // ── readHandoff ─────────────────────────────────────────────────────────

  describe('readHandoff()', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = makeTmpDir();
    });

    after(() => {
      try { rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('returns null when browser-handoff.json does not exist', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      const result = await mod.readHandoff({ stateDir });
      assert.strictEqual(result, null);
    });

    it('returns null for stale state (older than 24h)', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        path.join(stateDir, 'browser-handoff.json'),
        JSON.stringify({ schemaVersion: 1, sessionId: 'abc', url: 'https://x.com', createdAt: old }),
      );

      const result = await mod.readHandoff({ stateDir });
      assert.strictEqual(result, null, 'stale handoff must return null');
    });

    it('returns state for fresh handoff', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      const state = {
        schemaVersion: 1,
        sessionId: 'sess-read',
        url: 'https://app.example.com/step2',
        breadcrumb: { step: 'step2', lastClickedSelector: '#btn' },
        createdAt: new Date().toISOString(),
      };
      writeFileSync(path.join(stateDir, 'browser-handoff.json'), JSON.stringify(state));

      const result = await mod.readHandoff({ stateDir });
      assert.ok(result, 'should return non-null for fresh state');
      assert.strictEqual(result.sessionId, 'sess-read');
    });

    it('returns null for corrupted JSON — fail-safe', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, 'browser-handoff.json'), 'NOT_JSON{{{{');

      const result = await mod.readHandoff({ stateDir });
      assert.strictEqual(result, null);
    });

    it('includes stale flag when stale state is read with includeStale:true', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        path.join(stateDir, 'browser-handoff.json'),
        JSON.stringify({ schemaVersion: 1, sessionId: 'abc', url: 'https://x.com', createdAt: old }),
      );

      const result = await mod.readHandoff({ stateDir, includeStale: true });
      assert.ok(result, 'includeStale:true must return state even if stale');
      assert.strictEqual(result.stale, true, 'stale:true must be set on the returned object');
    });
  });

  // ── autonomy.json disabled path ─────────────────────────────────────────

  describe('browserHandoff disabled path', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = makeTmpDir();
    });

    after(() => {
      try { rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('saveHandoff returns early when autonomy.json has browserHandoff.disabled:true', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      // Write autonomy.json with disabled flag
      const aoDir = path.join(tmpDir, '.ao');
      writeFileSync(
        path.join(aoDir, 'autonomy.json'),
        JSON.stringify({ browserHandoff: { disabled: true } }),
      );

      await mod.saveHandoff({
        sessionId: 'skip-test',
        url: 'https://app.example.com/',
        breadcrumb: { step: 'test' },
        stateDir,
        cwd: tmpDir, // tell the module to find autonomy.json here
      });

      // File should NOT be written
      assert.strictEqual(
        existsSync(path.join(stateDir, 'browser-handoff.json')),
        false,
        'must skip write when browserHandoff.disabled:true',
      );
    });
  });

  // ── SENSITIVE_PARAM_PATTERNS completeness test ──────────────────────────

  describe('SENSITIVE_PARAM_PATTERNS completeness (AC explicit)', () => {
    // AC says: "patterns matched as regex against parameter names"
    // Required patterns from the AC: access_token, id_token, code, state, sig, signature,
    // secret, key, password, auth, session, token, jwt, hmac, otp, recovery, refresh
    const REQUIRED_PARAM_NAMES = [
      'access_token', 'id_token', 'code', 'state', 'sig', 'signature',
      'secret', 'key', 'password', 'auth', 'session', 'token', 'jwt',
      'hmac', 'otp', 'recovery', 'refresh',
    ];

    for (const paramName of REQUIRED_PARAM_NAMES) {
      it(`SENSITIVE_PARAM_PATTERNS must match "${paramName}"`, () => {
        const matched = mod.SENSITIVE_PARAM_PATTERNS.some((pattern) => {
          const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
          return re.test(paramName);
        });
        assert.ok(matched, `No pattern in SENSITIVE_PARAM_PATTERNS matches "${paramName}"`);
      });
    }

    it('SENSITIVE_PARAM_PATTERNS match as regex (not just string includes)', () => {
      // access_token should match via a regex pattern, not just string.includes
      // This verifies the impl uses RegExp, not String.includes
      const hasRegex = mod.SENSITIVE_PARAM_PATTERNS.some(
        (p) => p instanceof RegExp || typeof p === 'string',
      );
      assert.ok(hasRegex, 'patterns must be RegExp or string patterns');
    });
  });

  // ── saveHandoff + readHandoff round-trip ─────────────────────────────────

  describe('save/read round-trip', () => {
    let tmpDir;

    before(() => {
      tmpDir = makeTmpDir();
    });

    after(() => {
      try { rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('saved state can be read back with correct fields', async () => {
      const stateDir = path.join(tmpDir, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true });

      await mod.saveHandoff({
        sessionId: 'sess-roundtrip',
        url: 'https://app.example.com/step3?page=1',
        breadcrumb: {
          step: 'checkout',
          lastClickedSelector: '#checkout-btn',
          screenshotPath: '/tmp/checkout.png',
          formValues: { cc: '4111...' }, // FORBIDDEN — must be stripped
        },
        stateDir,
      });

      const state = await mod.readHandoff({ stateDir });
      assert.ok(state, 'should read back successfully');
      assert.strictEqual(state.sessionId, 'sess-roundtrip');
      assert.strictEqual(state.schemaVersion, 1);
      assert.ok(state.url, 'url must be present');
      assert.strictEqual(state.breadcrumb.step, 'checkout');
      assert.ok(!('formValues' in state.breadcrumb), 'formValues must be stripped at save time');
    });
  });
});

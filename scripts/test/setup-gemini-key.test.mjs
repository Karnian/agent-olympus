/**
 * Unit tests for the pure helpers exported from scripts/setup-gemini-key.mjs.
 *
 * We intentionally don't import the wizard's main() — that path requires a
 * TTY and the real `/usr/bin/security` binary. The critical fixable bugs
 * codex flagged in PR 3 review live in parseArgs + patchCredentialSource,
 * both of which are pure functions and safe to unit test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, patchCredentialSource } from '../setup-gemini-key.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// parseArgs — missing-value detection (codex PR3 finding: Low)

test('parseArgs: no args returns all defaults, no error', () => {
  const r = parseArgs([]);
  assert.equal(r.error, null);
  assert.equal(r.help, false);
  assert.equal(r.account, null);
  assert.equal(r.service, null);
  assert.equal(r.updateAutonomy, null);
});

test('parseArgs: --help sets help=true', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs: --account requires a value; missing → error', () => {
  const r = parseArgs(['--account']);
  assert.match(r.error, /--account requires a value/);
  assert.equal(r.account, null);
});

test('parseArgs: --account followed by another flag rejects (does NOT consume the flag)', () => {
  const r = parseArgs(['--account', '--update-autonomy']);
  assert.match(r.error, /--account requires a value/);
  assert.equal(r.account, null, 'must not swallow --update-autonomy as account value');
  assert.equal(r.updateAutonomy, null, 'must not have processed the next flag');
});

test('parseArgs: --account with value parsed correctly', () => {
  const r = parseArgs(['--account', 'work-api-key']);
  assert.equal(r.error, null);
  assert.equal(r.account, 'work-api-key');
});

test('parseArgs: --service requires a value; missing → error', () => {
  const r = parseArgs(['--service']);
  assert.match(r.error, /--service requires a value/);
});

test('parseArgs: --service followed by another flag rejects', () => {
  const r = parseArgs(['--service', '--no-update-autonomy']);
  assert.match(r.error, /--service requires a value/);
  assert.equal(r.service, null);
});

test('parseArgs: --update-autonomy and --no-update-autonomy set tri-state correctly', () => {
  assert.equal(parseArgs(['--update-autonomy']).updateAutonomy, true);
  assert.equal(parseArgs(['--no-update-autonomy']).updateAutonomy, false);
  // Absent = null = "ask interactively"
  assert.equal(parseArgs([]).updateAutonomy, null);
});

test('parseArgs: unknown argument returns error, no exit', () => {
  const r = parseArgs(['--nonsense']);
  assert.match(r.error, /unknown argument.*--nonsense/);
});

test('parseArgs: combination of account + service + update-autonomy parses cleanly', () => {
  const r = parseArgs([
    '--account', 'work',
    '--service', 'my.service',
    '--update-autonomy',
  ]);
  assert.equal(r.error, null);
  assert.equal(r.account, 'work');
  assert.equal(r.service, 'my.service');
  assert.equal(r.updateAutonomy, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// patchCredentialSource — stale keychainService clearing (codex PR3 finding: Medium)

test('patchCredentialSource: empty input produces gemini block with ao-keychain', () => {
  const p = patchCredentialSource({}, 'agent-olympus.gemini-api-key');
  assert.equal(p.gemini.credentialSource, 'ao-keychain');
  // Default service → no explicit keychainService override
  assert.equal(p.gemini.keychainService, undefined);
});

test('patchCredentialSource: null/undefined data still produces valid object', () => {
  assert.equal(patchCredentialSource(null, 'agent-olympus.gemini-api-key').gemini.credentialSource, 'ao-keychain');
  assert.equal(patchCredentialSource(undefined, 'agent-olympus.gemini-api-key').gemini.credentialSource, 'ao-keychain');
});

test('patchCredentialSource: custom service name is recorded as keychainService override', () => {
  const p = patchCredentialSource({}, 'my.custom.service');
  assert.equal(p.gemini.credentialSource, 'ao-keychain');
  assert.equal(p.gemini.keychainService, 'my.custom.service');
});

test('patchCredentialSource: CRITICAL — reverting to default service REMOVES stale keychainService override', () => {
  const prior = {
    gemini: {
      credentialSource: 'ao-keychain',
      keychainService: 'my.old.service', // stale from a previous wizard run
      keychainAccount: 'default-api-key',
    },
  };
  const p = patchCredentialSource(prior, 'agent-olympus.gemini-api-key');
  assert.equal(p.gemini.credentialSource, 'ao-keychain');
  assert.equal(
    'keychainService' in p.gemini, false,
    'stale keychainService override must be DELETED when switching to default'
  );
  // Unrelated gemini subfields preserved
  assert.equal(p.gemini.keychainAccount, 'default-api-key');
});

test('patchCredentialSource: non-gemini fields are preserved (shallow spread)', () => {
  const prior = {
    codex: { approval: 'full-auto' },
    ship: { autoPush: true, labels: ['wip'] },
    gemini: { approval: 'yolo' },
  };
  const p = patchCredentialSource(prior, 'agent-olympus.gemini-api-key');
  assert.deepEqual(p.codex, { approval: 'full-auto' });
  assert.deepEqual(p.ship, { autoPush: true, labels: ['wip'] });
  assert.equal(p.gemini.approval, 'yolo', 'other gemini fields preserved');
});

test('patchCredentialSource: does not mutate the input object', () => {
  const prior = {
    gemini: { keychainService: 'old.service', approval: 'auto' },
  };
  const snapshot = JSON.parse(JSON.stringify(prior));
  patchCredentialSource(prior, 'agent-olympus.gemini-api-key');
  assert.deepEqual(prior, snapshot, 'input must remain unchanged');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_CLI_CAPABILITIES,
  requireCodexCapability,
} from '../lib/codex-version-gate.mjs';

test('Codex CLI capability contract is deeply frozen', () => {
  assert.equal(Object.isFrozen(CODEX_CLI_CAPABILITIES), true);
  for (const capability of Object.values(CODEX_CLI_CAPABILITIES)) {
    assert.equal(Object.isFrozen(capability), true);
  }
});

test('requireCodexCapability fails closed for missing and unparseable versions', () => {
  for (const version of [null, undefined, '', 'garbage', '0.143.0-beta']) {
    assert.throws(
      () => requireCodexCapability(version, 'ignoreRules'),
      /read-only rule isolation requires Codex >=0\.143\.0 .*detected unknown\. Upgrade with:/,
    );
  }
});

test('requireCodexCapability rejects old versions and accepts the exact minimum', () => {
  assert.throws(
    () => requireCodexCapability('0.142.5', 'ignoreRules'),
    /detected 0\.142\.5/,
  );
  assert.doesNotThrow(() => requireCodexCapability('0.143.0', 'ignoreRules'));
});

test('requireCodexCapability rejects unknown capability names', () => {
  assert.throws(
    () => requireCodexCapability('0.143.0', 'not-real'),
    /unknown Codex CLI capability: not-real/,
  );
});

/**
 * Async-compat gating test for SubagentStart hook (v1.0.2 F-001 AC-3).
 *
 * Per prd.json F-001 acceptance criteria:
 *   "hooks/hooks.json SubagentStart entry WHEN inspected THEN it remains SYNC
 *    by default (matching the existing context-producing hook pattern in
 *    scripts/session-start.mjs); async:true is allowed ONLY after a
 *    compatibility test in scripts/test/subagent-start-async.test.mjs proves
 *    that Claude Code still delivers additionalContext from async
 *    SubagentStart hooks. The default is sync; async is opt-in and gated
 *    behind a passing compatibility test."
 *
 * This test file GATES the async upgrade. It currently asserts the SYNC
 * default is in place. The Claude-Code-side async compatibility check is
 * out of process scope, so this gate test ships as a contract marker: as
 * long as hooks.json keeps SubagentStart sync, this test passes. Any future
 * PR that flips it to async must also provide the runtime proof described
 * in the AC and update this test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_JSON = path.resolve(__dirname, '..', '..', 'hooks', 'hooks.json');

describe('SubagentStart async-compat gate (F-001 AC-3)', () => {
  it('hooks/hooks.json keeps SubagentStart SYNC (async:true is gated)', () => {
    const raw = readFileSync(HOOKS_JSON, 'utf-8');
    const parsed = JSON.parse(raw);
    const entries = parsed?.hooks?.SubagentStart;
    assert.ok(Array.isArray(entries) && entries.length > 0, 'SubagentStart registered');

    for (const group of entries) {
      for (const h of group.hooks || []) {
        // Contract: until runtime compatibility is verified, async must be
        // falsy/absent. Flipping this to true requires a separate PR that
        // updates this test with documented runtime proof.
        assert.ok(
          h.async !== true,
          'SubagentStart must remain sync until Claude Code async compat is proven',
        );
      }
    }
  });

  it('scripts/subagent-start.mjs exists and imports subagent-context', () => {
    const script = readFileSync(
      path.resolve(__dirname, '..', 'subagent-start.mjs'),
      'utf-8',
    );
    assert.match(script, /from '\.\/lib\/subagent-context\.mjs'/);
    assert.match(script, /loadContextBundle/);
  });
});

/** Structural safety contract for the user-facing /cancel workflow. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const skill = readFileSync(
  fileURLToPath(new URL('../../skills/cancel/SKILL.md', import.meta.url)),
  'utf8',
);

test('/cancel proves identity before terminalization or destructive cleanup', () => {
  assert.match(skill, /AO-CONTRACT:cancel-proof/);
  assert.match(skill, /getActiveRunId/);
  assert.match(skill, /getPipelineState/);
  assert.match(skill, /current `in_progress`\s+phase/);
  assert.match(skill, /preserve everything and stop/i);
});

test('/cancel terminalizes the exact active run before deleting recovery state', () => {
  assert.match(skill, /AO-CONTRACT:cancel-terminalize/);
  assert.match(skill, /finalizeFailedRun\(runId/);
  assert.match(skill, /failureClass:\s*'cancelled'/);
  assert.match(skill, /code:\s*'user_cancelled'/);
  assert.match(skill, /getActiveRunId\(orchestrator\)\s*===\s*runId/);

  const terminalize = skill.indexOf('finalizeFailedRun(runId');
  const clear = skill.indexOf('clearCheckpoint(orchestrator)');
  const worktrees = skill.indexOf('cleanupTeamWorktrees(cwd, teamSlug)');
  assert.ok(terminalize >= 0 && clear > terminalize && worktrees > terminalize,
    'terminal proof must precede checkpoint/worktree cleanup');
});

test('/cancel never makes broad destructive cleanup or checkpoint deletion an authority', () => {
  assert.doesNotMatch(skill, /^\s*rm\s+-rf\s+\.ao\/teams\/\s*$/m);
  assert.doesNotMatch(skill, /grep\s+["'](?:atlas-|athena-)/);
  assert.match(skill, /Do \*\*not\*\* call `shutdownTeam\(\)`/);
  assert.match(skill, /`cleanupTeamWorktrees\(\)`/);
  assert.match(skill, /`TeamDelete`/);
  assert.doesNotMatch(skill, /await\s+shutdownTeam\(/);
  assert.match(skill, /spawn` and `monitor` are always preserve-and-stop/i);
  assert.match(skill, /adapter-only.*every intended worker already[\s\S]*?`completed`/i);
  assert.doesNotMatch(skill, /Cancel is always safe/i);
  assert.match(skill, /checkpoint alone never\s+authorizes/i);
  assert.match(skill, /do not clean\s+up/i);
});

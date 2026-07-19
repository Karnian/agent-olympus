/** Static contract for the Claude Code 2.1.178+ native-team lifecycle. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const readRepoFile = relativePath => readFileSync(
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
  'utf8',
);

const agent = readRepoFile('agents/athena.md');
const skill = readRepoFile('skills/athena/SKILL.md');
const athenaContracts = `${agent}\n${skill}`;

test('Athena uses the current implicit native-team lifecycle', () => {
  for (const removedOrIgnored of ['TeamCreate', 'TeamDelete', 'team_name']) {
    assert.doesNotMatch(
      athenaContracts,
      new RegExp(`\\b${removedOrIgnored}\\b`),
      `Athena must not depend on stale native-team token ${removedOrIgnored}`,
    );
  }

  assert.match(agent, /Claude Code 2\.1\.178\+/);
  assert.match(skill, /Claude Code 2\.1\.178\+/);
  assert.match(athenaContracts, /first successful native teammate launch forms the team automatically/i);
  assert.match(skill, /Agent\(name="<worker>"/);
  assert.match(skill, /If this launch fails or its outcome\s+is ambiguous, preserve the run\/worktrees and stop/i);
  assert.match(skill, /Never switch this run to\s+Path B after a native Agent launch was attempted/i);
  assert.match(skill, /Path B: Fallback \(`hasNativeTeamTools === false` before any native launch\)/);
});

test('Athena shuts native teammates down through supported task lifecycle', () => {
  assert.match(agent, /SendMessage\(\{ to: "<worker>", message: \{ type: "shutdown_request", reason: "Run complete" \} \}\)/);
  assert.match(skill, /SendMessage\(\{ to: "<worker>", message: \{ type: "shutdown_request", reason: "Athena run complete" \} \}\)/);
  assert.doesNotMatch(athenaContracts, /SendMessage\([^)]*\b(?:content|recipient)\s*=/s);
  const sendCalls = [...athenaContracts.matchAll(/SendMessage\(\{([\s\S]*?)\}\)/g)];
  assert.ok(sendCalls.length >= 7, 'expected lifecycle, START, relay, and shutdown examples');
  for (const [, body] of sendCalls) {
    if (/\bmessage\s*:\s*\{/.test(body)) continue;
    assert.match(body, /\bsummary\s*:\s*['"][^'"]+['"]/, 'plain-string SendMessage requires summary');
  }
  assert.match(skill, /TaskList\(\)/);
  assert.match(skill, /TaskUpdate\(taskId="\.\.\.", status="completed"\)/);
  assert.match(skill, /If any teammate is[\s\S]*state is unknown[\s\S]*preserve the checkpoint[\s\S]*STOP/);
  assert.match(skill, /Never edit or[\s\S]*~\/\.claude\/teams\/[\s\S]*~\/\.claude\/tasks\//);
});

test('every TaskList call uses the current zero-argument API', () => {
  const calls = [...skill.matchAll(/\bTaskList\s*\(([^)]*)\)/g)];
  assert.ok(calls.length >= 3, 'expected spawn recovery, monitor, and cleanup TaskList contracts');
  for (const call of calls) {
    assert.equal(
      call[1].trim(),
      '',
      `TaskList must be zero-argument, found: ${call[0]}`,
    );
  }
});

test('native adoption is bound to the originating Claude session', () => {
  assert.match(
    skill,
    /import\s*\{[^}]*\bbindRunToCurrentSession\b[^}]*\}\s*from\s*['"][^'"]*run-artifacts\.mjs['"]/s,
  );
  assert.match(
    skill,
    /import\s*\{[^}]*\bgetCurrentSessionId\b[^}]*\bgetSession\b[^}]*\bisSessionAlive\b[^}]*\}\s*from\s*['"][^'"]*session-registry\.mjs['"]/s,
  );
  assert.match(
    skill,
    /import\s*\{[^}]*\bloadRuntimeSessionIdentity\b[^}]*\}\s*from\s*['"][^'"]*runtime-permissions\.mjs['"]/s,
  );
  assert.match(skill, /const readClaudeSessionBinding\s*=\s*\(\)\s*=>[\s\S]*?currentSessionId\s*=\s*getCurrentSessionId\(\)[\s\S]*?originSessionId\s*=\s*getRun\(runId\)\.summary\?\.sessionId[\s\S]*?currentSessionId\s*===\s*originSessionId/);
  assert.match(skill, /runtimeIdentity\?\.source\s*===\s*['"]hook_stdin['"][\s\S]*?runtimeIdentity\.sessionId\s*===\s*originSessionId/);
  assert.match(skill, /originSession\?\.sessionId\s*===\s*originSessionId[\s\S]*?isSessionAlive\(originSessionId\)/);
  assert.match(skill, /proven:[\s\S]*?currentSessionId\s*===\s*originSessionId[\s\S]*?runtimeMatches\s*&&\s*registryMatches/);
  assert.match(skill, /const nativeSessionRequired\s*=\s*plannedSpawnPath\s*===\s*['"]native-or-mixed['"]/);
  assert.match(skill, /nativeSessionRequired\s*&&\s*!getRun\(runId\)\.summary\?\.sessionId[\s\S]*?bindRunToCurrentSession\(runId\)[\s\S]*?!adoptedSession\.ok/,
    'a harness-preallocated sessionless run must bind to the live Claude session before native launch');
  assert.match(skill, /expectedSpawn\s*=\s*\{[\s\S]*?nativeSessionId,/);
  assert.match(skill, /spawnCheckpointPayload\s*=\s*\{[\s\S]*?nativeSessionId,/);
  assert.match(skill, /persistedSpawn\?\.nativeSessionId\s*===\s*nativeSessionId[\s\S]*?spawnCheckpoint\?\.nativeSessionId\s*===\s*nativeSessionId/);

  const recoverySessionGuard = skill.indexOf(
    "if (spawnGate.reason === 'recover' && nativeSessionRequired && !nativeSessionMatches)",
  );
  const nativeTaskList = skill.indexOf('TaskList()', recoverySessionGuard);
  const recoveryPlanner = skill.indexOf('planAthenaSpawnRecovery({', nativeTaskList);
  assert.ok(
    recoverySessionGuard >= 0 && recoverySessionGuard < nativeTaskList && nativeTaskList < recoveryPlanner,
    'session proof must fail closed before TaskList can become native adoption evidence',
  );
  assert.match(
    skill,
    /const nativeObservationAllowed\s*=\s*spawnGate\.reason\s*===\s*['"]recover['"][\s\S]*?nativeSessionRequired[\s\S]*?nativeSessionMatches[\s\S]*?nativeObservationAllowed\s*\?\s*TaskList\(\)\s*:\s*null/,
  );
  assert.match(skill, /cannot monitor\/adopt native teammates outside their originating Claude session/);
  assert.match(skill, /native cleanup is outside the originating Claude session/);
  assert.match(skill, /must never[\s\S]*label replacement workers as the old native team/i);
});

test('adapter-only recovery remains independent of the native session fence', () => {
  assert.match(skill, /const plannedSpawnPath\s*=\s*adapterOnly[\s\S]*?['"]adapter-only['"]/);
  assert.match(skill, /const nativeSessionRequired\s*=\s*plannedSpawnPath\s*===\s*['"]native-or-mixed['"]/);
  assert.match(skill, /const nativeSessionId\s*=\s*nativeSessionRequired[\s\S]*?:\s*['"]none['"]/);
  assert.match(skill, /const durableAdapterState\s*=\s*hasAdapterWorkers\s*\?\s*monitorTeam\(teamSlug\)\s*:\s*null/);
  assert.match(skill, /adapterTeamProof,[\s\S]*?nativeTeamProof,/);
});

test('Athena takes concurrency authority from config and environment', () => {
  assert.doesNotMatch(athenaContracts, /5\s+Claude(?:\s+workers?)?\s*\+\s*2\s+Codex/i);
  assert.doesNotMatch(athenaContracts, /2\s+Codex(?:\s+workers?)?\s*\+\s*2\s+Gemini/i);
  assert.match(athenaContracts, /config\/model-routing\.jsonc/);
  for (const key of [
    'maxParallelTasks',
    'maxClaudeWorkers',
    'maxCodexWorkers',
    'maxGeminiWorkers',
    'AO_CONCURRENCY_GLOBAL',
    'AO_CONCURRENCY_CLAUDE',
    'AO_CONCURRENCY_CODEX',
    'AO_CONCURRENCY_GEMINI',
  ]) {
    assert.match(athenaContracts, new RegExp(`\\b${key}\\b`), `missing concurrency authority ${key}`);
  }
});

test('Athena describes external providers as lead-bridged, not native peers', () => {
  assert.doesNotMatch(athenaContracts, /peer-to-peer/i);
  assert.match(agent, /Codex and[\s\S]*Gemini workers do not join that native mailbox/i);
  assert.match(skill, /Codex and Gemini workers remain external executors/i);
  assert.match(skill, /Claude teammates share directly; Codex\/Gemini use lead relay/i);
});

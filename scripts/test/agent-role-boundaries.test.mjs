import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function agent(name) {
  return readFileSync(path.join(ROOT, 'agents', `${name}.md`), 'utf8');
}

test('planning roles keep evidence, specification, and assignment ownership separate', () => {
  const metis = agent('metis');
  const prometheus = agent('prometheus');
  assert.match(metis, /Hermes owns those/);
  assert.match(metis, /Prometheus owns the authoritative execution plan/);
  assert.match(metis, /explicitly requests capability triage or provisional team design/);
  assert.match(metis, /labeled as planning inputs/);
  assert.doesNotMatch(metis, /Suggested approach and model allocation/);
  assert.match(prometheus, /Treat that input as immutable/);
  assert.match(prometheus, /Do not emit or rewrite the authoritative PRD/);
});

test('mutation-capable specialist prompts declare narrow default edit boundaries', () => {
  const tests = agent('test-engineer');
  const writer = agent('writer');
  assert.match(tests, /By default, edit only tests, fixtures, test helpers/);
  assert.match(tests, /Do not change production implementation to make a test pass/);
  assert.match(writer, /Edit only documentation paths explicitly assigned/);
  assert.match(writer, /Do not change production code, tests, package manifests/);
  assert.match(writer, /Do not install dependencies, commit, push/);
});

test('read and review roles keep local data private and avoid reviewer overlap', () => {
  const explore = agent('explore');
  const architect = agent('architect');
  const reviewer = agent('code-reviewer');
  assert.match(explore, /local files first/);
  assert.match(explore, /Never place repository source, private paths, credentials/);
  assert.match(architect, /Do not duplicate line-level style/);
  assert.match(reviewer, /security-reviewer for threat modeling, exploitability/);
});

test('debugger reports escalation honestly and Ask uses the production helper', () => {
  const debuggerPrompt = agent('debugger');
  const ask = agent('ask');
  assert.match(debuggerPrompt, /not a machine-parsed JSON contract/);
  assert.match(debuggerPrompt, /does not have the Skill tool/);
  assert.match(debuggerPrompt, /TRACE_ESCALATION_REQUESTED/);
  assert.match(ask, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/ask\.mjs/);
  assert.match(ask, /Do not call adapter internals directly/);
  assert.match(ask, /exit code: `0`[\s\S]*`1`[\s\S]*`2`[\s\S]*`3`/);
});

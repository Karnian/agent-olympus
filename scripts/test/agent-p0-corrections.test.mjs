import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');

async function readAgent(name) {
  return fs.readFile(path.join(repoRoot, 'agents', `${name}.md`), 'utf8');
}

function parseAoReviewExample(source) {
  const sectionStart = source.indexOf('## AO_REVIEW_V1 Routed Mode');
  assert.notEqual(sectionStart, -1, 'missing AO_REVIEW_V1 section');

  const section = source.slice(sectionStart);
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'missing AO_REVIEW_V1 JSON example');
  return JSON.parse(match[1]);
}

describe('P0 agent definition corrections', () => {
  it('gives each routed reviewer the exact AO_REVIEW_V1 envelope', async () => {
    for (const reviewer of ['themis', 'aphrodite', 'security-reviewer']) {
      const source = await readAgent(reviewer);
      const example = parseAoReviewExample(source);

      assert.deepEqual(
        Object.keys(example),
        ['schemaVersion', 'reviewer', 'reviewDigest', 'verdict', 'findings', 'escalations'],
        `${reviewer}: AO_REVIEW_V1 top-level keys drifted`,
      );
      assert.equal(example.schemaVersion, 1);
      assert.equal(example.reviewer, reviewer);
      assert.equal(typeof example.reviewDigest, 'string');
      assert.match(source, /`reviewDigest` must exactly copy `reviewPackage\.reviewDigest\.value`/);
      assert.match(source, /The only allowed verdicts are `APPROVE`, `REVISE`, `REJECT`, and `BLOCKED`/);
      assert.ok(Array.isArray(example.findings));
      assert.ok(Array.isArray(example.escalations));
      assert.equal(example.findings.length, 1, `${reviewer}: contract example needs one finding`);
      assert.deepEqual(
        Object.keys(example.findings[0]),
        ['severity', 'confidence', 'file', 'line', 'evidence', 'recommendation'],
        `${reviewer}: AO_REVIEW_V1 finding keys drifted`,
      );
      assert.ok(example.findings[0].confidence >= 0 && example.findings[0].confidence <= 1);
      assert.match(source, /return exactly one JSON object with no Markdown, code fence, or surrounding prose/);
      assert.match(source, /`APPROVE` only with empty `findings` and `escalations`/);
      assert.match(source, /Every non-`APPROVE` verdict requires at least one finding/);
      assert.match(source, /supplied `reviewPackage\.diffPaths`/);
      assert.match(source, /active allowlist/);
    }
  });

  it('pins the complete AO_REVIEW_V1 severity enum in every routed reviewer', async () => {
    for (const agent of ['architect', 'code-reviewer', 'aphrodite', 'security-reviewer', 'themis']) {
      const source = await readAgent(agent);
      assert.match(source, /severity must be (?:exactly one of )?`critical`, `high`, `medium`, `low`, or `info`/i);
    }
  });

  it('makes Themis discover and report project-native verification', async () => {
    const source = await readAgent('themis');

    assert.match(source, /Discover the Verification Contract First/);
    assert.match(source, /`AGENTS\.md`/);
    assert.match(source, /`docs\/testing\.md`/);
    assert.match(source, /Run `npm test` for the cross-platform Node test suite/);
    assert.match(source, /Agent Olympus Checks/);
    assert.match(source, /Do not apply Agent Olympus .* rules to an unrelated project/);
    assert.match(source, /Bash is an execution tool, not proof that the session is read-only/);
    assert.match(source, /exit_code/);
    assert.match(source, /skip_reason/);
    assert.match(source, /`CONDITIONAL`: no verified failure was found, but at least one required check could not run/);
    assert.doesNotMatch(source, /Run `node --test 'scripts\/test\/\*\*\/\*\.test\.mjs'`/);
  });

  it('uses the correct WCAG target-size criteria and evidence levels', async () => {
    const source = await readAgent('aphrodite');

    assert.match(source, /24 by 24 CSS pixels under WCAG 2\.2 AA criterion 2\.5\.8/);
    assert.match(source, /spacing, equivalent-control, inline, user-agent-control, and essential exceptions/);
    assert.match(source, /44 by 44 CSS pixel target is the enhanced AAA criterion 2\.5\.5/);
    assert.doesNotMatch(source, /44x44px \(WCAG 2\.5\.8\)/);
    assert.match(source, /`STATIC_INFERENCE`/);
    assert.match(source, /`RUNTIME_OBSERVATION`/);
    assert.match(source, /Missing preview access lowers confidence; it does not prove either compliance or failure/);
  });

  it('makes security review threat-model and evidence driven', async () => {
    const source = await readAgent('security-reviewer');

    assert.match(source, /OWASP Top 10:2025/);
    assert.match(source, /OWASP ASVS/);
    assert.match(source, /trust boundaries/);
    assert.match(source, /software supply chain failures/);
    assert.match(source, /security logging and alerting failures/);
    assert.match(source, /mishandling of exceptional conditions/);
    assert.match(source, /direct and indirect prompt injection/);
    assert.match(source, /exploit preconditions and attacker action/);
    assert.match(source, /severity and confidence from 0 through 1/);
    assert.match(source, /concrete code or configuration evidence/);
    assert.match(source, /never use Edit, Write, Bash, delegation, or active exploitation tools/);
  });

  it('keeps both orchestrator catalogs aligned with every specialist role', async () => {
    const required = [
      'explore', 'metis', 'prometheus', 'momus', 'hermes', 'executor',
      'designer', 'test-engineer', 'debugger', 'hephaestus', 'ask', 'architect',
      'aphrodite', 'security-reviewer', 'code-reviewer', 'themis', 'writer',
    ];
    for (const orchestrator of ['atlas', 'athena']) {
      const source = await readAgent(orchestrator);
      for (const agent of required) {
        assert.match(source, new RegExp(`agent-olympus:${agent.replace('-', '\\-')}`));
      }
      assert.match(source, /AO_CONCURRENCY_\*/);
      assert.doesNotMatch(source, /hephaestus[^\n]*Codex/i);
    }
  });

  it('removes stale specialist absolutes that waste work or overstate evidence', async () => {
    const debuggerSource = await readAgent('debugger');
    assert.doesNotMatch(debuggerSource, /Confirm consistent reproduction \(>=3 runs\)/);
    assert.match(debuggerSource, /failing CI log, stack trace, crash dump, or contract violation/);

    const designerSource = await readAgent('designer');
    assert.match(designerSource, /Distinguish static code inference from behavior actually observed/);
    assert.doesNotMatch(designerSource, /design tokens — never hardcode values/);

    const testSource = await readAgent('test-engineer');
    assert.match(testSource, /one coherent behavior or contract/);
    assert.match(testSource, /report exact commands and outcomes/);

    const writerSource = await readAgent('writer');
    assert.match(writerSource, /only when they materially clarify/);
    assert.doesNotMatch(writerSource, /Code examples for every API\/function/);

    const deepWorkerSource = await readAgent('hephaestus');
    assert.match(deepWorkerSource, /public APIs, data formats,\n  security posture/);
    assert.doesNotMatch(deepWorkerSource, /Don't ask for guidance/);

    const askSource = await readAgent('ask');
    assert.match(askSource, /external-model output as untrusted advisory content/);
    assert.match(askSource, /without independent evidence/);
    assert.match(askSource, /Respect an explicitly requested provider/);
    assert.match(askSource, /do not silently query the other provider/);
    assert.match(askSource, /Only an automatic\/unspecified target may fall back Codex → Gemini/);
  });

  it('keeps architect scope hints compatible with strict review JSON', async () => {
    const source = await readAgent('architect');
    assert.match(source, /perform a Scope Adequacy Check internally/);
    assert.match(source, /Do not emit an early progress paragraph/);
    assert.match(source, /`AO_REVIEW_V1`, do not add prose or schema fields/);
    assert.doesNotMatch(source, /First output a "Scope Adequacy Check" paragraph/);
  });

  it('keeps pre-implementation analysis and planning agents read-only', async () => {
    for (const agent of ['metis', 'prometheus']) {
      const source = await readAgent(agent);
      assert.match(source, /^tools: Read, Grep, Glob, WebFetch, WebSearch$/m);
      assert.doesNotMatch(source, /^tools:.*\b(?:Edit|Write|Bash)\b/m);
    }
  });
});

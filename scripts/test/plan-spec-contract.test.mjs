import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseHermesSpecEnvelope,
  validateHermesPrd,
} from '../lib/spec-artifact.mjs';

const planPath = fileURLToPath(new URL('../../skills/plan/SKILL.md', import.meta.url));
const plan = readFileSync(planPath, 'utf8');
const hermesPath = fileURLToPath(new URL('../../agents/hermes.md', import.meta.url));
const hermes = readFileSync(hermesPath, 'utf8');

function extractPrdFixture(name) {
  const marker = `<!-- AO_SPEC_FIXTURE:${name} -->`;
  const markerOffset = plan.indexOf(marker);
  assert.notEqual(markerOffset, -1, `missing ${name} marker`);
  const match = plan.slice(markerOffset + marker.length).match(/^\s*```json\n([\s\S]*?)\n```/);
  assert.ok(match, `missing JSON block after ${name} marker`);
  return JSON.parse(match[1]);
}

function parseFixtureEnvelope(name, prd) {
  return parseHermesSpecEnvelope(JSON.stringify({
    schemaVersion: 1,
    verdict: 'CREATE',
    summary: `Validated the ${name} plan fixture.`,
    specMarkdown: `# ${name} specification\n\nValidator-backed fixture.`,
    prd,
  }));
}

describe('/plan AO_SPEC_V1 fixtures', () => {
  for (const [name, expectedMode] of [
    ['forward-prd', 'product-feature'],
    ['reverse-prd', 'reverse'],
  ]) {
    it(`${name} is accepted by the PRD and envelope validators`, () => {
      const prd = extractPrdFixture(name);
      assert.deepEqual(validateHermesPrd(prd), { ok: true, errors: [] });

      const envelope = parseFixtureEnvelope(name, prd);
      assert.equal(envelope.prd.mode, expectedMode);
      assert.ok(envelope.prd.userStories.every(story => story.passes === false));
    });
  }

  it('the product-feature fixture includes its mode-specific required fields', () => {
    const prd = extractPrdFixture('forward-prd');
    assert.ok(Array.isArray(prd.targetUsers) && prd.targetUsers.length > 0);
    assert.ok(Array.isArray(prd.successMetrics) && prd.successMetrics.length > 0);
  });

  it('Hermes documents the same product-feature discriminator as the validator', () => {
    assert.match(hermes, /"mode": "product-feature"/);
    assert.match(hermes, /"targetUsers": \["specific user group"\]/);
    assert.match(hermes, /"successMetrics": \[/);
    assert.match(hermes, /When `prd\.mode` is `product-feature`, `targetUsers` is required/);
    assert.match(hermes, /AO_SPEC_V1 intentionally adds no unvalidated mode-specific top-level fields/);
  });

  it('does not force product-only prose sections onto engineering or bugfix modes', () => {
    const reverseStart = plan.indexOf('## Reverse Mode');
    assert.ok(reverseStart > 0);
    const forward = plan.slice(0, reverseStart);

    assert.match(plan, /Target Users \(product-feature only\)/);
    assert.match(plan, /Success Metrics \(product-feature only\)/);
    assert.match(plan, /Engineering Change Contract \(engineering-change only\)/);
    assert.match(plan, /Bugfix Evidence \(bugfix only\)/);
    assert.doesNotMatch(forward, /\*\*As a\*\* <persona>/);
  });
});

describe('/plan artifact persistence contract', () => {
  it('routes both finalization paths through the hardened pair writer', () => {
    const reverseStart = plan.indexOf('## Reverse Mode');
    assert.ok(reverseStart > 0);
    const forward = plan.slice(0, reverseStart);
    const reverse = plan.slice(reverseStart);

    assert.match(forward, /writeHermesSpecArtifacts\(envelope, \{ cwd: process\.cwd\(\) \}\)/);
    assert.match(forward, /A direct `Write`, shell redirection, or separate file update is\s+forbidden/);
    assert.match(reverse, /persist this pair with the exact\s+`writeHermesSpecArtifacts\(\)` envelope procedure/);
    assert.match(reverse, /Directly\s+writing either `\.ao` artifact is forbidden/);
    assert.doesNotMatch(plan, /writeFileSync\([^\n]*\.ao\/(?:spec\.md|prd\.json)/);
  });
});

describe('/plan Momus verdict contract', () => {
  it('requests and parses the same fenced STAGE_VERDICT required by Momus', () => {
    assert.match(plan, /```stage_verdict[\s\S]*stage: plan-validation[\s\S]*verdict: APPROVE/);
    assert.match(plan, /Parse only the final fenced `STAGE_VERDICT`/);
    assert.doesNotMatch(plan, /End with one of:\s*\n\s*VERDICT:/);
  });
});

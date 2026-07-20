import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECLARED_READ_ONLY_AGENTS,
  EXPECTED_AGENT_NAMES,
  parseAgentFrontmatter,
  parseToolDeclaration,
  validateRoleContracts,
  validateRoleManifest,
} from '../../evals/lib/role-contracts.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const manifestPath = path.join(repoRoot, 'evals', 'roles', 'manifest.json');

function freshManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function agent(manifest, name) {
  const found = manifest.agents.find((entry) => entry.name === name);
  assert.ok(found, `missing fixture agent ${name}`);
  return found;
}

describe('role eval Phase 0 contract', () => {
  it('validates exactly 19 checked-in agents and every documented machine example', () => {
    const result = validateRoleContracts({ repoRoot });
    assert.deepEqual(result, {
      schemaVersion: 1,
      namespace: 'agent-olympus',
      agentCount: 19,
      readOnlyAgentCount: 5,
      machineExampleCount: 9,
    });
    assert.equal(EXPECTED_AGENT_NAMES.length, 19);
    assert.deepEqual(DECLARED_READ_ONLY_AGENTS, [
      'aphrodite',
      'architect',
      'code-reviewer',
      'explore',
      'security-reviewer',
    ]);
  });

  it('fails closed on schema drift and unexpected manifest fields', () => {
    const future = freshManifest();
    future.schemaVersion = 2;
    assert.throws(() => validateRoleManifest(future), /schemaVersion must be 1/);

    const extraRoot = freshManifest();
    extraRoot.generatedAt = 'never-trusted';
    assert.throws(() => validateRoleManifest(extraRoot), /unexpected keys: generatedAt/);

    const extraAgentField = freshManifest();
    agent(extraAgentField, 'executor').prompt = 'not part of the contract';
    assert.throws(() => validateRoleManifest(extraAgentField), /unexpected keys: prompt/);
  });

  it('rejects missing, duplicate, and unexpected agent inventory mutations', () => {
    const missing = freshManifest();
    missing.agents = missing.agents.filter((entry) => entry.name !== 'writer');
    assert.throws(() => validateRoleManifest(missing), /missing expected agents: writer/);

    const duplicate = freshManifest();
    duplicate.agents.splice(1, 0, structuredClone(duplicate.agents[0]));
    assert.throws(() => validateRoleManifest(duplicate), /contains duplicate aphrodite/);

    const unexpected = freshManifest();
    const zeus = structuredClone(agent(unexpected, 'writer'));
    zeus.name = 'zeus';
    zeus.invocation = 'agent-olympus:zeus';
    unexpected.agents.push(zeus);
    assert.throws(() => validateRoleManifest(unexpected), /contains unexpected agents: zeus/);
  });

  it('pins model tiers and actual frontmatter model declarations', () => {
    const invalidTier = freshManifest();
    agent(invalidTier, 'executor').model = 'ultra';
    assert.throws(() => validateRoleManifest(invalidTier), /model is invalid/);

    const driftedTier = freshManifest();
    agent(driftedTier, 'executor').model = 'haiku';
    assert.doesNotThrow(() => validateRoleManifest(driftedTier));
    assert.throws(
      () => validateRoleContracts({ repoRoot, manifest: driftedTier }),
      /executor model does not match manifest/,
    );
  });

  it('parses constrained and MCP tool syntax without comma-splitting constraints', () => {
    assert.deepEqual(
      parseToolDeclaration(
        'Read, Bash(git diff:*, git status:*), mcp__Claude_Preview__preview_snapshot',
      ),
      ['Read', 'Bash(git diff:*, git status:*)', 'mcp__Claude_Preview__preview_snapshot'],
    );
    assert.throws(() => parseToolDeclaration('Read, Bash(git status:*'), /unbalanced tools declaration/);
    assert.throws(() => parseToolDeclaration('Read,, Glob'), /empty tool token/);
  });

  it('rejects every mutation or delegation surface added to a read-only role', () => {
    for (const forbidden of [
      'Write',
      'Edit',
      'Bash',
      'Bash(git status:*)',
      'Agent(executor)',
      'Task',
      'Skill',
      'mcp__untrusted__delete_file',
    ]) {
      const mutated = freshManifest();
      agent(mutated, 'architect').tools.push(forbidden);
      assert.throws(
        () => validateRoleManifest(mutated),
        /read-only policy forbids tool/,
        forbidden,
      );
    }
  });

  it('rejects tool and machine-contract drift against checked-in agent definitions', () => {
    const toolDrift = freshManifest();
    agent(toolDrift, 'executor').tools.push('WebSearch');
    assert.doesNotThrow(() => validateRoleManifest(toolDrift));
    assert.throws(
      () => validateRoleContracts({ repoRoot, manifest: toolDrift }),
      /executor tools declaration does not match manifest/,
    );

    const outputDrift = freshManifest();
    agent(outputDrift, 'hermes').machineOutputs = [];
    assert.doesNotThrow(() => validateRoleManifest(outputDrift));
    assert.throws(
      () => validateRoleContracts({ repoRoot, manifest: outputDrift }),
      /hermes machine-output declarations do not match documented contracts/,
    );
  });

  it('requires namespaced invocation identities and rejects unknown contracts', () => {
    const bare = freshManifest();
    agent(bare, 'explore').invocation = 'explore';
    assert.throws(() => validateRoleManifest(bare), /invocation must be agent-olympus:explore/);

    const foreignNamespace = freshManifest();
    agent(foreignNamespace, 'explore').invocation = 'other-plugin:explore';
    assert.throws(
      () => validateRoleManifest(foreignNamespace),
      /invocation must be agent-olympus:explore/,
    );

    const unknownOutput = freshManifest();
    agent(unknownOutput, 'writer').machineOutputs = ['AO_PROSE_V1'];
    assert.throws(() => validateRoleManifest(unknownOutput), /contains unsupported AO_PROSE_V1/);
  });

  it('fails closed on unsupported or duplicate frontmatter fields', () => {
    assert.throws(
      () => parseAgentFrontmatter(`---
name: probe
model: sonnet
description: probe
tool: Read
---
`, 'probe'),
      /unexpected frontmatter field tool/,
    );
    assert.throws(
      () => parseAgentFrontmatter(`---
name: probe
name: duplicate
model: sonnet
description: probe
---
`, 'probe'),
      /repeats frontmatter field name/,
    );
  });
});

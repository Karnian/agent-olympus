import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildConsensusExecutionPrd,
  parseConsensusAssignmentPlan,
} from '../lib/consensus-assignment-plan.mjs';
import { computeExecutionPrdGeneration } from '../lib/execution-prd-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATION = 'a'.repeat(64);

function story(id, title) {
  return {
    id,
    title,
    acceptanceCriteria: [
      `GIVEN ${id} input WHEN the behavior runs THEN ${title.toLowerCase()} is observable`,
    ],
    passes: false,
  };
}

function planningPrd() {
  return {
    projectName: 'consensus-contract',
    mode: 'engineering-change',
    scale: 'M',
    goals: ['Preserve the typed planning contract'],
    nonGoals: [],
    constraints: [],
    risks: [],
    openQuestions: [],
    userStories: [
      story('US-001', 'External analysis completes'),
      story('US-002', 'Implementation completes'),
    ],
  };
}

function envelope(orchestrator, assignments, overrides = {}) {
  return {
    schemaVersion: 1,
    contract: 'AO_CONSENSUS_ASSIGNMENT_PLAN_V1',
    verdict: 'APPROVE',
    approvalBasis: 'reviewers',
    orchestrator,
    sourcePrdGeneration: GENERATION,
    revisionCycles: 1,
    summary: 'Two reviewed assignments preserve the planning stories.',
    assignments,
    ...overrides,
  };
}

function atlasAssignments() {
  return [
    {
      storyId: 'US-001',
      parallelGroup: 'A',
      scope: ['src/external-analysis.mjs'],
      dependsOn: [],
      requiresTDD: false,
      assignTo: 'codex',
      model: 'sonnet',
    },
    {
      storyId: 'US-002',
      parallelGroup: 'B',
      scope: ['src/implementation.mjs'],
      dependsOn: ['US-001'],
      requiresTDD: true,
      assignTo: 'claude',
      model: 'sonnet',
      agentType: 'executor',
    },
  ];
}

function athenaAssignments() {
  return [
    {
      storyId: 'US-001',
      parallelGroup: 'A',
      scope: ['src/external-analysis.mjs'],
      assignedWorker: 'codex-analysis',
      workerType: 'codex',
    },
    {
      storyId: 'US-002',
      parallelGroup: 'A',
      scope: ['src/implementation.mjs'],
      requiresTDD: true,
      assignedWorker: 'claude-implementation',
      workerType: 'claude',
      model: 'sonnet',
      agentType: 'executor',
    },
  ];
}

describe('AO_CONSENSUS_ASSIGNMENT_PLAN_V1', () => {
  it('merges an Atlas external assignment only when Codex is available', () => {
    const source = planningPrd();
    const plan = parseConsensusAssignmentPlan(
      JSON.stringify(envelope('atlas', atlasAssignments())),
      { orchestrator: 'atlas' },
    );
    const candidate = buildConsensusExecutionPrd(source, plan, {
      orchestrator: 'atlas',
      sourcePrdGeneration: GENERATION,
      hasCodex: true,
      hasGemini: false,
    });

    assert.equal(candidate.projectName, source.projectName);
    assert.equal(candidate.userStories[0].title, source.userStories[0].title);
    assert.equal(candidate.userStories[0].assignTo, 'codex');
    assert.equal(candidate.userStories[0].model, 'sonnet');
    assert.equal(candidate.userStories[0].agentType, undefined);
    assert.equal(candidate.userStories[1].agentType, 'executor');
    assert.throws(
      () => buildConsensusExecutionPrd(source, plan, {
        orchestrator: 'atlas',
        sourcePrdGeneration: GENERATION,
        hasCodex: false,
      }),
      /unavailable Codex/,
    );
  });

  it('requires the canonical Atlas model field even for an external provider', () => {
    const assignments = atlasAssignments();
    delete assignments[0].model;
    assert.throws(
      () => parseConsensusAssignmentPlan(
        JSON.stringify(envelope('atlas', assignments)),
        { orchestrator: 'atlas' },
      ),
      /model must be opus, sonnet, or haiku/,
    );
  });

  it('builds a valid Athena candidate without provider-specific external models', () => {
    const source = planningPrd();
    const plan = parseConsensusAssignmentPlan(
      JSON.stringify(envelope('athena', athenaAssignments())),
      { orchestrator: 'athena' },
    );
    const candidate = buildConsensusExecutionPrd(source, plan, {
      orchestrator: 'athena',
      sourcePrdGeneration: GENERATION,
      hasCodex: true,
      hasGemini: false,
    });
    assert.equal(candidate.userStories[0].workerType, 'codex');
    assert.equal(candidate.userStories[0].model, undefined);
    assert.equal(candidate.userStories[1].assignedWorker, 'claude-implementation');
  });

  it('fails closed on unknown fields, reordered stories, and stale generations', () => {
    const withUnknown = atlasAssignments();
    withUnknown[0].title = 'must not rewrite the planning story';
    assert.throws(
      () => parseConsensusAssignmentPlan(
        JSON.stringify(envelope('atlas', withUnknown)),
        { orchestrator: 'atlas' },
      ),
      /unknown fields: title/,
    );

    const source = planningPrd();
    const reversed = atlasAssignments().reverse();
    const reorderedPlan = parseConsensusAssignmentPlan(
      JSON.stringify(envelope('atlas', reversed)),
      { orchestrator: 'atlas' },
    );
    assert.throws(
      () => buildConsensusExecutionPrd(source, reorderedPlan, {
        orchestrator: 'atlas',
        sourcePrdGeneration: GENERATION,
        hasCodex: true,
      }),
      /story order must exactly match/,
    );
    assert.throws(
      () => buildConsensusExecutionPrd(
        source,
        parseConsensusAssignmentPlan(
          JSON.stringify(envelope('atlas', atlasAssignments())),
          { orchestrator: 'atlas' },
        ),
        {
          orchestrator: 'atlas',
          sourcePrdGeneration: 'b'.repeat(64),
          hasCodex: true,
        },
      ),
      /source generation does not match/,
    );
  });

  it('uses the real planning generation when supplied by the execution store', () => {
    const source = planningPrd();
    const sourcePrdGeneration = computeExecutionPrdGeneration(source);
    const plan = parseConsensusAssignmentPlan(
      JSON.stringify(envelope('atlas', atlasAssignments(), { sourcePrdGeneration })),
      { orchestrator: 'atlas' },
    );
    assert.doesNotThrow(() => buildConsensusExecutionPrd(source, plan, {
      orchestrator: 'atlas',
      sourcePrdGeneration,
      hasCodex: true,
    }));
  });
});

describe('consensus-plan skill integration contract', () => {
  const skill = readFileSync(path.join(ROOT, 'skills/consensus-plan/SKILL.md'), 'utf8');
  const atlas = readFileSync(path.join(ROOT, 'skills/atlas/reference.md'), 'utf8');
  const athena = readFileSync(path.join(ROOT, 'skills/athena/SKILL.md'), 'utf8');

  it('returns an assignment-only contract and forbids authoritative PRD writes', () => {
    assert.match(skill, /AO_CONSENSUS_ASSIGNMENT_PLAN_V1/);
    assert.match(skill, /MUST NOT write, replace, rename, or\s+delete `\.ao\/prd\.json`/);
    assert.match(skill, /`enrichExecutionPrd\(\)` remains the\s+only authoritative writer/);
    assert.doesNotMatch(skill, /Write the approved plan to `\.ao\/prd\.json`/);
    assert.doesNotMatch(skill, /PRD saved to `\.ao\/prd\.json`/);
    assert.doesNotMatch(skill, /"ownedFiles"|"consensusReached"|"dependencyOrder"/);
  });

  it('makes both orchestrators parse, consume, and CAS-enrich the returned plan', () => {
    for (const [name, source] of [['atlas', atlas], ['athena', athena]]) {
      assert.match(source, /const consensusRawOutput = Skill\(skill="agent-olympus:consensus-plan"/);
      assert.match(source, /OUTPUT_CONTRACT: AO_CONSENSUS_ASSIGNMENT_PLAN_V1/);
      assert.match(source, /approvedConsensusAssignmentPlan = parseConsensusAssignmentPlan/);
      assert.match(source, /buildConsensusExecutionPrd\(/);
      assert.match(source, /enrichExecutionPrd\(executionCandidate/);
      assert.match(source, new RegExp(`orchestrator: '${name}'`));
      assert.doesNotMatch(source, /If consensus-plan is used[^\n]*go directly to PRD generation/);
    }
  });
});

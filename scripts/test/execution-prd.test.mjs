import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_EXECUTION_AGENT_TYPES,
  assertExecutionPrd,
  buildAtlasStoryDefinitions,
  buildAthenaWorkerDefinitions,
  buildExecutionTeamSlug,
  parseNulDelimitedGitPaths,
  resolveClaudeExecutionSubagentType,
  validateChangedPathsAgainstScope,
  validateExecutionPrd,
} from '../lib/execution-prd.mjs';

function prd(overrides = {}) {
  return {
    projectName: 'atlas-agent-contracts',
    mode: 'engineering-change',
    scale: 'M',
    goals: ['Keep execution and specification contracts aligned'],
    nonGoals: ['Add a new provider'],
    constraints: ['Use zero runtime dependencies'],
    risks: ['A stale plan could launch unsafe work'],
    openQuestions: [],
    ...overrides,
  };
}

function story(overrides = {}) {
  return {
    id: 'US-001',
    title: 'Add a typed execution contract',
    acceptanceCriteria: [
      'GIVEN an execution PRD WHEN a worker launch is requested THEN the PRD is validated first',
    ],
    passes: false,
    parallelGroup: 'A',
    assignTo: 'claude',
    model: 'sonnet',
    agentType: 'executor',
    scope: ['src/default.mjs'],
    ...overrides,
  };
}

describe('Atlas execution PRD', () => {
  it('accepts the generic AO_SPEC project slug and derives namespaced runtime identities', () => {
    const input = prd({
      projectName: 'example-notification-preferences',
      userStories: [story()],
    });
    assert.equal(validateExecutionPrd(input, { orchestrator: 'atlas' }).ok, true);
    const atlasSlug = buildExecutionTeamSlug(input.projectName, { orchestrator: 'atlas' });
    const athenaSlug = buildExecutionTeamSlug(input.projectName, { orchestrator: 'athena' });
    assert.match(atlasSlug, /^atlas-example-notification-preferences-[0-9a-f]{12}$/);
    assert.match(athenaSlug, /^athena-example-notification-preferences-[0-9a-f]{12}$/);
    assert.notEqual(atlasSlug, athenaSlug);
    assert.equal(
      atlasSlug,
      buildExecutionTeamSlug(input.projectName, { orchestrator: 'atlas' }),
    );
  });

  it('accepts a complete Atlas worker assignment', () => {
    const input = prd({
      userStories: [story({ assignTo: 'claude', model: 'sonnet' })],
    });
    assert.equal(validateExecutionPrd(input, { orchestrator: 'atlas' }).ok, true);
    assert.equal(assertExecutionPrd(input, { orchestrator: 'atlas' }), input);
  });

  it('rejects missing provider, model, group, and duplicate story IDs', () => {
    const input = prd({
      userStories: [story({
        parallelGroup: undefined,
        assignTo: undefined,
        model: undefined,
      }), story()],
    });
    const result = validateExecutionPrd(input, { orchestrator: 'atlas' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /parallelGroup/);
    assert.match(result.errors.join('\n'), /assignTo/);
    assert.match(result.errors.join('\n'), /model/);
    assert.match(result.errors.join('\n'), /unique/);
  });

  it('requires the preserved AO_SPEC_V1 fields and Given/When/Then criteria', () => {
    const input = {
      projectName: 'atlas-agent-contracts',
      userStories: [story({
        assignTo: 'claude',
        model: 'sonnet',
        acceptanceCriteria: ['Works correctly'],
      })],
    };
    const result = validateExecutionPrd(input, { orchestrator: 'atlas' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /mode/);
    assert.match(result.errors.join('\n'), /goals/);
    assert.match(result.errors.join('\n'), /GIVEN/);
  });

  it('preserves target users and measurable metrics for product features', () => {
    const assignment = story({ assignTo: 'claude', model: 'sonnet' });
    const missing = validateExecutionPrd(prd({
      mode: 'product-feature',
      userStories: [assignment],
    }), { orchestrator: 'atlas' });
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join('\n'), /targetUsers/);
    assert.match(missing.errors.join('\n'), /successMetrics/);

    const complete = validateExecutionPrd(prd({
      mode: 'product-feature',
      targetUsers: ['Orchestrator maintainers'],
      successMetrics: [{ metric: 'successful final reviews', target: '100%' }],
      userStories: [assignment],
    }), { orchestrator: 'atlas' });
    assert.deepEqual(complete, { ok: true, errors: [] });
  });

  it('requires dependency-first contiguous Atlas group order', () => {
    const input = prd({
      userStories: [
        story({
          id: 'US-001',
          parallelGroup: 'A',
          assignTo: 'claude',
          model: 'sonnet',
          dependsOn: ['US-002'],
        }),
        story({
          id: 'US-002',
          parallelGroup: 'B',
          assignTo: 'codex',
          model: 'sonnet',
          agentType: undefined,
          scope: ['src/codex.mjs'],
        }),
        story({
          id: 'US-003',
          parallelGroup: 'A',
          assignTo: 'gemini',
          model: 'haiku',
          agentType: undefined,
          scope: ['src/gemini.mjs'],
        }),
      ],
    });
    const result = validateExecutionPrd(input, { orchestrator: 'atlas' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /must appear in an earlier Atlas group/);
    assert.match(result.errors.join('\n'), /must be one contiguous block/);
  });

  it('requires explicit scope and an allowlisted Claude role', () => {
    const missing = validateExecutionPrd(prd({
      userStories: [story({ scope: undefined, agentType: undefined })],
    }), { orchestrator: 'atlas' });
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join('\n'), /scope must contain/);
    assert.match(missing.errors.join('\n'), /agentType must be one of/);

    const externalRole = validateExecutionPrd(prd({
      userStories: [story({
        assignTo: 'codex',
        model: 'sonnet',
        agentType: 'executor',
      })],
    }), { orchestrator: 'atlas' });
    assert.equal(externalRole.ok, false);
    assert.match(externalRole.errors.join('\n'), /agentType must be omitted/);
  });

  it('uses printable ASCII scope spellings and case-insensitive duplicate keys', () => {
    const spaced = validateExecutionPrd(prd({
      userStories: [story({ scope: [' leading/path.mjs', 'trailing/path.mjs '] })],
    }), { orchestrator: 'atlas' });
    assert.equal(spaced.ok, true);

    for (const unsafeScope of [
      ['src/caf\u00e9.mjs'],
      ['src/cafe\u0301.mjs'],
      ['src/tab\tname.mjs'],
      ['src/escape\x1bname.mjs'],
      ['src/delete\x7fname.mjs'],
      ['src/Foo.mjs', 'SRC/foo.mjs'],
    ]) {
      const result = validateExecutionPrd(prd({
        userStories: [story({ scope: unsafeScope })],
      }), { orchestrator: 'atlas' });
      assert.equal(result.ok, false, `expected unsafe scope: ${JSON.stringify(unsafeScope)}`);
      assert.match(result.errors.join('\n'), /explicit safe repo-relative paths/);
    }
  });

  it('builds exact namespaced Atlas Claude dispatch definitions', () => {
    const input = prd({
      userStories: [story({ agentType: 'test-engineer', scope: ['test/api.test.mjs'] })],
    });
    const [definition] = buildAtlasStoryDefinitions(input);
    assert.equal(definition.type, 'claude');
    assert.equal(definition.agentType, 'test-engineer');
    assert.equal(definition.subagentType, 'agent-olympus:test-engineer');
    assert.deepEqual(definition.scope, ['test/api.test.mjs']);
  });

  it('rejects mixed-provider groups, overlapping parallel scope, and external groups after Claude', () => {
    const input = prd({
      userStories: [
        story({ id: 'US-001', parallelGroup: 'A', scope: ['src/shared'] }),
        story({
          id: 'US-002',
          parallelGroup: 'A',
          assignTo: 'codex',
          model: 'sonnet',
          agentType: undefined,
          scope: ['src/shared/file.mjs'],
        }),
        story({
          id: 'US-003',
          parallelGroup: 'B',
          assignTo: 'gemini',
          model: 'haiku',
          agentType: undefined,
          scope: ['src/later.mjs'],
        }),
      ],
    });
    const result = validateExecutionPrd(input, { orchestrator: 'atlas' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /provider-homogeneous/);
    assert.match(result.errors.join('\n'), /scope overlaps/);
    assert.match(result.errors.join('\n'), /external-provider groups must precede/);
  });

  it('accepts clean external groups before a final Claude group', () => {
    const input = prd({
      userStories: [
        story({
          id: 'US-001',
          parallelGroup: 'A',
          assignTo: 'codex',
          model: 'sonnet',
          agentType: undefined,
          scope: ['src/external.mjs'],
        }),
        story({
          id: 'US-002',
          parallelGroup: 'B',
          assignTo: 'claude',
          model: 'sonnet',
          agentType: 'executor',
          scope: ['src/local.mjs'],
          dependsOn: ['US-001'],
        }),
      ],
    });
    assert.equal(validateExecutionPrd(input, { orchestrator: 'atlas' }).ok, true);
  });
});

describe('Athena execution PRD', () => {
  it('accepts coherent native and external worker assignments', () => {
    const input = prd({
      projectName: 'athena-agent-contracts',
      userStories: [
        story({ assignedWorker: 'claude-worker', workerType: 'claude', model: 'sonnet' }),
        story({
          id: 'US-002',
          assignedWorker: 'codex-worker',
          workerType: 'codex',
          model: undefined,
          agentType: undefined,
        }),
      ].map((item, index) => ({
        ...item,
        scope: index === 0 ? ['scripts/lib/execution-prd.mjs'] : ['scripts/test/execution-prd.test.mjs'],
      })),
    });
    assert.equal(validateExecutionPrd(input, { orchestrator: 'athena' }).ok, true);
  });

  it('rejects mixed provider identity and provider-specific model ambiguity', () => {
    const input = prd({
      projectName: 'athena-agent-contracts',
      userStories: [
        story({
          assignedWorker: 'shared',
          workerType: 'claude',
          model: 'sonnet',
          scope: ['src/one.mjs'],
        }),
        story({
          id: 'US-002',
          assignedWorker: 'shared',
          workerType: 'codex',
          model: 'gpt-x',
          agentType: undefined,
          scope: ['src/two.mjs'],
        }),
      ],
    });
    const result = validateExecutionPrd(input, { orchestrator: 'athena' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /model must be omitted/);
    assert.match(result.errors.join('\n'), /conflicting workerType\/model\/agentType/);
  });

  it('allows completed stories only when resume validation opts in', () => {
    const input = prd({
      projectName: 'athena-agent-contracts',
      userStories: [story({
        assignedWorker: 'worker',
        workerType: 'claude',
        passes: true,
        scope: ['scripts/lib'],
      })],
    });
    assert.equal(validateExecutionPrd(input, { orchestrator: 'athena' }).ok, false);
    assert.equal(validateExecutionPrd(input, { orchestrator: 'athena', allowCompleted: true }).ok, true);
  });

  it('rejects unsafe scope ownership, same-group dependencies, and cycles', () => {
    const input = prd({
      projectName: 'athena-agent-contracts',
      userStories: [
        story({
          assignedWorker: 'one',
          workerType: 'claude',
          scope: ['../outside'],
          dependsOn: ['US-002'],
        }),
        story({
          id: 'US-002',
          assignedWorker: 'two',
          workerType: 'codex',
          model: undefined,
          agentType: undefined,
          scope: ['scripts/test'],
          dependsOn: ['US-001'],
        }),
      ],
    });
    const result = validateExecutionPrd(input, { orchestrator: 'athena' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /scope/);
    assert.match(result.errors.join('\n'), /cycle/);
  });

  it('rejects overlapping scope ownership across parallel workers', () => {
    const input = prd({
      projectName: 'athena-agent-contracts',
      userStories: [
        story({
          assignedWorker: 'one',
          workerType: 'claude',
          scope: ['scripts/lib'],
        }),
        story({
          id: 'US-002',
          assignedWorker: 'two',
          workerType: 'codex',
          model: undefined,
          agentType: undefined,
          scope: ['scripts/lib/worker.mjs'],
        }),
      ],
    });
    const result = validateExecutionPrd(input, { orchestrator: 'athena' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /scope overlaps/);
  });

  it('rejects different launch groups, cross-worker dependencies, wildcards, and case-folded overlap', () => {
    const input = prd({
      projectName: 'athena-agent-contracts',
      userStories: [
        story({
          assignedWorker: 'one',
          workerType: 'claude',
          scope: ['src/Foo'],
        }),
        story({
          id: 'US-002',
          assignedWorker: 'two',
          workerType: 'codex',
          model: undefined,
          agentType: undefined,
          parallelGroup: 'B',
          dependsOn: ['US-001'],
          scope: ['src/foo/file.mjs', 'test/**'],
        }),
      ],
    });
    const result = validateExecutionPrd(input, { orchestrator: 'athena' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /exactly one concurrently launched parallelGroup/);
    assert.match(result.errors.join('\n'), /another concurrently launched worker/);
    assert.match(result.errors.join('\n'), /explicit safe repo-relative paths/);
    assert.match(result.errors.join('\n'), /scope overlaps/);
  });

  it('allows ordered dependencies only within one sequential worker', () => {
    const input = prd({
      projectName: 'athena-agent-contracts',
      userStories: [
        story({ assignedWorker: 'one', workerType: 'claude', scope: ['src/one.mjs'] }),
        story({
          id: 'US-002',
          assignedWorker: 'one',
          workerType: 'claude',
          scope: ['src/two.mjs'],
          dependsOn: ['US-001'],
        }),
      ],
    });
    assert.equal(validateExecutionPrd(input, { orchestrator: 'athena' }).ok, true);
  });

  it('requires an allowlisted Claude execution role and forbids it on adapter workers', () => {
    assert.deepEqual(CLAUDE_EXECUTION_AGENT_TYPES, [
      'executor',
      'designer',
      'test-engineer',
      'debugger',
      'hephaestus',
      'writer',
    ]);
    assert.equal(resolveClaudeExecutionSubagentType('designer'), 'agent-olympus:designer');
    assert.throws(
      () => resolveClaudeExecutionSubagentType('architect'),
      /unsupported Claude execution agentType/,
    );

    const missing = validateExecutionPrd(prd({
      projectName: 'athena-agent-contracts',
      userStories: [story({
        assignedWorker: 'claude-worker',
        workerType: 'claude',
        agentType: undefined,
        scope: ['src/one.mjs'],
      })],
    }), { orchestrator: 'athena' });
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join('\n'), /agentType must be one of/);

    const planningOnly = validateExecutionPrd(prd({
      projectName: 'athena-agent-contracts',
      userStories: [story({
        assignedWorker: 'claude-worker',
        workerType: 'claude',
        agentType: 'architect',
        scope: ['src/one.mjs'],
      })],
    }), { orchestrator: 'athena' });
    assert.equal(planningOnly.ok, false);
    assert.match(planningOnly.errors.join('\n'), /agentType must be one of/);

    const externalRole = validateExecutionPrd(prd({
      projectName: 'athena-agent-contracts',
      userStories: [story({
        assignedWorker: 'codex-worker',
        workerType: 'codex',
        model: undefined,
        agentType: 'executor',
        scope: ['src/one.mjs'],
      })],
    }), { orchestrator: 'athena' });
    assert.equal(externalRole.ok, false);
    assert.match(externalRole.errors.join('\n'), /agentType must be omitted/);
  });

  it('builds deterministic fully-qualified Claude worker definitions', () => {
    const input = prd({
      projectName: 'athena-agent-contracts',
      userStories: [
        story({
          assignedWorker: 'ui-worker',
          workerType: 'claude',
          agentType: 'designer',
          model: 'sonnet',
          scope: ['src/ui.mjs'],
        }),
        story({
          id: 'US-002',
          assignedWorker: 'ui-worker',
          workerType: 'claude',
          agentType: 'designer',
          model: 'sonnet',
          scope: ['test/ui.test.mjs'],
          dependsOn: ['US-001'],
        }),
        story({
          id: 'US-003',
          assignedWorker: 'codex-worker',
          workerType: 'codex',
          model: undefined,
          agentType: undefined,
          scope: ['src/algorithm.mjs'],
        }),
      ],
    });

    assert.deepEqual(buildAthenaWorkerDefinitions(input), [
      {
        name: 'ui-worker',
        type: 'claude',
        model: 'sonnet',
        agentType: 'designer',
        subagentType: 'agent-olympus:designer',
        stories: [input.userStories[0], input.userStories[1]],
        storyIds: ['US-001', 'US-002'],
        scope: ['src/ui.mjs', 'test/ui.test.mjs'],
      },
      {
        name: 'codex-worker',
        type: 'codex',
        model: undefined,
        agentType: null,
        subagentType: null,
        stories: [input.userStories[2]],
        storyIds: ['US-003'],
        scope: ['src/algorithm.mjs'],
      },
    ]);
  });

  it('rejects oversized plans without recursing through attacker-controlled chains', () => {
    const stories = Array.from({ length: 257 }, (_, index) => story({
      id: `US-${index}`,
      assignedWorker: 'one',
      workerType: 'claude',
      scope: [`src/${index}.mjs`],
      dependsOn: index === 0 ? [] : [`US-${index - 1}`],
    }));
    const result = validateExecutionPrd(prd({
      projectName: 'athena-agent-contracts',
      userStories: stories,
    }), { orchestrator: 'athena' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /at most 256/);
  });
});

describe('Athena changed-path scope enforcement', () => {
  it('accepts exact and descendant paths and rejects out-of-scope changes', () => {
    assert.deepEqual(
      validateChangedPathsAgainstScope(['src/api.mjs', 'test/api/case.test.mjs'], [
        'src/api.mjs',
        'test/api',
      ]),
      { ok: true, outsideScope: [] },
    );
    assert.deepEqual(
      validateChangedPathsAgainstScope(['src/Foo/file.mjs', 'README.md'], ['src/foo']),
      { ok: false, outsideScope: ['README.md'] },
    );
  });

  it('rejects case-aliased scope duplicates before matching changed paths', () => {
    assert.deepEqual(
      validateChangedPathsAgainstScope(['src/foo.mjs'], ['src/Foo.mjs', 'SRC/foo.mjs']),
      {
        ok: false,
        outsideScope: [],
        error: 'changedPaths and explicit safe scope are required',
      },
    );
  });
});

describe('NUL-delimited Git path parsing', () => {
  it('preserves leading and trailing spaces without line-based parsing', () => {
    assert.deepEqual(
      parseNulDelimitedGitPaths(Buffer.from(' leading.txt\0dir/trailing.txt \0', 'utf8')),
      [' leading.txt', 'dir/trailing.txt '],
    );
  });

  it('fails closed on controls, traversal, non-ASCII, and case aliases', () => {
    for (const value of [
      'line\nbreak.txt',
      'tab\tname.txt',
      `delete${String.fromCharCode(0x7f)}name.txt`,
      '../outside.txt',
      'caf\u00e9.txt',
      'cafe\u0301.txt',
    ]) {
      assert.throws(
        () => parseNulDelimitedGitPaths(Buffer.from(`${value}\0`, 'utf8')),
        /unsafe repo-relative path/,
      );
    }
    assert.throws(
      () => parseNulDelimitedGitPaths(Buffer.from('src/Foo.mjs\0SRC/foo.mjs\0', 'utf8')),
      /duplicate or case-aliased path/,
    );
  });

  it('requires Buffer input, fatal UTF-8, and terminal NUL framing', () => {
    assert.throws(() => parseNulDelimitedGitPaths('file.txt\0'), /provided as a Buffer/);
    assert.throws(
      () => parseNulDelimitedGitPaths(Buffer.from([0xff, 0x00])),
      /invalid UTF-8/,
    );
    assert.throws(
      () => parseNulDelimitedGitPaths(Buffer.from('file.txt', 'utf8')),
      /NUL terminated/,
    );
    assert.deepEqual(parseNulDelimitedGitPaths(Buffer.alloc(0)), []);
  });
});

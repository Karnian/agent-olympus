import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_KEYS = new Set(['name', 'model', 'description', 'tools', 'disallowedTools', 'memory']);
const ALLOWED_MODELS = new Set(['haiku', 'sonnet', 'opus']);
const AGENT_TOOL_CONTRACTS = {
  ask: ['Read', 'Grep', 'Glob', 'Bash'],
  executor: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  debugger: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  'test-engineer': ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  hephaestus: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  writer: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'],
  designer: [
    'Read',
    'Grep',
    'Glob',
    'Edit',
    'Write',
    'Bash',
    'mcp__Claude_Preview__preview_screenshot',
    'mcp__Claude_Preview__preview_snapshot',
  ],
  explore: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  architect: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  'code-reviewer': ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  'security-reviewer': ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  momus: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  aphrodite: [
    'Read',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'mcp__Claude_Preview__preview_screenshot',
    'mcp__Claude_Preview__preview_snapshot',
  ],
  themis: ['Read', 'Grep', 'Glob', 'Bash'],
};
const NESTED_DELEGATION_TOOLS = ['Agent', 'Task', 'Skill'];
const MUTATION_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const READ_ONLY_AGENTS = new Set([
  'explore', 'architect', 'code-reviewer', 'security-reviewer', 'momus', 'aphrodite', 'themis',
]);
const FORBIDDEN_KEYS_FOR_CONTRACTED = ['disallowedTools', 'memory'];
const BUILTIN_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'Skill',
  'TodoWrite',
  'BashOutput',
  'KillShell',
]);

function parseFrontmatter(source) {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new Error('missing opening frontmatter delimiter');
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (endIndex === -1) {
    throw new Error('missing closing frontmatter delimiter');
  }

  const frontmatter = {};
  for (const line of lines.slice(1, endIndex)) {
    if (line.trim() === '') {
      continue;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`invalid frontmatter line: ${line}`);
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    frontmatter[key] = value;
  }

  return frontmatter;
}

function tokenizeTools(value) {
  if (!value || value.trim() === '') {
    return [];
  }

  const tokens = [];
  let token = '';
  let depth = 0;

  for (const char of value) {
    if (char === '(') {
      depth += 1;
      token += char;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`unbalanced tools token: ${value}`);
      }
      token += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      const trimmed = token.trim();
      if (trimmed) {
        tokens.push(trimmed);
      }
      token = '';
      continue;
    }

    token += char;
  }

  if (depth !== 0) {
    throw new Error(`unbalanced tools token: ${value}`);
  }

  const trimmed = token.trim();
  if (trimmed) {
    tokens.push(trimmed);
  }

  return tokens;
}

function isRecognizedToolToken(token) {
  if (BUILTIN_TOOLS.has(token)) {
    return true;
  }

  if (/^(Bash|Agent|Task)\(.+\)$/.test(token)) {
    return true;
  }

  return /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(token);
}

function assertExactSet(actual, expected, label) {
  const expectedSet = new Set(expected);
  for (const token of expectedSet) {
    assert.ok(actual.has(token), `${label}: missing ${token}`);
  }
  for (const token of actual) {
    assert.ok(expectedSet.has(token), `${label}: unexpected ${token}`);
  }
  assert.equal(actual.size, expectedSet.size, `${label}: expected ${expectedSet.size} tools, got ${actual.size}`);
}

function isForbiddenToolToken(token) {
  return NESTED_DELEGATION_TOOLS.some((forbidden) => token === forbidden || token.startsWith(`${forbidden}(`));
}

function validateAgentFrontmatter({ source, fileStem, agentToolContracts = AGENT_TOOL_CONTRACTS }) {
  const frontmatter = parseFrontmatter(source);

  for (const key of Object.keys(frontmatter)) {
    assert.ok(ALLOWED_KEYS.has(key), `${fileStem}: unknown frontmatter key ${key}`);
  }

  assert.equal(frontmatter.name, fileStem, `${fileStem}: name must equal file stem`);
  assert.ok(ALLOWED_MODELS.has(frontmatter.model), `${fileStem}: invalid model ${frontmatter.model}`);
  assert.ok(frontmatter.description?.length > 0, `${fileStem}: description is required`);

  let toolsTokens = [];
  if ('tools' in frontmatter) {
    toolsTokens = tokenizeTools(frontmatter.tools);
    for (const token of toolsTokens) {
      assert.ok(isRecognizedToolToken(token), `${fileStem}: unrecognized tools token ${token}`);
    }
  }

  const toolContract = agentToolContracts[fileStem];
  if (toolContract) {
    assert.ok('tools' in frontmatter, `${fileStem}: contracted agent must declare tools`);
    assertExactSet(new Set(toolsTokens), toolContract, `${fileStem}: contracted tools`);
    for (const token of toolsTokens) {
      assert.ok(!isForbiddenToolToken(token), `${fileStem}: nested delegation tool ${token}`);
      if (READ_ONLY_AGENTS.has(fileStem)) {
        assert.ok(!MUTATION_TOOLS.includes(token), `${fileStem}: read-only agent cannot use ${token}`);
      }
    }
    for (const key of FORBIDDEN_KEYS_FOR_CONTRACTED) {
      assert.ok(!(key in frontmatter), `${fileStem}: contracted agent must not declare ${key}`);
    }
  }

  return { frontmatter, toolsTokens };
}

async function readAgentFiles() {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const agentsDir = path.resolve(testDir, '../../agents');
  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(agentsDir, entry.name))
    .sort();

  return Promise.all(files.map(async (filePath) => ({
    filePath,
    fileStem: path.basename(filePath, '.md'),
    source: await fs.readFile(filePath, 'utf8'),
  })));
}

describe('agent frontmatter parser', () => {
  it('parses frontmatter regardless of key order and preserves colons in values', () => {
    const parsed = parseFrontmatter(`---
description: Query adapter: Codex/Gemini cross-check
model: sonnet
name: ask
---

Body
`);

    assert.deepEqual(parsed, {
      description: 'Query adapter: Codex/Gemini cross-check',
      model: 'sonnet',
      name: 'ask',
    });
  });

  it('tokenizes tools on top-level commas only', () => {
    assert.deepEqual(
      tokenizeTools('Read, Bash(git diff:*), Agent(a, b), mcp__preview__snapshot'),
      ['Read', 'Bash(git diff:*)', 'Agent(a, b)', 'mcp__preview__snapshot'],
    );
  });
});

describe('agent frontmatter contract', () => {
  it('validates every agents/*.md schema and per-agent tool contract', async () => {
    const agents = await readAgentFiles();
    assert.ok(agents.length > 0, 'expected at least one agent file');

    for (const agent of agents) {
      validateAgentFrontmatter(agent);
    }
  });

  it('denies nested Agent, Task, and Skill delegation to every implementation leaf', async () => {
    const agents = await readAgentFiles();
    const leafNames = new Set(['ask', 'executor', 'debugger', 'test-engineer', 'hephaestus', 'writer', 'designer']);
    for (const agent of agents.filter(({ fileStem }) => leafNames.has(fileStem))) {
      const { toolsTokens } = validateAgentFrontmatter(agent);
      for (const token of toolsTokens) {
        assert.ok(!isForbiddenToolToken(token), `${agent.fileStem}: must not inherit ${token}`);
      }
    }
  });

  it('fails read-only fixtures that include write, shell, or delegation tools', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'explore',
        source: `---
name: explore
model: haiku
description: Fixture read-only agent
tools: Read, Grep, Glob, WebFetch, WebSearch, Write, Bash(git diff:*), Agent(executor)
---
`,
      }),
      /(unexpected (Write|Bash\(git diff:\*\)|Agent\(executor\))|forbidden tools token (Write|Agent\(executor\)))/,
    );
  });

  it('fails aphrodite contract fixtures that include Bash', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'aphrodite',
        source: `---
name: aphrodite
model: sonnet
description: Fixture visual review agent
tools: Read, Grep, Glob, WebFetch, WebSearch, mcp__Claude_Preview__preview_screenshot, mcp__Claude_Preview__preview_snapshot, Bash
---
`,
      }),
      /unexpected Bash/,
    );
  });

  it('fails themis contract fixtures that include delegation tools', () => {
    for (const token of ['Agent', 'Task', 'Skill']) {
      assert.throws(
        () => validateAgentFrontmatter({
          fileStem: 'themis',
          source: `---
name: themis
model: sonnet
description: Fixture quality gate
tools: Read, Grep, Glob, Bash, ${token}
---
`,
        }),
        new RegExp(`(unexpected ${token}|forbidden tools token ${token})`),
      );
    }
  });

  it('fails contracted agents that declare memory', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'themis',
        source: `---
name: themis
model: sonnet
description: Fixture quality gate
tools: Read, Grep, Glob, Bash
memory: project
---
`,
      }),
      /contracted agent must not declare memory/,
    );
  });

  it('fails contracted agents that declare disallowedTools', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'explore',
        source: `---
name: explore
model: haiku
description: Fixture read-only agent
tools: Read, Grep, Glob, WebFetch, WebSearch
disallowedTools: Read
---
`,
      }),
      /contracted agent must not declare disallowedTools/,
    );
  });

  it('fails tier-1 agents with stray MCP tool tokens', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'explore',
        source: `---
name: explore
model: haiku
description: Fixture read-only agent
tools: Read, Grep, Glob, WebFetch, WebSearch, mcp__Foo__bar
---
`,
      }),
      /unexpected mcp__Foo__bar/,
    );
  });

  it('fails a tool key typo instead of inheriting all tools silently', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'explore',
        source: `---
name: explore
model: haiku
description: Fixture read-only agent
tool: Read, Grep, Glob, WebFetch, WebSearch
---
`,
      }),
      /unknown frontmatter key tool/,
    );
  });

  it('fails unrecognized tools tokens', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'writer',
        source: `---
name: writer
model: haiku
description: Fixture writer
tools: Read, Reed
---
`,
      }),
      /unrecognized tools token Reed/,
    );
  });
});

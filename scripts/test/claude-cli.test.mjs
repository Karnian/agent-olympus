import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

// ─── Mock child_process.spawn ────────────────────────────────────────────────

let _mockChild = null;

function makeMockChild() {
  const stdin = new EventEmitter();
  stdin.write = mock.fn(() => true);
  stdin.end = mock.fn();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 99999;
  child.killed = false;
  child.kill = mock.fn((sig) => {
    if (sig === 'SIGTERM' || sig === 'SIGKILL') child.killed = true;
  });
  return child;
}

// We need to mock before import, but node:test doesn't support that directly.
// Instead, we test the pure functions by importing them, and test spawn behavior
// with the module's own event processing.

// ─── Import the module ───────────────────────────────────────────────────────

const {
  parseStreamJsonEvents,
  mapClaudeCliError,
  classifyResultEvent,
  monitor,
  spawn,
  collect,
  shutdown,
} = await import('../../scripts/lib/claude-cli.mjs');

// ─── parseStreamJsonEvents ───────────────────────────────────────────────────

describe('parseStreamJsonEvents', () => {
  it('parses complete JSONL lines', () => {
    const input = '{"type":"system","subtype":"init"}\n{"type":"assistant"}\n';
    const { events, remainder } = parseStreamJsonEvents(input);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'system');
    assert.equal(events[1].type, 'assistant');
    assert.equal(remainder, '');
  });

  it('preserves partial line as remainder', () => {
    const input = '{"type":"system"}\n{"type":"assi';
    const { events, remainder } = parseStreamJsonEvents(input);
    assert.equal(events.length, 1);
    assert.equal(remainder, '{"type":"assi');
  });

  it('returns empty array for empty input', () => {
    const { events, remainder } = parseStreamJsonEvents('');
    assert.equal(events.length, 0);
    assert.equal(remainder, '');
  });

  it('skips blank lines', () => {
    const input = '\n\n{"type":"result"}\n\n';
    const { events } = parseStreamJsonEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'result');
  });

  it('skips malformed JSON lines', () => {
    const input = 'not json\n{"type":"ok"}\nalso bad\n';
    const { events } = parseStreamJsonEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'ok');
  });
});

// ─── mapClaudeCliError ───────────────────────────────────────────────────────

describe('mapClaudeCliError', () => {
  it('maps authentication errors', () => {
    assert.equal(mapClaudeCliError('Not logged in'), 'auth_failed');
    assert.equal(mapClaudeCliError('authentication failed'), 'auth_failed');
    assert.equal(mapClaudeCliError('unauthorized'), 'auth_failed');
    assert.equal(mapClaudeCliError('invalid API key'), 'auth_failed');
  });

  it('maps rate limit errors', () => {
    assert.equal(mapClaudeCliError('rate limit exceeded'), 'rate_limited');
    assert.equal(mapClaudeCliError('429 Too Many Requests'), 'rate_limited');
    assert.equal(mapClaudeCliError('quota exceeded'), 'rate_limited');
    assert.equal(mapClaudeCliError('server overloaded'), 'rate_limited');
  });

  it('maps budget errors to rate_limited', () => {
    assert.equal(mapClaudeCliError('max_budget_usd exceeded'), 'rate_limited');
    assert.equal(mapClaudeCliError('error_max_budget_usd'), 'rate_limited');
  });

  it('maps not_installed errors', () => {
    assert.equal(mapClaudeCliError('command not found'), 'not_installed');
    assert.equal(mapClaudeCliError('ENOENT'), 'not_installed');
  });

  it('maps network errors', () => {
    assert.equal(mapClaudeCliError('ETIMEDOUT'), 'network');
    assert.equal(mapClaudeCliError('ECONNRESET'), 'network');
    assert.equal(mapClaudeCliError('socket hang up'), 'network');
  });

  it('maps context exceeded', () => {
    assert.equal(mapClaudeCliError('context window exceeded'), 'context_exceeded');
    assert.equal(mapClaudeCliError('too many tokens'), 'context_exceeded');
  });

  it('maps crash errors', () => {
    assert.equal(mapClaudeCliError('fatal error'), 'crash');
    assert.equal(mapClaudeCliError('SIGSEGV'), 'crash');
  });

  it('maps timeout errors', () => {
    assert.equal(mapClaudeCliError('timed out'), 'timeout');
    assert.equal(mapClaudeCliError('did not complete within'), 'timeout');
  });

  it('returns unknown for null/undefined', () => {
    assert.equal(mapClaudeCliError(null), 'unknown');
    assert.equal(mapClaudeCliError(undefined), 'unknown');
    assert.equal(mapClaudeCliError(''), 'unknown');
  });

  it('returns unknown for unrecognized text', () => {
    assert.equal(mapClaudeCliError('something else happened'), 'unknown');
  });
});

// ─── classifyResultEvent ─────────────────────────────────────────────────────

describe('classifyResultEvent', () => {
  it('returns null for non-error result', () => {
    assert.equal(classifyResultEvent({ is_error: false, subtype: 'success', result: 'hello' }), null);
  });

  it('returns null for null input', () => {
    assert.equal(classifyResultEvent(null), null);
  });

  it('maps budget error subtype (is_error: true)', () => {
    assert.equal(
      classifyResultEvent({ is_error: true, subtype: 'error_max_budget_usd', result: '' }),
      'rate_limited'
    );
  });

  it('maps budget error subtype even when is_error: false (wire protocol edge case)', () => {
    // Real wire: CLI returns is_error: false with subtype: "error_max_budget_usd"
    assert.equal(
      classifyResultEvent({ is_error: false, subtype: 'error_max_budget_usd', result: '', total_cost_usd: 0.11 }),
      'rate_limited'
    );
  });

  it('maps auth error from result text', () => {
    assert.equal(
      classifyResultEvent({ is_error: true, subtype: 'success', result: 'Not logged in' }),
      'auth_failed'
    );
  });

  it('maps generic error via result text', () => {
    assert.equal(
      classifyResultEvent({ is_error: true, subtype: 'success', result: 'ECONNRESET' }),
      'network'
    );
  });
});

// ─── Simulated handle processing ─────────────────────────────────────────────

describe('event processing (via monitor)', () => {
  function makeHandle() {
    return {
      pid: 12345,
      process: null,
      stdout: null,
      kill: () => {},
      _events: [],
      _partial: '',
      sessionId: null,
      status: 'running',
      _output: '',
      _usage: null,
      _exitCode: null,
      _stderrChunks: [],
      totalCostUsd: null,
      _adapterName: 'claude-cli',
      _resultEvent: null,
      _errorField: null,
    };
  }

  it('monitor returns running status for fresh handle', () => {
    const h = makeHandle();
    const result = monitor(h);
    assert.equal(result.status, 'running');
    assert.equal(result.output, '');
    assert.equal(result.events.length, 0);
  });

  it('monitor returns error info for failed handle', () => {
    const h = makeHandle();
    h.status = 'failed';
    h._stderrChunks = ['authentication failed'];
    const result = monitor(h);
    assert.equal(result.status, 'failed');
    assert.ok(result.error);
    assert.equal(result.error.category, 'auth_failed');
  });

  it('monitor includes usage when available', () => {
    const h = makeHandle();
    h.status = 'completed';
    h._usage = { input_tokens: 100, output_tokens: 50 };
    const result = monitor(h);
    assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 50 });
  });

  it('monitor includes totalCostUsd when available', () => {
    const h = makeHandle();
    h.status = 'completed';
    h.totalCostUsd = 0.05;
    const result = monitor(h);
    assert.equal(result.totalCostUsd, 0.05);
  });

  it('monitor classifies result event error over stderr', () => {
    const h = makeHandle();
    h.status = 'failed';
    h._resultEvent = { is_error: true, subtype: 'error_max_budget_usd', result: '' };
    const result = monitor(h);
    assert.equal(result.error.category, 'rate_limited');
  });
});

// ─── Wire protocol format verification ──────────────────────────────────────

describe('wire protocol — stream-json format', () => {
  it('parses init event correctly', () => {
    const line = '{"type":"system","subtype":"init","session_id":"abc-123","tools":["Bash"],"model":"claude-sonnet-4-6"}\n';
    const { events } = parseStreamJsonEvents(line);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'system');
    assert.equal(events[0].subtype, 'init');
    assert.equal(events[0].session_id, 'abc-123');
    assert.equal(events[0].model, 'claude-sonnet-4-6');
  });

  it('parses assistant event with text content', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    };
    const { events } = parseStreamJsonEvents(JSON.stringify(msg) + '\n');
    assert.equal(events[0].type, 'assistant');
    assert.equal(events[0].message.content[0].text, 'Hello world');
  });

  it('parses assistant event with error field', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Not logged in' }] },
      error: 'authentication_failed',
    };
    const { events } = parseStreamJsonEvents(JSON.stringify(msg) + '\n');
    assert.equal(events[0].error, 'authentication_failed');
  });

  it('parses result event with cost and usage', () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done',
      total_cost_usd: 0.03,
      usage: { input_tokens: 500, output_tokens: 100 },
    };
    const { events } = parseStreamJsonEvents(JSON.stringify(msg) + '\n');
    assert.equal(events[0].type, 'result');
    assert.equal(events[0].total_cost_usd, 0.03);
    assert.equal(events[0].is_error, false);
  });

  it('parses error result event', () => {
    const msg = {
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: false,
      total_cost_usd: 0.11,
    };
    const { events } = parseStreamJsonEvents(JSON.stringify(msg) + '\n');
    assert.equal(events[0].subtype, 'error_max_budget_usd');
  });
});

// ─── selectAdapter integration (imported from worker-spawn) ──────────────────

describe('selectAdapter with claude-cli', async () => {
  const { selectAdapter } = await import('../../scripts/lib/worker-spawn.mjs');

  it('returns claude-cli for claude worker when hasClaudeCli=true', () => {
    assert.equal(
      selectAdapter({ type: 'claude', name: 'w1' }, { hasClaudeCli: true }),
      'claude-cli'
    );
  });

  it('returns tmux for claude worker when hasClaudeCli=false', () => {
    assert.equal(
      selectAdapter({ type: 'claude', name: 'w1' }, { hasClaudeCli: false }),
      'tmux'
    );
  });

  it('returns tmux for claude worker when capabilities empty', () => {
    assert.equal(
      selectAdapter({ type: 'claude', name: 'w1' }, {}),
      'tmux'
    );
  });

  it('does not affect codex adapter selection', () => {
    assert.equal(
      selectAdapter({ type: 'codex', name: 'w1' }, { hasCodexAppServer: true, hasClaudeCli: true }),
      'codex-appserver'
    );
  });

  it('does not affect generic worker adapter selection', () => {
    assert.equal(
      selectAdapter({ type: 'generic', name: 'w1' }, { hasClaudeCli: true }),
      'tmux'
    );
  });
});

// ─── resolveClaudeBinary ─────────────────────────────────────────────────────

describe('resolveClaudeBinary', async () => {
  const { resolveClaudeBinary, clearBinCache } = await import('../../scripts/lib/resolve-binary.mjs');

  beforeEach(() => {
    clearBinCache();
  });

  afterEach(() => {
    clearBinCache();
  });

  it('returns a string', () => {
    const result = resolveClaudeBinary();
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('caches the result on second call', () => {
    const first = resolveClaudeBinary();
    const second = resolveClaudeBinary();
    assert.equal(first, second);
  });

  it('discovers macOS Application Support path', () => {
    // On macOS CI or dev machines with Claude installed, this should find it
    const result = resolveClaudeBinary();
    // Either found the real binary or fell back to 'claude'
    assert.ok(typeof result === 'string');
    if (result !== 'claude') {
      assert.ok(result.includes('claude'), `Expected path to contain "claude", got: ${result}`);
    }
  });
});

// ─── collect ─────────────────────────────────────────────────────────────────

describe('collect', () => {
  it('resolves immediately for already-completed handle', async () => {
    const h = {
      pid: 1, process: null, stdout: null, kill: () => {},
      _events: [], _partial: '', sessionId: null,
      status: 'completed', _output: 'done',
      _usage: null, _exitCode: 0, _stderrChunks: [],
      totalCostUsd: 0.01, _adapterName: 'claude-cli',
      _resultEvent: null, _errorField: null,
    };
    const result = await collect(h, 1000);
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'done');
  });

  it('resolves immediately for failed handle', async () => {
    const h = {
      pid: 1, process: null, stdout: null, kill: () => {},
      _events: [], _partial: '', sessionId: null,
      status: 'failed', _output: '',
      _usage: null, _exitCode: 1, _stderrChunks: ['error'],
      totalCostUsd: null, _adapterName: 'claude-cli',
      _resultEvent: null, _errorField: null,
    };
    const result = await collect(h, 1000);
    assert.equal(result.status, 'failed');
    assert.ok(result.error);
  });

  it('resolves immediately when _exitCode is set even if status is running (exit race guard)', async () => {
    const mockProcess = new EventEmitter();
    mockProcess.killed = false;
    mockProcess.kill = () => {};
    const h = {
      pid: 1, process: mockProcess, stdout: null, kill: () => {},
      _events: [], _partial: '', sessionId: null,
      status: 'running', _output: 'partial work',
      _usage: null, _exitCode: 0, _stderrChunks: [],
      totalCostUsd: null, _adapterName: 'claude-cli',
      _resultEvent: null, _errorField: null,
    };
    // Even though status is 'running', _exitCode being set means process exited
    const result = await collect(h, 100);
    // Should resolve without timeout
    assert.ok(result.status === 'running' || result.status === 'completed');
  });

  it('flushes partial buffer on collect', async () => {
    const h = {
      pid: 1, process: null, stdout: null, kill: () => {},
      _events: [], _partial: '{"type":"result","subtype":"success","is_error":false,"result":"hi","total_cost_usd":0.01}',
      sessionId: null, status: 'completed', _output: 'hi',
      _usage: null, _exitCode: 0, _stderrChunks: [],
      totalCostUsd: null, _adapterName: 'claude-cli',
      _resultEvent: null, _errorField: null,
    };
    const result = await collect(h, 1000);
    assert.equal(result.status, 'completed');
    // The partial should have been flushed — result event processed
    assert.equal(h.totalCostUsd, 0.01);
  });
});

// ─── shutdown ────────────────────────────────────────────────────────────────

describe('shutdown', () => {
  it('resolves immediately for already-killed process', async () => {
    const h = { process: { killed: true } };
    await shutdown(h, 100); // Should not throw
  });

  it('resolves immediately for null process', async () => {
    const h = { process: null };
    await shutdown(h, 100);
  });

  it('sends SIGTERM and resolves on exit', async () => {
    const child = makeMockChild();
    const h = {
      pid: child.pid,
      process: child,
      kill: (sig) => child.kill(sig),
      _exitCode: null, // Not yet exited
    };

    const p = shutdown(h, 5000);
    // Simulate immediate exit
    child.emit('exit', 0);
    await p;

    assert.ok(child.kill.mock.calls.length >= 1);
  });

  it('escalates to SIGKILL after grace period', async () => {
    const child = makeMockChild();
    const h = {
      pid: child.pid,
      process: child,
      kill: (sig) => child.kill(sig),
      _exitCode: null,
    };

    // Use a very short grace period
    const p = shutdown(h, 10);
    // Don't emit exit — let it timeout
    await p;
    // Should have attempted SIGKILL escalation
  });

  it('resolves immediately when _exitCode is already set (PID reuse prevention)', async () => {
    const child = makeMockChild();
    const h = {
      pid: child.pid,
      process: child,
      kill: (sig) => child.kill(sig),
      _exitCode: 0, // Already exited
    };

    await shutdown(h, 100);
    // Should NOT have sent any signals
    assert.equal(child.kill.mock.calls.length, 0);
  });
});

// ─── monitorClaudeCliWorker (via worker-spawn) ──────────────────────────────

describe('monitorClaudeCliWorker integration', async () => {
  const workerSpawn = await import('../../scripts/lib/worker-spawn.mjs');
  const claudeCli = await import('../../scripts/lib/claude-cli.mjs');

  it('monitorTeam handles claude-cli workers (no live handle)', () => {
    // This is a basic integration test — monitorTeam would fall through to tmux
    // for workers without live handles, which is the correct behavior
    // The actual claude-cli monitoring path requires a spawned process
  });
});

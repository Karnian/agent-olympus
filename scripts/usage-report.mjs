#!/usr/bin/env node
/**
 * usage-report — print per-agent model-usage summary from recorded JSONL.
 *
 * Reads `.ao/artifacts/runs/<runId>/model-usage.jsonl` (per-run) or
 * `.ao/state/ao-model-usage.jsonl` (fallback) and prints a sorted table.
 *
 * Usage:
 *   node scripts/usage-report.mjs              # fallback file
 *   node scripts/usage-report.mjs --run <runId>
 *   node scripts/usage-report.mjs --all        # all runs + fallback
 *   node scripts/usage-report.mjs --json       # machine-readable output
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readUsageRecords, summariseUsage } from './lib/model-usage.mjs';

const RUNS_BASE = join(process.cwd(), '.ao', 'artifacts', 'runs');
const FALLBACK = join(process.cwd(), '.ao', 'state', 'ao-model-usage.jsonl');

function parseArgs(argv) {
  const out = { run: null, all: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.run = argv[++i];
    else if (a === '--all') out.all = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: usage-report [--run <runId>] [--all] [--json]\n' +
        '  --run <runId>  Read .ao/artifacts/runs/<runId>/model-usage.jsonl\n' +
        '  --all          Aggregate every run + fallback\n' +
        '  --json         Emit JSON instead of text table\n'
      );
      process.exit(0);
    }
  }
  return out;
}

function collectRecords(opts) {
  const records = [];
  if (opts.run) {
    records.push(...readUsageRecords(join(RUNS_BASE, opts.run, 'model-usage.jsonl')));
    return records;
  }
  if (opts.all) {
    records.push(...readUsageRecords(FALLBACK));
    try {
      for (const entry of readdirSync(RUNS_BASE, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = join(RUNS_BASE, entry.name, 'model-usage.jsonl');
        if (existsSync(p)) records.push(...readUsageRecords(p));
      }
    } catch { /* runs dir missing */ }
    return records;
  }
  records.push(...readUsageRecords(FALLBACK));
  return records;
}

function printTable(summary, totals) {
  if (summary.length === 0) {
    process.stdout.write('(no usage records found)\n');
    return;
  }
  const maxAgent = Math.max(...summary.map(s => (s.agentType || '<unknown>').length), 10);
  const header =
    `${'agentType'.padEnd(maxAgent)}  ${'model'.padEnd(8)}  ${'calls'.padStart(6)}  ` +
    `${'inChars'.padStart(10)}  ${'outChars'.padStart(10)}  ${'src(P/D)'.padStart(9)}  share%`;
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length) + '\n');
  for (const s of summary) {
    const a = (s.agentType || '<unknown>').padEnd(maxAgent);
    const m = (s.model || '<null>').padEnd(8);
    const c = String(s.callCount).padStart(6);
    const ic = String(s.totalInputChars).padStart(10);
    const oc = String(s.totalOutputChars).padStart(10);
    const src = `${s.payloadModelCount}/${s.defaultModelCount}`.padStart(9);
    const share = totals.totalCalls > 0 ? ((s.callCount / totals.totalCalls) * 100).toFixed(1) : '0.0';
    process.stdout.write(`${a}  ${m}  ${c}  ${ic}  ${oc}  ${src}  ${share}%\n`);
  }
  process.stdout.write('-'.repeat(header.length) + '\n');
  process.stdout.write(
    `total calls: ${totals.totalCalls}  ` +
    `input chars: ${totals.totalInputChars}  ` +
    `output chars: ${totals.totalOutputChars}\n`
  );

  const opusShare = summary
    .filter(s => s.model === 'opus')
    .reduce((acc, s) => {
      acc.calls += s.callCount;
      acc.inChars += s.totalInputChars;
      acc.outChars += s.totalOutputChars;
      return acc;
    }, { calls: 0, inChars: 0, outChars: 0 });
  if (totals.totalCalls > 0) {
    const callPct = ((opusShare.calls / totals.totalCalls) * 100).toFixed(1);
    const totalChars = totals.totalInputChars + totals.totalOutputChars;
    const charPct = totalChars > 0
      ? (((opusShare.inChars + opusShare.outChars) / totalChars) * 100).toFixed(1)
      : '0.0';
    process.stdout.write(
      `opus share: ${callPct}% of calls (${opusShare.calls}/${totals.totalCalls})  |  ` +
      `${charPct}% of chars\n`
    );
  }
  process.stdout.write(
    `\nmodelSource: P = payload (Task model=... explicit), D = default (agent fallback)\n` +
    `If payload=0 across the board, Claude Code SubagentStop may not propagate tool_input.model.\n`
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const records = collectRecords(opts);
  const summary = summariseUsage(records);
  const totals = summary.reduce(
    (acc, s) => {
      acc.totalCalls += s.callCount;
      acc.totalInputChars += s.totalInputChars;
      acc.totalOutputChars += s.totalOutputChars;
      return acc;
    },
    { totalCalls: 0, totalInputChars: 0, totalOutputChars: 0 }
  );

  if (opts.json) {
    process.stdout.write(JSON.stringify({ summary, ...totals }, null, 2) + '\n');
    return;
  }
  printTable(summary, totals);
}

main();

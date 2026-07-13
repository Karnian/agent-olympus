#!/usr/bin/env node
/**
 * Local HU-17 review-queue CLI.
 *
 * Deliberately absent: task scaffolding, promotion, provider calls, network,
 * and git mutation. Approval records human intent; linking records the id of a
 * separately reviewed golden task.
 */

import {
  collectRunFailureCandidate,
  linkFailureCandidate,
  listFailureCandidates,
  reviewFailureCandidate,
} from './lib/eval-failure-candidates.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/eval-candidates.mjs collect <runId>',
    '  node scripts/eval-candidates.mjs list [pending|approved|rejected|all]',
    '  node scripts/eval-candidates.mjs show <candidateId>',
    '  node scripts/eval-candidates.mjs approve <candidateId>',
    '  node scripts/eval-candidates.mjs reject <candidateId>',
    '  node scripts/eval-candidates.mjs link <candidateId> <taskId>',
  ].join('\n');
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(reason, exitCode = 1) {
  writeJson({ ok: false, reason });
  process.exitCode = exitCode;
}

function exactArgs(args, count) {
  return args.length === count;
}

function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = command ? 0 : 2;
    return;
  }

  if (command === 'collect') {
    if (!exactArgs(args, 1)) return fail('invalid-arguments', 2);
    const result = collectRunFailureCandidate(args[0]);
    writeJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'list') {
    if (args.length > 1) return fail('invalid-arguments', 2);
    const status = args[0] || 'pending';
    if (!['pending', 'approved', 'rejected', 'all'].includes(status)) {
      return fail('invalid-status', 2);
    }
    writeJson({ ok: true, candidates: listFailureCandidates({ status }) });
    return;
  }

  if (command === 'show') {
    if (!exactArgs(args, 1)) return fail('invalid-arguments', 2);
    const candidate = listFailureCandidates({ status: 'all' })
      .find((item) => item.candidateId === args[0]);
    if (!candidate) return fail('candidate-not-found');
    writeJson({ ok: true, candidate });
    return;
  }

  if (command === 'approve' || command === 'reject') {
    if (!exactArgs(args, 1)) return fail('invalid-arguments', 2);
    const result = reviewFailureCandidate(
      args[0],
      command === 'approve' ? 'approve' : 'reject',
    );
    writeJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'link') {
    if (!exactArgs(args, 2)) return fail('invalid-arguments', 2);
    const result = linkFailureCandidate(args[0], args[1]);
    writeJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  process.stderr.write(`${usage()}\n`);
  fail('unknown-command', 2);
}

main();

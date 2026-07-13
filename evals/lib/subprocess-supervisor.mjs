#!/usr/bin/env node

import { spawn } from 'node:child_process';

const REQUEST_LIMIT = 2 * 1024 * 1024;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const CLOSE_WATCHDOG_MS = 500;

function detail(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

async function readRequest() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value, 'utf-8') > REQUEST_LIMIT) {
      throw new Error('subprocess request is too large');
    }
  }
  const request = JSON.parse(value);
  if (!request || request.schemaVersion !== 1) throw new Error('invalid subprocess request');
  if (!/^[a-f0-9]{32}$/.test(request.nonce)) throw new Error('invalid subprocess nonce');
  if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('invalid subprocess argv');
  }
  if (typeof request.cwd !== 'string' || request.cwd.length === 0) throw new Error('invalid subprocess cwd');
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('invalid subprocess timeout');
  if (request.input !== null && typeof request.input !== 'string') throw new Error('invalid subprocess input');
  return request;
}

function terminateTree(child) {
  if (!child) return;
  const pid = child.pid;
  if (process.platform !== 'win32' && Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
    }
  }
  if (process.platform === 'win32' && Number.isInteger(pid) && pid > 1) {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(0));
}

async function main() {
  const request = await readRequest();
  const outputLimit = Number.isInteger(request.maxBuffer) && request.maxBuffer > 0
    ? request.maxBuffer
    : DEFAULT_OUTPUT_LIMIT;
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let timedOut = false;
  let overflow = false;
  let finished = false;
  let timeoutTimer;
  let watchdogTimer;

  const child = spawn(process.execPath, request.args, {
    cwd: request.cwd,
    env: request.env,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const finish = (code, signal, error = null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    clearTimeout(watchdogTimer);
    // Reap descendants that detached from the direct Node lifecycle but stayed
    // inside the private process group, including children with ignored stdio.
    terminateTree(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
    emit({
      schemaVersion: 1,
      nonce: request.nonce,
      code,
      signal,
      timedOut,
      overflow,
      error: error ? { message: detail(error), code: error?.code ?? null } : null,
      stdout: Buffer.concat(stdout).toString('utf-8'),
      stderr: Buffer.concat(stderr).toString('utf-8'),
    });
  };

  const forceStop = (reason) => {
    if (finished) return;
    if (reason === 'timeout') timedOut = true;
    if (reason === 'overflow') overflow = true;
    terminateTree(child);
    // A hostile descendant can keep a pipe object open even after the direct
    // process exits. The watchdog bounds this supervisor regardless.
    watchdogTimer ??= setTimeout(() => finish(null, 'SIGKILL'), CLOSE_WATCHDOG_MS);
  };

  const capture = (target) => (chunk) => {
    if (finished || overflow) return;
    const buffer = Buffer.from(chunk);
    outputBytes += buffer.length;
    if (outputBytes > outputLimit) {
      forceStop('overflow');
      return;
    }
    target.push(buffer);
  };

  child.stdout.on('data', capture(stdout));
  child.stderr.on('data', capture(stderr));
  child.once('error', (error) => finish(null, null, error));
  child.once('close', (code, signal) => finish(code, signal));
  child.stdin.on('error', () => {});
  child.stdin.end(request.input ?? '');

  timeoutTimer = setTimeout(() => forceStop('timeout'), request.timeoutMs);
}

main().catch((error) => {
  process.stderr.write(`${detail(error)}\n`, () => process.exit(1));
});

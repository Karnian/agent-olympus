import { writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeUtil from 'node:util';

const RESULT_MARKER = 'AO_GRADER_RESULT:';
const CHILD_PATH = fileURLToPath(import.meta.url);
const safeStringify = JSON.stringify;
const safeString = String;
const safeBoolean = Boolean;
const safeCreate = Object.create.bind(Object);
const safeWrite = writeSync.bind(null, 1);
const safeExit = process.exit.bind(process);
const safeSetInterval = setInterval;
const safeClearInterval = clearInterval;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function installHiddenCoordinateRedaction(graderUrl, workdir) {
  const NativeError = Error;
  const graderPath = fileURLToPath(graderUrl);
  const candidateRoot = path.resolve(workdir);
  const hiddenCoordinates = [graderUrl, graderPath, CHILD_PATH];

  const prepareStackTrace = (error, frames) => {
    const name = typeof error?.name === 'string' && error.name ? error.name : 'Error';
    const message = typeof error?.message === 'string' ? error.message : '';
    const header = message ? `${name}: ${message}` : name;
    const visibleFrames = frames.filter((frame) => {
      let source = '';
      let rendered = '';
      try {
        source = frame.getFileName?.() || frame.getScriptNameOrSourceURL?.() || '';
        rendered = frame.toString();
      } catch {
        return false;
      }
      if (hiddenCoordinates.some((coordinate) => (
        source.includes(coordinate) || rendered.includes(coordinate)
      ))) return false;
      try {
        const sourcePath = source.startsWith('file:') ? fileURLToPath(source) : source;
        if (path.isAbsolute(sourcePath) && !isWithin(candidateRoot, path.resolve(sourcePath))) {
          return false;
        }
      } catch {
        return false;
      }
      return true;
    });
    return [header, ...visibleFrames.map((frame) => `    at ${frame.toString()}`)].join('\n');
  };

  // V8 stitches awaited dynamic imports back to their awaiting task grader.
  // Install one immutable formatter before candidate code loads so neither
  // import-time nor call-time stacks disclose the hidden module coordinate.
  Object.defineProperty(NativeError, 'prepareStackTrace', {
    value: prepareStackTrace,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globalThis, 'Error', {
    value: NativeError,
    writable: false,
    configurable: false,
  });

  // Node 25 added util.getCallSites({ sourceMap: true }), which bypasses
  // Error.prepareStackTrace and exposes the staged candidate-invoke path. That
  // path reveals the sibling hidden grader directory, so disable the diagnostic
  // API before any candidate-controlled module can import node:util. Updating
  // builtin ESM bindings closes both default/CommonJS and named-import access.
  if (typeof nodeUtil.getCallSites === 'function') {
    const redactedGetCallSites = () => Object.freeze([]);
    Object.defineProperty(nodeUtil, 'getCallSites', {
      value: redactedGetCallSites,
      writable: false,
      configurable: false,
    });
    syncBuiltinESMExports();
  }

  // Permission flags contain the grader directory, and diagnostic reports
  // retain the original command line even after execArgv is scrubbed.
  Object.defineProperty(process, 'argv', {
    value: Object.freeze([process.execPath, 'ao-eval-candidate']),
    writable: false,
    configurable: false,
  });
  Object.defineProperty(process, 'execArgv', {
    value: Object.freeze([]),
    writable: false,
    configurable: false,
  });
  Object.defineProperty(process, 'report', {
    value: undefined,
    writable: false,
    configurable: false,
  });
}

function detail(error) {
  return error instanceof Error ? error.message : safeString(error ?? 'unknown error');
}

function normalizeCheck(value) {
  const normalized = safeCreate(null);
  normalized.name = typeof value?.name === 'string' ? value.name : 'hidden-check';
  normalized.pass = safeBoolean(value?.pass);
  normalized.detail = value?.detail == null ? '' : safeString(value.detail);
  return normalized;
}

function emit(nonce, value) {
  const payload = `${RESULT_MARKER}${nonce}:${safeStringify(normalizeCheck(value))}\n`;
  safeWrite(payload);
  safeExit(0);
}

async function readRequest() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 16 * 1024) throw new Error('grader request is too long');
  }
  const request = JSON.parse(value);
  if (!/^[a-f0-9]{32}$/.test(request?.nonce)) throw new Error('grader nonce is invalid');
  for (const field of ['graderUrl', 'exportName', 'workdir']) {
    if (typeof request?.[field] !== 'string' || request[field].length === 0) {
      throw new Error(`grader ${field} is invalid`);
    }
  }
  return request;
}

async function main() {
  const { nonce, graderUrl, exportName, workdir } = await readRequest();
  // Candidate modules run in this process. Remove hidden grader coordinates
  // from process metadata before importing any candidate-controlled code.
  installHiddenCoordinateRedaction(graderUrl, workdir);

  const grader = await import(graderUrl);
  const check = grader[exportName];
  if (typeof check !== 'function') {
    throw new Error(`${exportName} must be a function`);
  }

  try {
    emit(nonce, await check(workdir));
  } catch (error) {
    emit(nonce, { name: 'hidden-check', pass: false, detail: detail(error) });
  }
}

// A pending Promise alone does not keep Node 20 alive. Hold a private handle
// so a candidate that never settles remains inside the supervisor's fixed
// timeout boundary instead of exiting early without an authenticated result.
const keepAliveTimer = safeSetInterval(() => {}, 60_000);
main().then(
  () => safeClearInterval(keepAliveTimer),
  (error) => {
    process.stderr.write(`${detail(error)}\n`, () => {
      safeClearInterval(keepAliveTimer);
      process.exit(1);
    });
  },
);

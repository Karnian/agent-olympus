/** Fault injection for a normal lock-release observation race, never a production import. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync;
const rename = fs.renameSync;
let injected = 0;
let vanished = false;
fs.openSync = (path, ...args) => {
  if (injected < 2 && typeof path === 'string' && path.endsWith('/ao-concurrency.lock/owner.json')
    && new Error().stack.includes('inspectExistingLock')) {
    injected++;
    if (injected === 1) {
      const error = new Error('concurrent holder released before owner read');
      error.code = 'ENOENT'; throw error;
    }
    const dir = path.slice(0, -'/owner.json'.length);
    const generation = fs.lstatSync(dir);
    const deadline = Date.now() + 2000;
    // Let the actual owner finish; do not remove or alter a live holder's lock.
    while (Date.now() < deadline) {
      try {
        const current = fs.lstatSync(dir);
        if (current.ino !== generation.ino || current.birthtimeMs !== generation.birthtimeMs) break;
      } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    const error = new Error('owner generation changed during read');
    error.code = 'AO_HARDENED_FS_VIOLATION'; throw error;
  }
  return open(path, ...args);
};
fs.renameSync = (source, target) => {
  if (!vanished && target.endsWith('/ao-concurrency.lock') && !fs.existsSync(target)) {
    vanished = true;
    const error = new Error('holder released between failed rename and existence probe');
    error.code = 'ENOTEMPTY'; throw error;
  }
  const value = rename(source, target);
  // Ensure other independently launched contenders observe an occupied lock.
  if (target.endsWith('/ao-concurrency.lock')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return value;
};
syncBuiltinESMExports();

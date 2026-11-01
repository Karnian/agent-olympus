/** Fault injection for a normal lock-release observation race, never a production import. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync;
const rename = fs.renameSync;
let injected = false;
fs.openSync = (path, ...args) => {
  if (!injected && typeof path === 'string' && path.endsWith('/ao-concurrency.lock/owner.json')
    && new Error().stack.includes('inspectExistingLock')) {
    injected = true;
    const error = new Error('concurrent holder released before owner read');
    error.code = 'ENOENT'; throw error;
  }
  return open(path, ...args);
};
fs.renameSync = (source, target) => {
  const value = rename(source, target);
  // Ensure other independently launched contenders observe an occupied lock.
  if (target.endsWith('/ao-concurrency.lock')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return value;
};
syncBuiltinESMExports();

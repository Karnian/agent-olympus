import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Grade the sample task.
 *
 * @param {string} workdir Trial working directory.
 * @returns {Promise<{pass:boolean, checks:{name:string, pass:boolean, detail:string}[]}>}
 */
export async function grade(workdir) {
  try {
    const marker = await readFile(join(workdir, 'marker.txt'), 'utf-8');
    const value = marker.trim();
    const pass = value === 'fixed';
    return {
      pass,
      checks: [{
        name: 'marker.txt contains fixed',
        pass,
        detail: pass ? 'marker.txt is fixed' : `marker.txt is ${JSON.stringify(value)}`,
      }],
    };
  } catch (error) {
    return {
      pass: false,
      checks: [{
        name: 'marker.txt readable',
        pass: false,
        detail: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

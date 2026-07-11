import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const VALID_TRACKS = new Set(['all', 'regression', 'capability']);

export function discoverTasks(tasksDir, track = 'all') {
  if (!VALID_TRACKS.has(track)) {
    throw new Error(`track must be one of: ${[...VALID_TRACKS].join(', ')}`);
  }

  const tasks = readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => {
      const taskDir = path.join(tasksDir, entry.name);
      const task = JSON.parse(readFileSync(path.join(taskDir, 'task.json'), 'utf-8'));
      return { task, taskDir };
    })
    .filter(({ task }) => track === 'all' || task.track === track)
    .sort((a, b) => a.task.id.localeCompare(b.task.id));

  const ids = new Set();
  for (const { task } of tasks) {
    if (typeof task.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(task.id)) {
      throw new Error(`Unsafe eval task id: ${JSON.stringify(task.id)}`);
    }
    if (ids.has(task.id)) throw new Error(`Duplicate eval task id: ${task.id}`);
    ids.add(task.id);
  }
  return tasks;
}

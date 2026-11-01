/** Single-writer task lifecycle inside a detached supervisor. */
import { submitCommand, readCommands, readCommandResult, writeCommandResult } from './supervisor-mailbox.mjs';

export async function runPersistentWorker({
  identity, initialPrompt, execute, steer, interrupt, stop,
  onState = () => {}, idleTimeoutMs = 300000, pollMs = 50,
}) {
  submitCommand(identity, { id: identity.workerRunId, type: 'assign', prompt: initialPrompt, createdAt: 0 });
  let active = null;
  let idleSince = Date.now();
  let lastOutput = '';
  let closing = false;
  const result = (command, value) => writeCommandResult(identity, command.id, value);
  onState({ taskState: 'idle', taskId: '' });
  // An accepted result from a prior process is not permission to replay work.
  // This supervisor is never restarted over an ambiguous accepted assignment.
  if (readCommands(identity).some(c => readCommandResult(identity, c.id)?.status === 'accepted')) {
    throw new Error('ambiguous accepted command; preserve this worker generation');
  }
  while (!closing) {
    if (!active && Date.now() - idleSince > idleTimeoutMs) {
      await stop();
      return { status: 'completed', output: lastOutput, reason: 'idle-expired' };
    }
    for (const command of readCommands(identity)) {
      if (readCommandResult(identity, command.id)) continue;
      if (command.type === 'assign') {
        if (active) continue;
        result(command, { status: 'accepted' });
        const task = { id: command.id };
        active = task;
        onState({ taskState: 'active', taskId: task.id });
        task.promise = Promise.resolve().then(() => execute(command.prompt)).then(value => {
          if (closing) return;
          result(command, value);
          lastOutput = value.output || '';
          active = null;
          idleSince = Date.now();
          onState({ taskState: 'idle', taskId: task.id });
        }).catch(error => {
          if (closing) return;
          result(command, { status: 'failed', error: { category: 'task_failed', message: error.message } });
          active = null;
          idleSince = Date.now();
          onState({ taskState: 'idle', taskId: task.id });
        });
        continue;
      }
      if (command.type === 'shutdown') {
        result(command, { status: 'accepted' });
        closing = true;
        await stop();
        if (active) result({ id: active.id }, { status: 'cancelled' });
        for (const queued of readCommands(identity)) {
          if (!readCommandResult(identity, queued.id)) result(queued, { status: 'cancelled' });
        }
        result(command, { status: 'completed' });
        return { status: 'completed', output: lastOutput };
      }
      if (!active || command.expectedTaskId !== active.id) {
        result(command, { status: 'rejected', error: { category: 'stale_task', message: 'expected task is not active' } });
        continue;
      }
      const handler = command.type === 'steer' ? steer : interrupt;
      if (!handler) {
        result(command, { status: 'rejected', error: { category: 'unsupported', message: 'adapter does not support this command' } });
        continue;
      }
      result(command, { status: 'accepted' });
      try {
        const response = await handler(command.prompt);
        result(command, response?.error
          ? { status: 'rejected', error: response.error }
          : { status: 'completed' });
      } catch (error) {
        result(command, { status: 'failed', error: { category: 'command_failed', message: error.message } });
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

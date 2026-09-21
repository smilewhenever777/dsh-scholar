/** Serialize writes to one entity so the user's last action is stored last. */
const queues = new Map<string, Promise<unknown>>();
export function queueMutation<T>(key: string, run: () => Promise<T>): Promise<T> {
  const task = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  queues.set(key, task);
  void task.finally(() => { if (queues.get(key) === task) queues.delete(key); }).catch(() => undefined);
  return task;
}

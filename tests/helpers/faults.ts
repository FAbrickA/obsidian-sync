export function crashAfter<T extends object, K extends keyof T>(target: T, method: K): T {
  let armed = true;
  return { ...target, [method]: async (...args: unknown[]) => {
    const result = await (target[method] as (...args: unknown[]) => Promise<unknown>)(...args);
    if (armed) { armed = false; throw new Error('Simulated process termination after durable effect.'); }
    return result;
  } };
}

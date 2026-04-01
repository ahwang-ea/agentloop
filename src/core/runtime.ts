// core/runtime.ts — Injectable runtime helpers for time, env, and timers.

export type RuntimeTimer = ReturnType<typeof globalThis.setTimeout>;

export interface RuntimeDeps {
  now: () => number;
  env: NodeJS.ProcessEnv;
  sleep: (ms: number) => Promise<void>;
  setTimeout: (callback: () => void, ms: number) => RuntimeTimer;
  clearTimeout: (timer: RuntimeTimer) => void;
}

const sleep = (ms: number) => new Promise<void>(resolve => { globalThis.setTimeout(resolve, ms); });

export const systemRuntime: RuntimeDeps = {
  now: () => Date.now(),
  env: process.env,
  sleep,
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: timer => globalThis.clearTimeout(timer),
};

export const elapsedSeconds = (runtime: Pick<RuntimeDeps, 'now'>, startedAt: number): number => (runtime.now() - startedAt) / 1000;
export const flagEnabled = (runtime: Pick<RuntimeDeps, 'env'>, key: string): boolean => runtime.env[key] === '1';
export const withEnv = (runtime: Pick<RuntimeDeps, 'env'>, overrides: Record<string, string>): NodeJS.ProcessEnv => ({ ...runtime.env, ...overrides });

const INLINE_WORKER_DEFAULT_ENABLED =
  typeof __US_INLINE_WORKER_ENABLED__ === 'boolean' ? __US_INLINE_WORKER_ENABLED__ : false;

const FORCE_INLINE_WORKER_STORAGE_KEY = '__gwr_force_inline_worker__';

function isTruthyFlagValue(value) {
  return value === true || value === '1' || value === 'true';
}

function readForceInlineWorkerStorage(env) {
  try {
    const value = env?.localStorage?.getItem?.(FORCE_INLINE_WORKER_STORAGE_KEY);
    return isTruthyFlagValue(value);
  } catch {
    return false;
  }
}

function readForceInlineWorkerFlag(env) {
  try {
    return isTruthyFlagValue(env?.__GWR_FORCE_INLINE_WORKER__);
  } catch {
    return false;
  }
}

export function shouldUseInlineWorker(workerCode, env = globalThis) {
  const unsafeWindowEnv = env?.unsafeWindow;
  const forceEnable =
    readForceInlineWorkerFlag(env)
    || readForceInlineWorkerFlag(unsafeWindowEnv)
    || readForceInlineWorkerStorage(env)
    || readForceInlineWorkerStorage(unsafeWindowEnv);
  if (!INLINE_WORKER_DEFAULT_ENABLED && !forceEnable) return false;
  if (typeof workerCode !== 'string' || workerCode.length === 0) return false;
  return typeof env?.Worker !== 'undefined' && typeof env?.Blob !== 'undefined';
}

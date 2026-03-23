export const MAX_PROCESS_RETRIES = 3;
export const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const RETRY_JITTER_MS = 300;

const toSafeInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function readRetryState(dataset = {}) {
  const failureCount = Math.max(0, toSafeInteger(dataset.watermarkFailureCount, 0));
  const retryExhausted = dataset.watermarkRetryExhausted === 'true' || failureCount >= MAX_PROCESS_RETRIES;
  const nextRetryAt = retryExhausted
    ? 0
    : Math.max(0, toSafeInteger(dataset.watermarkNextRetryAt, 0));

  return {
    failureCount,
    nextRetryAt,
    retryExhausted
  };
}

export function shouldProcessNow(state, now = Date.now()) {
  if (!state || state.retryExhausted) return false;
  return now >= state.nextRetryAt;
}

export function resetRetryState(dataset = {}) {
  dataset.watermarkFailureCount = '0';
  dataset.watermarkNextRetryAt = '0';
  dataset.watermarkRetryExhausted = 'false';
}

export function computeRetryDelayMs(failureCount, { random = Math.random } = {}) {
  const safeFailures = Math.max(1, toSafeInteger(failureCount, 1));
  const exponential = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** (safeFailures - 1)));
  const jitter = Math.floor(Math.max(0, random()) * RETRY_JITTER_MS);
  return exponential + jitter;
}

export function registerProcessFailure(dataset = {}, { now = Date.now(), random = Math.random } = {}) {
  const current = readRetryState(dataset);
  const failureCount = current.failureCount + 1;

  dataset.watermarkFailureCount = String(failureCount);

  if (failureCount >= MAX_PROCESS_RETRIES) {
    dataset.watermarkRetryExhausted = 'true';
    dataset.watermarkNextRetryAt = '0';
    return {
      failureCount,
      exhausted: true,
      delayMs: 0,
      nextRetryAt: 0
    };
  }

  const delayMs = computeRetryDelayMs(failureCount, { random });
  const nextRetryAt = now + delayMs;
  dataset.watermarkRetryExhausted = 'false';
  dataset.watermarkNextRetryAt = String(nextRetryAt);

  return {
    failureCount,
    exhausted: false,
    delayMs,
    nextRetryAt
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BASE_RETRY_DELAY_MS,
    MAX_PROCESS_RETRIES,
    readRetryState,
    resetRetryState,
    registerProcessFailure,
    shouldProcessNow
} from '../../src/userscript/retryPolicy.js';

test('registerProcessFailure should apply exponential backoff', () => {
    const dataset = {};

    const first = registerProcessFailure(dataset, { now: 1000, random: () => 0 });
    assert.equal(first.failureCount, 1);
    assert.equal(first.exhausted, false);
    assert.equal(first.delayMs, BASE_RETRY_DELAY_MS);
    assert.equal(readRetryState(dataset).nextRetryAt, 1000 + BASE_RETRY_DELAY_MS);

    const second = registerProcessFailure(dataset, { now: 2000, random: () => 0 });
    assert.equal(second.failureCount, 2);
    assert.equal(second.exhausted, false);
    assert.equal(second.delayMs, BASE_RETRY_DELAY_MS * 2);
    assert.equal(readRetryState(dataset).nextRetryAt, 2000 + BASE_RETRY_DELAY_MS * 2);
});

test('shouldProcessNow should block attempts before next retry timestamp', () => {
    const dataset = {};
    registerProcessFailure(dataset, { now: 5000, random: () => 0 });
    const state = readRetryState(dataset);

    assert.equal(shouldProcessNow(state, 5000), false);
    assert.equal(shouldProcessNow(state, state.nextRetryAt - 1), false);
    assert.equal(shouldProcessNow(state, state.nextRetryAt), true);
});

test('registerProcessFailure should stop retrying after max attempts', () => {
    const dataset = {};

    for (let i = 0; i < MAX_PROCESS_RETRIES; i += 1) {
        registerProcessFailure(dataset, { now: 1000 * (i + 1), random: () => 0 });
    }

    const state = readRetryState(dataset);
    assert.equal(state.failureCount, MAX_PROCESS_RETRIES);
    assert.equal(state.retryExhausted, true);
    assert.equal(shouldProcessNow(state, Date.now()), false);
});

test('resetRetryState should clear failure tracking after success', () => {
    const dataset = {};
    registerProcessFailure(dataset, { now: 1000, random: () => 0 });
    resetRetryState(dataset);
    const state = readRetryState(dataset);

    assert.equal(state.failureCount, 0);
    assert.equal(state.nextRetryAt, 0);
    assert.equal(state.retryExhausted, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS,
    configureVideoPageTimeouts
} from '../../src/sdk/videoProgress.js';

test('page setup timeouts remain independent from export completion timeout', () => {
    const calls = [];
    const page = {
        setDefaultTimeout(value) {
            calls.push(['action', value]);
        },
        setDefaultNavigationTimeout(value) {
            calls.push(['navigation', value]);
        }
    };

    configureVideoPageTimeouts(page);

    assert.equal(DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS, 30_000);
    assert.deepEqual(calls, [
        ['action', DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS],
        ['navigation', DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS]
    ]);
});

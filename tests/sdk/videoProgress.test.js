import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS,
    configureVideoPageTimeouts,
    waitForVideoProcessing
} from '../../src/sdk/videoProgress.js';

function createSnapshotPage(...snapshots) {
    let index = 0;
    return {
        async evaluate() {
            const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
            index += 1;
            return snapshot;
        }
    };
}

function processingSnapshot(overrides = {}) {
    return {
        tone: '',
        status: 'Exporting',
        progressText: 'Exporting frames',
        progress: 0.1,
        phase: 'export',
        processedFrames: 1,
        frameEstimate: 10,
        aiDenoiseFrames: 0,
        aiReuseFrames: 0,
        ...overrides
    };
}

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

test('video processing rejects after the configured inactivity period', async () => {
    let clock = 0;
    const page = createSnapshotPage(processingSnapshot());

    await assert.rejects(
        waitForVideoProcessing(page, {
            timeoutMs: 100,
            pollIntervalMs: 30,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms;
            }
        }),
        /made no progress for 100 ms.*Exporting frames/s
    );
    assert.equal(clock, 100);
});

test('video processing may exceed the timeout while frame progress continues', async () => {
    let clock = 0;
    const progressEvents = [];
    const page = createSnapshotPage(
        processingSnapshot(),
        processingSnapshot(),
        processingSnapshot({ progress: 0.2, processedFrames: 2 }),
        processingSnapshot({ progress: 0.2, processedFrames: 2 }),
        processingSnapshot({ tone: 'success', status: 'Done', progress: 1, processedFrames: 10 })
    );

    const result = await waitForVideoProcessing(page, {
        timeoutMs: 50,
        pollIntervalMs: 20,
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
        },
        onProgress: (progress) => progressEvents.push(progress)
    });

    assert.equal(result.tone, 'success');
    assert.equal(result.elapsedMs, 80);
    assert.deepEqual(progressEvents.map((event) => event.processedFrames), [1, 2, 10]);
});

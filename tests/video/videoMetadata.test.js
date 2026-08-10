import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveVideoMetadata } from '../../src/video/videoMetadata.js';

function createVideoTrack(packetStats, duration = 10) {
    return {
        getDisplayWidth: async () => 1920,
        getDisplayHeight: async () => 1080,
        getFirstTimestamp: async () => 0,
        getCodec: async () => 'avc1.640028',
        computePacketStats: async () => packetStats,
        computeDuration: async () => duration
    };
}

function createInput(duration = 10) {
    return {
        getDurationFromMetadata: async () => duration
    };
}

test('resolveVideoMetadata estimates total frames from duration and sampled packet rate', async () => {
    const metadata = await resolveVideoMetadata(
        createInput(10),
        createVideoTrack({
            packetCount: 90,
            averagePacketRate: 24,
            averageBitrate: 8_000_000
        })
    );

    assert.equal(metadata.frameRate, 24);
    assert.equal(metadata.frameCountEstimate, 240);
});

test('resolveVideoMetadata does not treat the sampled packet count as a total without a sampled rate', async () => {
    const metadata = await resolveVideoMetadata(
        createInput(10),
        createVideoTrack({
            packetCount: 90,
            averagePacketRate: null,
            averageBitrate: 8_000_000
        })
    );

    assert.equal(metadata.frameRate, 30);
    assert.equal(metadata.frameCountEstimate, null);
});

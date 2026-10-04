import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createCodecReclaimStats,
    createReclaimableVideoEncoding,
    isCodecReclaimedError,
    tryConsumeCodecReclaimRecovery
} from '../../src/video/videoCodecReclaim.js';
import {
    createVideoDecodeStats,
    iterateVideoSamplesWithDecoderRecovery
} from '../../src/video/videoDecodeRecovery.js';

class CustomVideoEncoderStub {}
class EncodedPacketStub {
    constructor(data, type, timestamp, duration) {
        Object.assign(this, { data, type, timestamp, duration });
    }
}

function reclaimError() {
    const error = new Error('Codec reclaimed due to inactivity.');
    error.name = 'QuotaExceededError';
    return error;
}

function avcDescription(spsByte) {
    return new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 2, 0x67, spsByte, 1, 0, 1, 0x68]);
}

const flushTasks = () => new Promise((resolve) => setImmediate(resolve));

// Mirrors Chrome: a reclaim closes the codec and runs the error callback in one task;
// close() rejects a pending flush and never runs the error callback.
function installFakeVideoEncoder({ latency = 2, descriptions = [] } = {}) {
    const instances = [];
    class FakeVideoEncoder {
        constructor({ output, error }) {
            this.output = output;
            this.onError = error;
            this.state = 'unconfigured';
            this.encodeQueueSize = 0;
            this.inFlight = [];
            this.emitted = 0;
            this.encodedKeyFlags = [];
            this.pendingFlush = null;
            this.description = descriptions[instances.length] ?? avcDescription(0x10);
            instances.push(this);
        }
        configure() { this.state = 'configured'; }
        addEventListener() {}
        encode(frame, options) {
            if (this.state !== 'configured') throw new Error('InvalidStateError');
            const keyFrame = Boolean(options?.keyFrame);
            this.inFlight.push({ timestamp: frame.timestamp, keyFrame });
            this.encodedKeyFlags.push(keyFrame);
            queueMicrotask(() => this.drain(latency));
        }
        drain(keep) {
            while (this.state === 'configured' && this.inFlight.length > keep) {
                const { timestamp, keyFrame } = this.inFlight.shift();
                const type = keyFrame || this.emitted === 0 ? 'key' : 'delta';
                const meta = this.emitted === 0 ? { decoderConfig: { codec: 'avc1', description: this.description } } : undefined;
                this.emitted++;
                this.output({
                    type,
                    timestamp,
                    duration: 1,
                    byteLength: 1,
                    copyTo: (target) => { target[0] = timestamp & 0xff; }
                }, meta);
            }
        }
        flush() {
            if (this.state !== 'configured') return Promise.reject(new Error('InvalidStateError'));
            if (this.pendingFlush) return this.pendingFlush.promise;
            let resolve;
            let reject;
            const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
            this.pendingFlush = { promise, reject };
            queueMicrotask(() => {
                if (this.state !== 'configured') return;
                this.drain(0);
                this.pendingFlush = null;
                resolve();
            });
            return promise;
        }
        reclaim() {
            this.state = 'closed';
            this.inFlight = [];
            this.pendingFlush?.reject(reclaimError());
            setImmediate(() => this.onError(reclaimError()));
        }
        close() {
            this.state = 'closed';
            this.inFlight = [];
            this.pendingFlush?.reject(new Error('AbortError'));
        }
    }
    const previous = globalThis.VideoEncoder;
    globalThis.VideoEncoder = FakeVideoEncoder;
    return { instances, restore: () => { globalThis.VideoEncoder = previous; } };
}

function createEncoding() {
    return createReclaimableVideoEncoding({
        CustomVideoEncoder: CustomVideoEncoderStub,
        EncodedPacket: EncodedPacketStub,
        registerEncoder: () => {}
    });
}

async function createEncoder(stats) {
    const { ReclaimableVideoEncoder, beginReclaimableVideoEncoding } = createEncoding();
    const end = beginReclaimableVideoEncoding(stats);
    const encoder = new ReclaimableVideoEncoder();
    const packets = [];
    encoder.codec = 'avc';
    encoder.config = { codec: 'avc1.64001f', width: 64, height: 36 };
    encoder.onPacket = (packet) => packets.push(packet);
    await encoder.init();
    return { encoder, packets, end };
}

function frameSample(timestamp, closed = []) {
    return { toVideoFrame: () => ({ timestamp, close: () => closed.push(timestamp) }) };
}

const microseconds = (packets) => packets.map((packet) => Math.round(packet.timestamp * 1e6));

test('reclaim errors are recognised by name or message and spend one bounded budget', () => {
    assert.equal(isCodecReclaimedError(reclaimError()), true);
    assert.equal(isCodecReclaimedError(new Error('Codec reclaimed due to inactivity.')), true);
    assert.equal(isCodecReclaimedError(new Error('Encoding task failed')), false);

    const stats = createCodecReclaimStats(1);
    assert.equal(tryConsumeCodecReclaimRecovery(stats, new Error('Decoder failure')), false);
    assert.equal(tryConsumeCodecReclaimRecovery(stats, reclaimError()), true);
    assert.equal(tryConsumeCodecReclaimRecovery(stats, reclaimError()), false);
    assert.equal(tryConsumeCodecReclaimRecovery(null, reclaimError()), false);
});

test('the reclaim-aware encoder is only offered for AVC while an export is active', () => {
    const fake = installFakeVideoEncoder();
    try {
        const { ReclaimableVideoEncoder, beginReclaimableVideoEncoding } = createEncoding();
        assert.equal(ReclaimableVideoEncoder.supports('avc'), false);
        const end = beginReclaimableVideoEncoding(createCodecReclaimStats());
        assert.equal(ReclaimableVideoEncoder.supports('avc'), true);
        assert.equal(ReclaimableVideoEncoder.supports('vp9'), false);
        end();
        assert.equal(ReclaimableVideoEncoder.supports('avc'), false);
    } finally {
        fake.restore();
    }
});

test('a reclaimed encoder is rebuilt and re-encodes the frames it had not emitted', async () => {
    const fake = installFakeVideoEncoder({ latency: 2 });
    const stats = createCodecReclaimStats();
    const { encoder, packets, end } = await createEncoder(stats);
    const closed = [];
    try {
        for (let timestamp = 0; timestamp < 10; timestamp++) {
            if (timestamp === 6) fake.instances[0].reclaim();
            await encoder.encode(frameSample(timestamp, closed), { keyFrame: timestamp === 0 });
            await flushTasks();
        }
        await encoder.flush();
        encoder.close();

        assert.deepEqual(microseconds(packets), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert.equal(stats.recoveries, 1);
        // Frames 4 and 5 were still inside the reclaimed encoder; the new one starts from them with a key frame.
        assert.deepEqual(fake.instances[1].encodedKeyFlags.slice(0, 2), [true, false]);
        assert.equal(packets[4].type, 'key');
        assert.deepEqual([...closed].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    } finally {
        end();
        fake.restore();
    }
});

test('a reclaim with nothing in flight forces the next frame to be a key frame', async () => {
    const fake = installFakeVideoEncoder({ latency: 0 });
    const { encoder, packets, end } = await createEncoder(createCodecReclaimStats());
    try {
        await encoder.encode(frameSample(0), { keyFrame: true });
        await flushTasks();
        fake.instances[0].reclaim();
        await encoder.encode(frameSample(1), { keyFrame: false });
        await encoder.flush();
        assert.deepEqual(packets.map((packet) => packet.type), ['key', 'key']);
    } finally {
        end();
        fake.restore();
    }
});

test('a reclaim during flush rebuilds the encoder and flushes again', async () => {
    const fake = installFakeVideoEncoder({ latency: 3 });
    const stats = createCodecReclaimStats();
    const { encoder, packets, end } = await createEncoder(stats);
    try {
        for (let timestamp = 0; timestamp < 5; timestamp++) {
            await encoder.encode(frameSample(timestamp), { keyFrame: timestamp === 0 });
        }
        await flushTasks();
        const flushed = encoder.flush();
        fake.instances[0].reclaim();
        await flushed;
        assert.deepEqual(microseconds(packets), [0, 1, 2, 3, 4]);
        assert.equal(stats.recoveries, 1);
    } finally {
        end();
        fake.restore();
    }
});

test('reclaims beyond the budget fail with the reclaim error', async () => {
    const fake = installFakeVideoEncoder({ latency: 0 });
    const stats = createCodecReclaimStats(1);
    const { encoder, end } = await createEncoder(stats);
    try {
        await encoder.encode(frameSample(0), { keyFrame: true });
        fake.instances[0].reclaim();
        await encoder.encode(frameSample(1), {});
        fake.instances[1].reclaim();
        await assert.rejects(encoder.encode(frameSample(2), {}), { name: 'QuotaExceededError' });
        assert.equal(stats.recoveries, 1);
    } finally {
        end();
        fake.restore();
    }
});

test('a rebuilt encoder with different parameter sets fails instead of writing an undecodable track', async () => {
    const fake = installFakeVideoEncoder({ latency: 0, descriptions: [avcDescription(0x10), avcDescription(0x20)] });
    const { encoder, packets, end } = await createEncoder(createCodecReclaimStats());
    try {
        await encoder.encode(frameSample(0), { keyFrame: true });
        await flushTasks();
        fake.instances[0].reclaim();
        await encoder.encode(frameSample(1), {});
        await flushTasks();

        await assert.rejects(encoder.flush(), { name: 'QuotaExceededError', message: /changed the stream parameters/ });
        await assert.rejects(encoder.encode(frameSample(2), {}), { name: 'QuotaExceededError' });
        assert.deepEqual(microseconds(packets), [0]);
    } finally {
        end();
        fake.restore();
    }
});

test('a reclaimed decoder resumes from the last frame without using the decoder failure budget', async () => {
    let run = 0;
    const createSink = () => {
        const failAt = run++ === 0 ? 3 : null;
        return {
            async *samples(startTimestamp) {
                const first = startTimestamp === undefined ? 0 : Math.floor(startTimestamp);
                for (let timestamp = first; timestamp < 6; timestamp++) {
                    if (timestamp === failAt) throw reclaimError();
                    yield { timestamp, close() {} };
                }
            }
        };
    };
    const decodeStats = createVideoDecodeStats();
    const codecReclaimStats = createCodecReclaimStats();
    const timestamps = [];
    for await (const sample of iterateVideoSamplesWithDecoderRecovery(createSink, { stats: decodeStats, codecReclaimStats })) {
        timestamps.push(sample.timestamp);
    }

    assert.deepEqual(timestamps, [0, 1, 2, 3, 4, 5]);
    assert.equal(decodeStats.recoveries, 0);
    assert.equal(codecReclaimStats.recoveries, 1);
});

test('a reclaimed decoder is not resumed without a reclaim budget', async () => {
    const createSink = () => ({
        async *samples() {
            yield { timestamp: 0, close() {} };
            throw reclaimError();
        }
    });
    await assert.rejects(async () => {
        for await (const sample of iterateVideoSamplesWithDecoderRecovery(createSink)) sample.close();
    }, { name: 'QuotaExceededError' });
});

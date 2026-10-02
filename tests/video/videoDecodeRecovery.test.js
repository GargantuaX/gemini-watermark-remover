import test from 'node:test';
import assert from 'node:assert/strict';

import {
    attachVideoDecodeDiagnostics,
    createVideoDecodeStats,
    isRecoverableVideoDecodeError,
    iterateVideoSamplesWithDecoderRecovery
} from '../../src/video/videoDecodeRecovery.js';

function decoderError(message = 'Decoder failure') {
    const error = new Error(message);
    error.name = 'EncodingError';
    return error;
}

function createSample(timestamp, closed) {
    return { timestamp, close: () => closed.push(timestamp) };
}

// Each sink run decodes frames 0..frameCount-1 from its start timestamp and throws `failAt` once reached.
function createSinkFactory(frameCount, failures) {
    const starts = [];
    const closed = [];
    let run = 0;
    const createSink = () => {
        const failAt = failures[run++];
        return {
            async *samples(startTimestamp) {
                starts.push(startTimestamp);
                const first = startTimestamp === undefined ? 0 : Math.floor(startTimestamp);
                for (let timestamp = first; timestamp < frameCount; timestamp++) {
                    if (failAt && timestamp === failAt.timestamp) throw failAt.error;
                    yield createSample(timestamp, closed);
                }
            }
        };
    };
    return { createSink, starts, closed };
}

async function collect(iterable) {
    const timestamps = [];
    for await (const sample of iterable) {
        timestamps.push(sample.timestamp);
        sample.close();
    }
    return timestamps;
}

test('a decoder failure mid-stream resumes after the last yielded frame', async () => {
    const { createSink, starts, closed } = createSinkFactory(6, [{ timestamp: 3, error: decoderError() }]);
    const stats = createVideoDecodeStats();
    const recoveries = [];

    const timestamps = await collect(iterateVideoSamplesWithDecoderRecovery(createSink, {
        stats,
        onRecovery: (event) => recoveries.push(event.resumeAfter)
    }));

    assert.deepEqual(timestamps, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(starts, [undefined, 2]);
    assert.equal(stats.recoveries, 1);
    assert.deepEqual(recoveries, [2]);
    assert.equal(closed.filter((timestamp) => timestamp === 2).length, 2, 'the re-decoded frame is closed, not yielded');
});

test('a stream that keeps failing throws after the recovery budget is used up', async () => {
    const failure = { timestamp: 2, error: decoderError('Decoding error.') };
    const { createSink, starts } = createSinkFactory(6, [failure, failure, failure]);
    const stats = createVideoDecodeStats();

    await assert.rejects(
        collect(iterateVideoSamplesWithDecoderRecovery(createSink, { stats })),
        failure.error
    );
    assert.equal(stats.recoveries, 2);
    assert.equal(starts.length, 3);
    assert.equal(stats.lastTimestamp, 1);
});

test('errors that are not decoder failures are not retried', async () => {
    const encoderError = decoderError('Encoder initialization error.');
    const { createSink, starts } = createSinkFactory(6, [{ timestamp: 1, error: encoderError }]);

    await assert.rejects(collect(iterateVideoSamplesWithDecoderRecovery(createSink)), encoderError);
    assert.equal(starts.length, 1);
});

test('an aborted export does not retry a decoder failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { createSink, starts } = createSinkFactory(6, [{ timestamp: 1, error: decoderError() }]);

    await assert.rejects(
        collect(iterateVideoSamplesWithDecoderRecovery(createSink, { signal: controller.signal })),
        { name: 'AbortError' }
    );
    assert.equal(starts.length, 1);
});

test('a failure in the consumer is not treated as a decoder failure', async () => {
    const { createSink, starts } = createSinkFactory(6, []);
    const consumerError = decoderError();

    await assert.rejects(async () => {
        for await (const sample of iterateVideoSamplesWithDecoderRecovery(createSink)) {
            sample.close();
            if (sample.timestamp === 2) throw consumerError;
        }
    }, consumerError);
    assert.equal(starts.length, 1);
});

test('decoder failure messages from WebKit and Chromium are recoverable', () => {
    assert.equal(isRecoverableVideoDecodeError(decoderError('Decoder failure')), true);
    assert.equal(isRecoverableVideoDecodeError(decoderError('Decoding error.')), true);
    assert.equal(isRecoverableVideoDecodeError(decoderError('Decoding task did not complete')), true);
    assert.equal(isRecoverableVideoDecodeError(decoderError('Encoding task failed')), false);
    assert.equal(isRecoverableVideoDecodeError(Object.assign(new Error('Decoder failure'), { name: 'AbortError' })), false);
});

test('decoder failures carry diagnostics for error reporting', () => {
    const error = attachVideoDecodeDiagnostics(
        decoderError(),
        { recoveries: 2, lastTimestamp: 4.5 },
        { firstTimestamp: 0.5, codec: 'hevc', width: 1080, height: 1920, averageBitrate: 8_000_000 }
    );

    assert.equal(error.decoderRecoveries, 2);
    assert.equal(error.decodeFailedAtSeconds, 4);
    assert.equal(error.videoCodec, 'hevc');
    assert.equal(error.videoWidth, 1080);
    assert.equal(error.videoHeight, 1920);
    assert.equal(error.videoAverageBitrate, 8_000_000);

    const encoderError = attachVideoDecodeDiagnostics(decoderError('Encoding task failed'), { recoveries: 0, lastTimestamp: 1 }, {});
    assert.equal(encoderError.decoderRecoveries, undefined);
});

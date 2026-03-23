import test from 'node:test';
import assert from 'node:assert/strict';

import { WatermarkWorkerClient, canUseWatermarkWorker } from '../../src/core/workerClient.js';

class FakeWorker {
    constructor() {
        this.listeners = {
            message: new Set(),
            error: new Set()
        };
        this.lastPosted = null;
    }

    addEventListener(type, handler) {
        this.listeners[type]?.add(handler);
    }

    removeEventListener(type, handler) {
        this.listeners[type]?.delete(handler);
    }

    postMessage(payload) {
        this.lastPosted = payload;
        FakeWorker.lastPostedType = payload.type;
        const response = {
            id: payload.id,
            ok: true,
            result: {
                mimeType: 'image/png',
                processedBuffer: new Uint8Array([1, 2, 3]).buffer,
                meta: { source: 'worker' }
            }
        };

        queueMicrotask(() => {
            for (const handler of this.listeners.message) {
                handler({ data: response });
            }
        });
    }

    terminate() {}
}

class ThrowingWorker extends FakeWorker {
    postMessage() {
        throw new Error('postMessage failed');
    }
}

test('canUseWatermarkWorker should require Worker and Blob support', () => {
    assert.equal(canUseWatermarkWorker({ Worker: undefined, Blob }), false);
    assert.equal(canUseWatermarkWorker({ Worker: FakeWorker, Blob }), true);
});

test('WatermarkWorkerClient should process image blob via worker protocol', async () => {
    const client = new WatermarkWorkerClient({
        WorkerClass: FakeWorker,
        workerUrl: './watermark-worker.js'
    });
    const input = new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' });

    const result = await client.processBlob(input);

    assert.equal(result.meta.source, 'worker');
    assert.equal(result.blob.type, 'image/png');
    assert.equal(result.blob.size, 3);
});

test('WatermarkWorkerClient should verify worker readiness with ping', async () => {
    const client = new WatermarkWorkerClient({
        WorkerClass: FakeWorker,
        workerUrl: './watermark-worker.js'
    });

    await assert.doesNotReject(() => client.ping());
    assert.equal(FakeWorker.lastPostedType, 'ping');
});

test('WatermarkWorkerClient should cleanup pending request when postMessage throws', async () => {
    const client = new WatermarkWorkerClient({
        WorkerClass: ThrowingWorker,
        workerUrl: './watermark-worker.js'
    });

    await assert.rejects(
        client.request('process-image', { inputBuffer: new ArrayBuffer(0) }),
        /postMessage failed/
    );
    assert.equal(client.pending.size, 0);
});

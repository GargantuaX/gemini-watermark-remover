export function canUseWatermarkWorker(env = globalThis) {
    return typeof env.Worker !== 'undefined' && typeof env.Blob !== 'undefined';
}

function normalizeError(errorLike) {
    if (!errorLike) return 'Unknown worker error';
    if (typeof errorLike === 'string') return errorLike;
    if (typeof errorLike.message === 'string' && errorLike.message.length > 0) {
        return errorLike.message;
    }
    return 'Unknown worker error';
}

function toError(errorLike) {
    if (errorLike instanceof Error) return errorLike;
    return new Error(normalizeError(errorLike));
}

export class WatermarkWorkerClient {
    constructor({
        workerUrl = './workers/watermark-worker.js',
        WorkerClass = globalThis.Worker
    } = {}) {
        if (typeof WorkerClass === 'undefined') {
            throw new Error('Worker is not supported in this runtime');
        }

        this.worker = new WorkerClass(workerUrl, { type: 'module' });
        this.pending = new Map();
        this.requestId = 0;

        this.onMessage = this.onMessage.bind(this);
        this.onError = this.onError.bind(this);
        this.worker.addEventListener('message', this.onMessage);
        this.worker.addEventListener('error', this.onError);
    }

    dispose() {
        this.worker.removeEventListener('message', this.onMessage);
        this.worker.removeEventListener('error', this.onError);
        this.worker.terminate();
        this.rejectAllPending(new Error('Worker disposed'));
    }

    onMessage(event) {
        const payload = event?.data;
        if (!payload || typeof payload.id === 'undefined') return;
        const pending = this.pending.get(payload.id);
        if (!pending) return;

        this.pending.delete(payload.id);
        clearTimeout(pending.timeoutId);
        if (payload.ok) {
            pending.resolve(payload.result);
            return;
        }

        pending.reject(new Error(normalizeError(payload.error)));
    }

    onError(event) {
        const reason = event?.message || 'Worker execution failed';
        this.rejectAllPending(new Error(reason));
    }

    rejectAllPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeoutId);
            pending.reject(error);
        }
        this.pending.clear();
    }

    request(type, payload, transferList = [], timeoutMs = 120000) {
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Worker request timed out: ${type}`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timeoutId });
            try {
                this.worker.postMessage({ id, type, ...payload }, transferList);
            } catch (error) {
                clearTimeout(timeoutId);
                this.pending.delete(id);
                reject(toError(error));
            }
        });
    }

    async ping(timeoutMs = 3000) {
        await this.request('ping', {}, [], timeoutMs);
    }

    async processBlob(blob, options = {}) {
        const inputBuffer = await blob.arrayBuffer();
        const result = await this.request(
            'process-image',
            {
                inputBuffer,
                mimeType: blob.type || 'image/png',
                options
            },
            [inputBuffer]
        );

        return {
            blob: new Blob([result.processedBuffer], { type: result.mimeType || 'image/png' }),
            meta: result.meta || null
        };
    }
}

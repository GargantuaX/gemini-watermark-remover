import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createBatchQueue,
    enqueueBatchFiles,
    processBatchQueue,
    startBatchSelection,
    summarizeBatch
} from '../../src/video/videoBatchQueue.js';

const fileOf = (name) => ({ name });
const statusesOf = (queue) => queue.items.map((item) => item.status);

function exportStub(results) {
    return async (file) => {
        const outcome = results[file.name];
        if (typeof outcome === 'function') return outcome(file);
        return outcome ?? { ok: false };
    };
}

const exported = (file) => ({ ok: true, href: `blob:${file.name}`, filename: `${file.name}.mp4` });

test('a second batch replaces the completed queue instead of appending to it', async () => {
    const queue = createBatchQueue();

    startBatchSelection(queue);
    enqueueBatchFiles(queue, [fileOf('good.mp4'), fileOf('bad.mp4')]);
    const first = await processBatchQueue(queue, {
        processFile: exportStub({ 'good.mp4': exported(fileOf('good')), 'bad.mp4': { ok: false } })
    });
    assert.deepEqual(first, { done: 1, total: 2 });

    // Second selection of two invalid files must report 0/2, not 1/4.
    startBatchSelection(queue);
    enqueueBatchFiles(queue, [fileOf('bad-a.mp4'), fileOf('bad-b.mp4')]);
    const second = await processBatchQueue(queue, {
        processFile: exportStub({ 'bad-a.mp4': { ok: false }, 'bad-b.mp4': { ok: false } })
    });

    assert.equal(queue.items.length, 2);
    assert.deepEqual(second, { done: 0, total: 2 });
});

test('returning to single-file mode clears the completed batch queue', () => {
    const queue = createBatchQueue();
    queue.items = [
        { file: fileOf('done.mp4'), status: 'done' },
        { file: fileOf('failed.mp4'), status: 'error' }
    ];

    startBatchSelection(queue);

    assert.deepEqual(queue.items, []);
    assert.deepEqual(summarizeBatch(queue.items), { done: 0, total: 0 });
});

test('a failing item does not abort the batch and the run continues', async () => {
    const queue = createBatchQueue();
    startBatchSelection(queue);
    enqueueBatchFiles(queue, [fileOf('broken.mp4'), fileOf('fine.mp4')]);

    const seen = [];
    const summary = await processBatchQueue(queue, {
        processFile: exportStub({
            'broken.mp4': () => { throw new Error('decode failed'); },
            'fine.mp4': exported(fileOf('fine'))
        }),
        onError: (error) => seen.push(error.message)
    });

    assert.deepEqual(statusesOf(queue), ['error', 'done']);
    assert.deepEqual(summary, { done: 1, total: 2 });
    assert.deepEqual(seen, ['decode failed']);
});

test('only successful items emit an automatic download', async () => {
    const queue = createBatchQueue();
    startBatchSelection(queue);
    enqueueBatchFiles(queue, [fileOf('ok.mp4'), fileOf('bad.mp4'), fileOf('image.png')]);

    const downloads = [];
    await processBatchQueue(queue, {
        processFile: exportStub({
            'ok.mp4': exported(fileOf('ok')),
            'bad.mp4': { ok: false },
            'image.png': { skipped: true }
        }),
        downloadResult: (payload) => downloads.push(payload)
    });

    assert.deepEqual(statusesOf(queue), ['done', 'error', 'skipped']);
    assert.deepEqual(downloads, [{ href: 'blob:ok', filename: 'ok.mp4' }]);
});

test('a completed queue releases its file references on the next selection', async () => {
    const queue = createBatchQueue();
    startBatchSelection(queue);
    enqueueBatchFiles(queue, [fileOf('first.mp4')]);
    await processBatchQueue(queue, {
        processFile: exportStub({ 'first.mp4': exported(fileOf('first')) })
    });
    const stale = queue.items[0];

    startBatchSelection(queue);

    assert.equal(queue.items.length, 0);
    assert.equal(queue.items.includes(stale), false);
    assert.equal(queue.processing, false);
});

test('files selected while a batch is running are appended to the active run', async () => {
    const queue = createBatchQueue();
    startBatchSelection(queue);
    enqueueBatchFiles(queue, [fileOf('a.mp4')]);

    const summary = await processBatchQueue(queue, {
        processFile: async (file) => {
            // A selection arriving mid-run must extend the active batch.
            if (file.name === 'a.mp4') {
                startBatchSelection(queue);
                enqueueBatchFiles(queue, [fileOf('b.mp4')]);
            }
            return exported({ name: file.name.replace('.mp4', '') });
        }
    });

    assert.deepEqual(statusesOf(queue), ['done', 'done']);
    assert.deepEqual(summary, { done: 2, total: 2 });
});

test('processBatchQueue refuses to start a second concurrent run', async () => {
    const queue = createBatchQueue();
    queue.processing = true;

    const result = await processBatchQueue(queue, { processFile: async () => exported(fileOf('x')) });

    assert.equal(result, null);
});

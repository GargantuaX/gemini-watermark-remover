import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createBatchQueue, enqueueBatchFiles, startBatchSelection } from '../../src/video/videoBatchQueue.js';

// Execute the actual UI routing function, not a copy of its decision logic.
const source = readFileSync(new URL('../../src/video-app.js', import.meta.url), 'utf8');
const start = source.indexOf('function handleIncomingFiles(');
const end = source.indexOf('\nfunction reset(', start);
assert.ok(start >= 0 && end > start);
function setup(processing) {
    const batch = createBatchQueue();
    batch.processing = processing;
    batch.items.push({ file: { name: 'existing.mp4' }, status: processing ? 'processing' : 'done' });
    const selected = [];
    let runs = 0;
    const handle = runInNewContext(`${source.slice(start, end)}; handleIncomingFiles`, {
        batch, startBatchSelection, enqueueBatchFiles,
        getDebugFileKind: file => file.name.endsWith('.mp4') ? 'video' : 'image',
        pickDebugUploadFile: files => files?.[0],
        renderBatchQueue() {}, runBatch() { runs++; }, setFile(file) { selected.push(file); }
    });
    return { batch, selected, handle, runs: () => runs };
}
test('one video arriving during a batch appends without changing the active file', () => {
    const s = setup(true), file = { name: 'added.mp4' };
    s.handle([file]);
    assert.equal(s.selected.length, 0);
    assert.equal(s.batch.items.length, 2);
    assert.equal(s.batch.items[1].file, file);
    assert.equal(s.batch.items[0].status, 'processing');
});
test('multiple incoming videos append to an active batch', () => {
    const s = setup(true);
    s.handle([{ name: 'a.mp4' }, { name: 'b.mp4' }]);
    assert.equal(s.selected.length, 0);
    assert.equal(s.batch.items.length, 3);
});
test('an idle single selection clears the old queue and retains manual export', () => {
    const s = setup(false), file = { name: 'single.mp4' };
    s.handle([file]);
    assert.deepEqual(s.selected, [file]);
    assert.equal(s.batch.items.length, 0);
    assert.equal(s.runs(), 0);
});
test('a new idle batch replaces the completed queue', () => {
    const s = setup(false);
    s.handle([{ name: 'a.mp4' }, { name: 'b.mp4' }]);
    assert.equal(s.batch.items.length, 2);
    assert.equal(s.selected.length, 0);
    assert.equal(s.runs(), 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the actual yield helpers from video-app.js, not a copy of them.
const source = readFileSync(new URL('../../src/video-app.js', import.meta.url), 'utf8');
const start = source.indexOf('function isDocumentHidden(');
const end = source.indexOf('\nfunction createDetectionProgressHandler(', start);
assert.ok(start >= 0 && end > start);

function setup(visibilityState) {
    const listeners = new Set();
    const frames = [];
    const document = {
        visibilityState,
        addEventListener(type, listener) {
            if (type === 'visibilitychange') listeners.add(listener);
        },
        removeEventListener(type, listener) {
            if (type === 'visibilitychange') listeners.delete(listener);
        }
    };
    const yieldToBrowserFrame = runInNewContext(`${source.slice(start, end)}; yieldToBrowserFrame`, {
        document,
        MessageChannel,
        setTimeout,
        requestAnimationFrame(callback) {
            frames.push(callback);
        }
    });
    return {
        document,
        frames,
        listeners,
        yieldToBrowserFrame,
        hide() {
            document.visibilityState = 'hidden';
            for (const listener of [...listeners]) listener();
        }
    };
}

function settlesWithin(promise, ms = 200) {
    return Promise.race([
        promise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), ms))
    ]);
}

test('a hidden page yields without waiting for an animation frame', async () => {
    const s = setup('hidden');
    assert.equal(await settlesWithin(s.yieldToBrowserFrame()), true);
    assert.equal(s.frames.length, 0);
});

test('a visible page waits for the next animation frame', async () => {
    const s = setup('visible');
    const pending = s.yieldToBrowserFrame();
    assert.equal(s.frames.length, 1);
    assert.equal(await settlesWithin(pending, 50), false);
    s.frames[0]();
    assert.equal(await settlesWithin(pending), true);
    assert.equal(s.listeners.size, 0);
});

test('a page hidden while waiting for a frame stops waiting for it', async () => {
    const s = setup('visible');
    const pending = s.yieldToBrowserFrame();
    s.hide();
    assert.equal(await settlesWithin(pending), true);
    assert.equal(s.listeners.size, 0);
    s.frames[0]();
});

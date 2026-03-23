import test from 'node:test';
import assert from 'node:assert/strict';

import { canvasToBlob } from '../../src/core/canvasBlob.js';

test('canvasToBlob should prefer convertToBlob when available', async () => {
    const expected = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    let receivedOptions = null;
    const canvas = {
        convertToBlob: async (options) => {
            receivedOptions = options;
            return expected;
        },
        toBlob: () => {
            throw new Error('toBlob should not be called when convertToBlob exists');
        }
    };

    const result = await canvasToBlob(canvas, 'image/webp');
    assert.equal(result, expected);
    assert.deepEqual(receivedOptions, { type: 'image/webp' });
});

test('canvasToBlob should fallback to toBlob when convertToBlob is unavailable', async () => {
    const expected = new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' });
    let receivedType = null;
    const canvas = {
        toBlob: (callback, type) => {
            receivedType = type;
            queueMicrotask(() => callback(expected));
        }
    };

    const result = await canvasToBlob(canvas);
    assert.equal(result, expected);
    assert.equal(receivedType, 'image/png');
});

test('canvasToBlob should reject when toBlob returns null', async () => {
    const canvas = {
        toBlob: (callback) => {
            queueMicrotask(() => callback(null));
        }
    };

    await assert.rejects(canvasToBlob(canvas), /Failed to encode image blob/);
});

test('canvasToBlob should reject when no canvas blob export API is available', async () => {
    await assert.rejects(canvasToBlob({}), /Canvas blob export API is unavailable/);
});

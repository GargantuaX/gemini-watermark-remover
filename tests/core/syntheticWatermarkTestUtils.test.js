import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applySyntheticWatermark,
    cloneTestImageData,
    createPatternImageData,
    createSyntheticAlphaMap
} from './syntheticWatermarkTestUtils.js';

test('syntheticWatermarkTestUtils should create independent clones and brighten the watermark region', () => {
    const alpha48 = createSyntheticAlphaMap(48);
    const original = createPatternImageData(160, 160);
    const clone = cloneTestImageData(original);
    const position = { x: 80, y: 80, width: 48, height: 48 };

    applySyntheticWatermark(clone, alpha48, position, 1);

    const centerX = position.x + Math.floor(position.width / 2);
    const centerY = position.y + Math.floor(position.height / 2);
    const targetIndex = (centerY * clone.width + centerX) * 4;
    assert.notEqual(clone.data[targetIndex], original.data[targetIndex]);
    assert.equal(original.data[targetIndex], createPatternImageData(160, 160).data[targetIndex]);
});

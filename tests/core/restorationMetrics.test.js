import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assessReferenceTextureAlignment,
    calculateNearBlackRatio,
    cloneImageData
} from '../../src/core/restorationMetrics.js';

test('cloneImageData should return a deep copy for plain image-like objects', () => {
    const original = {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255])
    };

    const cloned = cloneImageData(original);
    cloned.data[0] = 99;

    assert.notEqual(cloned.data, original.data);
    assert.equal(original.data[0], 10);
    assert.equal(cloned.width, original.width);
    assert.equal(cloned.height, original.height);
});

test('assessReferenceTextureAlignment should mark a darker flatter candidate as hard reject', () => {
    const width = 96;
    const height = 96;
    const referenceData = new Uint8ClampedArray(width * height * 4);
    const candidateData = new Uint8ClampedArray(width * height * 4);

    for (let i = 0; i < referenceData.length; i += 4) {
        referenceData[i + 3] = 255;
        candidateData[i + 3] = 255;
    }

    const referenceRegion = { x: 24, y: 0, width: 48, height: 48 };
    const position = { x: 24, y: 48, width: 48, height: 48 };

    for (let row = 0; row < 48; row++) {
        for (let col = 0; col < 48; col++) {
            const refIdx = ((referenceRegion.y + row) * width + (referenceRegion.x + col)) * 4;
            const posIdx = ((position.y + row) * width + (position.x + col)) * 4;
            const value = (row + col) % 2 === 0 ? 40 : 180;
            referenceData[refIdx] = value;
            referenceData[refIdx + 1] = value;
            referenceData[refIdx + 2] = value;
            candidateData[posIdx] = 18;
            candidateData[posIdx + 1] = 18;
            candidateData[posIdx + 2] = 18;
        }
    }

    const assessment = assessReferenceTextureAlignment({
        referenceImageData: { width, height, data: referenceData },
        candidateImageData: { width, height, data: candidateData },
        position
    });

    assert.equal(assessment.tooDark, true);
    assert.equal(assessment.tooFlat, true);
    assert.equal(assessment.hardReject, true);
    assert.ok(assessment.texturePenalty > 0, `texturePenalty=${assessment.texturePenalty}`);
});

test('calculateNearBlackRatio should count only near-black pixels inside the target region', () => {
    const imageData = {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([
            0, 0, 0, 255,
            6, 6, 6, 255,
            4, 4, 4, 255,
            20, 20, 20, 255
        ])
    };

    const ratio = calculateNearBlackRatio(imageData, {
        x: 0,
        y: 0,
        width: 2,
        height: 2
    });

    assert.equal(ratio, 0.5);
});

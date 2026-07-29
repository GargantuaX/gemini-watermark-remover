import assert from 'node:assert/strict';
import test from 'node:test';

import { compositeKnownWatermark } from '../../scripts/synthetic-residual-ground-truth.js';

let estimationModule = null;
try {
    estimationModule = await import(
        '../../scripts/clean-alpha-profile-estimation.js'
    );
} catch {
    // RED: the experimental estimator does not exist yet.
}

function createFlatImageData(width, height, value) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) {
        const offset = index * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
    }
    return { width, height, data };
}

test('recovers a white-logo alpha profile from varied clean controls', () => {
    assert.equal(
        typeof estimationModule?.estimateWhiteLogoAlphaMap,
        'function'
    );
    const position = { x: 1, y: 1, width: 2, height: 2 };
    const expected = new Float32Array([0.04, 0.1, 0.2, 0.3]);
    const pairs = [40, 80, 120, 160, 200].map((value) => {
        const clean = createFlatImageData(4, 4, value);
        return {
            originalImageData: compositeKnownWatermark({
                truthImageData: clean,
                alphaMap: expected,
                position
            }),
            candidateImageData: clean,
            position
        };
    });

    const estimated = estimationModule.estimateWhiteLogoAlphaMap({
        pairs
    });

    assert.equal(estimated.status, 'complete');
    assert.equal(estimated.alphaMap.length, expected.length);
    for (let index = 0; index < expected.length; index++) {
        assert.ok(
            Math.abs(estimated.alphaMap[index] - expected[index]) < 0.01,
            `index ${index}: ${estimated.alphaMap[index]} vs ${expected[index]}`
        );
        assert.ok(estimated.supportCounts[index] >= pairs.length * 3);
    }
});

test('uses a robust median so one corrupted control does not move the profile', () => {
    assert.equal(
        typeof estimationModule?.estimateWhiteLogoAlphaMap,
        'function'
    );
    const position = { x: 0, y: 0, width: 2, height: 2 };
    const expected = new Float32Array([0.08, 0.12, 0.18, 0.24]);
    const pairs = [50, 90, 130, 170, 210].map((value) => {
        const clean = createFlatImageData(2, 2, value);
        return {
            originalImageData: compositeKnownWatermark({
                truthImageData: clean,
                alphaMap: expected,
                position
            }),
            candidateImageData: clean,
            position
        };
    });
    const corrupted = {
        originalImageData: createFlatImageData(2, 2, 250),
        candidateImageData: createFlatImageData(2, 2, 20),
        position
    };

    const estimated = estimationModule.estimateWhiteLogoAlphaMap({
        pairs: [...pairs, corrupted]
    });

    assert.equal(estimated.status, 'complete');
    for (let index = 0; index < expected.length; index++) {
        assert.ok(
            Math.abs(estimated.alphaMap[index] - expected[index]) < 0.015
        );
    }
});

test('fits profile strength separately from alpha-map shape', () => {
    assert.equal(
        typeof estimationModule?.fitAlphaMapScale,
        'function'
    );
    const fitted = estimationModule.fitAlphaMapScale({
        referenceMap: new Float32Array([0.1, 0.2, 0.3]),
        observedMap: new Float32Array([0.06, 0.12, 0.18])
    });

    assert.ok(Math.abs(fitted.scale - 0.6) < 1e-7);
    assert.ok(fitted.residual.mae < 1e-7);
    assert.ok(fitted.residual.rmse < 1e-7);
    assert.ok(fitted.residual.maxAbsoluteError < 1e-7);
});

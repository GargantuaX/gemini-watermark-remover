import assert from 'node:assert/strict';
import test from 'node:test';

import {
    measureAlphaEdgeLocalizedError,
    measureAlphaEdgeRecompositionEvidence
} from '../../scripts/alpha-edge-cleanliness.js';
import { compositeKnownWatermark } from '../../scripts/synthetic-residual-ground-truth.js';

function createRectangularAlphaMap(width, height) {
    const alphaMap = new Float64Array(width * height);
    for (let y = 3; y <= 7; y++) {
        for (let x = 4; x <= 6; x++) {
            alphaMap[y * width + x] = 0.8;
        }
    }
    return alphaMap;
}

function createErrorVector(width, height, points) {
    const errorVector = new Float64Array(width * height * 3);
    for (const [x, y] of points) {
        const offset = (y * width + x) * 3;
        errorVector[offset] = 12;
        errorVector[offset + 1] = 12;
        errorVector[offset + 2] = 12;
    }
    return errorVector;
}

test('ranks a true alpha-edge halo above equal-energy translated damage', () => {
    const width = 11;
    const height = 11;
    const alphaMap = createRectangularAlphaMap(width, height);
    const trueEdgePoints = [
        [3, 4],
        [3, 5],
        [3, 6],
        [7, 4],
        [7, 5],
        [7, 6]
    ];
    const translatedPoints = trueEdgePoints.map(([x, y]) => [x, y + 3]);
    const aligned = measureAlphaEdgeLocalizedError({
        errorVector: createErrorVector(
            width,
            height,
            trueEdgePoints
        ),
        alphaMap,
        width,
        height,
        decoyShifts: [
            [-3, 0],
            [3, 0],
            [0, -3],
            [0, 3]
        ]
    });
    const translated = measureAlphaEdgeLocalizedError({
        errorVector: createErrorVector(
            width,
            height,
            translatedPoints
        ),
        alphaMap,
        width,
        height,
        decoyShifts: [
            [-3, 0],
            [3, 0],
            [0, -3],
            [0, 3]
        ]
    });

    assert.ok(aligned.edgeWeightedMean > translated.edgeWeightedMean);
    assert.ok(aligned.edgeDecoyRatio > translated.edgeDecoyRatio);
    assert.ok(aligned.edgeDecoyRatio > 1);
});

test('reports zero edge energy without inventing a localization ratio', () => {
    const width = 11;
    const height = 11;
    const result = measureAlphaEdgeLocalizedError({
        errorVector: new Float64Array(width * height * 3),
        alphaMap: createRectangularAlphaMap(width, height),
        width,
        height,
        decoyShifts: [[3, 0]]
    });

    assert.equal(result.edgeWeightedMean, 0);
    assert.equal(result.decoyEdgeMedian, 0);
    assert.equal(result.edgeDecoyRatio, null);
});

test('exposes an alpha-edge halo that is orthogonal to the white template', () => {
    const width = 11;
    const height = 11;
    const position = { x: 0, y: 0, width, height };
    const alphaMap = createRectangularAlphaMap(width, height);
    const truthImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
        const offset = pixelIndex * 4;
        truthImageData.data[offset] = 100;
        truthImageData.data[offset + 1] = 100;
        truthImageData.data[offset + 2] = 100;
        truthImageData.data[offset + 3] = 255;
    }
    const originalImageData = compositeKnownWatermark({
        truthImageData,
        alphaMap,
        position
    });
    const haloImageData = {
        width,
        height,
        data: new Uint8ClampedArray(truthImageData.data)
    };
    for (const [x, y] of [
        [3, 4],
        [3, 5],
        [3, 6],
        [7, 4],
        [7, 5],
        [7, 6]
    ]) {
        const offset = (y * width + x) * 4;
        haloImageData.data[offset] += 12;
        haloImageData.data[offset + 1] -= 12;
    }

    const clean = measureAlphaEdgeRecompositionEvidence({
        originalImageData,
        candidateImageData: truthImageData,
        alphaMap,
        position,
        decoyShifts: [
            [-3, 0],
            [3, 0],
            [0, -3],
            [0, 3]
        ]
    });
    const halo = measureAlphaEdgeRecompositionEvidence({
        originalImageData,
        candidateImageData: haloImageData,
        alphaMap,
        position,
        decoyShifts: [
            [-3, 0],
            [3, 0],
            [0, -3],
            [0, 3]
        ]
    });

    assert.equal(clean.edgeWeightedMean, 0);
    assert.ok(Math.abs(halo.signedTemplateAmplitude) < 0.02);
    assert.ok(halo.edgeWeightedMean > 0);
    assert.ok(halo.edgeDecoyRatio > 1);
});

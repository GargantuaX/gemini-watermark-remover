import test from 'node:test';
import assert from 'node:assert/strict';

import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import { measureRestorationAgainstTruth } from '../../scripts/synthetic-residual-ground-truth.js';
import {
    createExactRoundTrip,
    createRealPipelineResidualFailure,
    mapReviewCropPositionToModelInput
} from '../../scripts/real-pipeline-residual-synthesis.js';

function createFlatTruth(width = 112, height = 112) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) {
        const offset = index * 4;
        data[offset] = 64;
        data[offset + 1] = 128;
        data[offset + 2] = 192;
        data[offset + 3] = 255;
    }
    return { width, height, data };
}

const POSITION = Object.freeze({ x: 32, y: 32, width: 48, height: 48 });

function truthProjection(result, alphaMap) {
    return measureRestorationAgainstTruth({
        truthImageData: result.truthImageData,
        watermarkedImageData: result.watermarkedImageData,
        candidateImageData: result.candidateImageData,
        alphaMap,
        position: POSITION
    });
}

test('exact production forward and inverse round trip stays within byte quantization error', () => {
    const truth = createFlatTruth();
    const originalBytes = new Uint8ClampedArray(truth.data);
    const alphaMap = getEmbeddedAlphaMap(48);

    const result = createExactRoundTrip({
        truthImageData: truth,
        alphaMap,
        position: POSITION
    });

    assert.deepEqual(truth.data, originalBytes, 'truth input must not be mutated');
    const projection = truthProjection(result, alphaMap);
    assert.ok(projection.roi.mae <= 0.7, `unexpected MAE ${projection.roi.mae}`);
    assert.ok(Math.abs(projection.template.signedAmplitude) <= 0.02);
});

test('gain mismatch produces opposite under-removal and over-removal directions', () => {
    const truth = createFlatTruth();
    const alphaMap = getEmbeddedAlphaMap(48);
    const under = createRealPipelineResidualFailure({
        truthImageData: truth,
        alphaMap,
        position: POSITION,
        mode: 'under-gain-0.78'
    });
    const over = createRealPipelineResidualFailure({
        truthImageData: truth,
        alphaMap,
        position: POSITION,
        mode: 'over-gain-1.12'
    });
    const underProjection = truthProjection(under, alphaMap);
    const overProjection = truthProjection(over, alphaMap);

    assert.ok(underProjection.template.signedAmplitude > 0.12);
    assert.ok(overProjection.template.signedAmplitude < -0.05);
    assert.ok(underProjection.roi.rmse > 1);
    assert.ok(overProjection.roi.rmse > 1);
});

test('profile and position mismatch preserve measurable non-template damage', () => {
    const truth = createFlatTruth();
    const alphaMap = getEmbeddedAlphaMap(48);
    for (const mode of [
        'forward-power-0.86',
        'forward-warped',
        'inverse-shift-1--1'
    ]) {
        const result = createRealPipelineResidualFailure({
            truthImageData: truth,
            alphaMap,
            position: POSITION,
            mode
        });
        const projection = truthProjection(result, alphaMap);
        assert.ok(
            projection.orthogonal.rmse > 0.1,
            `${mode} orthogonal RMSE ${projection.orthogonal.rmse}`
        );
        assert.ok(projection.roi.rmse > 0.1, `${mode} ROI RMSE ${projection.roi.rmse}`);
    }
});

test('review crop geometry maps catalog and boundary crops into model pixels', () => {
    assert.deepEqual(
        mapReviewCropPositionToModelInput({
            crop: { left: 100, top: 200, width: 144, height: 144 },
            position: { x: 148, y: 248, width: 48, height: 48 },
            modelSize: 144
        }),
        { x: 48, y: 48, width: 48, height: 48 }
    );
    assert.deepEqual(
        mapReviewCropPositionToModelInput({
            crop: { left: 100, top: 200, width: 128, height: 128 },
            position: { x: 148, y: 248, width: 48, height: 48 },
            modelSize: 144
        }),
        { x: 54, y: 54, width: 54, height: 54 }
    );
});

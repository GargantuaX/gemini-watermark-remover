import test from 'node:test';
import assert from 'node:assert/strict';

import { removeWatermark } from '../../src/core/blendModes.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    interpolateAlphaMap
} from '../../src/core/adaptiveDetector.js';
import {
    applySyntheticWatermark,
    cloneTestImageData,
    createPatternImageData,
    createSyntheticAlphaMap
} from './syntheticWatermarkTestUtils.js';

function scoreRegion(imageData, alphaMap, position) {
    return {
        spatial: computeRegionSpatialCorrelation({
            imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        }),
        gradient: computeRegionGradientCorrelation({
            imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        })
    };
}

async function getRemoveRepeatedWatermarkLayers() {
    try {
        const mod = await import('../../src/core/multiPassRemoval.js');
        return mod.removeRepeatedWatermarkLayers;
    } catch (error) {
        assert.fail(`removeRepeatedWatermarkLayers not implemented: ${error.message}`);
    }
}

test('removeRepeatedWatermarkLayers should keep peeling repeated watermark layers until residual falls', async () => {
    const removeRepeatedWatermarkLayers = await getRemoveRepeatedWatermarkLayers();
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha72 = interpolateAlphaMap(alpha96, 96, 72);
    const original = createPatternImageData(512, 384);
    const watermarked = cloneTestImageData(original);
    const position = { x: 512 - 44 - 72, y: 384 - 52 - 72, width: 72, height: 72 };

    applySyntheticWatermark(watermarked, alpha72, position, 3);

    const singlePass = cloneTestImageData(watermarked);
    removeWatermark(singlePass, alpha72, position);

    const singlePassScore = scoreRegion(singlePass, alpha72, position);
    const result = removeRepeatedWatermarkLayers({
        imageData: watermarked,
        alphaMap: alpha72,
        position,
        maxPasses: 4
    });
    const multiPassScore = scoreRegion(result.imageData, alpha72, position);

    assert.ok(result.passCount >= 2, `passCount=${result.passCount}`);
    assert.ok(
        multiPassScore.spatial < singlePassScore.spatial - 0.08,
        `single=${singlePassScore.spatial}, multi=${multiPassScore.spatial}`
    );
    assert.equal(result.stopReason, 'residual-low');
    assert.ok(Number.isFinite(multiPassScore.gradient), `gradient=${multiPassScore.gradient}`);
    assert.ok(
        result.passes.some((pass) => pass.improvement > 0),
        `passes=${JSON.stringify(result.passes)}`
    );
    assert.equal(result.passCount, result.passes[result.passes.length - 1].index);
});

test('removeRepeatedWatermarkLayers should stop early when single pass already clears the watermark', async () => {
    const removeRepeatedWatermarkLayers = await getRemoveRepeatedWatermarkLayers();
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const original = createPatternImageData(320, 320);
    const watermarked = cloneTestImageData(original);
    const position = { x: 320 - 32 - 48, y: 320 - 32 - 48, width: 48, height: 48 };

    applySyntheticWatermark(watermarked, alpha48, position, 1);

    const result = removeRepeatedWatermarkLayers({
        imageData: watermarked,
        alphaMap: alpha48,
        position,
        maxPasses: 4
    });

    assert.equal(result.passCount, 1);
    assert.equal(result.stopReason, 'residual-low');
    assert.equal(result.passes.length, 1);
});

test('removeRepeatedWatermarkLayers should support continuing pass numbering from an existing first pass', async () => {
    const removeRepeatedWatermarkLayers = await getRemoveRepeatedWatermarkLayers();
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha72 = interpolateAlphaMap(alpha96, 96, 72);
    const original = createPatternImageData(512, 384);
    const watermarked = cloneTestImageData(original);
    const position = { x: 512 - 44 - 72, y: 384 - 52 - 72, width: 72, height: 72 };

    applySyntheticWatermark(watermarked, alpha72, position, 2);
    removeWatermark(watermarked, alpha72, position);

    const result = removeRepeatedWatermarkLayers({
        imageData: watermarked,
        alphaMap: alpha72,
        position,
        maxPasses: 3,
        startingPassIndex: 1
    });

    assert.ok(result.passCount >= 2, `passCount=${result.passCount}`);
    assert.ok(result.passes.length >= 1, `passes=${JSON.stringify(result.passes)}`);
    assert.equal(result.passes[0].index, 2);
    assert.equal(result.passCount, result.passes[result.passes.length - 1].index);
});

test('removeRepeatedWatermarkLayers should stop when a pass causes texture collapse against the local reference', async () => {
    const removeRepeatedWatermarkLayers = await getRemoveRepeatedWatermarkLayers();
    const width = 96;
    const height = 96;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let i = 0; i < data.length; i += 4) {
        data[i + 3] = 255;
    }

    const position = { x: 24, y: 48, width: 48, height: 48 };
    for (let row = 0; row < 48; row++) {
        for (let col = 0; col < 48; col++) {
            const referenceIdx = (row * width + (24 + col)) * 4;
            const candidateIdx = (((48 + row) * width) + (24 + col)) * 4;
            const referenceValue = (row + col) % 2 === 0 ? 40 : 180;
            data[referenceIdx] = referenceValue;
            data[referenceIdx + 1] = referenceValue;
            data[referenceIdx + 2] = referenceValue;
            data[candidateIdx] = 138;
            data[candidateIdx + 1] = 138;
            data[candidateIdx + 2] = 138;
        }
    }

    const result = removeRepeatedWatermarkLayers({
        imageData: { width, height, data },
        alphaMap: new Float32Array(48 * 48).fill(0.5),
        position,
        maxPasses: 2
    });

    assert.equal(result.stopReason, 'safety-texture-collapse');
    assert.equal(result.passCount, 0);
    assert.equal(result.attemptedPassCount, 1);
    assert.equal(result.passes.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assessReferenceTextureAlignment,
    evaluateRestorationCandidate,
    selectInitialCandidate
} from '../../src/core/candidateSelector.js';
import { interpolateAlphaMap } from '../../src/core/adaptiveDetector.js';
import {
    applySyntheticWatermark,
    createPatternImageData,
    createSyntheticAlphaMap
} from './syntheticWatermarkTestUtils.js';

test('selectInitialCandidate should return a skipped result when no standard trials can be built', () => {
    const imageData = createPatternImageData(456, 142);
    const config = {
        logoSize: 125,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48: null,
        alpha96: null,
        getAlphaMap: () => null,
        allowAdaptiveSearch: false,
        alphaGainCandidates: [1]
    });

    assert.equal(result.selectedTrial, null);
    assert.equal(result.source, 'skipped');
    assert.equal(result.decisionTier, 'insufficient');
    assert.equal(result.standardSpatialScore, null);
    assert.equal(result.standardGradientScore, null);
});

test('selectInitialCandidate should not require eager adaptive search when the standard candidate is already strong', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPatternImageData(320, 320);
    const config = {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96: null,
        getAlphaMap: () => null,
        allowAdaptiveSearch: true,
        alphaGainCandidates: [1]
    });

    assert.ok(result.selectedTrial, 'expected standard candidate to be selected');
    assert.ok(result.source.startsWith('standard'), `source=${result.source}`);
    assert.equal(result.position.x, position.x);
    assert.equal(result.position.y, position.y);
});

test('evaluateRestorationCandidate should add texture penalty when restoration becomes darker than the local reference region', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPatternImageData(320, 320);
    const position = {
        x: 240,
        y: 240,
        width: 48,
        height: 48
    };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    const candidate = evaluateRestorationCandidate({
        originalImageData: imageData,
        alphaMap: alpha48,
        position,
        source: 'standard',
        config: {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        },
        baselineNearBlackRatio: 0,
        alphaGain: 1.05
    });

    const baseValidationCost =
        Math.abs(candidate.processedSpatialScore) +
        Math.max(0, candidate.processedGradientScore) * 0.6 +
        Math.max(0, candidate.nearBlackIncrease) * 3;

    assert.equal(candidate.accepted, true);
    assert.ok(candidate.validationCost > baseValidationCost, 'expected local texture penalty to increase validation cost');
    assert.ok(candidate.texturePenalty > 0, `texturePenalty=${candidate.texturePenalty}`);
});

test('assessReferenceTextureAlignment should mark a candidate unsafe when it is both darker and flatter than the local reference', () => {
    const width = 96;
    const height = 96;
    const data = new Uint8ClampedArray(width * height * 4);
    const candidateData = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i + 3] = 255;
        candidateData[i + 3] = 255;
    }

    const referenceRegion = { x: 24, y: 0, width: 48, height: 48 };
    const position = { x: 24, y: 48, width: 48, height: 48 };

    for (let row = 0; row < 48; row++) {
        for (let col = 0; col < 48; col++) {
            const refIdx = ((referenceRegion.y + row) * width + (referenceRegion.x + col)) * 4;
            const posIdx = ((position.y + row) * width + (position.x + col)) * 4;
            const value = (row + col) % 2 === 0 ? 40 : 180;
            data[refIdx] = value;
            data[refIdx + 1] = value;
            data[refIdx + 2] = value;
            candidateData[posIdx] = 18;
            candidateData[posIdx + 1] = 18;
            candidateData[posIdx + 2] = 18;
        }
    }

    const originalImageData = { width, height, data };
    const candidateImageData = { width, height, data: candidateData };
    const assessment = assessReferenceTextureAlignment({
        originalImageData,
        candidateImageData,
        position
    });

    assert.equal(assessment.tooDark, true);
    assert.equal(assessment.tooFlat, true);
    assert.ok(assessment.texturePenalty > 0, `texturePenalty=${assessment.texturePenalty}`);
    assert.equal(assessment.hardReject, true);
});

test('selectInitialCandidate should expose structured provenance for size-jitter recovery', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const alpha54 = interpolateAlphaMap(alpha96, 96, 54);
    const imageData = createPatternImageData(320, 320);
    const config = {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };
    const truePosition = {
        x: 320 - 32 - 54,
        y: 320 - 32 - 54,
        width: 54,
        height: 54
    };

    applySyntheticWatermark(imageData, alpha54, truePosition, 1);

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: false,
        alphaGainCandidates: [1]
    });

    assert.ok(result.selectedTrial, 'expected size-jitter candidate to be selected');
    assert.equal(result.selectedTrial.provenance?.sizeJitter, true);
});

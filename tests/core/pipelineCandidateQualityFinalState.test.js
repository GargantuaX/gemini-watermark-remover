import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { removeWatermark } from '../../src/core/blendModes.js';
import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import { createCandidateQualitySignals } from '../../src/core/pipelineCandidateQuality.js';
import { decodeImageDataInNode } from '../../scripts/sample-benchmark.js';

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function createPoweredAlphaMap(alphaMap, exponent) {
    return Float32Array.from(alphaMap, (alpha) => (
        Math.max(0, Math.min(0.99, Math.pow(alpha, exponent)))
    ));
}

function createCompositedWatermarkFixture(alphaMap, position, background = 200) {
    const imageData = {
        width: 128,
        height: 128,
        data: new Uint8ClampedArray(128 * 128 * 4)
    };
    for (let index = 0; index < imageData.data.length; index += 4) {
        imageData.data[index] = background;
        imageData.data[index + 1] = background;
        imageData.data[index + 2] = background;
        imageData.data[index + 3] = 255;
    }
    for (let row = 0; row < position.height; row += 1) {
        for (let column = 0; column < position.width; column += 1) {
            const alpha = alphaMap[row * position.width + column];
            const value = Math.round(background * (1 - alpha) + 255 * alpha);
            const pixelIndex = (
                (position.y + row) * imageData.width + position.x + column
            ) * 4;
            imageData.data[pixelIndex] = value;
            imageData.data[pixelIndex + 1] = value;
            imageData.data[pixelIndex + 2] = value;
        }
    }
    return imageData;
}

test('candidate quality reports a residual found by an independent reference alpha map', () => {
    const position = { x: 16, y: 16, width: 96, height: 96 };
    const referenceAlphaMap = getEmbeddedAlphaMap('96-20260520');
    const candidateImageData = createCompositedWatermarkFixture(
        referenceAlphaMap,
        position
    );
    const wrongSelfScoringAlphaMap = new Float32Array(96 * 96);
    wrongSelfScoringAlphaMap[0] = 0.5;

    const quality = createCandidateQualitySignals({
        originalImageData: cloneImageData(candidateImageData),
        candidateImageData,
        hypothesis: {
            position,
            trial: {
                position,
                alphaMap: wrongSelfScoringAlphaMap,
                alphaGain: 1
            }
        },
        finalCandidate: {
            position,
            alphaMap: wrongSelfScoringAlphaMap,
            alphaGain: 1
        },
        referenceAlphaMap
    });

    assert.equal(quality.referenceVisibility.visible, true);
    assert.equal(quality.residualVisible, true);
    assert.equal(quality.qualityStatus, 'visible-residual');
});

test('candidate quality derives the independent reference alpha map from the catalog config', () => {
    const position = { x: 16, y: 16, width: 96, height: 96 };
    const catalogAlphaMap = getEmbeddedAlphaMap('96-20260520');
    const candidateImageData = createCompositedWatermarkFixture(
        catalogAlphaMap,
        position
    );
    const wrongSelfScoringAlphaMap = new Float32Array(96 * 96);
    wrongSelfScoringAlphaMap[0] = 0.5;

    const quality = createCandidateQualitySignals({
        originalImageData: cloneImageData(candidateImageData),
        candidateImageData,
        hypothesis: {
            config: {
                logoSize: 96,
                marginRight: 192,
                marginBottom: 192,
                alphaVariant: '20260520'
            },
            position,
            trial: {
                position,
                alphaMap: wrongSelfScoringAlphaMap,
                alphaGain: 1
            }
        },
        finalCandidate: {
            position,
            alphaMap: wrongSelfScoringAlphaMap,
            alphaGain: 1
        }
    });

    assert.equal(quality.referenceVisibility.visible, true);
    assert.equal(quality.qualityStatus, 'visible-residual');
});

test('candidate quality uses final pipeline alpha state instead of the discovery trial alpha', async () => {
    const originalImageData = await decodeImageDataInNode(
        path.resolve('src/assets/samples/20260607-2.png')
    );
    const discoveryAlphaMap = calculateAlphaMap(
        await decodeImageDataInNode(path.resolve('src/assets/bg_48.png'))
    );
    const finalAlphaMap = createPoweredAlphaMap(discoveryAlphaMap, 0.9);
    const position = { x: 576, y: 1313, width: 48, height: 48 };
    const candidateImageData = cloneImageData(originalImageData);
    removeWatermark(candidateImageData, finalAlphaMap, position, { alphaGain: 0.85 });
    const hypothesis = {
        position,
        trial: {
            position,
            alphaMap: discoveryAlphaMap,
            alphaGain: 1
        }
    };

    const quality = createCandidateQualitySignals({
        originalImageData,
        candidateImageData,
        hypothesis,
        finalCandidate: {
            position,
            alphaMap: finalAlphaMap,
            alphaGain: 0.85
        }
    });

    assert.equal(
        quality.visibility.visible,
        false,
        `visibility=${JSON.stringify(quality.visibility)}`
    );
    assert.ok(
        quality.visibility.positiveHaloLum <= 4,
        `positiveHaloLum=${quality.visibility.positiveHaloLum}`
    );
    assert.ok(
        quality.artifacts.newlyClippedRatio <= 0.02,
        `newlyClippedRatio=${quality.artifacts.newlyClippedRatio}`
    );
});

test('explicit unchanged final alpha state preserves ordinary candidate quality', async () => {
    const originalImageData = await decodeImageDataInNode(
        path.resolve('src/assets/samples/20260608-6.png')
    );
    const alphaMap = calculateAlphaMap(
        await decodeImageDataInNode(path.resolve('src/assets/bg_48.png'))
    );
    const position = { x: 576, y: 1313, width: 48, height: 48 };
    const candidateImageData = cloneImageData(originalImageData);
    removeWatermark(candidateImageData, alphaMap, position, { alphaGain: 0.6 });
    const hypothesis = {
        position,
        trial: {
            position,
            alphaMap,
            alphaGain: 0.6
        }
    };

    const legacy = createCandidateQualitySignals({
        originalImageData,
        candidateImageData,
        hypothesis
    });
    const explicit = createCandidateQualitySignals({
        originalImageData,
        candidateImageData,
        hypothesis,
        finalCandidate: {
            position,
            alphaMap,
            alphaGain: 0.6
        }
    });

    assert.deepEqual(explicit, legacy);
});

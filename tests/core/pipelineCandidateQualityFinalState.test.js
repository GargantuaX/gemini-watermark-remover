import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { removeWatermark } from '../../src/core/blendModes.js';
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

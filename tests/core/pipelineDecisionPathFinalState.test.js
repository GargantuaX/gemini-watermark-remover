import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { interpolateAlphaMap } from '../../src/core/adaptiveDetector.js';
import { processWatermarkImageData } from '../../src/core/watermarkProcessor.js';
import { decodeImageDataInNode } from '../../scripts/sample-benchmark.js';

let alphaMapsPromise = null;

function loadAlphaMaps() {
    alphaMapsPromise ??= Promise.all([
        decodeImageDataInNode(path.resolve('src/assets/bg_48.png')),
        decodeImageDataInNode(path.resolve('src/assets/bg_96.png'))
    ]).then(([background48, background96]) => ({
        alpha48: calculateAlphaMap(background48),
        alpha96: calculateAlphaMap(background96)
    }));
    return alphaMapsPromise;
}

async function processSample(fileName) {
    const [
        originalImageData,
        { alpha48, alpha96 }
    ] = await Promise.all([
        decodeImageDataInNode(path.resolve('src/assets/samples', fileName)),
        loadAlphaMaps()
    ]);
    return processWatermarkImageData(originalImageData, {
        alpha48,
        alpha96,
        adaptiveMode: 'never',
        getAlphaMap: (size) => (
            size === 48
                ? alpha48
                : interpolateAlphaMap(alpha96, 96, size)
        )
    });
}

test('20260607-2 decisionPath should report the final profile-alpha pipeline state', async () => {
    const result = await processSample('20260607-2.png');
    const alphaTrial = result.meta.decisionPath?.alphaTrial;
    const finalQuality = result.meta.qualitySignals;

    assert.equal(result.meta.applied, true);
    assert.equal(alphaTrial?.strategy, 'large-margin-48-profile-alpha');
    assert.equal(alphaTrial?.migrationStage, 'phase2-alpha-trial');
    assert.equal(
        alphaTrial?.artifacts?.newlyClippedRatio,
        finalQuality?.artifacts?.newlyClippedRatio
    );
    assert.ok(
        alphaTrial.artifacts.newlyClippedRatio > 0.019 &&
        alphaTrial.artifacts.newlyClippedRatio < 0.021,
        `newlyClippedRatio=${alphaTrial.artifacts.newlyClippedRatio}`
    );
    assert.equal(
        alphaTrial.damage.newlyClippedRatio,
        alphaTrial.artifacts.newlyClippedRatio
    );
    assert.equal(
        alphaTrial.residual.spatial,
        result.meta.detection.processedSpatialScore
    );
    assert.equal(
        alphaTrial.residual.gradient,
        result.meta.detection.processedGradientScore
    );
    assert.equal(
        alphaTrial.alphaShape.profileStages[0].profileExponent,
        0.9
    );
});

test('phase1 repair decisionPath should also report final damage artifacts and residual', async () => {
    const result = await processSample('4-3.png');
    const decisionPath = result.meta.decisionPath;
    const alphaTrial = decisionPath?.alphaTrial;
    const finalQuality = result.meta.qualitySignals;

    assert.equal(result.meta.applied, true);
    assert.equal(alphaTrial?.migrationStage, 'phase1-adapter');
    assert.equal(decisionPath?.repairTrial?.applied, true);
    assert.equal(alphaTrial?.artifacts, finalQuality?.artifacts);
    assert.equal(
        alphaTrial.damage.newlyClippedRatio,
        finalQuality.artifacts.newlyClippedRatio
    );
    assert.equal(alphaTrial.residual.spatial, finalQuality.final.spatialScore);
    assert.equal(alphaTrial.residual.gradient, finalQuality.final.gradientScore);
});

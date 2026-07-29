import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { interpolateAlphaMap } from '../../src/core/adaptiveDetector.js';
import { removeWatermark } from '../../src/core/blendModes.js';
import { scoreRegion } from '../../src/core/candidateSelector.js';
import {
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility
} from '../../src/core/restorationMetrics.js';
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
    const { alpha48, alpha96 } = await loadAlphaMaps();
    const originalImageData = await decodeImageDataInNode(
        path.resolve('src/assets/samples', fileName)
    );
    const result = processWatermarkImageData(originalImageData, {
        alpha48,
        alpha96,
        adaptiveMode: 'never',
        debugTimings: true,
        getAlphaMap: (size) => (
            size === 48
                ? alpha48
                : interpolateAlphaMap(alpha96, 96, size)
        )
    });
    return { alpha48, originalImageData, result };
}

function assertExactAnchor(result, expectedPosition, fileName) {
    assert.deepEqual(
        result.meta.position,
        expectedPosition,
        `${fileName}: geometry must stay fixed, source=${result.meta.source}`
    );
}

function assertGainInRange(result, min, max, fileName) {
    assert.ok(
        result.meta.alphaGain >= min && result.meta.alphaGain <= max,
        `${fileName}: expected alpha gain in [${min}, ${max}], got ${result.meta.alphaGain}; ` +
            `source=${result.meta.source}`
    );
}

function powerAlphaMap(alphaMap, exponent) {
    return Float32Array.from(alphaMap, (value) => (
        Math.sign(value) * Math.pow(Math.abs(value), exponent)
    ));
}

test('damage-triggered local alpha search lowers gain without changing the exact 48px anchor', async () => {
    const cases = [
        {
            fileName: '20260520-1.png',
            position: { x: 1328, y: 688, width: 48, height: 48 },
            minGain: 0.94,
            maxGain: 0.96,
            maxNewlyClippedRatio: 0.01
        },
        {
            fileName: '4-5.png',
            position: { x: 848, y: 1072, width: 48, height: 48 },
            minGain: 0.994,
            maxGain: 0.998,
            maxNewlyClippedRatio: 0.02
        }
    ];

    for (const item of cases) {
        const {
            alpha48,
            originalImageData,
            result
        } = await processSample(item.fileName);

        assert.equal(result.meta.applied, true, `${item.fileName}: ${result.meta.skipReason}`);
        assertExactAnchor(result, item.position, item.fileName);
        assertGainInRange(result, item.minGain, item.maxGain, item.fileName);
        assert.equal(
            result.meta.detection.residualVisibility?.visible,
            false,
            `${item.fileName}: residual=${JSON.stringify(result.meta.detection.residualVisibility)}`
        );
        assert.equal(
            String(result.meta.source).includes('+located-aggressive'),
            false,
            `${item.fileName}: a safe scalar calibration must precede generic repair`
        );
        assert.deepEqual(
            result.meta.qualitySignals?.localAlphaSearch,
            item.fileName === '4-5.png'
                ? {
                    trigger: 'damage',
                    acceptedTrialDamageSafe: false,
                    finalDamageSafe: false,
                    riskResolution: 'best-effort-damage'
                }
                : {
                    trigger: 'damage',
                    acceptedTrialDamageSafe: true,
                    finalDamageSafe: true,
                    riskResolution: null
                },
            `${item.fileName}: metadata must distinguish intermediate and final damage risk`
        );

        const artifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData: result.imageData,
            alphaMap: alpha48,
            position: item.position,
            alphaGain: result.meta.alphaGain
        });
        assert.ok(
            artifacts.newlyClippedRatio <= item.maxNewlyClippedRatio,
            `${item.fileName}: newlyClippedRatio=${artifacts.newlyClippedRatio}`
        );

        if (item.fileName === '4-5.png') {
            assert.equal(
                result.meta.qualitySignals?.damageWarning,
                false,
                '4-5.png: calibrated product warning remains non-blocking'
            );
            assert.equal(result.meta.qualityStatus, 'clean');
            assert.equal(
                result.meta.decisionPath?.alphaTrial?.damage?.safe,
                result.meta.qualitySignals?.localAlphaSearch?.finalDamageSafe,
                'local search metadata must use the same final scoreDamage verdict as alphaTrial'
            );

            const instrumentation = result.debugTimings;
            assert.ok(
                instrumentation.localAlphaSearchTrialCount >= 2,
                `trialCount=${instrumentation.localAlphaSearchTrialCount}`
            );
            assert.equal(
                instrumentation.localAlphaSearchTrialFullImageCloneCount,
                0,
                'gain trials must not clone the full image'
            );
            assert.equal(
                instrumentation.localAlphaSearchMaxTrialBufferPixels,
                56 * 56,
                '48px trials need the full 4px residual-visibility outer ring'
            );
            assert.ok(
                instrumentation.localAlphaSearchTrialAllocatedPixels <=
                    instrumentation.localAlphaSearchTrialCount * 56 * 56,
                `trialAllocatedPixels=${instrumentation.localAlphaSearchTrialAllocatedPixels}`
            );
            assert.ok(
                instrumentation.localAlphaSearchTrialAllocatedPixels <
                    instrumentation.localAlphaSearchTrialCount *
                    originalImageData.width *
                    originalImageData.height /
                    100,
                'trial allocation must stay below one percent of equivalent full-image clones'
            );
            assert.ok(
                instrumentation.localAlphaSearchFullImageMaterializationCount >= 1,
                'the accepted winner should be materialized after the scratch search'
            );
        }
    }
});

test('low-gradient overshoot gets a 0.01 local alpha search while its clean pair stays at 0.6', async () => {
    const overshoot = await processSample('20260608-7.png');
    const cleanPair = await processSample('20260608-6.png');

    assertExactAnchor(
        overshoot.result,
        { x: 576, y: 1312, width: 48, height: 48 },
        '20260608-7.png'
    );
    assertGainInRange(overshoot.result, 0.565, 0.575, '20260608-7.png');
    assert.equal(
        overshoot.result.meta.detection.residualVisibility?.visible,
        false,
        `20260608-7.png: residual=${JSON.stringify(overshoot.result.meta.detection.residualVisibility)}`
    );
    assert.ok(
        Math.abs(overshoot.result.meta.detection.processedSpatialScore) <= 0.18,
        `20260608-7.png: spatial=${overshoot.result.meta.detection.processedSpatialScore}`
    );
    assert.ok(
        overshoot.result.meta.detection.processedGradientScore <= 0.22,
        `20260608-7.png: gradient=${overshoot.result.meta.detection.processedGradientScore}`
    );
    const overshootStage = overshoot.result.meta.alphaAdjustmentStages?.find(
        (stage) => stage.stage === 'evidence-gated-local-alpha-search'
    );
    assert.ok(
        overshootStage,
        `20260608-7.png: stages=${JSON.stringify(overshoot.result.meta.alphaAdjustmentStages)}`
    );
    assert.ok(
        overshootStage.beforeGradientScore < 0.35,
        `20260608-7.png: the regression requires search below the old gradient gate`
    );
    assert.equal(
        String(overshoot.result.meta.source).includes('+located-aggressive'),
        false,
        `20260608-7.png: source=${overshoot.result.meta.source}`
    );

    assertExactAnchor(
        cleanPair.result,
        { x: 576, y: 1313, width: 48, height: 48 },
        '20260608-6.png'
    );
    assert.equal(
        cleanPair.result.meta.alphaGain,
        0.6,
        `20260608-6.png: a clean pair must not inherit the 0.57 gain`
    );
    assert.equal(cleanPair.result.meta.detection.residualVisibility?.visible, false);
    assert.equal(
        cleanPair.result.meta.alphaAdjustmentStages?.some(
            (stage) => stage.stage === 'evidence-gated-local-alpha-search'
        ),
        false,
        `20260608-6.png: stages=${JSON.stringify(cleanPair.result.meta.alphaAdjustmentStages)}`
    );
});

test('strict 48px large-margin profile rescue clears 20260607-2 before star-producing repair', async () => {
    const rescued = await processSample('20260607-2.png');
    const cleanControl = await processSample('20260608-5.png');

    assertExactAnchor(
        rescued.result,
        { x: 576, y: 1313, width: 48, height: 48 },
        '20260607-2.png'
    );
    assertGainInRange(rescued.result, 0.84, 0.86, '20260607-2.png');
    assert.equal(
        rescued.result.meta.detection.residualVisibility?.visible,
        false,
        `20260607-2.png: residual=${JSON.stringify(rescued.result.meta.detection.residualVisibility)}`
    );
    assert.ok(
        Math.abs(rescued.result.meta.detection.processedSpatialScore) <= 0.12,
        `20260607-2.png: spatial=${rescued.result.meta.detection.processedSpatialScore}`
    );
    assert.ok(
        rescued.result.meta.detection.processedGradientScore <= 0.1,
        `20260607-2.png: gradient=${rescued.result.meta.detection.processedGradientScore}`
    );
    assert.ok(
        rescued.result.meta.detection.residualVisibility.positiveHaloLum <= 4,
        `20260607-2.png: halo=${rescued.result.meta.detection.residualVisibility.positiveHaloLum}`
    );
    assert.equal(
        String(rescued.result.meta.source).includes('+located-aggressive'),
        false,
        `20260607-2.png: source=${rescued.result.meta.source}`
    );
    const profileStage = rescued.result.meta.alphaAdjustmentStages?.find(
        (stage) => stage.stage === 'large-margin-48-profile-alpha-rescue'
    );
    assert.equal(profileStage?.profileExponent, 0.9);

    const rescuedArtifacts = assessRemovalDiffArtifacts({
        originalImageData: rescued.originalImageData,
        candidateImageData: rescued.result.imageData,
        alphaMap: powerAlphaMap(rescued.alpha48, 0.9),
        position: rescued.result.meta.position,
        alphaGain: rescued.result.meta.alphaGain
    });
    assert.ok(
        rescuedArtifacts.newlyClippedRatio <= 0.02,
        `20260607-2.png: newlyClippedRatio=${rescuedArtifacts.newlyClippedRatio}`
    );
    assert.ok(
        rescuedArtifacts.visualArtifactCost <= 0.12,
        `20260607-2.png: visualArtifactCost=${rescuedArtifacts.visualArtifactCost}`
    );

    assertExactAnchor(
        cleanControl.result,
        { x: 576, y: 1313, width: 48, height: 48 },
        '20260608-5.png'
    );
    assert.equal(
        cleanControl.result.meta.alphaGain,
        0.64,
        `20260608-5.png: clean control gain=${cleanControl.result.meta.alphaGain}`
    );
    assert.equal(cleanControl.result.meta.detection.residualVisibility?.visible, false);
    assert.equal(
        cleanControl.result.meta.alphaAdjustmentStages?.some(
            (stage) => stage.stage === 'large-margin-48-profile-alpha-rescue'
        ),
        false,
        `20260608-5.png: stages=${JSON.stringify(cleanControl.result.meta.alphaAdjustmentStages)}`
    );
});

test('gain-one large-margin profile entry rejects a powered-map candidate that stays visible', async () => {
    const { alpha48, originalImageData } = await processSample('20260607-2.png');
    const { alpha96 } = await loadAlphaMaps();
    const entryAlphaMap = powerAlphaMap(alpha48, 1.025);
    const position = { x: 576, y: 1313, width: 48, height: 48 };
    const gainOneImageData = {
        width: originalImageData.width,
        height: originalImageData.height,
        data: new Uint8ClampedArray(originalImageData.data)
    };
    removeWatermark(gainOneImageData, entryAlphaMap, position, { alphaGain: 1 });

    const entryScores = scoreRegion(gainOneImageData, entryAlphaMap, position);
    const entryVisibility = assessWatermarkResidualVisibility({
        imageData: gainOneImageData,
        position,
        alphaMap: entryAlphaMap
    });
    const entryArtifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: gainOneImageData,
        alphaMap: entryAlphaMap,
        position,
        alphaGain: 1
    });
    assert.ok(Math.abs(entryScores.spatialScore) <= 0.1);
    assert.ok(entryScores.gradientScore <= 0.1);
    assert.equal(entryVisibility.visible, true);
    assert.ok(entryVisibility.positiveHaloLum >= 12);
    assert.ok(entryArtifacts.newlyClippedRatio >= 0.05);
    assert.ok(entryArtifacts.newlyClippedRatio <= 0.11);
    assert.ok(entryArtifacts.visualArtifactCost <= 0.13);

    const result = processWatermarkImageData(originalImageData, {
        alpha48: entryAlphaMap,
        alpha96,
        adaptiveMode: 'never',
        debugTimings: true,
        getAlphaMap: (size) => (
            size === 48
                ? entryAlphaMap
                : interpolateAlphaMap(alpha96, 96, size)
        )
    });
    assert.equal(result.meta.alphaGain, 1);
    assert.equal(
        result.meta.alphaAdjustmentStages?.some(
            (stage) => stage.stage === 'large-margin-48-profile-alpha-rescue'
        ),
        false,
        `stages=${JSON.stringify(result.meta.alphaAdjustmentStages)}`
    );
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAcceptedPipelineFinalResult } from '../../src/core/pipelineFinalization.js';
import {
    applySyntheticWatermark,
    createPatternImageData,
    createSyntheticAlphaMap
} from './syntheticWatermarkTestUtils.js';

function createPositiveHaloBackgroundCollisionFixture() {
    const width = 288;
    const height = 288;
    const position = { x: 192, y: 192, width: 96, height: 96 };
    const alphaMap = createSyntheticAlphaMap(96);
    const finalImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    let seed = 123456789;
    const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    for (let index = 0; index < finalImageData.data.length; index += 4) {
        const value = 40 + Math.floor(random() * 176);
        finalImageData.data[index] = value;
        finalImageData.data[index + 1] = value;
        finalImageData.data[index + 2] = value;
        finalImageData.data[index + 3] = 255;
    }
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            const value = Math.min(255, finalImageData.data[pixelIndex] + alpha * 30);
            finalImageData.data[pixelIndex] = value;
            finalImageData.data[pixelIndex + 1] = value;
            finalImageData.data[pixelIndex + 2] = value;
        }
    }

    return {
        position,
        alphaMap,
        finalImageData,
        originalImageData: {
            width,
            height,
            data: finalImageData.data.slice()
        }
    };
}

test('createAcceptedPipelineFinalResult should finalize accepted result metadata from state', () => {
    const imageData = createPatternImageData(128, 128);
    const alphaMap = createSyntheticAlphaMap(48);
    const position = { x: 48, y: 48, width: 48, height: 48 };
    const result = createAcceptedPipelineFinalResult({
        pipelineState: {
            finalImageData: imageData,
            alphaMap,
            position,
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            alphaGain: 0.9,
            alphaMapSource: 'catalog',
            originalSpatialScore: 0.7,
            originalGradientScore: 0.6,
            finalProcessedSpatialScore: 0.08,
            finalProcessedGradientScore: 0.05,
            suppressionGain: 0.62,
            source: 'standard+fine-alpha'
        },
        passState: {
            passCount: 1,
            attemptedPassCount: 1,
            passStopReason: 'residual-low',
            passes: [{ index: 1 }]
        },
        traceState: {
            alphaAdjustmentStages: [{ stage: 'fine-alpha' }],
            alphaTrialEvents: [{ stage: 'fine-alpha', decision: 'accept' }]
        },
        resultContext: {
            debugTimings: { totalMs: 10 },
            selectedTrial: {
                config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
                position
            },
            adaptiveConfidence: 0.8,
            templateWarp: null,
            decisionTier: 'standard',
            subpixelShift: null
        },
        initialSelection: { source: 'standard' },
        originalImageData: imageData,
        resolvedConfig: { logoSize: 48, marginRight: 32, marginBottom: 32 }
    });

    assert.equal(result.imageData, imageData);
    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.source, 'standard+fine-alpha');
    assert.equal(result.meta.selectionDebug.candidateSource, 'standard');
    assert.equal(result.meta.selectionDebug.initialPosition.width, 48);
    assert.equal(typeof result.meta.detection.residualVisibility.visible, 'boolean');
    assert.equal(result.meta.decisionPath.alphaTrial.strategy, 'fine-alpha');
});

test('createAcceptedPipelineFinalResult should fail closed for unsafe visible residual on issue 103 new-margin variant', () => {
    const originalImageData = createPatternImageData(64, 64);
    const finalImageData = createPatternImageData(64, 64);
    const alphaMap = createSyntheticAlphaMap(8);
    const position = { x: 24, y: 24, width: 8, height: 8 };
    const config = {
        logoSize: 96,
        marginRight: 192,
        marginBottom: 192,
        alphaVariant: '20260520'
    };
    applySyntheticWatermark(finalImageData, alphaMap, position);

    const result = createAcceptedPipelineFinalResult({
        pipelineState: {
            finalImageData,
            alphaMap,
            position,
            config,
            alphaGain: 0.85,
            alphaMapSource: null,
            originalSpatialScore: 0.394,
            originalGradientScore: 0.692,
            finalProcessedSpatialScore: -0.195,
            finalProcessedGradientScore: 0.294,
            suppressionGain: 0.589,
            source: 'standard+located-aggressive'
        },
        passState: {
            passCount: 2,
            attemptedPassCount: 2,
            passStopReason: 'located-aggressive-edge-cleanup',
            passes: [{ index: 1 }, { index: 2 }]
        },
        traceState: {
            alphaAdjustmentStages: [{ stage: 'located-aggressive-removal' }],
            alphaTrialEvents: [{ strategy: 'located-aggressive-alpha', decision: 'accept' }]
        },
        resultContext: {
            debugTimings: { totalMs: 20 },
            selectedTrial: {
                config,
                position,
                damage: { safe: false, reason: 'texture' }
            },
            adaptiveConfidence: null,
            templateWarp: null,
            decisionTier: 'direct-match',
            subpixelShift: null
        },
        initialSelection: { source: 'standard' },
        originalImageData,
        resolvedConfig: config
    });

    assert.equal(result.imageData, originalImageData);
    assert.equal(result.meta.applied, false);
    assert.equal(result.meta.skipReason, 'visible-residual-unsafe-damage');
    assert.equal(result.meta.position.width, 8);
    assert.equal(result.meta.config.alphaVariant, '20260520');
    assert.equal(result.meta.detection.residualVisibility.visible, true);
    assert.equal(result.meta.decisionPath.evaluation.blockedGate, 'visible-residual-unsafe-damage');
});

test('createAcceptedPipelineFinalResult should fail closed for unsafe weak shifted fallback candidates', () => {
    const originalImageData = createPatternImageData(192, 192);
    const finalImageData = createPatternImageData(192, 192);
    const alphaMap = createSyntheticAlphaMap(48);
    const position = { x: 48, y: 52, width: 48, height: 48 };
    const config = { logoSize: 48, marginRight: 96, marginBottom: 96 };

    const result = createAcceptedPipelineFinalResult({
        pipelineState: {
            finalImageData,
            alphaMap,
            position,
            config,
            alphaGain: 1,
            alphaMapSource: 'catalog',
            originalSpatialScore: 0.284,
            originalGradientScore: 0.004,
            finalProcessedSpatialScore: 0.016,
            finalProcessedGradientScore: 0.075,
            suppressionGain: 0.268,
            source: 'standard+catalog+local+edge-cleanup'
        },
        passState: {
            passCount: 1,
            attemptedPassCount: 1,
            passStopReason: 'known-48-edge-cleanup',
            passes: [{ index: 1 }]
        },
        traceState: {
            alphaAdjustmentStages: [{ stage: 'known-48-edge-cleanup' }],
            alphaTrialEvents: []
        },
        resultContext: {
            debugTimings: { totalMs: 10 },
            selectedTrial: {
                config,
                position,
                provenance: { catalogVariant: true, localShift: true },
                originalSpatialScore: 0.284,
                originalGradientScore: 0.004,
                damage: { safe: false, reason: 'texture' }
            },
            adaptiveConfidence: null,
            templateWarp: null,
            decisionTier: 'direct-match',
            subpixelShift: null
        },
        initialSelection: { source: 'standard' },
        originalImageData,
        resolvedConfig: config
    });

    assert.equal(result.imageData, originalImageData);
    assert.equal(result.meta.applied, false);
    assert.equal(result.meta.skipReason, 'unsafe-weak-shifted-candidate');
    assert.equal(result.meta.decisionPath.evaluation.blockedGate, 'unsafe-weak-shifted-candidate');
});

test('createAcceptedPipelineFinalResult should preserve imperfect pixels for Top-N arbitration', () => {
    const originalImageData = createPatternImageData(64, 64);
    const finalImageData = createPatternImageData(64, 64);
    const alphaMap = createSyntheticAlphaMap(8);
    const position = { x: 24, y: 24, width: 8, height: 8 };
    const config = {
        logoSize: 96,
        marginRight: 192,
        marginBottom: 192,
        alphaVariant: '20260520'
    };
    applySyntheticWatermark(finalImageData, alphaMap, position);

    const result = createAcceptedPipelineFinalResult({
        pipelineState: {
            finalImageData,
            alphaMap,
            position,
            config,
            alphaGain: 1,
            originalSpatialScore: 0.9,
            originalGradientScore: 0.8,
            finalProcessedSpatialScore: -0.8,
            finalProcessedGradientScore: 0.6,
            suppressionGain: 1.7,
            source: 'adaptive+aggressive-located'
        },
        passState: {},
        traceState: {},
        resultContext: {
            selectedTrial: {
                config,
                position,
                damage: { safe: false, reason: 'texture' }
            },
            selectionSource: 'adaptive+aggressive-located',
            decisionTier: 'direct-match'
        },
        initialSelection: { source: 'adaptive+aggressive-located' },
        originalImageData,
        resolvedConfig: config,
        allowFailClosed: false
    });

    assert.equal(result.imageData, finalImageData);
    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.source, 'adaptive+aggressive-located');
});

test('createAcceptedPipelineFinalResult should expose calibrated visibility while preserving raw residual evidence', () => {
    const {
        position,
        alphaMap,
        finalImageData,
        originalImageData
    } = createPositiveHaloBackgroundCollisionFixture();

    const result = createAcceptedPipelineFinalResult({
        pipelineState: {
            finalImageData,
            alphaMap,
            position,
            config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
            alphaGain: 1,
            source: 'standard'
        },
        resultContext: {
            selectedTrial: {
                position,
                config: { logoSize: 96, marginRight: 64, marginBottom: 64 }
            },
            decisionTier: 'direct-match'
        },
        originalImageData,
        resolvedConfig: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        allowFailClosed: false
    });

    assert.equal(result.meta.detection.residualVisibility.rawVisible, true);
    assert.equal(result.meta.detection.residualVisibility.visible, false);
    assert.equal(
        result.meta.detection.residualVisibility.metricRisk,
        'positive-halo-background-collision'
    );
});

test('createAcceptedPipelineFinalResult should fail closed unsafe new-margin output using raw visibility', () => {
    const width = 288;
    const height = 288;
    const position = { x: 192, y: 192, width: 96, height: 96 };
    const config = {
        logoSize: 96,
        marginRight: 192,
        marginBottom: 192,
        alphaVariant: '20260520'
    };
    const alphaMap = createSyntheticAlphaMap(96);
    const finalImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    let seed = 123456789;
    const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    for (let index = 0; index < finalImageData.data.length; index += 4) {
        const value = 40 + Math.floor(random() * 176);
        finalImageData.data[index] = value;
        finalImageData.data[index + 1] = value;
        finalImageData.data[index + 2] = value;
        finalImageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            const value = Math.min(255, finalImageData.data[pixelIndex] + alpha * 30);
            finalImageData.data[pixelIndex] = value;
            finalImageData.data[pixelIndex + 1] = value;
            finalImageData.data[pixelIndex + 2] = value;
        }
    }
    const originalImageData = {
        width,
        height,
        data: finalImageData.data.slice()
    };

    const result = createAcceptedPipelineFinalResult({
        pipelineState: {
            finalImageData,
            alphaMap,
            position,
            config,
            alphaGain: 1,
            source: 'standard+located-aggressive'
        },
        resultContext: {
            selectedTrial: {
                position,
                config,
                damage: {
                    safe: false,
                    reason: 'clipping'
                }
            },
            decisionTier: 'direct-match'
        },
        originalImageData,
        resolvedConfig: config
    });

    assert.equal(result.imageData, originalImageData);
    assert.equal(result.meta.applied, false);
    assert.equal(result.meta.skipReason, 'visible-residual-unsafe-damage');
    assert.equal(result.meta.detection.residualVisibility.rawVisible, true);
    assert.equal(result.meta.detection.residualVisibility.visible, false);
    assert.equal(
        result.meta.detection.residualVisibility.metricRisk,
        'positive-halo-background-collision'
    );
});

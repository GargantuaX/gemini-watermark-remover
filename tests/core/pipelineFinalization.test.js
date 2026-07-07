import test from 'node:test';
import assert from 'node:assert/strict';

import { createAcceptedPipelineFinalResult } from '../../src/core/pipelineFinalization.js';
import {
    applySyntheticWatermark,
    createPatternImageData,
    createSyntheticAlphaMap
} from './syntheticWatermarkTestUtils.js';

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

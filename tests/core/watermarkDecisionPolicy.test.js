import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyAdaptiveWatermarkSignal,
    classifyGeminiAttributionFromWatermarkMeta,
    classifyStandardWatermarkSignal
} from '../../src/core/watermarkDecisionPolicy.js';

test('classifyStandardWatermarkSignal should mark strong standard evidence as direct-match', () => {
    assert.equal(
        classifyStandardWatermarkSignal({
            spatialScore: 0.88,
            gradientScore: 0.74
        }).tier,
        'direct-match'
    );
});

test('classifyStandardWatermarkSignal should keep borderline standard evidence below direct-match', () => {
    assert.equal(
        classifyStandardWatermarkSignal({
            spatialScore: 0.2677163775605826,
            gradientScore: 0.25454479646469025
        }).tier,
        'needs-validation'
    );
});

test('classifyAdaptiveWatermarkSignal should mark strong adaptive evidence as direct-match', () => {
    assert.equal(
        classifyAdaptiveWatermarkSignal({
            found: true,
            confidence: 0.7845323693117736,
            spatialScore: 0.9965533853965058,
            gradientScore: 0.9541855887117356,
            region: { size: 48, x: 1328, y: 688 }
        }).tier,
        'direct-match'
    );
});

test('classifyAdaptiveWatermarkSignal should reject small low-gradient false positives', () => {
    assert.equal(
        classifyAdaptiveWatermarkSignal({
            found: true,
            confidence: 0.5066759179471003,
            spatialScore: 0.6938209781896534,
            gradientScore: 0.07713201509467535,
            region: { size: 38, x: 834, y: 400 }
        }).tier,
        'insufficient'
    );
});

test('classifyGeminiAttributionFromWatermarkMeta should promote validated near-threshold removals', () => {
    assert.equal(
        classifyGeminiAttributionFromWatermarkMeta({
            size: 48,
            source: 'standard+validated',
            position: { x: 928, y: 991, width: 48, height: 48 },
            detection: {
                originalSpatialScore: 0.20566919048343582,
                processedSpatialScore: -0.19221856811204466,
                suppressionGain: 0.3978877585954805,
                originalGradientScore: 0.18464983906035948,
                processedGradientScore: 0.0491637976752285,
                adaptiveConfidence: 0.33022714362309186
            }
        }).tier,
        'validated-match'
    );
});

test('classifyGeminiAttributionFromWatermarkMeta should keep skipped non-Gemini sample as insufficient', () => {
    assert.equal(
        classifyGeminiAttributionFromWatermarkMeta({
            applied: false,
            source: 'skipped',
            detection: {
                originalSpatialScore: 0.2795279437644118,
                processedSpatialScore: 0.2795279437644118,
                suppressionGain: 0,
                adaptiveConfidence: 0.5066759179471003
            }
        }).tier,
        'insufficient'
    );
});

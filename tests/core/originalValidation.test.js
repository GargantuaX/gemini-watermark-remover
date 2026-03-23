import test from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateOriginalFromExif,
    getOriginalStatus,
    isLikelyGeminiDimensions,
    resolveOriginalValidation
} from '../../src/utils.js';

test('isLikelyGeminiDimensions should include common metadata-stripped Gemini sizes', () => {
    assert.equal(isLikelyGeminiDimensions(768, 1376), true);
    assert.equal(isLikelyGeminiDimensions(848, 1264), true);
    assert.equal(isLikelyGeminiDimensions(832, 1248), true);
    assert.equal(isLikelyGeminiDimensions(928, 1152), true);
    assert.equal(isLikelyGeminiDimensions(1024, 1024), true);
});

test('isLikelyGeminiDimensions should reject common non-Gemini canvas sizes', () => {
    assert.equal(isLikelyGeminiDimensions(1280, 720), false);
    assert.equal(isLikelyGeminiDimensions(1000, 1000), false);
});

test('evaluateOriginalFromExif should trust Gemini Credit metadata', () => {
    const out = evaluateOriginalFromExif({
        Credit: 'Made with Google AI',
        ImageWidth: 2000,
        ImageHeight: 1300
    });
    assert.deepEqual(out, { is_google: true, is_original: true });
});

test('evaluateOriginalFromExif should fallback to Gemini dimensions when Credit is missing', () => {
    const out = evaluateOriginalFromExif({
        ImageWidth: 768,
        ImageHeight: 1376
    });
    assert.deepEqual(out, { is_google: true, is_original: true });
});

test('evaluateOriginalFromExif should keep unknown sizes as non-Gemini', () => {
    const out = evaluateOriginalFromExif({
        ImageWidth: 1280,
        ImageHeight: 720
    });
    assert.deepEqual(out, { is_google: false, is_original: true });
});

test('resolveOriginalValidation should promote Gemini status when watermark signal is strong', () => {
    const out = resolveOriginalValidation(
        { is_google: false, is_original: true },
        {
            size: 96,
            position: { x: 100, y: 200, width: 96, height: 96 },
            detection: {
                originalSpatialScore: 0.32,
                processedSpatialScore: 0.03,
                suppressionGain: 0.29,
                adaptiveConfidence: 0.12
            }
        }
    );

    assert.deepEqual(out, { is_google: true, is_original: true });
});

test('resolveOriginalValidation should keep non-Gemini status when watermark signal is weak', () => {
    const out = resolveOriginalValidation(
        { is_google: false, is_original: true },
        {
            size: 96,
            position: { x: 100, y: 200, width: 96, height: 96 },
            detection: {
                originalSpatialScore: 0.08,
                processedSpatialScore: 0.04,
                suppressionGain: 0.04,
                adaptiveConfidence: 0.1
            }
        }
    );

    assert.deepEqual(out, { is_google: false, is_original: true });
});

test('resolveOriginalValidation should not promote when suppression evidence is missing', () => {
    const out = resolveOriginalValidation(
        { is_google: false, is_original: true },
        {
            size: 96,
            position: { x: 100, y: 200, width: 96, height: 96 },
            detection: {
                originalSpatialScore: 0.36,
                processedSpatialScore: 0.33,
                suppressionGain: 0.03
            }
        }
    );

    assert.deepEqual(out, { is_google: false, is_original: true });
});

test('resolveOriginalValidation should not promote when only adaptive confidence is high', () => {
    const out = resolveOriginalValidation(
        { is_google: false, is_original: true },
        {
            size: 96,
            position: { x: 100, y: 200, width: 96, height: 96 },
            detection: {
                adaptiveConfidence: 0.52
            }
        }
    );

    assert.deepEqual(out, { is_google: false, is_original: true });
});

test('resolveOriginalValidation should not promote when removal was explicitly skipped', () => {
    const out = resolveOriginalValidation(
        { is_google: false, is_original: true },
        {
            applied: false,
            detection: {
                originalSpatialScore: 0.82,
                processedSpatialScore: 0.82,
                suppressionGain: 0,
                adaptiveConfidence: 0.61
            }
        }
    );

    assert.deepEqual(out, { is_google: false, is_original: true });
});

test('resolveOriginalValidation should promote validated near-threshold standard removals', () => {
    const out = resolveOriginalValidation(
        { is_google: false, is_original: true },
        {
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
        }
    );

    assert.deepEqual(out, { is_google: true, is_original: true });
});

test('getOriginalStatus should not warn for non-original size when Gemini source is confirmed', () => {
    const message = getOriginalStatus({ is_google: true, is_original: false });
    assert.equal(message, 'original.pass');
});

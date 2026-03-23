import test from 'node:test';
import assert from 'node:assert/strict';

import {
    hasReliableAdaptiveWatermarkSignal,
    hasReliableStandardWatermarkSignal
} from '../../src/core/watermarkPresence.js';

test('hasReliableStandardWatermarkSignal should accept strong Gemini-like standard match', () => {
    assert.equal(
        hasReliableStandardWatermarkSignal({
            spatialScore: 0.88,
            gradientScore: 0.74
        }),
        true
    );
});

test('hasReliableStandardWatermarkSignal should keep borderline spatial matches for restoration validation instead of direct acceptance', () => {
    assert.equal(
        hasReliableStandardWatermarkSignal({
            spatialScore: 0.2677163775605826,
            gradientScore: 0.25454479646469025
        }),
        false
    );
});

test('hasReliableStandardWatermarkSignal should reject weak low-gradient false positive', () => {
    assert.equal(
        hasReliableStandardWatermarkSignal({
            spatialScore: 0.2795279437644118,
            gradientScore: 0.0821895253433136
        }),
        false
    );
});

test('hasReliableAdaptiveWatermarkSignal should accept strong adaptive Gemini match', () => {
    assert.equal(
        hasReliableAdaptiveWatermarkSignal({
            found: true,
            confidence: 0.7845323693117736,
            spatialScore: 0.9965533853965058,
            gradientScore: 0.9541855887117356,
            region: { size: 48, x: 1328, y: 688 }
        }),
        true
    );
});

test('hasReliableAdaptiveWatermarkSignal should reject small low-gradient false positive', () => {
    assert.equal(
        hasReliableAdaptiveWatermarkSignal({
            found: true,
            confidence: 0.5066759179471003,
            spatialScore: 0.6938209781896534,
            gradientScore: 0.07713201509467535,
            region: { size: 38, x: 834, y: 400 }
        }),
        false
    );
});

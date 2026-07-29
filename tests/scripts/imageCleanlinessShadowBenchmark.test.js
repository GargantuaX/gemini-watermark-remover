import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assessShadowBenchmark,
    summarizeShadowBenchmarkSamples
} from '../../scripts/benchmark-image-cleanliness-shadow-metric.js';

test('benchmark summary uses nearest-rank percentiles for decode, feature, and total timings', () => {
    const summary = summarizeShadowBenchmarkSamples([
        { decodeMs: 4, featureMs: 1, totalMs: 5 },
        { decodeMs: 3, featureMs: 2, totalMs: 5 },
        { decodeMs: 2, featureMs: 3, totalMs: 5 },
        { decodeMs: 1, featureMs: 4, totalMs: 5 }
    ]);

    assert.deepEqual(summary, {
        count: 4,
        decodeMs: { mean: 2.5, p50: 2, p95: 4, max: 4 },
        featureMs: { mean: 2.5, p50: 2, p95: 4, max: 4 },
        totalMs: { mean: 5, p50: 5, p95: 5, max: 5 }
    });
});

test('interactive runtime assessment fails closed when feature p95 exceeds its budget', () => {
    assert.deepEqual(
        assessShadowBenchmark(
            {
                count: 120,
                featureMs: { mean: 8, p50: 9, p95: 24, max: 30 }
            },
            { featureP95BudgetMs: 20 }
        ),
        {
            readyForInteractiveRuntime: false,
            featureP95BudgetMs: 20,
            reasons: ['feature-p95-exceeds-budget']
        }
    );
});

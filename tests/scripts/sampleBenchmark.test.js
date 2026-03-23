import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyBenchmarkCase,
    summarizeBenchmarkResults
} from '../../scripts/sample-benchmark.js';

test('classifyBenchmarkCase should mark skipped expected Gemini sample as missed detection', () => {
    const result = classifyBenchmarkCase({
        expectedGemini: true,
        applied: false,
        skipReason: 'no-watermark-detected',
        fileName: '6.png'
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.bucket, 'missed-detection');
});

test('classifyBenchmarkCase should separate weak suppression from residual edge cases', () => {
    const weakSuppression = classifyBenchmarkCase({
        expectedGemini: true,
        applied: true,
        residualScore: 0.31,
        suppressionGain: 0.18,
        decisionTier: 'validated-match',
        fileName: 'weak.png'
    });
    const residualEdge = classifyBenchmarkCase({
        expectedGemini: true,
        applied: true,
        residualScore: 0.31,
        suppressionGain: 0.36,
        decisionTier: 'validated-match',
        fileName: 'edge.png'
    });

    assert.equal(weakSuppression.bucket, 'weak-suppression');
    assert.equal(residualEdge.bucket, 'residual-edge');
});

test('classifyBenchmarkCase should treat changed non-Gemini region as false positive', () => {
    const result = classifyBenchmarkCase({
        expectedGemini: false,
        applied: true,
        changedRatio: 0.08,
        avgAbsoluteDeltaPerChannel: 3.2,
        fileName: 'no-gemini.jpg'
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.bucket, 'false-positive');
});

test('summarizeBenchmarkResults should aggregate pass fail and bucket counts', () => {
    const summary = summarizeBenchmarkResults([
        { classification: { status: 'pass', bucket: 'pass' } },
        { classification: { status: 'fail', bucket: 'missed-detection' } },
        { classification: { status: 'fail', bucket: 'missed-detection' } },
        { classification: { status: 'fail', bucket: 'false-positive' } }
    ]);

    assert.equal(summary.total, 4);
    assert.equal(summary.passCount, 1);
    assert.equal(summary.failCount, 3);
    assert.equal(summary.buckets['missed-detection'], 2);
    assert.equal(summary.buckets['false-positive'], 1);
});

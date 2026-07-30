import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyLabeledExternalBenchmarkCase,
    compareTrustedExternalBenchmarkResults,
    summarizeTrustedExternalBenchmarkResults
} from '../../scripts/external-benchmark-evaluation.js';

test('label-aware classification separates misses, clean skips, false positives, and exclusions', () => {
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'watermarked', applied: false }), {
        status: 'fail', bucket: 'missed-detection', includedInMetrics: true
    });
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'clean', pixelsChanged: false }), {
        status: 'pass', bucket: 'clean-skip', includedInMetrics: true
    });
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'clean', pixelsChanged: true }), {
        status: 'fail', bucket: 'false-positive', includedInMetrics: true
    });
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'ambiguous', pixelsChanged: true }), {
        status: 'excluded', bucket: 'ambiguous', includedInMetrics: false
    });
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'unlabeled', pixelsChanged: false }), {
        status: 'excluded', bucket: 'unlabeled', includedInMetrics: false
    });
});

test('trusted metrics use only watermarked and clean denominators', () => {
    const result = summarizeTrustedExternalBenchmarkResults([
        { label: 'watermarked', applied: true, classification: { status: 'pass', bucket: 'pass', includedInMetrics: true } },
        { label: 'watermarked', applied: false, classification: { status: 'fail', bucket: 'missed-detection', includedInMetrics: true } },
        { label: 'clean', applied: false, classification: { status: 'pass', bucket: 'clean-skip', includedInMetrics: true } },
        { label: 'clean', applied: true, classification: { status: 'fail', bucket: 'false-positive', includedInMetrics: true } },
        { label: 'ambiguous', applied: true, classification: { status: 'excluded', bucket: 'ambiguous', includedInMetrics: false } },
        { label: 'unlabeled', applied: false, classification: { status: 'excluded', bucket: 'unlabeled', includedInMetrics: false } }
    ]);

    assert.deepEqual(result.labels, { watermarked: 2, clean: 2, ambiguous: 1, unlabeled: 1 });
    assert.deepEqual(result.metrics.watermarkDetectionRecall, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.deepEqual(result.metrics.watermarkEndToEndPassRate, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.deepEqual(result.metrics.restorationPassRateAmongApplied, { numerator: 1, denominator: 1, rate: 1 });
    assert.deepEqual(result.metrics.cleanSkipRate, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.deepEqual(result.metrics.falsePositiveRate, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.deepEqual(result.metrics.qualifiedOverallPassRate, { numerator: 2, denominator: 4, rate: 0.5 });
});

test('baseline comparison uses trusted dataset identity and content hashes', () => {
    const dataset = {
        trusted: true,
        datasetId: 'fixture',
        labelManifestSha256: 'labels-hash',
        contentSetSha256: 'contents-hash'
    };
    const baseline = {
        dataset,
        results: [
            { contentSha256: 'a', classification: { status: 'fail', includedInMetrics: true } },
            { contentSha256: 'b', classification: { status: 'pass', includedInMetrics: true } }
        ]
    };
    const comparison = compareTrustedExternalBenchmarkResults({
        dataset,
        baseline,
        results: [
            { fileName: 'a.png', contentSha256: 'a', classification: { status: 'pass', includedInMetrics: true } },
            { fileName: 'b.png', contentSha256: 'b', classification: { status: 'fail', includedInMetrics: true } }
        ]
    });
    assert.deepEqual(comparison, { status: 'comparable', newlyPassing: ['a.png'], newlyFailing: ['b.png'] });
});

test('baseline comparison rejects every dataset identity mismatch and legacy reports', () => {
    const dataset = { trusted: true, datasetId: 'fixture', labelManifestSha256: 'labels', contentSetSha256: 'contents' };
    const baseline = { dataset, results: [] };
    for (const field of ['datasetId', 'labelManifestSha256', 'contentSetSha256']) {
        assert.throws(
            () => compareTrustedExternalBenchmarkResults({
                dataset,
                results: [],
                baseline: { ...baseline, dataset: { ...dataset, [field]: 'different' } }
            }),
            new RegExp(field)
        );
    }
    assert.throws(
        () => compareTrustedExternalBenchmarkResults({ dataset, results: [], baseline: { results: [] } }),
        /requires trusted-labels reports/
    );
});

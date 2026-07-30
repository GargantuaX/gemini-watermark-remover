import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyLabeledExternalBenchmarkCase,
    compareTrustedExternalBenchmarkResults,
    summarizeTrustedExternalBenchmarkResults
} from '../../scripts/external-benchmark-evaluation.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const LABEL_MANIFEST_SHA256 = 'c'.repeat(64);
const TWO_CONTENT_SET_SHA256 = '5e9ae866add9a85d69c3481d059bb9f158a39e5670ba11f95112fc409630894e';

function createTrustedDataset(overrides = {}) {
    return {
        mode: 'trusted-labels',
        trusted: true,
        datasetId: 'fixture',
        labelManifestSha256: LABEL_MANIFEST_SHA256,
        contentSetSha256: TWO_CONTENT_SET_SHA256,
        ...overrides
    };
}

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

test('label-aware classification normalizes a missing label and rejects unknown labels', () => {
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ applied: false }), {
        status: 'excluded', bucket: 'unlabeled', includedInMetrics: false
    });
    assert.throws(
        () => classifyLabeledExternalBenchmarkCase({ label: 'not-a-runtime-label' }),
        /unknown external benchmark label/i
    );
});

test('trusted summary force-excludes a missing label with an inconsistent included classification', () => {
    const result = summarizeTrustedExternalBenchmarkResults([{
        group: 'task-source',
        source: 'pipeline',
        classification: { status: 'pass', bucket: 'pass', includedInMetrics: true }
    }]);

    assert.equal(result.labels.unlabeled, 1);
    assert.equal(result.summary.excludedCount, 1);
    assert.equal(result.summary.passCount, 0);
    assert.equal(result.summary.failCount, 0);
    assert.equal(result.summary.byGroup['task-source'].qualifiedTotal, 0);
    assert.equal(result.summary.byGroup['task-source'].rate, null);
    assert.equal(result.summary.sourceOnly.qualifiedTotal, 0);
    assert.equal(result.summary.sourceOnly.successRate, null);
    assert.equal(result.reviewQueue.unlabeled.length, 1);
    assert.equal(result.reviewQueue.unlabeled[0].label, 'unlabeled');
    assert.deepEqual(result.reviewQueue.unlabeled[0].classification, {
        status: 'excluded', bucket: 'unlabeled', includedInMetrics: false
    });
});

test('trusted summary force-excludes ambiguous and unlabeled records with inconsistent classifications', () => {
    const result = summarizeTrustedExternalBenchmarkResults([
        { label: 'ambiguous', classification: { status: 'pass', bucket: 'pass', includedInMetrics: true } },
        { label: 'unlabeled', classification: { status: 'fail', bucket: 'missed-detection', includedInMetrics: true } }
    ]);

    assert.equal(result.summary.excludedCount, 2);
    assert.equal(result.summary.passCount, 0);
    assert.equal(result.summary.failCount, 0);
    assert.deepEqual(result.reviewQueue.ambiguous[0].classification, {
        status: 'excluded', bucket: 'ambiguous', includedInMetrics: false
    });
    assert.deepEqual(result.reviewQueue.unlabeled[0].classification, {
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

test('diagnostic rates exclude ambiguous records while anchor summaries include only qualified watermarked records', () => {
    const result = summarizeTrustedExternalBenchmarkResults([
        {
            label: 'watermarked',
            group: 'task-source',
            decisionTier: 'direct-match',
            source: 'pipeline',
            actualAnchor: { logoSize: 96, marginRight: 64, marginBottom: 64 },
            classification: { status: 'pass', bucket: 'pass', includedInMetrics: true }
        },
        {
            label: 'ambiguous',
            group: 'task-source',
            decisionTier: 'direct-match',
            source: 'pipeline',
            actualAnchor: { logoSize: 96, marginRight: 64, marginBottom: 64 },
            classification: { status: 'excluded', bucket: 'ambiguous', includedInMetrics: false }
        },
        {
            label: 'unlabeled',
            group: 'other',
            decisionTier: 'insufficient',
            source: 'fallback',
            actualAnchor: null,
            classification: { status: 'excluded', bucket: 'unlabeled', includedInMetrics: false }
        }
    ]);

    for (const bucket of [
        result.summary.byGroup['task-source'],
        result.summary.byDecisionTier['direct-match'],
        result.summary.bySource.pipeline
    ]) {
        assert.equal(bucket.total, 2);
        assert.equal(bucket.pass, 1);
        assert.equal(bucket.fail, 0);
        assert.equal(bucket.excludedCount, 1);
        assert.equal(bucket.qualifiedTotal, 1);
        assert.equal(bucket.rate, 1);
    }
    assert.deepEqual(result.summary.byAnchor['96/64/64'], {
        total: 1,
        pass: 1,
        fail: 0,
        excludedCount: 0,
        qualifiedTotal: 1,
        rate: 1,
        buckets: { pass: 1 }
    });
    assert.deepEqual(result.summary.sourceOnly, {
        total: 2,
        passCount: 1,
        failCount: 0,
        excludedCount: 1,
        qualifiedTotal: 1,
        successRate: 1,
        buckets: { pass: 1, ambiguous: 1 }
    });
});

test('clean and excluded records do not create anchor evidence', () => {
    const result = summarizeTrustedExternalBenchmarkResults([
        {
            label: 'clean',
            actualAnchor: { logoSize: 96, marginRight: 192, marginBottom: 192, alphaVariant: '20260520' },
            classification: { status: 'pass', bucket: 'clean-skip', includedInMetrics: true }
        },
        {
            label: 'ambiguous',
            actualAnchor: { logoSize: 96, marginRight: 192, marginBottom: 192, alphaVariant: '20260520' },
            classification: { status: 'excluded', bucket: 'ambiguous', includedInMetrics: false }
        }
    ]);

    assert.deepEqual(result.summary.byAnchor, {});
});

test('baseline comparison uses trusted dataset identity and content hashes', () => {
    const dataset = createTrustedDataset();
    const baseline = {
        dataset,
        results: [
            { contentSha256: SHA_A, classification: { status: 'fail', includedInMetrics: true } },
            { contentSha256: SHA_B, classification: { status: 'pass', includedInMetrics: true } }
        ]
    };
    const comparison = compareTrustedExternalBenchmarkResults({
        dataset,
        baseline,
        results: [
            { fileName: 'a.png', contentSha256: SHA_A, classification: { status: 'pass', includedInMetrics: true } },
            { fileName: 'b.png', contentSha256: SHA_B, classification: { status: 'fail', includedInMetrics: true } }
        ]
    });
    assert.deepEqual(comparison, { status: 'comparable', newlyPassing: ['a.png'], newlyFailing: ['b.png'] });
});

test('baseline comparison rejects every dataset identity mismatch and legacy reports', () => {
    const dataset = createTrustedDataset();
    const baseline = {
        dataset,
        results: [
            { contentSha256: SHA_A, classification: { status: 'pass', includedInMetrics: true } },
            { contentSha256: SHA_B, classification: { status: 'pass', includedInMetrics: true } }
        ]
    };
    const results = [
        { fileName: 'a.png', contentSha256: SHA_A, classification: { status: 'pass', includedInMetrics: true } },
        { fileName: 'b.png', contentSha256: SHA_B, classification: { status: 'pass', includedInMetrics: true } }
    ];
    for (const field of ['datasetId', 'labelManifestSha256', 'contentSetSha256']) {
        assert.throws(
            () => compareTrustedExternalBenchmarkResults({
                dataset,
                results,
                baseline: { ...baseline, dataset: { ...dataset, [field]: 'different' } }
            }),
            new RegExp(field)
        );
    }
    assert.throws(
        () => compareTrustedExternalBenchmarkResults({ dataset, results, baseline: { results: baseline.results } }),
        /requires trusted-labels reports/
    );
});

test('baseline comparison rejects empty, missing, duplicate, and incomplete result identities', () => {
    const dataset = createTrustedDataset();
    const complete = [
        { fileName: 'a.png', contentSha256: SHA_A, classification: { status: 'pass', includedInMetrics: true } },
        { fileName: 'b.png', contentSha256: SHA_B, classification: { status: 'pass', includedInMetrics: true } }
    ];

    assert.throws(
        () => compareTrustedExternalBenchmarkResults({ dataset, results: complete, baseline: { dataset, results: [] } }),
        /baseline results must be a non-empty array/
    );
    assert.throws(
        () => compareTrustedExternalBenchmarkResults({
            dataset,
            results: complete,
            baseline: { dataset, results: [{ ...complete[0], contentSha256: null }, complete[1]] }
        }),
        /baseline result contentSha256/
    );
    assert.throws(
        () => compareTrustedExternalBenchmarkResults({
            dataset,
            results: complete,
            baseline: { dataset, results: [complete[0], { ...complete[1], contentSha256: SHA_A }] }
        }),
        /duplicate contentSha256/
    );
    assert.throws(
        () => compareTrustedExternalBenchmarkResults({
            dataset,
            results: complete,
            baseline: { dataset, results: [complete[0]] }
        }),
        /content SHA set mismatch/
    );
});

test('baseline comparison rejects missing trusted identity and forged content-set identity', () => {
    const dataset = createTrustedDataset();
    const results = [
        { fileName: 'a.png', contentSha256: SHA_A, classification: { status: 'pass', includedInMetrics: true } },
        { fileName: 'b.png', contentSha256: SHA_B, classification: { status: 'pass', includedInMetrics: true } }
    ];
    const baseline = { dataset, results };

    for (const field of ['datasetId', 'labelManifestSha256', 'contentSetSha256']) {
        assert.throws(
            () => compareTrustedExternalBenchmarkResults({
                dataset: createTrustedDataset({ [field]: '' }),
                results,
                baseline
            }),
            new RegExp(field)
        );
    }
    assert.throws(
        () => compareTrustedExternalBenchmarkResults({
            dataset: createTrustedDataset({ contentSetSha256: 'd'.repeat(64) }),
            results,
            baseline: {
                dataset: createTrustedDataset({ contentSetSha256: 'd'.repeat(64) }),
                results
            }
        }),
        /contentSetSha256 does not match results/
    );
});

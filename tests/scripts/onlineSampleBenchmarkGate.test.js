import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { evaluateOnlineSampleBenchmarkGate } from '../../scripts/gate-online-gemini-watermark-sample-benchmark.js';

const args = {
    expectedTotal: 2,
    expectedPaths: 2,
    minSuccessRate: 0.5,
    maxNewlyFailing: 0,
    minNewlyPassing: 0,
    requiredAnchors: []
};

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const CONTENT_SET_SHA256 = '5e9ae866add9a85d69c3481d059bb9f158a39e5670ba11f95112fc409630894e';
const REQUIRED_ANCHOR = '96/192/192/20260520';

const trustedReport = {
    dataset: {
        mode: 'trusted-labels',
        trusted: true,
        datasetId: 'fixture',
        labelManifestSha256: 'c'.repeat(64),
        contentSetSha256: CONTENT_SET_SHA256,
        pathCount: 2,
        uniqueContentCount: 2,
        duplicatePathCount: 0
    },
    labels: { watermarked: 1, clean: 1, ambiguous: 0, unlabeled: 0 },
    metrics: { qualifiedOverallPassRate: { numerator: 1, denominator: 2, rate: 0.5 } },
    summary: {
        passCount: 1,
        failCount: 1,
        excludedCount: 0,
        byAnchor: {
            [REQUIRED_ANCHOR]: {
                total: 1,
                pass: 1,
                fail: 0,
                excludedCount: 0,
                qualifiedTotal: 1,
                rate: 1,
                buckets: { pass: 1 }
            }
        }
    },
    comparison: { status: 'comparable' },
    newlyPassing: [],
    newlyFailing: [],
    results: [
        {
            fileName: 'watermarked.png',
            paths: ['watermarked.png'],
            contentSha256: SHA_A,
            label: 'watermarked',
            actualAnchor: { logoSize: 96, marginRight: 192, marginBottom: 192, alphaVariant: '20260520' },
            classification: { status: 'pass', bucket: 'pass', includedInMetrics: true }
        },
        {
            fileName: 'clean.png',
            paths: ['clean.png'],
            contentSha256: SHA_B,
            label: 'clean',
            actualAnchor: null,
            classification: { status: 'fail', bucket: 'false-positive', includedInMetrics: true }
        }
    ]
};

test('gate accepts a trusted complete report', () => {
    assert.equal(evaluateOnlineSampleBenchmarkGate(trustedReport, args).ok, true);
});

test('gate rejects assumed labels, unlabeled content, and dataset count mismatches', () => {
    assert.equal(evaluateOnlineSampleBenchmarkGate({
        ...trustedReport,
        dataset: { ...trustedReport.dataset, trusted: false }
    }, args).ok, false);
    assert.equal(evaluateOnlineSampleBenchmarkGate({
        ...trustedReport,
        labels: { ...trustedReport.labels, unlabeled: 1 }
    }, args).ok, false);
    assert.equal(evaluateOnlineSampleBenchmarkGate({
        ...trustedReport,
        dataset: { ...trustedReport.dataset, uniqueContentCount: 104 }
    }, args).ok, false);
});

test('gate rejects missing dataset identity and report shells without labels or results', () => {
    for (const field of ['datasetId', 'labelManifestSha256', 'contentSetSha256']) {
        const result = evaluateOnlineSampleBenchmarkGate({
            ...trustedReport,
            dataset: { ...trustedReport.dataset, [field]: '' }
        }, args);
        assert.equal(result.ok, false, field);
        assert.match(result.failures.join('\n'), new RegExp(field));
    }
    for (const field of ['labels', 'results']) {
        const result = evaluateOnlineSampleBenchmarkGate({ ...trustedReport, [field]: undefined }, args);
        assert.equal(result.ok, false, field);
        assert.match(result.failures.join('\n'), new RegExp(field));
    }
});

test('gate independently rejects label, summary, and unique-content count mismatches', () => {
    const badLabels = evaluateOnlineSampleBenchmarkGate({
        ...trustedReport,
        labels: { ...trustedReport.labels, clean: 2 }
    }, args);
    assert.equal(badLabels.ok, false);
    assert.match(badLabels.failures.join('\n'), /label count clean/i);

    const badSummary = evaluateOnlineSampleBenchmarkGate({
        ...trustedReport,
        summary: { ...trustedReport.summary, passCount: 2, failCount: 0 }
    }, args);
    assert.equal(badSummary.ok, false);
    assert.match(badSummary.failures.join('\n'), /summary passCount|summary failCount/i);

    const duplicateSha = evaluateOnlineSampleBenchmarkGate({
        ...trustedReport,
        results: [trustedReport.results[0], {
            ...trustedReport.results[1],
            contentSha256: SHA_A
        }]
    }, args);
    assert.equal(duplicateSha.ok, false);
    assert.match(duplicateSha.failures.join('\n'), /duplicate contentSha256|unique content/i);
});

test('gate rejects a forged qualified pass rate even when it exceeds the threshold', () => {
    const result = evaluateOnlineSampleBenchmarkGate({
        ...trustedReport,
        metrics: { qualifiedOverallPassRate: { numerator: 2, denominator: 2, rate: 1 } }
    }, args);

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /qualifiedOverallPassRate/i);
});

test('clean and excluded records cannot satisfy a required-anchor gate', () => {
    for (const pollutingLabel of ['clean', 'ambiguous']) {
        const pollutingClassification = pollutingLabel === 'clean'
            ? { status: 'pass', bucket: 'clean-skip', includedInMetrics: true }
            : { status: 'excluded', bucket: 'ambiguous', includedInMetrics: false };
        const report = {
            ...trustedReport,
            labels: {
                watermarked: 1,
                clean: pollutingLabel === 'clean' ? 1 : 0,
                ambiguous: pollutingLabel === 'ambiguous' ? 1 : 0,
                unlabeled: 0
            },
            metrics: {
                qualifiedOverallPassRate: {
                    numerator: pollutingLabel === 'clean' ? 2 : 1,
                    denominator: pollutingLabel === 'clean' ? 2 : 1,
                    rate: 1
                }
            },
            summary: {
                ...trustedReport.summary,
                passCount: pollutingLabel === 'clean' ? 2 : 1,
                failCount: 0,
                excludedCount: pollutingLabel === 'ambiguous' ? 1 : 0
            },
            results: [
                {
                    ...trustedReport.results[0],
                    actualAnchor: null
                },
                {
                    ...trustedReport.results[1],
                    label: pollutingLabel,
                    actualAnchor: {
                        logoSize: 96,
                        marginRight: 192,
                        marginBottom: 192,
                        alphaVariant: '20260520'
                    },
                    classification: pollutingClassification
                }
            ]
        };
        const result = evaluateOnlineSampleBenchmarkGate(report, {
            ...args,
            minSuccessRate: 0,
            requiredAnchors: [[REQUIRED_ANCHOR, 1]]
        });
        assert.equal(result.ok, false, pollutingLabel);
        assert.match(result.failures.join('\n'), new RegExp(`required anchor ${REQUIRED_ANCHOR} is missing`));
    }
});

test('newly-passing thresholds require a comparable baseline', () => {
    const result = evaluateOnlineSampleBenchmarkGate(
        { ...trustedReport, comparison: { status: 'not-requested' } },
        { ...args, minNewlyPassing: 1 }
    );
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('comparable trusted baseline is required'));
});

test('gate CLI exits non-zero for assumed-watermarked reports', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gwr-gate-cli-'));
    const reportPath = path.join(dir, 'report.json');
    await writeFile(reportPath, JSON.stringify({
        ...trustedReport,
        dataset: { ...trustedReport.dataset, mode: 'assumed-watermarked', trusted: false }
    }));
    const result = spawnSync(process.execPath, [
        'scripts/gate-online-gemini-watermark-sample-benchmark.js',
        '--report', reportPath,
        '--expected-total', '2',
        '--expected-paths', '2',
        '--min-success-rate', '0',
        '--max-newly-failing', '105',
        '--min-newly-passing', '0',
        '--no-default-anchors'
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /report must use trusted-labels/);
});

test('gate CLI rejects unknown arguments and every missing option value during parsing', () => {
    const unknown = spawnSync(process.execPath, [
        'scripts/gate-online-gemini-watermark-sample-benchmark.js',
        '--unknown-option'
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown argument: --unknown-option/);

    for (const option of [
        '--report',
        '--expected-total',
        '--expected-paths',
        '--min-success-rate',
        '--max-newly-failing',
        '--min-newly-passing',
        '--require-anchor-pass'
    ]) {
        const missing = spawnSync(process.execPath, [
            'scripts/gate-online-gemini-watermark-sample-benchmark.js',
            option
        ], { cwd: path.resolve('.'), encoding: 'utf8' });
        assert.notEqual(missing.status, 0, option);
        assert.match(missing.stderr, new RegExp(`${option} requires a value`), option);
    }
});

test('gate CLI accepts the leading argument separator used by the pnpm script', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gwr-gate-separator-'));
    const reportPath = path.join(dir, 'report.json');
    await writeFile(reportPath, JSON.stringify(trustedReport));
    const result = spawnSync(process.execPath, [
        'scripts/gate-online-gemini-watermark-sample-benchmark.js',
        '--',
        '--report', reportPath,
        '--expected-total', '2',
        '--expected-paths', '2',
        '--min-success-rate', '0',
        '--max-newly-failing', '2',
        '--min-newly-passing', '0',
        '--no-default-anchors'
    ], { cwd: path.resolve('.'), encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
});

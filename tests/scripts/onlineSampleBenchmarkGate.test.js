import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { evaluateOnlineSampleBenchmarkGate } from '../../scripts/gate-online-gemini-watermark-sample-benchmark.js';

const args = {
    expectedTotal: 105,
    expectedPaths: 119,
    minSuccessRate: 0.8,
    maxNewlyFailing: 0,
    minNewlyPassing: 0,
    requiredAnchors: []
};

const trustedReport = {
    dataset: { mode: 'trusted-labels', trusted: true, pathCount: 119, uniqueContentCount: 105 },
    labels: { watermarked: 40, clean: 65, ambiguous: 0, unlabeled: 0 },
    metrics: { qualifiedOverallPassRate: { numerator: 90, denominator: 105, rate: 0.8571 } },
    summary: { passCount: 90, failCount: 15, byAnchor: {} },
    comparison: { status: 'comparable' },
    newlyPassing: [],
    newlyFailing: []
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
        '--expected-total', '105',
        '--expected-paths', '119',
        '--min-success-rate', '0',
        '--max-newly-failing', '105',
        '--min-newly-passing', '0',
        '--no-default-anchors'
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /report must use trusted-labels/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import {
    imageDataPixelsChanged,
    parseExternalBenchmarkArgs,
    renderExternalBenchmarkMarkdown,
    renderExternalBenchmarkResultsCsv
} from '../../scripts/run-external-gemini-watermark-sample-benchmark.js';

test('runner requires exactly one label source', () => {
    assert.throws(() => parseExternalBenchmarkArgs([]), /exactly one of --labels or --assume-watermarked/);
    assert.throws(
        () => parseExternalBenchmarkArgs(['--labels', 'labels.json', '--assume-watermarked']),
        /exactly one of --labels or --assume-watermarked/
    );
    assert.equal(parseExternalBenchmarkArgs(['--labels', 'labels.json']).assumeWatermarked, false);
    assert.equal(parseExternalBenchmarkArgs(['--assume-watermarked']).assumeWatermarked, true);
});

test('pixel comparison detects real byte changes rather than trusting metadata', () => {
    const original = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) };
    const identical = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) };
    const changed = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 4, 255]) };
    assert.equal(imageDataPixelsChanged(original, identical), false);
    assert.equal(imageDataPixelsChanged(original, changed), true);
});

test('Markdown and CSV expose labels, inclusion, hashes, and classifications', () => {
    const report = {
        generatedAt: '2026-07-30T00:00:00.000Z',
        sampleRoot: 'sample-root',
        dataset: { trusted: true, datasetId: 'fixture', pathCount: 2, uniqueContentCount: 1, duplicatePathCount: 1 },
        labels: { watermarked: 0, clean: 1, ambiguous: 0, unlabeled: 0 },
        metrics: { qualifiedOverallPassRate: { numerator: 1, denominator: 1, rate: 1 } },
        summary: {
            passCount: 1,
            failCount: 0,
            excludedCount: 0,
            buckets: { 'clean-skip': 1 },
            contourResidualShadow: { flaggedCount: 0, measuredCount: 0, unavailableCount: 1, fallbackGeometryCount: 0 },
            interiorResidualShadow: { flaggedCount: 0, measuredCount: 0, unavailableCount: 1, fallbackGeometryCount: 0 }
        },
        comparison: { status: 'not-requested' },
        newlyPassing: [],
        newlyFailing: [],
        failures: [{
            fileName: 'failed.png',
            paths: ['failed.png'],
            contentSha256: 'def',
            label: 'watermarked',
            applied: false,
            source: '',
            actualAnchor: null,
            classification: { status: 'fail', bucket: 'missed-detection', includedInMetrics: true }
        }],
        results: [{
            fileName: 'a.png',
            paths: ['a.png', 'b.png'],
            contentSha256: 'abc',
            label: 'clean',
            classification: { status: 'pass', bucket: 'clean-skip', includedInMetrics: true }
        }]
    };
    const markdown = renderExternalBenchmarkMarkdown(report);
    assert.match(markdown, /qualifiedOverallPassRate/);
    assert.match(markdown, /failed\.png \| missed-detection/);
    const csv = renderExternalBenchmarkResultsCsv(report.results);
    assert.match(csv, /contentSha256,label,includedInMetrics,status,bucket/);
    assert.match(csv, /abc,clean,true,pass,clean-skip/);
});

test('CLI fails before writing output when label mode is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gwr-runner-cli-'));
    const output = path.join(dir, 'report.json');
    const result = spawnSync(process.execPath, [
        'scripts/run-external-gemini-watermark-sample-benchmark.js',
        '--sample-root', dir,
        '--output', output
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one of --labels or --assume-watermarked/);
    assert.equal(existsSync(output), false);
});

test('CLI marks assumed-watermarked output as diagnostic-only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gwr-runner-assumed-'));
    await sharp({
        create: {
            width: 1,
            height: 1,
            channels: 4,
            background: '#ffffff'
        }
    }).png().toFile(path.join(dir, 'one.png'));
    const output = path.join(dir, 'report.json');
    const result = spawnSync(process.execPath, [
        'scripts/run-external-gemini-watermark-sample-benchmark.js',
        '--sample-root', dir,
        '--assume-watermarked',
        '--output', output,
        '--markdown', path.join(dir, 'report.md'),
        '--results-csv', path.join(dir, 'results.csv'),
        '--failures-csv', path.join(dir, 'failures.csv')
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).dataset.trusted, false);
});

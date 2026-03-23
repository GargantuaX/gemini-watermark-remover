import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    computeDurationStats,
    parseUserscriptBenchmarkCliArgs,
    summarizeUserscriptBenchmarkResults
} from '../../scripts/userscript-benchmark.js';

test('computeDurationStats should calculate summary stats from unsorted durations', () => {
    const stats = computeDurationStats([18, 10, 14, 40]);

    assert.equal(stats.count, 4);
    assert.equal(stats.min, 10);
    assert.equal(stats.max, 40);
    assert.equal(stats.mean, 20.5);
    assert.equal(stats.p50, 16);
    assert.equal(stats.p95, 40);
});

test('summarizeUserscriptBenchmarkResults should aggregate totals by scenario and sample', () => {
    const summary = summarizeUserscriptBenchmarkResults([
        {
            scenario: 'main-thread',
            sampleName: '4.png',
            metrics: {
                initMs: 12,
                downloadHookMs: 90,
                pageReplacementMs: 120
            }
        },
        {
            scenario: 'main-thread',
            sampleName: '4.png',
            metrics: {
                initMs: 14,
                downloadHookMs: 110,
                pageReplacementMs: 100
            }
        },
        {
            scenario: 'inline-worker',
            sampleName: 'large2.png',
            metrics: {
                initMs: 20,
                downloadHookMs: 70,
                pageReplacementMs: 80
            }
        }
    ]);

    assert.equal(summary.totalRuns, 3);
    assert.deepEqual(summary.scenarios.sort(), ['inline-worker', 'main-thread']);
    assert.deepEqual(summary.samples.sort(), ['4.png', 'large2.png']);
    assert.equal(summary.byScenario['main-thread'].runCount, 2);
    assert.equal(summary.byScenario['main-thread'].metrics.downloadHookMs.mean, 100);
    assert.equal(summary.bySample['4.png'].metrics.pageReplacementMs.p50, 110);
    assert.equal(summary.byScenarioSample['inline-worker::large2.png'].metrics.initMs.max, 20);
});

test('parseUserscriptBenchmarkCliArgs should expand both scenarios and split sample list', () => {
    const parsed = parseUserscriptBenchmarkCliArgs([
        '--scenario',
        'both',
        '--samples',
        '4.png,large2.png',
        '--iterations',
        '5',
        '--warmup',
        '2',
        '--output',
        '.artifacts/userscript-benchmark/custom.json'
    ]);

    assert.deepEqual(parsed.scenarios, ['main-thread', 'inline-worker']);
    assert.deepEqual(parsed.sampleNames, ['4.png', 'large2.png']);
    assert.equal(parsed.iterations, 5);
    assert.equal(parsed.warmupIterations, 2);
    assert.match(parsed.outputPath, /custom\.json$/);
});

test('package.json should expose userscript benchmark command', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['benchmark:userscript'], 'node scripts/userscript-benchmark.js');
});

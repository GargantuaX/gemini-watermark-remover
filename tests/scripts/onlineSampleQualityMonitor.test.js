import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
    classifyRecord,
    summarizeRecord
} from '../../scripts/create-online-sample-quality-monitor.js';
import {
    attachTopNSelectionMeta,
    createWatermarkMeta
} from '../../src/core/pipelineMeta.js';

const execFileAsync = promisify(execFile);

test('quality monitor should use final alpha artifacts and residual instead of stale selection metrics', () => {
    const record = {
        fileName: '20260607-2.png',
        applied: true,
        classification: {
            status: 'pass',
            bucket: 'pass'
        },
        source: 'standard+catalog+profile-alpha-rescue',
        decisionTier: 'validated-match',
        actualAnchor: {
            logoSize: 48,
            marginRight: 96,
            marginBottom: 96
        },
        residualScore: 0,
        processedGradientScore: 0,
        suppressionGain: 0.628960825889181,
        residualVisibility: {
            visible: false,
            positiveHaloLum: 2.738
        },
        decisionPath: {
            riskFlags: [],
            alphaTrial: {
                damage: {
                    safe: true,
                    penalty: 0.1,
                    newlyClippedRatio: 0
                },
                artifacts: {
                    newlyClippedRatio: 0.019965277777777776,
                    visualArtifactCost: 0.117
                },
                residual: {
                    cleared: false,
                    spatialResidual: 0.08269753279573036,
                    gradientResidual: 0.0663245530919801
                }
            }
        }
    };

    const metrics = summarizeRecord(record);
    const classified = classifyRecord(record);

    assert.equal(metrics.residual, 0.08269753279573036);
    assert.equal(metrics.gradient, 0.0663245530919801);
    assert.equal(metrics.newlyClippedRatio, 0.019965277777777776);
    assert.equal(metrics.damageMetricAvailable, true);
    assert.ok(classified.strictFlags.includes('newly-clipped'));
    assert.ok(classified.cleanFlags.includes('newly-clipped'));
});

test('quality monitor should flag final clipping on an otherwise ordinary phase1 path', () => {
    const meta = attachTopNSelectionMeta(createWatermarkMeta({
        decisionPath: {
            decision: 'accept',
            riskFlags: [],
            alphaTrial: {
                migrationStage: 'phase1-adapter',
                scores: { suppressionGain: 0.48 },
                damage: { safe: true, penalty: 0, newlyClippedRatio: 0 },
                residual: { cleared: true, spatial: 0.01, gradient: 0.02 }
            }
        }
    }), {
        qualitySignals: {
            final: { spatialScore: 0.03, gradientScore: 0.04 },
            artifacts: {
                newlyClippedRatio: 0.017361111111111112,
                visualArtifactCost: 0.1
            },
            nearBlackIncrease: 0.01,
            texture: { hardReject: false, texturePenalty: 0 }
        }
    });
    const record = {
        fileName: '20260617.png',
        applied: true,
        classification: { status: 'pass', bucket: 'pass' },
        decisionPath: meta.decisionPath
    };

    const metrics = summarizeRecord(record);
    const classified = classifyRecord(record);

    assert.equal(metrics.newlyClippedRatio, 0.017361111111111112);
    assert.ok(classified.strictFlags.includes('newly-clipped'));
    assert.ok(classified.cleanFlags.includes('newly-clipped'));
});

test('quality monitor CLI should fail when applied coverage is lost', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-quality-coverage-'));
    const baselinePath = path.join(tempDir, 'baseline.json');
    const currentPath = path.join(tempDir, 'current.json');
    const outputDir = path.join(tempDir, 'monitor');
    const createRecord = (fileName, applied) => ({
        fileName,
        applied,
        classification: {
            status: applied ? 'pass' : 'fail',
            bucket: applied ? 'pass' : 'missed-detection'
        },
        decisionTier: applied ? 'validated-match' : 'insufficient'
    });
    await writeFile(
        baselinePath,
        JSON.stringify({
            results: [
                createRecord('lost.png', true),
                createRecord('gained.png', false)
            ]
        }),
        'utf8'
    );
    await writeFile(
        currentPath,
        JSON.stringify({
            results: [
                createRecord('lost.png', false),
                createRecord('gained.png', true)
            ]
        }),
        'utf8'
    );

    await assert.rejects(
        execFileAsync(process.execPath, [
            'scripts/create-online-sample-quality-monitor.js',
            '--report',
            currentPath,
            '--baseline',
            baselinePath,
            '--out-dir',
            outputDir,
            '--fail-on-applied-loss',
            '--max-applied-loss',
            '0'
        ], {
            cwd: path.resolve('.')
        }),
        (error) => {
            const output = JSON.parse(error.stdout);
            assert.ok(output.failures.includes('applied loss 1 > 0'));
            return true;
        }
    );

    const report = JSON.parse(
        await readFile(path.join(outputDir, 'latest.json'), 'utf8')
    );
    assert.equal(report.comparison.counts.appliedLost, 1);
    assert.equal(report.comparison.counts.appliedGained, 1);
    assert.equal(report.comparison.deltas.applied, 0);
});

test('quality monitor CLI should count a missing applied baseline file as coverage loss', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-quality-missing-coverage-'));
    const baselinePath = path.join(tempDir, 'baseline.json');
    const currentPath = path.join(tempDir, 'current.json');
    const outputDir = path.join(tempDir, 'monitor');
    const createRecord = (fileName) => ({
        fileName,
        applied: true,
        classification: { status: 'pass', bucket: 'pass' },
        decisionTier: 'validated-match'
    });
    await writeFile(
        baselinePath,
        JSON.stringify({ results: [createRecord('kept.png'), createRecord('missing.png')] }),
        'utf8'
    );
    await writeFile(
        currentPath,
        JSON.stringify({ results: [createRecord('kept.png')] }),
        'utf8'
    );

    await assert.rejects(
        execFileAsync(process.execPath, [
            'scripts/create-online-sample-quality-monitor.js',
            '--report',
            currentPath,
            '--baseline',
            baselinePath,
            '--out-dir',
            outputDir,
            '--fail-on-applied-loss',
            '--max-applied-loss',
            '0'
        ], {
            cwd: path.resolve('.')
        }),
        (error) => {
            const output = JSON.parse(error.stdout);
            assert.ok(output.failures.includes('applied loss 1 > 0'));
            return true;
        }
    );

    const report = JSON.parse(
        await readFile(path.join(outputDir, 'latest.json'), 'utf8')
    );
    assert.equal(report.comparison.counts.appliedLost, 1);
    assert.equal(report.comparison.alignment.baselineOnlyCount, 1);
    assert.deepEqual(report.comparison.alignment.baselineOnlyExamples, ['missing.png']);
});

test('quality monitor CLI should reject a baseline without benchmark results', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-quality-invalid-baseline-'));
    const baselinePath = path.join(tempDir, 'baseline-monitor.json');
    const currentPath = path.join(tempDir, 'current.json');
    const outputDir = path.join(tempDir, 'monitor');
    await writeFile(
        baselinePath,
        JSON.stringify({ records: [] }),
        'utf8'
    );
    await writeFile(
        currentPath,
        JSON.stringify({ results: [] }),
        'utf8'
    );

    await assert.rejects(
        execFileAsync(process.execPath, [
            'scripts/create-online-sample-quality-monitor.js',
            '--report',
            currentPath,
            '--baseline',
            baselinePath,
            '--out-dir',
            outputDir,
            '--fail-on-applied-loss'
        ], {
            cwd: path.resolve('.')
        }),
        (error) => {
            assert.match(error.stderr, /must contain a results array/);
            return true;
        }
    );
});

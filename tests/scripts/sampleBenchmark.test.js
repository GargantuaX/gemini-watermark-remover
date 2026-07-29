import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import {
    buildCandidateRankingReport,
    buildSelectedCandidateDiagnostic,
    classifyFineAlphaSelectionReason,
    classifyBenchmarkCase,
    decodeImageDataInNode,
    listBenchmarkSampleAssets,
    loadSampleGoldManifest,
    runSampleBenchmark,
    summarizeCandidateRankingReport,
    summarizeBenchmarkResults
} from '../../scripts/sample-benchmark.js';
import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { interpolateAlphaMap } from '../../src/core/adaptiveDetector.js';
import {
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from '../../src/core/watermarkConfig.js';
import { processWatermarkImageData } from '../../src/core/watermarkProcessor.js';
import {
    classifyExternalBenchmarkCase,
    resolveExternalBenchmarkAlphaMaps
} from '../../scripts/run-external-gemini-watermark-sample-benchmark.js';
import { createPatternImageData } from '../core/syntheticWatermarkTestUtils.js';

test('external benchmark should load the same embedded 96px variants as the SDK', () => {
    const alphaMaps = resolveExternalBenchmarkAlphaMaps();

    assert.deepEqual(Object.keys(alphaMaps.alpha96Variants).sort(), [
        '20260520',
        'outline-dark',
        'outline-light'
    ]);
    assert.ok(alphaMaps.alpha96Variants['outline-light'] instanceof Float32Array);
    assert.ok(alphaMaps.alpha96Variants['outline-dark'] instanceof Float32Array);
});

test('runSampleBenchmark should include embedded outline alpha variants', async () => {
    const sampleDir = await mkdtemp(path.join(tmpdir(), 'gwr-outline-benchmark-'));
    const fixtureName = 'issue101-outline-dark-landscape.png';
    const imageData = createPatternImageData(2816, 1536);
    const crop = await decodeImageDataInNode(path.resolve('tests/fixtures', fixtureName));
    const cropLeft = 2480;
    const cropTop = 1152;
    for (let y = 0; y < crop.height; y++) {
        for (let x = 0; x < crop.width; x++) {
            const sourceIndex = (y * crop.width + x) * 4;
            const targetIndex = ((cropTop + y) * imageData.width + cropLeft + x) * 4;
            imageData.data.set(crop.data.subarray(sourceIndex, sourceIndex + 4), targetIndex);
        }
    }
    const admittedFixturePath = path.join(sampleDir, fixtureName);
    await sharp(Buffer.from(imageData.data.buffer), {
        raw: { width: imageData.width, height: imageData.height, channels: 4 }
    }).png().toFile(admittedFixturePath);
    const admittedFixtureSha256 = createHash('sha256')
        .update(await readFile(admittedFixturePath))
        .digest('hex');
    await writeFile(path.join(sampleDir, 'gold-manifest.json'), JSON.stringify({
        version: 1,
        samples: {
            [fixtureName]: {
                shouldProcess: true,
                tags: ['issue-regression'],
                admission: {
                    status: 'confirmed-regression-input',
                    source: 'github-issue',
                    issue: 101,
                    originalFileName: fixtureName,
                    sha256: admittedFixtureSha256,
                    confirmedAt: '2026-07-30'
                },
                knownIssue: {
                    issue: 101,
                    qualityStatus: 'visible-residual',
                    bucket: 'residual-edge'
                }
            }
        }
    }));

    const report = await runSampleBenchmark({
        sampleDir,
        outputPath: path.join(sampleDir, 'report.json')
    });

    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].admission?.issue, 101);
    assert.equal(report.results[0].knownIssue?.issue, 101);
    assert.equal(report.results[0].actualAnchor?.alphaVariant, 'outline-dark');
    assert.match(report.results[0].source, /outline-dark/);
    assert.equal(
        Object.hasOwn(report.results[0], 'finalDamageWarning'),
        true,
        'report should expose the final post-restoration damage verdict'
    );
    assert.equal(
        Object.hasOwn(report.results[0], 'selectionDamageSafe'),
        true,
        'report should keep the selector-time safety diagnostic separate'
    );
    assert.equal(
        Object.hasOwn(report.results[0], 'qualitySignals'),
        true,
        'report should preserve final quality metrics for lifecycle monitoring'
    );
    assert.equal(Object.hasOwn(report.results[0], 'damageSafe'), false);
});

test('classifyBenchmarkCase should mark skipped expected Gemini sample as missed detection', () => {
    const result = classifyBenchmarkCase({
        expectedGemini: true,
        applied: false,
        skipReason: 'no-watermark-detected',
        fileName: 'expected-gemini.png'
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

const benchmarkCaseClassifiers = [
    {
        name: 'sample benchmark',
        classify: (record) => classifyBenchmarkCase({
            expectedGemini: true,
            ...record
        })
    },
    {
        name: 'external benchmark',
        classify: classifyExternalBenchmarkCase
    }
];

test('benchmark classifiers should reject strong negative spatial overshoot', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const result = classify({
            applied: true,
            residualScore: -0.31,
            processedGradientScore: 0.04,
            suppressionGain: 0.48,
            decisionTier: 'validated-match'
        });

        assert.deepEqual(result, {
            status: 'fail',
            bucket: 'residual-overshoot'
        }, name);
    }
});

test('benchmark classifiers should respect a calibrated clean residual verdict', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const result = classify({
            applied: true,
            residualScore: 0.317768,
            processedGradientScore: 0.036947,
            suppressionGain: 0.455735,
            decisionTier: 'validated-match',
            residualVisibility: {
                rawVisible: true,
                visible: false,
                calibratedVisible: false,
                metricRisk: 'positive-halo-background-collision',
                visibleSpatialResidual: true,
                visiblePositiveHalo: true,
                visibleGradientResidual: false
            }
        });

        assert.deepEqual(result, {
            status: 'pass',
            bucket: 'pass'
        }, name);
    }
});

test('benchmark classifiers should not trust unknown metric risks or hide strong gradients', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const unknownRisk = classify({
            applied: true,
            residualScore: 0.31,
            processedGradientScore: 0.04,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            residualVisibility: {
                rawVisible: true,
                visible: false,
                calibratedVisible: false,
                metricRisk: 'future-unreviewed-risk',
                visibleSpatialResidual: true,
                visiblePositiveHalo: false,
                visibleGradientResidual: false
            }
        });
        const strongGradient = classify({
            applied: true,
            residualScore: 0.31,
            processedGradientScore: 0.31,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            residualVisibility: {
                rawVisible: true,
                visible: false,
                calibratedVisible: false,
                metricRisk: 'positive-spatial-background-collision',
                visibleSpatialResidual: true,
                visiblePositiveHalo: false,
                visibleGradientResidual: false
            }
        });
        const lowVarianceStrongGradient = classify({
            applied: true,
            residualScore: -0.31,
            processedGradientScore: 0.31,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            residualVisibility: {
                rawVisible: true,
                visible: false,
                calibratedVisible: false,
                metricRisk: 'flat-low-variance-spatial-correlation',
                visibleSpatialResidual: true,
                visiblePositiveHalo: false,
                visibleGradientResidual: false
            }
        });

        assert.deepEqual(unknownRisk, {
            status: 'fail',
            bucket: 'residual-edge'
        }, `${name}: unknown risk`);
        assert.deepEqual(strongGradient, {
            status: 'fail',
            bucket: 'residual-edge'
        }, `${name}: spatial risk with strong gradient`);
        assert.deepEqual(lowVarianceStrongGradient, {
            status: 'fail',
            bucket: 'residual-edge'
        }, `${name}: low-variance risk with strong gradient`);
    }
});

test('benchmark classifiers should only exempt negative overshoot for the explicit low-variance metric risk', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const lowVarianceResult = classify({
            applied: true,
            residualScore: -0.423388,
            processedGradientScore: 0.042947,
            suppressionGain: 1.421172,
            decisionTier: 'validated-match',
            residualVisibility: {
                rawVisible: true,
                visible: false,
                calibratedVisible: false,
                metricRisk: 'flat-low-variance-spatial-correlation',
                visibleSpatialResidual: true,
                visiblePositiveHalo: false,
                visibleGradientResidual: false
            }
        });
        const unrelatedMetricRiskResult = classify({
            applied: true,
            residualScore: -0.31,
            processedGradientScore: 0.04,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            residualVisibility: {
                rawVisible: true,
                visible: false,
                calibratedVisible: false,
                metricRisk: 'flat-clipped-low-texture-spatial-correlation',
                visibleSpatialResidual: true,
                visiblePositiveHalo: false,
                visibleGradientResidual: false
            }
        });

        assert.deepEqual(lowVarianceResult, {
            status: 'pass',
            bucket: 'pass'
        }, name);
        assert.deepEqual(unrelatedMetricRiskResult, {
            status: 'fail',
            bucket: 'residual-overshoot'
        }, name);
    }
});

test('benchmark classifiers should reject strong gradient residuals', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const result = classify({
            applied: true,
            residualScore: 0.05,
            processedGradientScore: 0.31,
            suppressionGain: 0.48,
            decisionTier: 'validated-match'
        });

        assert.deepEqual(result, {
            status: 'fail',
            bucket: 'residual-edge'
        }, name);
    }
});

test('allowWeakResidual should not exempt gradient or halo visibility failures', () => {
    const failures = [
        {
            residualScore: 0.05,
            processedGradientScore: 0.31,
            residualVisibility: {
                visible: true,
                visibleGradientResidual: true
            }
        },
        {
            residualScore: 0.05,
            processedGradientScore: 0.04,
            residualVisibility: {
                visible: true,
                visiblePositiveHalo: true
            }
        }
    ];

    for (const record of failures) {
        const result = classifyBenchmarkCase({
            expectedGemini: true,
            applied: true,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            allowWeakResidual: true,
            ...record
        });

        assert.deepEqual(result, {
            status: 'fail',
            bucket: 'residual-edge'
        });
    }
});

test('allowWeakResidual should require bounded residual and minimum suppression', () => {
    const weakSuppression = classifyBenchmarkCase({
        expectedGemini: true,
        applied: true,
        residualScore: 0.99,
        processedGradientScore: 0.01,
        suppressionGain: 0.01,
        decisionTier: 'validated-match',
        allowWeakResidual: true,
        residualVisibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: false,
            visibleGradientResidual: false
        }
    });
    const excessiveResidual = classifyBenchmarkCase({
        expectedGemini: true,
        applied: true,
        residualScore: 0.99,
        processedGradientScore: 0.01,
        suppressionGain: 0.5,
        decisionTier: 'validated-match',
        allowWeakResidual: true,
        residualVisibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: false,
            visibleGradientResidual: false
        }
    });
    const goldBoundary = classifyBenchmarkCase({
        expectedGemini: true,
        applied: true,
        residualScore: 0.317768,
        processedGradientScore: 0.036947,
        suppressionGain: 0.455735,
        decisionTier: 'validated-match',
        allowWeakResidual: true,
        residualVisibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: false,
            visibleGradientResidual: false
        }
    });

    assert.deepEqual(weakSuppression, {
        status: 'fail',
        bucket: 'weak-suppression'
    });
    assert.deepEqual(excessiveResidual, {
        status: 'fail',
        bucket: 'residual-edge'
    });
    assert.deepEqual(goldBoundary, {
        status: 'pass',
        bucket: 'pass'
    });
});

test('benchmark classifiers should not let the canonical 96px exception hide explicit visible residuals', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const result = classify({
            applied: true,
            actualAnchor: { logoSize: 96, marginRight: 64, marginBottom: 64 },
            alphaGain: 1,
            residualScore: 0.31,
            processedGradientScore: 0.04,
            originalSpatialScore: 0.77,
            originalGradientScore: 0.47,
            suppressionGain: 0.45,
            decisionTier: 'direct-match',
            residualVisibility: {
                visible: true,
                visiblePositiveHalo: true
            }
        });

        assert.deepEqual(result, {
            status: 'fail',
            bucket: 'residual-edge'
        }, name);
    }
});

test('benchmark classifiers should reject explicitly unsafe content damage', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const result = classify({
            applied: true,
            residualScore: 0.05,
            processedGradientScore: 0.04,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            damageSafe: false
        });

        assert.deepEqual(result, {
            status: 'fail',
            bucket: 'content-damage'
        }, name);
    }
});

test('benchmark classifiers should prefer final damage signals over safe selection diagnostics', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const result = classify({
            applied: true,
            residualScore: 0.05,
            processedGradientScore: 0.04,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            qualitySignals: {
                damageWarning: true,
                qualityStatus: 'possible-content-damage'
            },
            selectionDamageSafe: true,
            selectionDebug: {
                damage: {
                    safe: true
                }
            }
        });

        assert.deepEqual(result, {
            status: 'fail',
            bucket: 'content-damage'
        }, name);
    }
});

test('benchmark classifiers should not let stale unsafe selection diagnostics override clean final quality', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const result = classify({
            applied: true,
            residualScore: 0.05,
            processedGradientScore: 0.04,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            finalDamageWarning: false,
            qualityStatus: 'clean',
            selectionDamageSafe: false,
            selectionDebug: {
                damage: {
                    safe: false
                }
            }
        });

        assert.deepEqual(result, {
            status: 'pass',
            bucket: 'pass'
        }, name);
    }
});

test('benchmark classifiers should recognize final damage quality status without a warning field', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const result = classify({
            applied: true,
            residualScore: 0.05,
            processedGradientScore: 0.04,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            qualityStatus: 'possible-content-damage',
            selectionDamageSafe: true
        });

        assert.deepEqual(result, {
            status: 'fail',
            bucket: 'content-damage'
        }, name);
    }
});

test('benchmark classifiers should use selection damage as a legacy fallback', () => {
    for (const { name, classify } of benchmarkCaseClassifiers) {
        const result = classify({
            applied: true,
            residualScore: 0.05,
            processedGradientScore: 0.04,
            suppressionGain: 0.48,
            decisionTier: 'validated-match',
            selectionDebug: {
                damage: {
                    safe: false
                }
            }
        });

        assert.deepEqual(result, {
            status: 'fail',
            bucket: 'content-damage'
        }, name);
    }
});

test('classifyBenchmarkCase should allow conservative canonical 96px residuals that avoid over-removal', () => {
    const result = classifyBenchmarkCase({
        expectedGemini: true,
        applied: true,
        actualAnchor: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        alphaGain: 1,
        residualScore: 0.31,
        processedGradientScore: 0.04,
        originalSpatialScore: 0.77,
        originalGradientScore: 0.47,
        suppressionGain: 0.45,
        decisionTier: 'direct-match',
        selectedCandidateDiagnostic: {
            alphaAdjustmentStages: []
        },
        fileName: 'conservative-canonical-96.png'
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.bucket, 'pass');
});

test('classifyExternalBenchmarkCase should allow conservative canonical 96px residuals that avoid over-removal', () => {
    const result = classifyExternalBenchmarkCase({
        applied: true,
        actualAnchor: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        alphaGain: 1,
        residualScore: 0.31,
        processedGradientScore: 0.04,
        originalSpatialScore: 0.77,
        originalGradientScore: 0.47,
        suppressionGain: 0.45,
        decisionTier: 'direct-match'
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.bucket, 'pass');
});

test('classifyExternalBenchmarkCase should cap the canonical 96px exception at residual 0.35', () => {
    const baseRecord = {
        applied: true,
        actualAnchor: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        alphaGain: 1,
        processedGradientScore: 0.04,
        originalSpatialScore: 0.77,
        originalGradientScore: 0.47,
        suppressionGain: 0.45,
        decisionTier: 'direct-match'
    };

    assert.deepEqual(classifyExternalBenchmarkCase({
        ...baseRecord,
        residualScore: 0.35
    }), {
        status: 'pass',
        bucket: 'pass'
    });
    assert.deepEqual(classifyExternalBenchmarkCase({
        ...baseRecord,
        residualScore: 0.9
    }), {
        status: 'fail',
        bucket: 'residual-edge'
    });
});

test('classifyBenchmarkCase should treat changed non-Gemini region as false positive', () => {
    const result = classifyBenchmarkCase({
        expectedGemini: false,
        applied: true,
        changedRatio: 0.08,
        avgAbsoluteDeltaPerChannel: 3.2,
        fileName: '16-9.jpg'
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.bucket, 'false-positive');
});

test('classifyBenchmarkCase should report an exact admitted residual debt as a known issue instead of pass', () => {
    const result = classifyBenchmarkCase({
        expectedGemini: true,
        applied: true,
        actualAnchor: { logoSize: 96, marginRight: 192, marginBottom: 192 },
        expectedAnchor: { logoSize: 96, marginRight: 192, marginBottom: 192 },
        alphaGain: 0.85,
        expectedAlphaGain: { min: 0.8, max: 0.9 },
        decisionTier: 'validated-match',
        qualityStatus: 'visible-residual',
        residualScore: 0.05,
        processedGradientScore: 0.53,
        suppressionGain: 0.8,
        residualVisibility: {
            visible: true,
            visibleGradientResidual: true
        },
        knownIssue: {
            issue: 118,
            qualityStatus: 'visible-residual',
            bucket: 'residual-edge'
        }
    });

    assert.deepEqual(result, {
        status: 'known-issue',
        bucket: 'residual-edge',
        issue: 118
    });
});

test('listBenchmarkSampleAssets should include every primary sample image under the sample directory', async () => {
    const sampleDir = path.resolve('src/assets/samples');
    const items = await listBenchmarkSampleAssets(sampleDir);

    assert.ok(items.length > 0, 'expected benchmark sample enumeration to find sample images');
    assert.ok(
        items.some((item) => item.expectedGemini === true),
        'expected directory-driven samples to include supported Gemini fixtures'
    );
    assert.ok(items.every((item) => !item.fileName.includes('-fix.')), 'expected fix snapshots to be excluded');
    assert.ok(items.every((item) => !item.fileName.includes('-after.')), 'expected derived after snapshots to be excluded');
    assert.equal(items.some((item) => item.fileName === '1-1.png'), true);
    assert.equal(items.some((item) => item.fileName === '9-16.png'), true);
    assert.equal(items.find((item) => item.fileName === '2-3.png')?.expectedGemini, true);
    assert.equal(items.find((item) => item.fileName === '8-1.png')?.expectedGemini, true);
    assert.deepEqual(
        items.find((item) => item.fileName === '16-9.png')?.gold?.expectedAnchor,
        { logoSize: 48, marginRight: 96, marginBottom: 96 }
    );
});

test('listBenchmarkSampleAssets should reject issue regression samples without formal admission metadata', async () => {
    const sampleDir = await mkdtemp(path.join(tmpdir(), 'gwr-sample-admission-missing-'));
    await writeFile(path.join(sampleDir, 'issue-118.png'), Buffer.from([1, 2, 3]));
    await writeFile(path.join(sampleDir, 'gold-manifest.json'), JSON.stringify({
        version: 1,
        samples: {
            'issue-118.png': {
                shouldProcess: true,
                tags: ['issue-regression']
            }
        }
    }));

    await assert.rejects(
        listBenchmarkSampleAssets(sampleDir),
        /issue-118\.png: formal admission metadata is required/
    );
});

test('listBenchmarkSampleAssets should reject a manifest whose admitted issue sample file disappeared', async () => {
    const sampleDir = await mkdtemp(path.join(tmpdir(), 'gwr-sample-admission-file-missing-'));
    await writeFile(path.join(sampleDir, 'gold-manifest.json'), JSON.stringify({
        version: 1,
        samples: {
            'issue-118.png': {
                shouldProcess: true,
                tags: ['issue-regression'],
                admission: {
                    status: 'confirmed-regression-input',
                    source: 'github-issue',
                    issue: 118,
                    originalFileName: 'Gemini_Generated_Image.png',
                    sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
                    confirmedAt: '2026-07-30'
                }
            }
        }
    }));

    await assert.rejects(
        listBenchmarkSampleAssets(sampleDir),
        /issue-118\.png: admitted sample file is missing/
    );
});

test('listBenchmarkSampleAssets should reject issue regression samples when the admitted source hash changed', async () => {
    const sampleDir = await mkdtemp(path.join(tmpdir(), 'gwr-sample-admission-stale-'));
    await writeFile(path.join(sampleDir, 'issue-118.png'), Buffer.from([1, 2, 3]));
    await writeFile(path.join(sampleDir, 'gold-manifest.json'), JSON.stringify({
        version: 1,
        samples: {
            'issue-118.png': {
                shouldProcess: true,
                tags: ['issue-regression'],
                admission: {
                    status: 'confirmed-regression-input',
                    source: 'github-issue',
                    issue: 118,
                    originalFileName: 'Gemini_Generated_Image.png',
                    sha256: '0'.repeat(64),
                    confirmedAt: '2026-07-30'
                }
            }
        }
    }));

    await assert.rejects(
        listBenchmarkSampleAssets(sampleDir),
        /issue-118\.png: admitted source sha256 mismatch/
    );
});

test('listBenchmarkSampleAssets should reject incomplete issue admission provenance', async () => {
    const validAdmission = {
        status: 'confirmed-regression-input',
        source: 'github-issue',
        issue: 118,
        originalFileName: 'Gemini_Generated_Image.png',
        sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        confirmedAt: '2026-07-30'
    };
    const cases = [
        [{ ...validAdmission, status: 'draft' }, /status must be confirmed-regression-input/],
        [{ ...validAdmission, source: 'unknown' }, /source must be github-issue/],
        [{ ...validAdmission, issue: 0 }, /issue must be a positive integer/],
        [{ ...validAdmission, originalFileName: '' }, /originalFileName is required/],
        [{ ...validAdmission, confirmedAt: 'today' }, /confirmedAt must use YYYY-MM-DD/]
    ];

    for (const [admission, expectedError] of cases) {
        const sampleDir = await mkdtemp(path.join(tmpdir(), 'gwr-sample-admission-invalid-'));
        await writeFile(path.join(sampleDir, 'issue-118.png'), Buffer.from([1, 2, 3]));
        await writeFile(path.join(sampleDir, 'gold-manifest.json'), JSON.stringify({
            version: 1,
            samples: {
                'issue-118.png': {
                    shouldProcess: true,
                    tags: ['issue-regression'],
                    admission
                }
            }
        }));

        await assert.rejects(listBenchmarkSampleAssets(sampleDir), expectedError);
    }
});

test('listBenchmarkSampleAssets should expose verified admission and known issue expectations', async () => {
    const sampleDir = await mkdtemp(path.join(tmpdir(), 'gwr-sample-admission-valid-'));
    const admission = {
        status: 'confirmed-regression-input',
        source: 'github-issue',
        issue: 118,
        originalFileName: 'Gemini_Generated_Image.png',
        sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        confirmedAt: '2026-07-30'
    };
    const knownIssue = {
        issue: 118,
        qualityStatus: 'visible-residual',
        bucket: 'residual-edge'
    };
    await writeFile(path.join(sampleDir, 'issue-118.png'), Buffer.from([1, 2, 3]));
    await writeFile(path.join(sampleDir, 'gold-manifest.json'), JSON.stringify({
        version: 1,
        samples: {
            'issue-118.png': {
                shouldProcess: true,
                tags: ['issue-regression'],
                admission,
                knownIssue
            }
        }
    }));

    const items = await listBenchmarkSampleAssets(sampleDir);

    assert.deepEqual(items[0].gold.admission, admission);
    assert.deepEqual(items[0].gold.knownIssue, knownIssue);
});

test('listBenchmarkSampleAssets should reject broad or mismatched known issue waivers', async () => {
    const validAdmission = {
        status: 'confirmed-regression-input',
        source: 'github-issue',
        issue: 118,
        originalFileName: 'Gemini_Generated_Image.png',
        sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        confirmedAt: '2026-07-30'
    };
    const cases = [
        [{ issue: 119, qualityStatus: 'visible-residual', bucket: 'residual-edge' }, /issue must match admission issue/],
        [{ issue: 118, qualityStatus: 'clean', bucket: 'residual-edge' }, /qualityStatus must be visible-residual/],
        [{ issue: 118, qualityStatus: 'visible-residual', bucket: 'content-damage' }, /bucket must be residual-edge/]
    ];

    for (const [knownIssue, expectedError] of cases) {
        const sampleDir = await mkdtemp(path.join(tmpdir(), 'gwr-known-issue-invalid-'));
        await writeFile(path.join(sampleDir, 'issue-118.png'), Buffer.from([1, 2, 3]));
        await writeFile(path.join(sampleDir, 'gold-manifest.json'), JSON.stringify({
            version: 1,
            samples: {
                'issue-118.png': {
                    shouldProcess: true,
                    tags: ['issue-regression'],
                    admission: validAdmission,
                    knownIssue
                }
            }
        }));

        await assert.rejects(listBenchmarkSampleAssets(sampleDir), expectedError);
    }
});

test('loadSampleGoldManifest should read human-maintained sample expectations', async () => {
    const manifest = await loadSampleGoldManifest(path.resolve('src/assets/samples'));

    assert.equal(manifest.version, 1);
    assert.equal(manifest.samples['8-1.png'].shouldProcess, true);
    assert.deepEqual(
        manifest.samples['20260520-3.png'].expectedAnchor,
        { logoSize: 96, marginRight: 192, marginBottom: 192 }
    );
});

test('summarizeBenchmarkResults should aggregate pass fail and bucket counts', () => {
    const summary = summarizeBenchmarkResults([
        {
            fileName: 'alpha-adjusted.png',
            classification: { status: 'pass', bucket: 'pass' },
            candidateRankingSummary: {
                topAcceptedMatchesSelectedAnchor: true,
                topAcceptedMatchesSelectedAlpha: false,
                selectedAnchorRank: 1,
                selectedExactRank: null,
                earlyAcceptRank: 2
            },
            selectedCandidateDiagnostic: {
                matchesExpectedAnchor: true,
                matchesExpectedAlpha: true,
                fineAlphaNeighborhood: [
                    { selected: false, alphaGain: 0.6 },
                    { selected: true, alphaGain: 0.64 }
                ],
                fineAlphaSelectedRank: 2,
                fineAlphaTopAlphaGain: 0.6,
                fineAlphaTopDelta: -0.04,
                fineAlphaTopDeltaBucket: 'micro-lower',
                fineAlphaSelectedAlphaType: 'fine',
                fineAlphaTopAlphaType: 'discrete',
                fineAlphaSelectionReason: 'dark-catalog-fine-alpha',
                alphaGain: 0.64,
                residual: { score: 0.12 },
                damage: { penalty: 0.02 },
                alphaAdjustmentStages: [
                    { stage: 'dark-catalog-fine-alpha' },
                    { stage: 'weak-positive-residual-fine-alpha' }
                ]
            }
        },
        { classification: { status: 'fail', bucket: 'missed-detection' } },
        { classification: { status: 'fail', bucket: 'missed-detection' } },
        { classification: { status: 'fail', bucket: 'false-positive' } }
    ]);

    assert.equal(summary.total, 4);
    assert.equal(summary.passCount, 1);
    assert.equal(summary.failCount, 3);
    assert.equal(summary.buckets['missed-detection'], 2);
    assert.equal(summary.buckets['false-positive'], 1);
    assert.equal(summary.candidateRanking.topAcceptedMatchesSelectedAnchor, 1);
    assert.equal(summary.candidateRanking.topAcceptedMatchesSelectedAlpha, 0);
    assert.equal(summary.candidateRanking.selectedAnchorInTop, 1);
    assert.equal(summary.candidateRanking.selectedExactInTop, 0);
    assert.equal(summary.candidateRanking.earlyAcceptInTop, 1);
    assert.equal(summary.candidateRanking.selectedFinalDiagnosticCount, 1);
    assert.equal(summary.candidateRanking.selectedFinalExpectedAnchorCount, 1);
    assert.equal(summary.candidateRanking.selectedFinalExpectedAlphaCount, 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaNeighborhoodCount, 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaTopCount, 0);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaSelectedRankCounts['2'], 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaSelectionReasons['dark-catalog-fine-alpha'], 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaSelectedAlphaTypes.fine, 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaTopDeltaBuckets['micro-lower'], 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaNonTopReasonCounts['dark-catalog-fine-alpha'], 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaNonTopSelectedAlphaTypes.fine, 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaNonTopDeltaBuckets['micro-lower'], 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaNonTopWithAdjustmentCount, 1);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaNonTopWithoutAdjustmentCount, 0);
    assert.deepEqual(summary.candidateRanking.selectedFinalFineAlphaNonTopSamples, [
        {
            fileName: 'alpha-adjusted.png',
            selectedRank: 2,
            selectedAlphaGain: 0.64,
            topAlphaGain: 0.6,
            alphaDelta: -0.04,
            alphaDeltaBucket: 'micro-lower',
            reason: 'dark-catalog-fine-alpha',
            selectedAlphaType: 'fine',
            topAlphaType: 'discrete',
            selectedResidualScore: 0.12,
            topResidualScore: null,
            residualScoreDelta: null,
            selectedDamagePenalty: 0.02,
            topDamagePenalty: null,
            topDamageSafe: null,
            topAccepted: null,
            significantDeltaConcern: null,
            alphaAdjustmentStages: ['dark-catalog-fine-alpha', 'weak-positive-residual-fine-alpha']
        }
    ]);
    assert.equal(summary.candidateRanking.selectedFinalFineAlphaSignificantDeltaCount, 0);
    assert.deepEqual(summary.candidateRanking.selectedFinalFineAlphaSignificantDeltaConcerns, {});
    assert.deepEqual(summary.candidateRanking.selectedFinalFineAlphaSignificantDeltaSamples, []);
    assert.equal(summary.candidateRanking.selectedFinalAlphaAdjustmentCount, 1);
    assert.equal(summary.candidateRanking.selectedFinalAlphaAdjustmentStages['dark-catalog-fine-alpha'], 1);
    assert.equal(summary.candidateRanking.selectedFinalAlphaAdjustmentStages['weak-positive-residual-fine-alpha'], 1);
    assert.deepEqual(
        summary.candidateRanking.selectedFinalAlphaAdjustmentStageSamples['dark-catalog-fine-alpha'],
        ['alpha-adjusted.png']
    );
    assert.deepEqual(
        summary.candidateRanking.selectedFinalAlphaAdjustmentStageSamples['weak-positive-residual-fine-alpha'],
        ['alpha-adjusted.png']
    );
});

test('classifyFineAlphaSelectionReason should separate production stages from report preference drift', () => {
    assert.equal(
        classifyFineAlphaSelectionReason({
            alphaGain: 0.64,
            fineAlphaSelectedRank: 3,
            alphaAdjustmentStages: [{ stage: 'weak-positive-residual-fine-alpha' }]
        }),
        'weak-positive-residual-fine-alpha'
    );
    assert.equal(
        classifyFineAlphaSelectionReason({
            alphaGain: 0.6,
            fineAlphaSelectedRank: 4,
            alphaAdjustmentStages: []
        }),
        'production-kept-standard-alpha'
    );
    assert.equal(
        classifyFineAlphaSelectionReason({
            alphaGain: 0.64,
            fineAlphaSelectedRank: 4,
            alphaAdjustmentStages: []
        }),
        'report-prefers-micro-alpha'
    );
    assert.equal(
        classifyFineAlphaSelectionReason({
            alphaGain: 1,
            fineAlphaSelectedRank: 1,
            alphaAdjustmentStages: []
        }),
        'direct-discrete-alpha'
    );
});

test('summarizeBenchmarkResults should keep known issues separate from passes and failures', () => {
    const summary = summarizeBenchmarkResults([
        { classification: { status: 'pass', bucket: 'pass' } },
        { classification: { status: 'known-issue', bucket: 'residual-edge', issue: 118 } },
        { classification: { status: 'fail', bucket: 'content-damage' } }
    ]);

    assert.equal(summary.total, 3);
    assert.equal(summary.passCount, 1);
    assert.equal(summary.knownIssueCount, 1);
    assert.equal(summary.failCount, 1);
    assert.equal(summary.buckets['residual-edge'], 1);
});

test('summarizeCandidateRankingReport should expose selected and expected candidate ranks', () => {
    const summary = summarizeCandidateRankingReport([
        {
            accepted: true,
            earlyAccept: false,
            matchesSelectedAnchor: false,
            matchesSelectedAlpha: false,
            matchesExpectedAnchor: true,
            matchesExpectedAlpha: true
        },
        {
            accepted: true,
            earlyAccept: true,
            matchesSelectedAnchor: true,
            matchesSelectedAlpha: false,
            matchesExpectedAnchor: true,
            matchesExpectedAlpha: true
        },
        {
            accepted: false,
            earlyAccept: false,
            matchesSelectedAnchor: true,
            matchesSelectedAlpha: true,
            matchesExpectedAnchor: false,
            matchesExpectedAlpha: false
        }
    ]);

    assert.equal(summary.total, 3);
    assert.equal(summary.acceptedCount, 2);
    assert.equal(summary.earlyAcceptRank, 2);
    assert.equal(summary.selectedAnchorRank, 2);
    assert.equal(summary.selectedExactRank, 3);
    assert.equal(summary.expectedAnchorRank, 1);
    assert.equal(summary.expectedAlphaRank, 1);
    assert.equal(summary.topAcceptedMatchesSelectedAnchor, false);
});

test('classifyBenchmarkCase should fail expected Gemini samples with the wrong anchor or alpha', () => {
    const anchorMismatch = classifyBenchmarkCase({
        expectedGemini: true,
        applied: true,
        decisionTier: 'direct-match',
        residualScore: 0.01,
        actualAnchor: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        expectedAnchor: { logoSize: 48, marginRight: 96, marginBottom: 96 }
    });
    const alphaMismatch = classifyBenchmarkCase({
        expectedGemini: true,
        applied: true,
        decisionTier: 'direct-match',
        residualScore: 0.01,
        actualAnchor: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        expectedAnchor: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        alphaGain: 0.4,
        expectedAlphaGain: { min: 0.5, max: 1 }
    });

    assert.equal(anchorMismatch.bucket, 'anchor-mismatch');
    assert.equal(alphaMismatch.bucket, 'alpha-mismatch');
});

test('decodeImageDataInNode should decode sample assets without launching a browser', async () => {
    const imageData = await decodeImageDataInNode(path.resolve('src/assets/samples/1-1.png'));

    assert.equal(imageData.width, 1024);
    assert.equal(imageData.height, 1024);
    assert.equal(imageData.data.length, 1024 * 1024 * 4);
});

test('buildCandidateRankingReport should expose sorted top candidate diagnostics', async () => {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const imageData = await decodeImageDataInNode(path.resolve('src/assets/samples/20260608-3.png'));
    const initialConfig = resolveInitialStandardConfig({
        imageData,
        defaultConfig: detectWatermarkConfig(imageData.width, imageData.height),
        alpha48,
        alpha96
    });

    const candidates = buildCandidateRankingReport({
        imageData,
        initialConfig,
        alpha48,
        alpha96,
        getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size),
        limit: 8
    });

    assert.ok(candidates.length > 0, 'expected top candidate diagnostics');
    assert.ok(candidates.length <= 8);
    assert.equal(candidates[0].accepted, true);
    const largeMarginCandidate = candidates.find((candidate) => (
        candidate.family === 'known-current-variant' &&
        candidate.watermarkSize === 48 &&
        candidate.marginRight === 96 &&
        candidate.marginBottom === 96
    ));

    assert.ok(largeMarginCandidate, 'expected top diagnostics to include the 48px large-margin catalog candidate');
    assert.equal(largeMarginCandidate.catalogMetadata.sourcePriority, 1);
    assert.equal(largeMarginCandidate.originalEvidence.tier, 'strong');
    assert.equal(typeof largeMarginCandidate.earlyAccept, 'boolean');
    assert.ok(Array.isArray(candidates[0].rankingKey));
    assert.equal(typeof candidates[0].residual.score, 'number');
    assert.equal(typeof candidates[0].damage.safe, 'boolean');
});

test('buildSelectedCandidateDiagnostic should score the final processed fine-alpha result', async () => {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const imageData = await decodeImageDataInNode(path.resolve('src/assets/samples/20260608-5.png'));
    const initialConfig = resolveInitialStandardConfig({
        imageData,
        defaultConfig: detectWatermarkConfig(imageData.width, imageData.height),
        alpha48,
        alpha96
    });
    const processed = processWatermarkImageData(imageData, {
        alpha48,
        alpha96,
        adaptiveMode: 'never',
        getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size)
    });

    const diagnostic = buildSelectedCandidateDiagnostic({
        originalImageData: imageData,
        processedImageData: processed.imageData,
        meta: processed.meta,
        initialConfig,
        alpha48,
        alpha96,
        getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size),
        expectedAnchor: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        expectedAlphaGain: { min: 0.5, max: 1 }
    });

    assert.ok(diagnostic, 'expected selected final diagnostic');
    assert.equal(diagnostic.family, 'selected-final');
    assert.equal(diagnostic.matchesExpectedAnchor, true);
    assert.equal(diagnostic.matchesExpectedAlpha, true);
    assert.equal(diagnostic.alphaGain, processed.meta.alphaGain);
    assert.equal(typeof diagnostic.fineAlphaSelectedRank, 'number');
    assert.equal(typeof diagnostic.fineAlphaTopAlphaGain, 'number');
    assert.equal(typeof diagnostic.fineAlphaTopDelta, 'number');
    assert.equal(typeof diagnostic.fineAlphaTopDeltaBucket, 'string');
    assert.equal(typeof diagnostic.fineAlphaSelectedAlphaType, 'string');
    assert.equal(typeof diagnostic.fineAlphaTopAlphaType, 'string');
    assert.equal(typeof diagnostic.fineAlphaSelectionReason, 'string');
    assert.ok(Array.isArray(diagnostic.rankingKey));
    assert.deepEqual(diagnostic.alphaAdjustmentStages, processed.meta.alphaAdjustmentStages);
    assert.ok(Array.isArray(diagnostic.fineAlphaNeighborhood));
    assert.ok(
        diagnostic.fineAlphaNeighborhood.some((candidate) => candidate.selected === true),
        'expected fine alpha neighborhood to mark the selected final alpha'
    );
    assert.equal(typeof diagnostic.residual.score, 'number');
});

test('buildSelectedCandidateDiagnostic should preserve legacy alpha map variants from selected meta', async () => {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    const imageData = await decodeImageDataInNode(path.resolve('src/assets/samples/20260520-3.png'));
    const initialConfig = resolveInitialStandardConfig({
        imageData,
        defaultConfig: detectWatermarkConfig(imageData.width, imageData.height),
        alpha48,
        alpha96
    });
    const processed = processWatermarkImageData(imageData, {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size)
    });

    const diagnostic = buildSelectedCandidateDiagnostic({
        originalImageData: imageData,
        processedImageData: processed.imageData,
        meta: processed.meta,
        initialConfig,
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size),
        expectedAnchor: { logoSize: 96, marginRight: 192, marginBottom: 192 },
        expectedAlphaGain: { min: 0.5, max: 1 }
    });

    assert.ok(diagnostic, 'expected selected final diagnostic');
    assert.equal(diagnostic.alphaMapProfile, '96-20260520');
    assert.equal(diagnostic.fineAlphaNeighborhood.some((candidate) => candidate.selected === true), true);
});

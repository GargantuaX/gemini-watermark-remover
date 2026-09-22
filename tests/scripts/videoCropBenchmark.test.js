import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
    buildPolarityProbe,
    calculateRawDiffMetrics,
    classifyOriginalEvidence,
    classifyOriginalFrameEvidence,
    computeBackgroundNormalizedAlphaContrast,
    loadVideoCropBenchmarkManifest,
    normalizeVideoBenchmarkCase,
    resolveBenchmarkPrimaryCandidate,
    resolveExpectedWatermarkCandidate,
    summarizeFrameScores,
    summarizeVideoBenchmarkVariants,
    summarizeVideoCropBenchmark
} from '../../scripts/video-crop-benchmark.js';

test('normalizeVideoBenchmarkCase should resolve project-relative manifest paths', () => {
    const normalized = normalizeVideoBenchmarkCase({
        id: 'case-a',
        originalPath: '.artifacts/video/original.mp4',
        currentPath: null,
        referencePath: 'D:\\videos\\reference.mp4',
        currentProfile: {
            algorithm: 'gwr-video-mvp',
            denoiseBackend: 'none'
        },
        referenceProfile: {
            algorithm: 'allenk',
            version: '0.6.2'
        },
        tags: ['1080p', 123]
    }, {
        manifestDir: path.resolve('scripts')
    });

    assert.equal(normalized.id, 'case-a');
    assert.equal(normalized.originalPath, path.resolve('.artifacts/video/original.mp4'));
    assert.equal(normalized.currentPath, null);
    assert.equal(normalized.referencePath, 'D:\\videos\\reference.mp4');
    assert.deepEqual(normalized.currentProfile, {
        algorithm: 'gwr-video-mvp',
        denoiseBackend: 'none'
    });
    assert.deepEqual(normalized.referenceProfile, {
        algorithm: 'allenk',
        version: '0.6.2'
    });
    assert.deepEqual(normalized.tags, ['1080p']);
});

test('video sample filenames use the configured root while explicit paths keep priority', () => {
    const sampleRoot = path.resolve('.artifacts/test-video-samples');
    const options = { sampleRoot, manifestDir: path.resolve('scripts') };
    assert.equal(
        normalizeVideoBenchmarkCase({ id: 'sample', originalFile: 'sample.mp4' }, options).originalPath,
        path.join(sampleRoot, 'sample.mp4')
    );
    assert.equal(
        normalizeVideoBenchmarkCase({
            id: 'sample', originalFile: 'sample.mp4', originalPath: '.artifacts/override.mp4'
        }, options).originalPath,
        path.resolve('.artifacts/override.mp4')
    );
});

test('calculateRawDiffMetrics should summarize RGB absolute deltas', () => {
    const left = new Uint8ClampedArray([
        10, 20, 30, 255,
        100, 100, 100, 255
    ]);
    const right = new Uint8ClampedArray([
        13, 20, 20, 255,
        90, 120, 100, 255
    ]);

    const metrics = calculateRawDiffMetrics(left, right, {
        width: 2,
        height: 1,
        threshold: 2
    });

    assert.equal(metrics.pixels, 2);
    assert.equal(metrics.maxAbsDelta, 20);
    assert.equal(metrics.meanAbsDeltaPerChannel, (3 + 0 + 10 + 10 + 20 + 0) / 6);
    assert.equal(metrics.changedRatio, 1);
});

test('resolveExpectedWatermarkCandidate should prefer manifest anchor geometry', () => {
    const candidate = resolveExpectedWatermarkCandidate({
        anchor: {
            x: 1704,
            y: 864,
            size: 72
        }
    }, {
        width: 1920,
        height: 1080
    });

    assert.equal(candidate.x, 1704);
    assert.equal(candidate.y, 864);
    assert.equal(candidate.size, 72);
    assert.equal(candidate.marginRight, 144);
    assert.equal(candidate.marginBottom, 144);
    assert.equal(candidate.source, 'manifest-expected');
});

test('resolveBenchmarkPrimaryCandidate should fall back to render primary candidate', () => {
    const renderPrimary = { id: 'veo-1080p-standard', x: 1740, y: 900, size: 72 };

    assert.deepEqual(
        resolveBenchmarkPrimaryCandidate({ primaryCandidate: renderPrimary, metadata: { width: 1920, height: 1080 } }, {}),
        renderPrimary
    );
});

test('summarizeVideoCropBenchmark should aggregate status and missing counts', () => {
    const summary = summarizeVideoCropBenchmark([
        { status: 'rendered-comparison', missing: [] },
        { status: 'rendered-original-only', missing: ['current', 'reference'] },
        { status: 'failed', missing: ['original'] }
    ]);

    assert.equal(summary.total, 3);
    assert.equal(summary.rendered, 2);
    assert.equal(summary.renderedComparison, 1);
    assert.equal(summary.renderedOriginalOnly, 1);
    assert.equal(summary.skippedMissingOriginal, 0);
    assert.equal(summary.failed, 1);
    assert.deepEqual(summary.missing, {
        original: 1,
        current: 1,
        reference: 1
    });
});

test('summarizeVideoBenchmarkVariants should compare variants against matching baseline', () => {
    const baseline = {
        id: 'case-a',
        tags: ['baseline'],
        expected: { anchor: { x: 10, y: 20, size: 4 } },
        paths: { original: 'original.mp4', reference: 'reference.mp4' },
        currentProfile: { denoiseBackend: 'none' },
        residualMetrics: {
            aggregate: {
                active: { meanAbs: 4, rms: 8, mean: 1 },
                edge: { meanAbs: 6, rms: 10, mean: 0 },
                lowBody: { meanAbs: 5, rms: 7, mean: 2 },
                highBody: { meanAbs: 3, rms: 4, mean: 1 }
            }
        }
    };
    const variant = {
        id: 'case-a-edge',
        tags: ['variant'],
        expected: { anchor: { x: 10, y: 20, size: 4 } },
        paths: { original: 'original.mp4', reference: 'reference.mp4' },
        currentProfile: { denoiseBackend: 'canvas-edge-denoise' },
        residualMetrics: {
            aggregate: {
                active: { meanAbs: 3.5, rms: 7, mean: 0.5 },
                edge: { meanAbs: 6.1, rms: 9.8, mean: 0.2 },
                lowBody: { meanAbs: 5.01, rms: 7, mean: 2 },
                highBody: { meanAbs: 3, rms: 4, mean: 1 }
            }
        }
    };

    const comparisons = summarizeVideoBenchmarkVariants([baseline, variant]);

    assert.equal(comparisons.length, 1);
    assert.equal(comparisons[0].baselineId, 'case-a');
    assert.equal(comparisons[0].variantId, 'case-a-edge');
    assert.equal(comparisons[0].deltas.active.meanAbsDelta, -0.5);
    assert.equal(comparisons[0].deltas.active.verdict, 'improved');
    assert.equal(comparisons[0].deltas.edge.verdict, 'regressed');
    assert.equal(comparisons[0].deltas.lowBody.verdict, 'neutral');
});

test('summarizeVideoBenchmarkVariants should flag sparse lowBody regressions as risk notes', () => {
    const baseline = {
        id: 'case-a',
        tags: ['baseline'],
        expected: { anchor: { x: 10, y: 20, size: 4 } },
        paths: { original: 'original.mp4', reference: 'reference.mp4' },
        currentProfile: { denoiseBackend: 'none' },
        residualMetrics: {
            aggregate: {
                active: { n: 10000, meanAbs: 4, rms: 8, mean: 1 },
                edge: { n: 2800, meanAbs: 6, rms: 10, mean: 0 },
                lowBody: { n: 40, meanAbs: 5, rms: 7, mean: 2 },
                highBody: { n: 7160, meanAbs: 3, rms: 4, mean: 1 }
            }
        }
    };
    const variant = {
        id: 'case-a-policy',
        tags: ['variant'],
        expected: { anchor: { x: 10, y: 20, size: 4 } },
        paths: { original: 'original.mp4', reference: 'reference.mp4' },
        currentProfile: { denoiseBackend: 'none', alphaEdgePolicy: 'candidate' },
        residualMetrics: {
            aggregate: {
                active: { n: 10000, meanAbs: 3.7, rms: 7.5, mean: 0.5 },
                edge: { n: 2800, meanAbs: 6.02, rms: 9.8, mean: 0.1 },
                lowBody: { n: 40, meanAbs: 5.4, rms: 7.3, mean: 2.2 },
                highBody: { n: 7160, meanAbs: 2.8, rms: 3.7, mean: 0.8 }
            }
        }
    };

    const [comparison] = summarizeVideoBenchmarkVariants([baseline, variant]);

    assert.equal(comparison.deltas.lowBody.verdict, 'regressed');
    assert.equal(comparison.deltas.active.verdict, 'improved');
    assert.equal(comparison.riskNotes[0].code, 'sparse-low-body-regression');
    assert.equal(comparison.riskNotes[0].severity, 'warning');
});

test('summarizeFrameScores should bucket frame confidence for gate analysis', () => {
    const summary = summarizeFrameScores([
        { spatial: 0.1, gradient: 0.2, confidence: 0.15, bestPolarity: 'positive', shouldProcessCandidate: true },
        { spatial: 0.05, gradient: 0.08, confidence: 0.06, bestPolarity: 'gray', shouldProcessCandidate: false },
        { spatial: -0.1, gradient: 0.01, confidence: 0.02, bestPolarity: 'negative', shouldProcessCandidate: true }
    ]);

    assert.equal(summary.frames, 3);
    assert.equal(summary.confidentFrames, 1);
    assert.equal(summary.weakFrames, 1);
    assert.equal(summary.likelyAbsentFrames, 1);
    assert.equal(summary.maxConfidence, 0.15);
    assert.equal(summary.meanAbsSpatial, (0.1 + 0.05 + 0.1) / 3);
    assert.equal(summary.maxAbsSpatial, 0.1);
    assert.equal(summary.positiveSpatialFrames, 0);
    assert.equal(summary.negativeSpatialFrames, 0);
    assert.equal(summary.positivePolarityFrames, 1);
    assert.equal(summary.negativePolarityFrames, 1);
    assert.equal(summary.grayPolarityFrames, 1);
    assert.equal(summary.processCandidateFrames, 2);
    assert.equal(summary.meanConfidence, (0.15 + 0.06 + 0.02) / 3);
});

test('summarizeFrameScores should handle empty input', () => {
    assert.deepEqual(summarizeFrameScores([]), {
        frames: 0,
        meanSpatial: 0,
        meanAbsSpatial: 0,
        meanGradient: 0,
        meanConfidence: 0,
        maxConfidence: 0,
        maxAbsSpatial: 0,
        positiveSpatialFrames: 0,
        negativeSpatialFrames: 0,
        positivePolarityFrames: 0,
        negativePolarityFrames: 0,
        grayPolarityFrames: 0,
        processCandidateFrames: 0,
        confidentFrames: 0,
        weakFrames: 0,
        likelyAbsentFrames: 0
    });
});

test('classifyOriginalEvidence should identify positive high-confidence samples', () => {
    const classification = classifyOriginalEvidence({
        frames: 5,
        meanSpatial: 0.72,
        meanAbsSpatial: 0.72,
        confidentFrames: 4,
        likelyAbsentFrames: 1,
        positiveSpatialFrames: 4,
        negativeSpatialFrames: 0
    });

    assert.equal(classification.class, 'positive-high-confidence');
    assert.equal(classification.shortLabel, 'positive-high');
    assert.equal(classification.recommendedNextStep, 'use-standard-detection-gate');
});

test('classifyOriginalEvidence should identify intermittent low-visible samples', () => {
    const classification = classifyOriginalEvidence({
        frames: 5,
        meanSpatial: -0.003,
        meanAbsSpatial: 0.18,
        confidentFrames: 1,
        likelyAbsentFrames: 4,
        positiveSpatialFrames: 1,
        negativeSpatialFrames: 2
    });

    assert.equal(classification.class, 'intermittent-low-visible');
    assert.equal(classification.shortLabel, 'intermittent');
    assert.equal(classification.recommendedNextStep, 'verify-frame-level-gate');
});

test('classifyOriginalEvidence should prefer negative polarity over absent when spatial evidence is strong', () => {
    const classification = classifyOriginalEvidence({
        frames: 5,
        meanSpatial: -0.23,
        meanAbsSpatial: 0.23,
        confidentFrames: 0,
        likelyAbsentFrames: 5,
        positiveSpatialFrames: 0,
        negativeSpatialFrames: 4
    });

    assert.equal(classification.class, 'negative-or-gray-polarity');
    assert.equal(classification.shortLabel, 'negative-gray');
    assert.equal(classification.recommendedNextStep, 'investigate-polarity-aware-detection');
});

test('classifyOriginalFrameEvidence should classify per-frame gate actions', () => {
    assert.deepEqual(
        classifyOriginalFrameEvidence({ spatial: 0.5, confidence: 0.4 }),
        {
            class: 'positive-confident',
            bestPolarity: 'positive',
            polarity: 'positive',
            polarityMargin: 0.325,
            shouldProcessCandidate: true,
            reason: 'positive-score-confident',
            recommendedGateAction: 'process'
        }
    );
    assert.deepEqual(
        classifyOriginalFrameEvidence({ spatial: -0.25, confidence: 0.01 }),
        {
            class: 'negative-or-gray-polarity',
            bestPolarity: 'negative',
            polarity: 'negative',
            polarityMargin: 0.1625,
            shouldProcessCandidate: true,
            reason: 'negative-score-dominant',
            recommendedGateAction: 'inspect-polarity'
        }
    );
});

test('buildPolarityProbe should expose positive negative and background-normalized evidence', () => {
    const positive = buildPolarityProbe(
        { spatial: 0.6, gradient: 0.2, confidence: 0.46 },
        { normalizedAlphaContrast: 0.3, alphaContrast: 0.02 }
    );
    const negative = buildPolarityProbe(
        { spatial: -0.45, gradient: 0.1, confidence: 0.02 },
        { normalizedAlphaContrast: -0.2, alphaContrast: -0.01 }
    );
    const gray = buildPolarityProbe(
        { spatial: 0.02, gradient: 0.01, confidence: 0.01 },
        { normalizedAlphaContrast: 0.9, alphaContrast: 0.04 }
    );

    assert.equal(positive.bestPolarity, 'positive');
    assert.equal(positive.shouldProcessCandidate, true);
    assert.equal(negative.bestPolarity, 'negative');
    assert.equal(negative.shouldProcessCandidate, true);
    assert.equal(gray.bestPolarity, 'gray');
    assert.equal(gray.reason, 'background-normalized-alpha-contrast');
    assert.equal(typeof gray.backgroundNormalizedScore, 'number');
});

test('computeBackgroundNormalizedAlphaContrast should compare alpha-weighted foreground with low-alpha background', () => {
    const imageData = {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([
            220, 220, 220, 255,
            50, 50, 50, 255,
            50, 50, 50, 255,
            50, 50, 50, 255
        ])
    };
    const alphaMap = new Float32Array([
        0.8, 0,
        0, 0
    ]);

    const probe = computeBackgroundNormalizedAlphaContrast(imageData, {
        x: 0,
        y: 0,
        width: 2,
        height: 2
    }, alphaMap);

    assert.ok(probe.alphaContrast > 0.6);
    assert.ok(probe.normalizedAlphaContrast > 0);
    assert.equal(probe.backgroundStdDev, 0);
});

test('loadVideoCropBenchmarkManifest should load the checked-in sample manifest', async () => {
    const manifest = await loadVideoCropBenchmarkManifest(path.resolve('scripts/video-crop-benchmark-manifest.json'));

    assert.equal(manifest.version, 1);
    assert.ok(manifest.cases.length >= 4);
    assert.equal(manifest.cases[0].id, '4d420881');
    assert.match(manifest.cases[0].currentPath, /edgeboost045-cleanup150\.mp4$/);
    assert.equal(manifest.cases[0].currentProfile.denoiseBackend, 'none');
    assert.deepEqual(manifest.timestamps, [1, 3, 5, 7, 9]);
});

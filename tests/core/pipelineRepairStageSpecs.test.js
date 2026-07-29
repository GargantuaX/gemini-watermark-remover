import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createPostLocatedRepairStageSequenceSpecs,
    createPreviewBackgroundCleanupStageSpec,
    createRepairCleanupPhaseSpecs,
    createTailRepairStageSequenceSpecs
} from '../../src/core/pipelineRepairStageSpecs.js';
import {
    runCurrentRepairStageSequence,
    runPreviewBackgroundCleanupStage,
    runRepairCleanupSpecPhase
} from '../../src/core/pipelineRuntime.js';

test('createPreviewBackgroundCleanupStageSpec should build dynamic cleanup payload', () => {
    const debugTimings = {};
    const nowValues = [100, 109];
    let currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        finalProcessedSpatialScore: 0.24,
        source: 'preview'
    };
    const calls = [];
    const accepted = [];

    const spec = createPreviewBackgroundCleanupStageSpec({
        nowMs: () => nowValues.shift(),
        readState: () => currentState,
        visualPostProcessingEnabled: true,
        maxNearBlackRatioIncrease: 0.12,
        measureOuterBorderLuminanceStd: (imageData, position) => {
            calls.push({
                name: 'border',
                imageId: imageData?.id,
                positionWidth: position?.width
            });
            return 0.03;
        },
        shouldApplyPreviewSmoothBackgroundCleanup: (payload) => {
            calls.push({
                name: 'gate',
                enabled: payload.enabled,
                source: payload.source,
                baselineSpatialScore: payload.baselineSpatialScore,
                borderStd: payload.borderStd
            });
            return true;
        },
        applyPreviewSmoothBackgroundCleanup: (payload) => {
            calls.push({
                name: 'cleanup',
                imageId: payload.imageData?.id,
                positionWidth: payload.position?.width
            });
            return {
                imageData: { id: 'cleaned' }
            };
        },
        createRegionCorrelationMetrics: (payload) => {
            calls.push({
                name: 'metrics',
                imageId: payload.imageData?.id,
                alphaMap: payload.alphaMap,
                includeNearBlackRatio: payload.includeNearBlackRatio
            });
            return {
                spatialScore: 0.1,
                gradientScore: 0.05,
                nearBlackRatio: 0.02
            };
        },
        calculateNearBlackRatio: (imageData, position) => {
            calls.push({
                name: 'near-black',
                imageId: imageData?.id,
                positionWidth: position?.width
            });
            return 0.01;
        },
        acceptPreviewBackgroundCleanupResult: (payload) => accepted.push(payload),
        debugTimings,
        debugTimingsEnabled: true
    });

    currentState = {
        ...currentState,
        finalImageData: { id: 'image-1' },
        alphaMap: 'alpha-1',
        finalProcessedSpatialScore: 0.2,
        source: 'preview+gain'
    };
    const cleanup = runPreviewBackgroundCleanupStage(spec);

    assert.deepEqual(cleanup, {
        cleanedImageData: { id: 'cleaned' },
        source: 'preview+gain+background-cleanup',
        cleanedSpatialScore: 0.1,
        cleanedGradientScore: 0.05,
        cleanedNearBlackRatio: 0.02,
        currentNearBlackRatio: 0.01,
        baselineSpatialScore: 0.2,
        maxNearBlackRatioIncrease: 0.12
    });
    assert.deepEqual(accepted, [cleanup]);
    assert.deepEqual(debugTimings, {
        previewBackgroundCleanupMs: 9
    });
    assert.deepEqual(calls, [
        {
            name: 'border',
            imageId: 'image-1',
            positionWidth: 48
        },
        {
            name: 'gate',
            enabled: true,
            source: 'preview+gain',
            baselineSpatialScore: 0.2,
            borderStd: 0.03
        },
        {
            name: 'cleanup',
            imageId: 'image-1',
            positionWidth: 48
        },
        {
            name: 'metrics',
            imageId: 'cleaned',
            alphaMap: 'alpha-1',
            includeNearBlackRatio: true
        },
        {
            name: 'near-black',
            imageId: 'image-1',
            positionWidth: 48
        }
    ]);
});

test('createPreviewBackgroundCleanupStageSpec should skip disabled cleanup safely', () => {
    const accepted = [];
    const calls = [];
    const spec = createPreviewBackgroundCleanupStageSpec({
        readState: () => ({
            finalImageData: { id: 'image-0' },
            alphaMap: 'alpha-0',
            position: { x: 0, y: 0, width: 48, height: 48 },
            finalProcessedSpatialScore: 0.2,
            source: 'preview'
        }),
        visualPostProcessingEnabled: false,
        measureOuterBorderLuminanceStd: () => {
            throw new Error('should not measure border when disabled');
        },
        shouldApplyPreviewSmoothBackgroundCleanup: (payload) => {
            calls.push(payload);
            return false;
        },
        applyPreviewSmoothBackgroundCleanup: () => {
            throw new Error('should not cleanup');
        },
        createRegionCorrelationMetrics: () => {
            throw new Error('should not score cleanup');
        },
        calculateNearBlackRatio: () => {
            throw new Error('should not calculate near black');
        },
        acceptPreviewBackgroundCleanupResult: (payload) => accepted.push(payload)
    });

    assert.equal(runPreviewBackgroundCleanupStage(spec), null);
    assert.deepEqual(accepted, []);
    assert.deepEqual(calls, [{
        enabled: false,
        source: 'preview',
        position: { x: 0, y: 0, width: 48, height: 48 },
        baselineSpatialScore: 0.2,
        borderStd: 0
    }]);
});

test('createTailRepairStageSequenceSpecs should build ordered dynamic tail repair specs', () => {
    const timingAnchors = {};
    const nowValues = [100, 110, 120, 130, 140, 150];
    let currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48 },
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.3,
        alphaGain: 1,
        source: 'standard'
    };
    const calls = [];
    const accepted = [];

    function makeRefiner(name) {
        return (payload) => {
            calls.push({
                name,
                source: payload.source,
                imageId: payload.currentImageData?.id,
                alphaMap: payload.currentAlphaMap ?? payload.alphaMap
            });
            return {
                imageData: { id: `${name}-image` },
                suppressionGain: calls.length / 10
            };
        };
    }

    const stages = createTailRepairStageSequenceSpecs({
        nowMs: () => nowValues.shift(),
        timingAnchors,
        readState: () => currentState,
        originalImageData: { id: 'original' },
        originalSpatialScore: 0.8,
        originalGradientScore: 0.7,
        alpha96: 'alpha-96',
        getAlphaMap: () => 'resolved-alpha',
        acceptCurrentRepairTrialResult: (stage) => {
            accepted.push(stage);
            currentState = {
                ...currentState,
                finalImageData: stage.result.imageData,
                source: stage.source
            };
        },
        refiners: {
            refineKnown48SmallMarginPriorRepairResidual: makeRefiner('small-margin'),
            refineSmallLocatedPriorRepairResidual: makeRefiner('small-located'),
            refineKnown48BoundaryRepairResidual: makeRefiner('boundary'),
            refineDarkHaloResidual: makeRefiner('dark-halo'),
            refineQuantizedNegativeBodyResidual: makeRefiner('quantized'),
            refineKnown48MidCoreBiasResidual: makeRefiner('mid-core')
        }
    });

    const results = runCurrentRepairStageSequence({ stages });

    assert.deepEqual(stages.map((stage) => stage.stage), [
        'known-48-small-margin-prior-repair',
        'small-located-prior-repair',
        'known-48-boundary-repair-rescue',
        'dark-halo-low-logo-rescue',
        'quantized-body-correction',
        'known-48-mid-core-bias-correction'
    ]);
    assert.equal(results.length, 6);
    assert.deepEqual(timingAnchors, {
        smallMarginPriorRepairStartedAt: 100,
        smallLocatedPriorRepairStartedAt: 110,
        boundaryRepairRescueStartedAt: 120,
        darkHaloRescueStartedAt: 130,
        quantizedBodyCorrectionStartedAt: 140,
        midCoreBiasStartedAt: 150
    });
    assert.deepEqual(calls.map((call) => call.imageId), [
        'image-0',
        'small-margin-image',
        'small-located-image',
        'boundary-image',
        'dark-halo-image',
        'quantized-image'
    ]);
    assert.deepEqual(accepted.map((stage) => stage.source), [
        'standard+small-margin-prior',
        'standard+small-margin-prior+small-located-prior',
        'standard+small-margin-prior+small-located-prior+boundary-repair-rescue',
        'standard+small-margin-prior+small-located-prior+boundary-repair-rescue+dark-halo-rescue',
        'standard+small-margin-prior+small-located-prior+boundary-repair-rescue+dark-halo-rescue+quantized-body-correction',
        'standard+small-margin-prior+small-located-prior+boundary-repair-rescue+dark-halo-rescue+quantized-body-correction+mid-core-bias'
    ]);
    assert.equal(accepted[5].deriveSuppressionGainFromOriginalSpatial, true);
});

test('createRepairCleanupPhaseSpecs should build dynamic cleanup phase specs', () => {
    const nowValues = [100, 103, 110, 114, 120, 122, 130, 133, 140, 144];
    let currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48 },
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.3,
        alphaGain: 1,
        source: 'standard'
    };
    const calls = [];
    const accepted = [];

    function record(name, payload) {
        calls.push({
            name,
            imageId: payload.sourceImageData?.id,
            source: payload.source,
            mode: payload.mode,
            minGradientImprovement: payload.minGradientImprovement
        });
        return {
            imageData: { id: `${name}-${calls.length}` },
            spatialScore: currentState.finalProcessedSpatialScore - 0.01,
            gradientScore: currentState.finalProcessedGradientScore - 0.01,
            suppressionGain: calls.length / 10
        };
    }

    const specs = createRepairCleanupPhaseSpecs({
        nowMs: () => nowValues.shift(),
        readState: () => currentState,
        shouldRunEdgeCleanup: true,
        useKnown48EdgeCleanup: true,
        usePreviewAnchorFastCleanup: true,
        cleanupConfig: {
            previewEdgeCleanupMaxAppliedPasses: 2,
            previewEdgeCleanupMinGradientImprovement: 0.1,
            previewEdgeCleanupMaxSpatialDrift: 0.2,
            known48EdgeCleanupMinGradientImprovement: 0.3,
            known48EdgeCleanupMaxSpatialDrift: 0.4,
            known48FlatFillMaxAppliedPasses: 2,
            known48FlatFillMinGradientImprovement: 0.5,
            known48FlatFillSecondPassMinGradientImprovement: 0.6
        },
        acceptCurrentRepairTrialResult: (stage) => {
            accepted.push(stage);
            currentState = {
                ...currentState,
                finalImageData: stage.result.imageData,
                finalProcessedSpatialScore: stage.result.spatialScore,
                finalProcessedGradientScore: stage.result.gradientScore,
                source: stage.source
            };
        },
        refiners: {
            refinePreviewResidualEdge: (payload) => record('edge', payload),
            refineKnown48FlatBackgroundResidual: (payload) => record('flat', payload),
            refineKnown48LumaEdgeResidual: (payload) => record('luma', payload),
            refineNewMargin96FlatBackgroundResidual: (payload) => record('new-margin', payload)
        }
    });

    const outcome = runRepairCleanupSpecPhase({
        createSpecs: () => specs
    });

    assert.equal(outcome.previewEdgeCleanupElapsedMs, 7);
    assert.deepEqual(calls.map((call) => call.name), [
        'edge',
        'edge',
        'flat',
        'flat',
        'luma',
        'new-margin'
    ]);
    assert.deepEqual(calls.map((call) => call.imageId), [
        'image-0',
        'edge-1',
        'edge-2',
        'flat-3',
        'flat-4',
        'luma-5'
    ]);
    assert.deepEqual(calls.slice(0, 2).map((call) => call.mode), [
        'known-48',
        'known-48'
    ]);
    assert.deepEqual(calls.slice(2, 4).map((call) => call.minGradientImprovement), [
        0.5,
        0.6
    ]);
    assert.deepEqual(accepted.map((stage) => stage.stage), [
        'known-48-edge-cleanup',
        'known-48-edge-cleanup',
        'known-48-flat-background-fill',
        'known-48-flat-background-fill',
        'known-48-luma-edge-correction',
        'new-margin-96-flat-background-fill'
    ]);
    assert.equal(accepted[0].deriveSuppressionGainFromOriginalSpatial, true);
});

test('known 48 flat fill should lower only the strong undersized entry threshold', () => {
    for (const [useStrongUndersizedAdaptiveCleanup, expected] of [
        [false, 0.28],
        [true, 0.27]
    ]) {
        let received = null;
        const specs = createRepairCleanupPhaseSpecs({
            readState: () => ({
                finalImageData: { id: 'image' },
                alphaMap: 'alpha',
                position: { x: 1, y: 2, width: 40, height: 40 },
                finalProcessedSpatialScore: 0.12,
                finalProcessedGradientScore: 0.277,
                source: 'adaptive+edge-cleanup'
            }),
            useKnown48EdgeCleanup: true,
            useStrongUndersizedAdaptiveCleanup,
            cleanupConfig: {
                known48FlatFillMinGradient: 0.28,
                strongUndersizedFlatFillMinGradient: 0.27
            },
            refiners: {
                refineKnown48FlatBackgroundResidual: (payload) => {
                    received = payload.minBaselineGradient;
                    return null;
                }
            }
        });

        specs.known48FlatFill.createStage(0);
        assert.equal(received, expected);
    }
});

test('createPostLocatedRepairStageSequenceSpecs should build dynamic post-located repair specs', () => {
    const timingAnchors = {};
    const nowValues = [200];
    let currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 96, height: 96 },
        config: { logoSize: 96 },
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.3,
        alphaGain: 1,
        source: 'standard'
    };
    const calls = [];
    const accepted = [];

    const stages = createPostLocatedRepairStageSequenceSpecs({
        nowMs: () => nowValues.shift(),
        timingAnchors,
        readState: () => currentState,
        originalImageData: { id: 'original' },
        originalSpatialScore: 0.8,
        originalGradientScore: 0.7,
        acceptCurrentRepairTrialResult: (stage) => {
            accepted.push(stage);
            currentState = {
                ...currentState,
                finalImageData: stage.result.imageData,
                finalProcessedSpatialScore: stage.result.spatialScore,
                finalProcessedGradientScore: stage.result.gradientScore,
                source: stage.source
            };
        },
        refiners: {
            refineCanonical96PositiveHaloResidual: (payload) => {
                calls.push({
                    name: 'canonical',
                    imageId: payload.currentImageData?.id,
                    source: payload.source
                });
                return {
                    imageData: { id: 'canonical-image' },
                    spatialScore: 0.35,
                    gradientScore: 0.25,
                    suppressionGain: 0.5
                };
            },
            refineSmoothLocatedResidualWithEstimatedPrior: (payload) => {
                calls.push({
                    name: 'smooth',
                    imageId: payload.currentImageData?.id,
                    source: payload.source
                });
                return {
                    imageData: { id: 'smooth-image' },
                    spatialScore: 0.3,
                    gradientScore: 0.2
                };
            }
        }
    });

    const results = runCurrentRepairStageSequence({ stages });

    assert.deepEqual(stages.map((stage) => stage.stage), [
        'canonical-96-positive-halo-rescue',
        'smooth-located-estimated-prior'
    ]);
    assert.equal(results.length, 2);
    assert.deepEqual(timingAnchors, {
        smoothPriorStartedAt: 200
    });
    assert.deepEqual(calls, [
        {
            name: 'canonical',
            imageId: 'image-0',
            source: undefined
        },
        {
            name: 'smooth',
            imageId: 'canonical-image',
            source: 'standard+canonical-96-positive-halo-rescue'
        }
    ]);
    assert.deepEqual(accepted.map((stage) => stage.source), [
        'standard+canonical-96-positive-halo-rescue',
        'standard+canonical-96-positive-halo-rescue+smooth-prior'
    ]);
    assert.equal(accepted[0].suppressionGain, 0.5);
    assert.equal(accepted[1].deriveSuppressionGainFromOriginalSpatial, true);
});

test('small located prior repair should propagate its convergence marker through stage extras', () => {
    const convergence = {
        accepted: true,
        mode: 'projected-small-dark-support',
        textureHardRejectResolved: true
    };
    const currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 464, y: 917, width: 36, height: 36 },
        config: { logoSize: 36, marginRight: 72, marginBottom: 71 },
        finalProcessedSpatialScore: 0.43,
        finalProcessedGradientScore: 0.42,
        alphaGain: 1.15,
        source: 'standard+preview-anchor+located-aggressive'
    };
    const accepted = [];
    const stages = createTailRepairStageSequenceSpecs({
        readState: () => currentState,
        originalImageData: { id: 'original' },
        originalSpatialScore: 0.95,
        originalGradientScore: 0.85,
        acceptCurrentRepairTrialResult: (stage) => accepted.push(stage),
        refiners: {
            refineSmallLocatedPriorRepairResidual: () => ({
                imageData: { id: 'repaired' },
                spatialScore: 0.08,
                gradientScore: 0.05,
                alphaGain: 1.15,
                suppressionGain: 0.87,
                darkBackgroundSupportConvergence: convergence
            })
        }
    });

    runCurrentRepairStageSequence({ stages });

    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].stage, 'small-located-prior-repair');
    assert.deepEqual(accepted[0].stageExtras, {
        darkBackgroundSupportConvergence: convergence
    });
});

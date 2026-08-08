import test from 'node:test';
import assert from 'node:assert/strict';

import { runAcceptedAlphaRepairPipeline } from '../../src/core/pipelineAcceptedExecutor.js';
import { createFirstPassPipelinePassState } from '../../src/core/pipelinePassState.js';
import { createPipelineTraceRecorder } from '../../src/core/pipelineTrace.js';

test('runAcceptedAlphaRepairPipeline should execute accepted stages and expose committed state', () => {
    const debugTimings = {};
    const nowValues = [100, 105, 110, 112, 120, 130, 140, 150, 160, 170, 180, 190];
    let state = {
        finalImageData: { id: 'initial-image' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        alphaGain: 1,
        alphaMapSource: null,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.6,
        finalProcessedSpatialScore: 0.2,
        finalProcessedGradientScore: 0.5,
        suppressionGain: 0.6,
        source: 'standard'
    };
    const pipelineTraceRecorder = createPipelineTraceRecorder();
    const calls = [];

    const result = runAcceptedAlphaRepairPipeline({
        nowMs: () => nowValues.shift() ?? 200,
        totalStartedAt: 90,
        runtimeBootstrap: {
            readPipelineState: () => state,
            applyPipelineState: (next) => {
                state = next;
            },
            cleanupFlags: {
                usePreviewAnchorFastCleanup: false,
                useKnown48EdgeCleanup: false,
                useStrongUndersizedAdaptiveCleanup: false,
                useV2SmallEdgeCleanup: false
            }
        },
        pipelineTraceRecorder,
        originalImageData: { id: 'original' },
        alpha96: 'alpha-96',
        getAlphaMap: () => 'variant-alpha',
        alpha96Variants: null,
        locatedAggressiveRemoval: false,
        debugTimings,
        debugTimingsEnabled: true,
        visualPostProcessingEnabled: true,
        templateWarp: null,
        passState: createFirstPassPipelinePassState({
            firstPassMetrics: {
                passStopReason: 'single-pass',
                passRecord: { index: 1 }
            }
        }),
        subpixelShift: null,
        metrics: {
            calculateNearBlackRatio: () => 0.01,
            computeRegionGradientCorrelation: () => 0.04,
            createRegionCorrelationMetrics: () => ({
                spatialScore: 0.11,
                gradientScore: 0.03,
                nearBlackRatio: 0.01
            }),
            measureOuterBorderLuminanceStd: () => 0.02,
            assessWatermarkResidualVisibility: () => ({ visible: false })
        },
        gates: {
            shouldRecalibrateAlphaStrength: () => false,
            shouldApplyPreviewSmoothBackgroundCleanup: () => false,
            shouldSkipLocatedAggressiveForCleanCanonical96: () => false
        },
        config: {
            maxNearBlackRatioIncrease: 0.1,
            outlineConfig: {
                outlineRefinementThreshold: 0.4,
                outlineRefinementMinGain: 0.1,
                subpixelRefineShifts: [0],
                subpixelRefineScales: [1]
            },
            repairCleanupConfig: {
                previewEdgeCleanupMaxAppliedPasses: 1
            }
        },
        refiners: {
            refineSubpixelOutline: (payload) => {
                calls.push({
                    name: 'subpixel',
                    imageId: payload.sourceImageData?.id,
                    baselineGradientScore: payload.baselineGradientScore
                });
                return {
                    imageData: { id: 'subpixel-image' },
                    spatialScore: 0.1,
                    gradientScore: 0.2,
                    alphaGain: 1.2,
                    suppressionGain: 0.7,
                    shift: { dx: 0.25, dy: 0, scale: 1 }
                };
            }
        }
    });

    assert.deepEqual(calls, [{
        name: 'subpixel',
        imageId: 'initial-image',
        baselineGradientScore: 0.5
    }]);
    assert.deepEqual(result.subpixelShift, { dx: 0.25, dy: 0, scale: 1 });
    assert.equal(result.passState.passCount, 1);
    assert.equal(result.readPipelineState().finalImageData.id, 'subpixel-image');
    assert.equal(result.readPipelineState().finalProcessedSpatialScore, 0.1);
    assert.equal(result.readPipelineState().source, 'standard+subpixel');
    assert.equal(pipelineTraceRecorder.alphaAdjustmentStages[0].stage, 'subpixel-outline-refinement');
    assert.equal(pipelineTraceRecorder.alphaAdjustmentStages[0].toAlphaGain, 1.2);
    assert.equal(debugTimings.subpixelRefinementMs, 10);
    assert.equal(typeof debugTimings.totalMs, 'number');
});

test('runAcceptedAlphaRepairPipeline should preserve a frozen source-witness trial without refinements', () => {
    const skippedTimingKeys = [
        'recalibrationMs',
        'localAlphaSearchMs',
        'overSubtractionRecalibrationMs',
        'darkCatalogFineTuneMs',
        'weakAlphaFineTuneMs',
        'previewBackgroundCleanupMs',
        'subpixelRefinementMs',
        'previewEdgeCleanupMs',
        'smallPreviewRefinementMs',
        'locatedAggressiveRemovalMs',
        'smoothPriorCleanupMs',
        'newMargin96VariantRescueMs',
        'known48AntiTemplateRescueMs',
        'powerProfileRescueMs',
        'positiveResidualRebalanceMs',
        'smallMarginPriorRepairMs',
        'smallLocatedPriorRepairMs',
        'boundaryRepairRescueMs',
        'darkHaloRescueMs',
        'quantizedBodyCorrectionMs',
        'midCoreBiasCorrectionMs'
    ];
    const debugTimings = Object.fromEntries(
        skippedTimingKeys.map((key) => [key, 999])
    );
    debugTimings.totalMs = 999;
    const state = {
        finalImageData: { id: 'fixed-gain-output' },
        alphaMap: 'alpha-48',
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        alphaGain: 0.6,
        originalSpatialScore: 0.2,
        originalGradientScore: 0.7,
        finalProcessedSpatialScore: -0.1,
        finalProcessedGradientScore: 0.05,
        source: 'standard+catalog+source-witness-rescue'
    };
    const passState = createFirstPassPipelinePassState({
        firstPassMetrics: {
            passStopReason: 'single-pass',
            passRecord: { index: 1 }
        }
    });
    const pipelineTraceRecorder = createPipelineTraceRecorder();

    const result = runAcceptedAlphaRepairPipeline({
        nowMs: () => 135,
        totalStartedAt: 100,
        runtimeBootstrap: {
            readPipelineState: () => state,
            applyPipelineState: () => {
                throw new Error('frozen trial must not be changed');
            },
            cleanupFlags: {
                usePreviewAnchorFastCleanup: false,
                useKnown48EdgeCleanup: true,
                useStrongUndersizedAdaptiveCleanup: false,
                useV2SmallEdgeCleanup: false
            }
        },
        pipelineTraceRecorder,
        originalImageData: { id: 'source' },
        debugTimings,
        debugTimingsEnabled: true,
        passState,
        freezeSelectedTrial: true,
        refiners: {
            refineLocatedAggressiveRemoval: () => {
                throw new Error('frozen trial must not search');
            }
        }
    });

    assert.equal(result.readPipelineState(), state);
    assert.equal(result.passState, passState);
    assert.deepEqual(pipelineTraceRecorder.alphaAdjustmentStages, []);
    for (const key of skippedTimingKeys) {
        assert.equal(debugTimings[key], 0, `${key} should record a skipped stage`);
    }
    assert.equal(debugTimings.totalMs, 35);
});

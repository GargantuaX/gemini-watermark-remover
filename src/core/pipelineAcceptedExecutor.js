import {
    createAlphaRescueStageSequenceSpecs,
    createFineAlphaTrialSequenceSpecs,
    createLocatedAggressiveStageSpec,
    createRecalibrationStageSpec,
    createSmallAnchorAlphaStageSequenceSpecs,
    createSubpixelOutlineAlphaStageSpecs
} from './pipelineAlphaStageSpecs.js';
import {
    createAlphaRepairPipelineRuntime,
    runCurrentAlphaStageSpecPhase,
    runCurrentRepairStageSpecPhase,
    runCurrentAlphaTrialSpecPhase,
    runLocatedAggressiveStage,
    runPreviewBackgroundCleanupStage,
    runRecalibrationStage,
    runRepairCleanupSpecPhase
} from './pipelineRuntime.js';
import {
    createPostLocatedRepairStageSequenceSpecs,
    createPreviewBackgroundCleanupStageSpec,
    createRepairCleanupPhaseSpecs,
    createTailRepairStageSequenceSpecs
} from './pipelineRepairStageSpecs.js';

export function runAcceptedAlphaRepairPipeline({
    nowMs = Date.now,
    totalStartedAt = null,
    runtimeBootstrap,
    pipelineTraceRecorder,
    originalImageData,
    alpha96,
    getAlphaMap,
    alpha96Variants = null,
    locatedAggressiveRemoval,
    debugTimings = null,
    debugTimingsEnabled = false,
    visualPostProcessingEnabled = false,
    templateWarp = null,
    passState,
    subpixelShift = null,
    metrics = {},
    gates = {},
    config = {},
    refiners = {}
} = {}) {
    const {
        readPipelineState,
        applyPipelineState,
        cleanupFlags
    } = runtimeBootstrap;
    const {
        usePreviewAnchorFastCleanup,
        useKnown48EdgeCleanup,
        useV2SmallEdgeCleanup
    } = cleanupFlags;
    const {
        recordAlphaTrialEvent,
        acceptCurrentAlphaTrialResult,
        acceptCurrentAlphaStageResult,
        acceptCurrentRepairTrialResult,
        acceptRecalibrationStageResult,
        acceptLocatedAggressiveResult,
        acceptPreviewBackgroundCleanupResult,
        assignTailDebugTimings
    } = createAlphaRepairPipelineRuntime({
        traceRecorder: pipelineTraceRecorder,
        readState: readPipelineState,
        applyState: applyPipelineState,
        debugTimings
    });

    runRecalibrationStage(createRecalibrationStageSpec({
        nowMs,
        readState: readPipelineState,
        shouldRecalibrateAlphaStrength: gates.shouldRecalibrateAlphaStrength,
        calculateNearBlackRatio: metrics.calculateNearBlackRatio,
        computeRegionGradientCorrelation: metrics.computeRegionGradientCorrelation,
        acceptRecalibrationStageResult,
        debugTimings,
        debugTimingsEnabled,
        refiners: {
            recalibrateAlphaStrength: refiners.recalibrateAlphaStrength
        }
    }));

    runCurrentAlphaTrialSpecPhase({
        createSpecs: () => {
            const current = readPipelineState();
            return createFineAlphaTrialSequenceSpecs({
                nowMs,
                readState: readPipelineState,
                originalImageData,
                originalSpatialScore: current.originalSpatialScore,
                originalGradientScore: current.originalGradientScore,
                calculateNearBlackRatio: metrics.calculateNearBlackRatio,
                acceptCurrentAlphaTrialResult,
                debugTimings,
                debugTimingsEnabled,
                refiners: {
                    recalibrateOverSubtractedAlpha: refiners.recalibrateOverSubtractedAlpha,
                    fineTuneDarkCatalogAlpha: refiners.fineTuneDarkCatalogAlpha,
                    fineTuneWeakPositiveResidualAlpha: refiners.fineTuneWeakPositiveResidualAlpha
                }
            });
        }
    });

    runPreviewBackgroundCleanupStage(createPreviewBackgroundCleanupStageSpec({
        nowMs,
        readState: readPipelineState,
        visualPostProcessingEnabled,
        maxNearBlackRatioIncrease: config.maxNearBlackRatioIncrease,
        measureOuterBorderLuminanceStd: metrics.measureOuterBorderLuminanceStd,
        shouldApplyPreviewSmoothBackgroundCleanup: gates.shouldApplyPreviewSmoothBackgroundCleanup,
        applyPreviewSmoothBackgroundCleanup: refiners.applyPreviewSmoothBackgroundCleanup,
        createRegionCorrelationMetrics: metrics.createRegionCorrelationMetrics,
        calculateNearBlackRatio: metrics.calculateNearBlackRatio,
        acceptPreviewBackgroundCleanupResult,
        debugTimings,
        debugTimingsEnabled
    }));

    const subpixelStartedAt = nowMs();
    const subpixelAlphaStageResults = runCurrentAlphaStageSpecPhase({
        createSpecs: () => createSubpixelOutlineAlphaStageSpecs({
            readState: readPipelineState,
            calculateNearBlackRatio: metrics.calculateNearBlackRatio,
            templateWarp,
            visualPostProcessingEnabled,
            usePreviewAnchorFastCleanup,
            outlineConfig: config.outlineConfig,
            acceptCurrentAlphaStageResult,
            refiners: {
                refineSubpixelOutline: refiners.refineSubpixelOutline
            }
        })
    });
    const subpixelRefined = subpixelAlphaStageResults[0];
    if (subpixelRefined) {
        subpixelShift = subpixelRefined.shift;
    }
    if (debugTimingsEnabled && debugTimings) {
        debugTimings.subpixelRefinementMs = nowMs() - subpixelStartedAt;
    }

    const shouldRunEdgeCleanup = visualPostProcessingEnabled ||
        useKnown48EdgeCleanup ||
        useV2SmallEdgeCleanup ||
        usePreviewAnchorFastCleanup;
    const {
        previewEdgeCleanupElapsedMs
    } = runRepairCleanupSpecPhase({
        createSpecs: () => createRepairCleanupPhaseSpecs({
            nowMs,
            readState: readPipelineState,
            shouldRunEdgeCleanup,
            useKnown48EdgeCleanup,
            useV2SmallEdgeCleanup,
            usePreviewAnchorFastCleanup,
            cleanupConfig: config.repairCleanupConfig,
            acceptCurrentRepairTrialResult,
            refiners: {
                refinePreviewResidualEdge: refiners.refinePreviewResidualEdge,
                refineKnown48FlatBackgroundResidual: refiners.refineKnown48FlatBackgroundResidual,
                refineKnown48LumaEdgeResidual: refiners.refineKnown48LumaEdgeResidual,
                refineNewMargin96FlatBackgroundResidual: refiners.refineNewMargin96FlatBackgroundResidual
            }
        })
    });

    const smallAnchorTimingAnchors = {};
    const smallAnchorAlphaStageResults = runCurrentAlphaStageSpecPhase({
        createSpecs: () => createSmallAnchorAlphaStageSequenceSpecs({
            nowMs,
            timingAnchors: smallAnchorTimingAnchors,
            readState: readPipelineState,
            originalImageData,
            originalGradientScore: readPipelineState().originalGradientScore,
            alpha96,
            getAlphaMap,
            visualPostProcessingEnabled,
            assessWatermarkResidualVisibility: metrics.assessWatermarkResidualVisibility,
            acceptCurrentAlphaStageResult,
            refiners: {
                refineSmallPreviewAnchorCandidate: refiners.refineSmallPreviewAnchorCandidate,
                refineSmallFixedLocalAnchorGeometry: refiners.refineSmallFixedLocalAnchorGeometry
            }
        })
    });
    const smallFixedLocalRelocated = smallAnchorAlphaStageResults[1];

    const locatedAggressiveStartedAt = nowMs();
    const locatedAggressiveRun = runLocatedAggressiveStage(createLocatedAggressiveStageSpec({
        readState: readPipelineState,
        originalImageData,
        originalSpatialScore: readPipelineState().originalSpatialScore,
        originalGradientScore: readPipelineState().originalGradientScore,
        smallFixedLocalRelocated,
        locatedAggressiveRemovalEnabled: locatedAggressiveRemoval,
        assessWatermarkResidualVisibility: metrics.assessWatermarkResidualVisibility,
        shouldSkipLocatedAggressiveForCleanCanonical96: gates.shouldSkipLocatedAggressiveForCleanCanonical96,
        recordAlphaTrialEvent,
        acceptLocatedAggressiveResult,
        currentPassState: passState,
        refiners: {
            refineLocatedAggressiveRemoval: refiners.refineLocatedAggressiveRemoval
        }
    }));
    passState = locatedAggressiveRun.passState;

    const postLocatedRepairTimingAnchors = {};
    runCurrentRepairStageSpecPhase({
        createSpecs: () => {
            const current = readPipelineState();
            return createPostLocatedRepairStageSequenceSpecs({
                nowMs,
                timingAnchors: postLocatedRepairTimingAnchors,
                readState: readPipelineState,
                originalImageData,
                originalSpatialScore: current.originalSpatialScore,
                originalGradientScore: current.originalGradientScore,
                acceptCurrentRepairTrialResult,
                refiners: {
                    refineCanonical96PositiveHaloResidual: refiners.refineCanonical96PositiveHaloResidual,
                    refineSmoothLocatedResidualWithEstimatedPrior: refiners.refineSmoothLocatedResidualWithEstimatedPrior
                }
            });
        }
    });

    const alphaRescueTimingAnchors = {};
    runCurrentAlphaStageSpecPhase({
        createSpecs: () => {
            const current = readPipelineState();
            return createAlphaRescueStageSequenceSpecs({
                nowMs,
                timingAnchors: alphaRescueTimingAnchors,
                readState: readPipelineState,
                originalImageData,
                originalSpatialScore: current.originalSpatialScore,
                originalGradientScore: current.originalGradientScore,
                resolveVariantAlphaMap: () => (
                    alpha96Variants?.['20260520'] ??
                    (typeof getAlphaMap === 'function' ? getAlphaMap('96-20260520') : null)
                ),
                acceptCurrentAlphaStageResult,
                refiners: {
                    refineNewMargin96VariantResidual: refiners.refineNewMargin96VariantResidual,
                    refineKnown48AntiTemplateResidual: refiners.refineKnown48AntiTemplateResidual,
                    refineKnown48PowerProfileResidual: refiners.refineKnown48PowerProfileResidual,
                    refineKnown48PositiveResidualRebalance: refiners.refineKnown48PositiveResidualRebalance
                }
            });
        }
    });

    const tailRepairTimingAnchors = {};
    runCurrentRepairStageSpecPhase({
        createSpecs: () => {
            const current = readPipelineState();
            return createTailRepairStageSequenceSpecs({
                nowMs,
                timingAnchors: tailRepairTimingAnchors,
                readState: readPipelineState,
                originalImageData,
                originalSpatialScore: current.originalSpatialScore,
                originalGradientScore: current.originalGradientScore,
                alpha96,
                getAlphaMap,
                acceptCurrentRepairTrialResult,
                refiners: {
                    refineKnown48SmallMarginPriorRepairResidual: refiners.refineKnown48SmallMarginPriorRepairResidual,
                    refineSmallLocatedPriorRepairResidual: refiners.refineSmallLocatedPriorRepairResidual,
                    refineKnown48BoundaryRepairResidual: refiners.refineKnown48BoundaryRepairResidual,
                    refineDarkHaloResidual: refiners.refineDarkHaloResidual,
                    refineQuantizedNegativeBodyResidual: refiners.refineQuantizedNegativeBodyResidual,
                    refineKnown48MidCoreBiasResidual: refiners.refineKnown48MidCoreBiasResidual
                }
            });
        }
    });

    if (debugTimingsEnabled && debugTimings) {
        assignTailDebugTimings({
            nowMs,
            totalStartedAt,
            previewEdgeCleanupElapsedMs,
            ...smallAnchorTimingAnchors,
            locatedAggressiveStartedAt,
            ...postLocatedRepairTimingAnchors,
            ...alphaRescueTimingAnchors,
            ...tailRepairTimingAnchors
        });
    }

    return {
        passState,
        subpixelShift,
        readPipelineState
    };
}

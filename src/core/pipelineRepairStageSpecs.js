function readPipelineRepairState(readState) {
    return typeof readState === 'function' ? readState() : {};
}

function markTimingAnchor({ timingAnchors, timingKey, nowMs }) {
    return () => {
        if (timingAnchors && timingKey) {
            timingAnchors[timingKey] = nowMs();
        }
    };
}

export function createPreviewBackgroundCleanupStageSpec({
    nowMs = Date.now,
    readState,
    visualPostProcessingEnabled = false,
    maxNearBlackRatioIncrease,
    measureOuterBorderLuminanceStd,
    shouldApplyPreviewSmoothBackgroundCleanup,
    applyPreviewSmoothBackgroundCleanup,
    createRegionCorrelationMetrics,
    calculateNearBlackRatio,
    acceptPreviewBackgroundCleanupResult,
    debugTimings = null,
    debugTimingsEnabled = false
} = {}) {
    return {
        createCleanup: () => {
            const state = readPipelineRepairState(readState);
            const previewBackgroundBorderStd = visualPostProcessingEnabled && typeof measureOuterBorderLuminanceStd === 'function'
                ? measureOuterBorderLuminanceStd(state.finalImageData, state.position)
                : 0;
            const shouldApply = typeof shouldApplyPreviewSmoothBackgroundCleanup === 'function'
                ? shouldApplyPreviewSmoothBackgroundCleanup({
                    enabled: visualPostProcessingEnabled,
                    source: state.source,
                    position: state.position,
                    baselineSpatialScore: state.finalProcessedSpatialScore,
                    borderStd: previewBackgroundBorderStd
                })
                : false;
            if (!shouldApply) {
                return null;
            }

            const cleaned = typeof applyPreviewSmoothBackgroundCleanup === 'function'
                ? applyPreviewSmoothBackgroundCleanup({
                    imageData: state.finalImageData,
                    position: state.position
                })
                : null;
            if (!cleaned) {
                return null;
            }

            const cleanedMetrics = typeof createRegionCorrelationMetrics === 'function'
                ? createRegionCorrelationMetrics({
                    imageData: cleaned.imageData,
                    alphaMap: state.alphaMap,
                    position: state.position,
                    includeNearBlackRatio: true
                })
                : {};
            return {
                cleanedImageData: cleaned.imageData,
                source: `${state.source}+background-cleanup`,
                cleanedSpatialScore: cleanedMetrics.spatialScore,
                cleanedGradientScore: cleanedMetrics.gradientScore,
                cleanedNearBlackRatio: cleanedMetrics.nearBlackRatio,
                currentNearBlackRatio: typeof calculateNearBlackRatio === 'function'
                    ? calculateNearBlackRatio(state.finalImageData, state.position)
                    : undefined,
                baselineSpatialScore: state.finalProcessedSpatialScore,
                maxNearBlackRatioIncrease
            };
        },
        acceptPreviewBackgroundCleanupResult,
        debugTimings,
        timingKey: debugTimingsEnabled ? 'previewBackgroundCleanupMs' : null,
        nowMs
    };
}

export function createRepairCleanupPhaseSpecs({
    nowMs = Date.now,
    readState,
    shouldRunEdgeCleanup = false,
    useKnown48EdgeCleanup = false,
    useStrongUndersizedAdaptiveCleanup = false,
    useV2SmallEdgeCleanup = false,
    usePreviewAnchorFastCleanup = false,
    cleanupConfig = {},
    acceptCurrentRepairTrialResult,
    refiners = {}
} = {}) {
    const {
        refinePreviewResidualEdge,
        refineKnown48FlatBackgroundResidual,
        refineKnown48LumaEdgeResidual,
        refineNewMargin96FlatBackgroundResidual
    } = refiners;
    const {
        previewEdgeCleanupMaxAppliedPasses = 1,
        previewEdgeCleanupMinGradientImprovement,
        previewEdgeCleanupMaxSpatialDrift,
        known48EdgeCleanupMinGradientImprovement,
        known48EdgeCleanupMaxSpatialDrift,
        v2SmallEdgeCleanupMinGradientImprovement,
        v2SmallEdgeCleanupMaxSpatialDrift,
        known48FlatFillMaxAppliedPasses = 1,
        known48FlatFillMinGradient = 0.28,
        strongUndersizedFlatFillMinGradient = 0.27,
        known48FlatFillMinGradientImprovement,
        known48FlatFillSecondPassMinGradientImprovement
    } = cleanupConfig;

    return {
        edgeCleanup: shouldRunEdgeCleanup ? {
            maxPasses: previewEdgeCleanupMaxAppliedPasses,
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refinePreviewResidualEdge === 'function'
                    ? refinePreviewResidualEdge({
                        sourceImageData: state.finalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        source: state.source,
                        baselineSpatialScore: state.finalProcessedSpatialScore,
                        baselineGradientScore: state.finalProcessedGradientScore,
                        minGradientImprovement: useKnown48EdgeCleanup
                            ? known48EdgeCleanupMinGradientImprovement
                            : (
                                useV2SmallEdgeCleanup
                                    ? v2SmallEdgeCleanupMinGradientImprovement
                                    : previewEdgeCleanupMinGradientImprovement
                            ),
                        maxSpatialDrift: useKnown48EdgeCleanup
                            ? known48EdgeCleanupMaxSpatialDrift
                            : (
                                useV2SmallEdgeCleanup
                                    ? v2SmallEdgeCleanupMaxSpatialDrift
                                    : previewEdgeCleanupMaxSpatialDrift
                            ),
                        allowAggressivePresets: usePreviewAnchorFastCleanup,
                        mode: useKnown48EdgeCleanup
                            ? 'known-48'
                            : (useV2SmallEdgeCleanup ? 'v2-small' : 'preview')
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            stage: () => useV2SmallEdgeCleanup
                ? 'v2-small-edge-cleanup'
                : (useKnown48EdgeCleanup ? 'known-48-edge-cleanup' : 'preview-edge-cleanup'),
            strategy: 'edge-cleanup',
            source: () => {
                const source = readPipelineRepairState(readState).source;
                return `${source}+${useV2SmallEdgeCleanup ? 'v2-small-edge-cleanup' : 'edge-cleanup'}`;
            },
            deriveSuppressionGainFromOriginalSpatial: true,
            nowMs
        } : null,
        known48FlatFill: useKnown48EdgeCleanup ? {
            maxPasses: known48FlatFillMaxAppliedPasses,
            createStage: (passIndex) => {
                const state = readPipelineRepairState(readState);
                return typeof refineKnown48FlatBackgroundResidual === 'function'
                    ? refineKnown48FlatBackgroundResidual({
                        sourceImageData: state.finalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        baselineSpatialScore: state.finalProcessedSpatialScore,
                        baselineGradientScore: state.finalProcessedGradientScore,
                        minBaselineGradient: useStrongUndersizedAdaptiveCleanup
                            ? strongUndersizedFlatFillMinGradient
                            : known48FlatFillMinGradient,
                        minGradientImprovement: passIndex === 0
                            ? known48FlatFillMinGradientImprovement
                            : known48FlatFillSecondPassMinGradientImprovement
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            stage: 'known-48-flat-background-fill',
            strategy: 'known-48-flat-fill',
            source: () => `${readPipelineRepairState(readState).source}+flat-fill`,
            deriveSuppressionGainFromOriginalSpatial: true,
        } : null,
        known48LumaEdge: useKnown48EdgeCleanup ? {
            stage: 'known-48-luma-edge-correction',
            strategy: 'luma-edge',
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineKnown48LumaEdgeResidual === 'function'
                    ? refineKnown48LumaEdgeResidual({
                        sourceImageData: state.finalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        baselineSpatialScore: state.finalProcessedSpatialScore,
                        baselineGradientScore: state.finalProcessedGradientScore
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+luma-edge`,
            deriveSuppressionGainFromOriginalSpatial: true,
        } : null,
        newMargin96FlatFill: {
            stage: 'new-margin-96-flat-background-fill',
            strategy: 'new-margin-96-flat-fill',
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineNewMargin96FlatBackgroundResidual === 'function'
                    ? refineNewMargin96FlatBackgroundResidual({
                        sourceImageData: state.finalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        config: state.config,
                        alphaGain: state.alphaGain,
                        baselineSpatialScore: state.finalProcessedSpatialScore,
                        baselineGradientScore: state.finalProcessedGradientScore
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+flat-fill`,
            deriveSuppressionGainFromOriginalSpatial: true,
        }
    };
}

export function createPostLocatedRepairStageSequenceSpecs({
    nowMs = Date.now,
    timingAnchors = {},
    readState,
    originalImageData,
    originalSpatialScore,
    originalGradientScore,
    acceptCurrentRepairTrialResult,
    refiners = {}
} = {}) {
    const {
        refineCanonical96PositiveHaloResidual,
        refineSmoothLocatedResidualWithEstimatedPrior,
        refineNewMargin96SmoothEdgeResidual
    } = refiners;

    return [
        {
            stage: 'canonical-96-positive-halo-rescue',
            strategy: 'canonical-96-positive-halo-repair',
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineCanonical96PositiveHaloResidual === 'function'
                    ? refineCanonical96PositiveHaloResidual({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        currentAlphaMap: state.alphaMap,
                        currentPosition: state.position,
                        currentConfig: state.config,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain,
                        originalSpatialScore,
                        originalGradientScore
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+canonical-96-positive-halo-rescue`,
            suppressionGain: (result) => result.suppressionGain,
        },
        {
            stage: 'smooth-located-estimated-prior',
            strategy: 'smooth-located-prior',
            beforeStage: markTimingAnchor({
                timingAnchors,
                timingKey: 'smoothPriorStartedAt',
                nowMs
            }),
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineSmoothLocatedResidualWithEstimatedPrior === 'function'
                    ? refineSmoothLocatedResidualWithEstimatedPrior({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        source: state.source,
                        alphaGain: state.alphaGain,
                        baselineSpatialScore: state.finalProcessedSpatialScore,
                        baselineGradientScore: state.finalProcessedGradientScore
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+smooth-prior`,
            deriveSuppressionGainFromOriginalSpatial: true,
        },
        {
            stage: 'new-margin-96-smooth-edge-repair',
            strategy: 'new-margin-96-smooth-edge',
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineNewMargin96SmoothEdgeResidual === 'function'
                    ? refineNewMargin96SmoothEdgeResidual({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        currentAlphaMap: state.alphaMap,
                        currentPosition: state.position,
                        currentConfig: state.config,
                        currentSource: state.source,
                        currentAlphaGain: state.alphaGain,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+smooth-edge`,
            deriveSuppressionGainFromOriginalSpatial: true,
        }
    ];
}

export function createTailRepairStageSequenceSpecs({
    nowMs = Date.now,
    timingAnchors = {},
    readState,
    originalImageData,
    originalSpatialScore,
    originalGradientScore,
    alpha96,
    getAlphaMap,
    acceptCurrentRepairTrialResult,
    refiners = {}
} = {}) {
    const {
        refineKnown48SmallMarginPriorRepairResidual,
        refineSmallLocatedPriorRepairResidual,
        refineKnown48BoundaryRepairResidual,
        refineDarkHaloResidual,
        refineQuantizedNegativeBodyResidual,
        refineKnown48MidCoreBiasResidual
    } = refiners;

    return [
        {
            stage: 'known-48-small-margin-prior-repair',
            strategy: 'small-margin-prior',
            beforeStage: markTimingAnchor({
                timingAnchors,
                timingKey: 'smallMarginPriorRepairStartedAt',
                nowMs
            }),
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineKnown48SmallMarginPriorRepairResidual === 'function'
                    ? refineKnown48SmallMarginPriorRepairResidual({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        currentAlphaMap: state.alphaMap,
                        currentPosition: state.position,
                        currentConfig: state.config,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain,
                        originalSpatialScore,
                        originalGradientScore,
                        source: state.source
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+small-margin-prior`,
            suppressionGain: (result) => result.suppressionGain,
        },
        {
            stage: 'small-located-prior-repair',
            strategy: 'small-located-prior',
            beforeStage: markTimingAnchor({
                timingAnchors,
                timingKey: 'smallLocatedPriorRepairStartedAt',
                nowMs
            }),
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineSmallLocatedPriorRepairResidual === 'function'
                    ? refineSmallLocatedPriorRepairResidual({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        currentAlphaMap: state.alphaMap,
                        currentPosition: state.position,
                        currentConfig: state.config,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain,
                        originalSpatialScore,
                        originalGradientScore,
                        source: state.source
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+small-located-prior`,
            suppressionGain: (result) => result.suppressionGain,
            stageExtras: (result) => ({
                darkBackgroundSupportConvergence:
                    result.darkBackgroundSupportConvergence ?? null
            }),
        },
        {
            stage: 'known-48-boundary-repair-rescue',
            strategy: 'boundary-repair',
            beforeStage: markTimingAnchor({
                timingAnchors,
                timingKey: 'boundaryRepairRescueStartedAt',
                nowMs
            }),
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineKnown48BoundaryRepairResidual === 'function'
                    ? refineKnown48BoundaryRepairResidual({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        currentAlphaMap: state.alphaMap,
                        currentPosition: state.position,
                        currentConfig: state.config,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain,
                        originalSpatialScore,
                        originalGradientScore
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+boundary-repair-rescue`,
            suppressionGain: (result) => result.suppressionGain,
        },
        {
            stage: 'dark-halo-low-logo-rescue',
            strategy: 'dark-halo-repair',
            beforeStage: markTimingAnchor({
                timingAnchors,
                timingKey: 'darkHaloRescueStartedAt',
                nowMs
            }),
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineDarkHaloResidual === 'function'
                    ? refineDarkHaloResidual({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        currentAlphaMap: state.alphaMap,
                        currentPosition: state.position,
                        currentConfig: state.config,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain,
                        alpha96,
                        getAlphaMap
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+dark-halo-rescue`,
            suppressionGain: (result) => result.suppressionGain,
        },
        {
            stage: 'quantized-body-correction',
            strategy: 'quantized-body-correction',
            beforeStage: markTimingAnchor({
                timingAnchors,
                timingKey: 'quantizedBodyCorrectionStartedAt',
                nowMs
            }),
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineQuantizedNegativeBodyResidual === 'function'
                    ? refineQuantizedNegativeBodyResidual({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        currentAlphaMap: state.alphaMap,
                        currentPosition: state.position,
                        currentConfig: state.config,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+quantized-body-correction`,
            suppressionGain: (result) => result.suppressionGain,
        },
        {
            stage: 'known-48-mid-core-bias-correction',
            strategy: 'mid-core-bias-correction',
            beforeStage: markTimingAnchor({
                timingAnchors,
                timingKey: 'midCoreBiasStartedAt',
                nowMs
            }),
            createStage: () => {
                const state = readPipelineRepairState(readState);
                return typeof refineKnown48MidCoreBiasResidual === 'function'
                    ? refineKnown48MidCoreBiasResidual({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        source: state.source,
                        alphaGain: state.alphaGain,
                        baselineSpatialScore: state.finalProcessedSpatialScore,
                        baselineGradientScore: state.finalProcessedGradientScore
                    })
                    : null;
            },
            acceptCurrentRepairTrialResult,
            source: () => `${readPipelineRepairState(readState).source}+mid-core-bias`,
            deriveSuppressionGainFromOriginalSpatial: true,
        }
    ];
}

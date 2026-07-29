function readPipelineAlphaState(readState) {
    return typeof readState === 'function' ? readState() : {};
}

function resolveNearBlackRatio({ calculateNearBlackRatio, imageData, position }) {
    return typeof calculateNearBlackRatio === 'function'
        ? calculateNearBlackRatio(imageData, position)
        : 0;
}

function markTimingAnchor({ timingAnchors, timingKey, nowMs }) {
    if (timingAnchors && timingKey) {
        timingAnchors[timingKey] = nowMs();
    }
}

export function createFineAlphaTrialSequenceSpecs({
    nowMs = Date.now,
    readState,
    originalImageData,
    originalSpatialScore,
    originalGradientScore,
    calculateNearBlackRatio,
    acceptCurrentAlphaTrialResult,
    debugTimings = null,
    debugTimingsEnabled = false,
    refiners = {}
} = {}) {
    const {
        refineLargeMargin48ProfileAlphaRescue,
        fineTuneEvidenceGatedLocalAlpha,
        recalibrateOverSubtractedAlpha,
        fineTuneDarkCatalogAlpha,
        fineTuneWeakPositiveResidualAlpha
    } = refiners;

    const evidenceGatedStages = [];
    if (typeof refineLargeMargin48ProfileAlphaRescue === 'function') {
        evidenceGatedStages.push({
            stage: 'large-margin-48-profile-alpha-rescue',
            strategy: 'large-margin-48-profile-alpha',
            createTrial: () => {
                const state = readPipelineAlphaState(readState);
                return typeof refineLargeMargin48ProfileAlphaRescue === 'function'
                    ? refineLargeMargin48ProfileAlphaRescue({
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
            acceptCurrentAlphaTrialResult,
            source: () => {
                const source = readPipelineAlphaState(readState).source;
                return source.includes('+profile-alpha-rescue')
                    ? source
                    : `${source}+profile-alpha-rescue`;
            },
            stageExtras: (result) => ({
                profileExponent: result.profileExponent
            })
        });
    }
    if (typeof fineTuneEvidenceGatedLocalAlpha === 'function') {
        evidenceGatedStages.push({
            stage: 'evidence-gated-local-alpha-search',
            strategy: 'evidence-gated-local-alpha',
            createTrial: () => {
                const state = readPipelineAlphaState(readState);
                return typeof fineTuneEvidenceGatedLocalAlpha === 'function'
                    ? fineTuneEvidenceGatedLocalAlpha({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain,
                        originalSpatialScore,
                        originalGradientScore,
                        originalNearBlackRatio: resolveNearBlackRatio({
                            calculateNearBlackRatio,
                            imageData: originalImageData,
                            position: state.position
                        })
                    })
                    : null;
            },
            acceptCurrentAlphaTrialResult,
            source: () => {
                const source = readPipelineAlphaState(readState).source;
                return source.includes('+fine-alpha')
                    ? source
                    : `${source}+fine-alpha`;
            },
            stageExtras: (result) => ({
                localSearchTrigger: result.localSearchTrigger,
                darkBackgroundSupportConvergence:
                    result.darkBackgroundSupportConvergence ?? null
            }),
            debugTimings,
            timingKey: debugTimingsEnabled ? 'localAlphaSearchMs' : null,
            nowMs
        });
    }

    return [
        ...evidenceGatedStages,
        {
            stage: 'over-subtraction-recalibration',
            strategy: 'over-subtraction-fine-alpha',
            createTrial: () => {
                const state = readPipelineAlphaState(readState);
                return typeof recalibrateOverSubtractedAlpha === 'function'
                    ? recalibrateOverSubtractedAlpha({
                        originalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain,
                        originalSpatialScore,
                        originalNearBlackRatio: resolveNearBlackRatio({
                            calculateNearBlackRatio,
                            imageData: originalImageData,
                            position: state.position
                        })
                    })
                    : null;
            },
            acceptCurrentAlphaTrialResult,
            source: () => {
                const source = readPipelineAlphaState(readState).source;
                return source.includes('+gain') ? source : `${source}+gain`;
            },
            debugTimings,
            timingKey: debugTimingsEnabled ? 'overSubtractionRecalibrationMs' : null,
            nowMs
        },
        {
            stage: 'dark-catalog-fine-alpha',
            strategy: 'dark-catalog-fine-alpha',
            createTrial: () => {
                const state = readPipelineAlphaState(readState);
                return typeof fineTuneDarkCatalogAlpha === 'function'
                    ? fineTuneDarkCatalogAlpha({
                        originalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        source: state.source,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain,
                        originalSpatialScore,
                        originalGradientScore,
                        originalNearBlackRatio: resolveNearBlackRatio({
                            calculateNearBlackRatio,
                            imageData: originalImageData,
                            position: state.position
                        })
                    })
                    : null;
            },
            acceptCurrentAlphaTrialResult,
            source: () => {
                const source = readPipelineAlphaState(readState).source;
                return source.includes('+fine-alpha') ? source : `${source}+fine-alpha`;
            },
            debugTimings,
            timingKey: debugTimingsEnabled ? 'darkCatalogFineTuneMs' : null,
            nowMs
        },
        {
            stage: 'weak-positive-residual-fine-alpha',
            strategy: 'over-subtraction-fine-alpha',
            createTrial: () => {
                const state = readPipelineAlphaState(readState);
                return typeof fineTuneWeakPositiveResidualAlpha === 'function'
                    ? fineTuneWeakPositiveResidualAlpha({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentAlphaGain: state.alphaGain,
                        originalSpatialScore,
                        originalGradientScore,
                        originalNearBlackRatio: resolveNearBlackRatio({
                            calculateNearBlackRatio,
                            imageData: originalImageData,
                            position: state.position
                        })
                    })
                    : null;
            },
            acceptCurrentAlphaTrialResult,
            source: () => {
                const source = readPipelineAlphaState(readState).source;
                return source.includes('+fine-alpha') ? source : `${source}+fine-alpha`;
            },
            debugTimings,
            timingKey: debugTimingsEnabled ? 'weakAlphaFineTuneMs' : null,
            nowMs
        }
    ];
}

export function createRecalibrationStageSpec({
    nowMs = Date.now,
    readState,
    shouldRecalibrateAlphaStrength,
    calculateNearBlackRatio,
    computeRegionGradientCorrelation,
    acceptRecalibrationStageResult,
    debugTimings = null,
    debugTimingsEnabled = false,
    refiners = {}
} = {}) {
    const {
        recalibrateAlphaStrength
    } = refiners;
    const state = readPipelineAlphaState(readState);

    return {
        shouldRun: typeof shouldRecalibrateAlphaStrength === 'function'
            ? shouldRecalibrateAlphaStrength({
                originalScore: state.originalSpatialScore,
                processedScore: state.finalProcessedSpatialScore,
                suppressionGain: state.suppressionGain
            })
            : false,
        createRecalibration: () => {
            const current = readPipelineAlphaState(readState);
            return typeof recalibrateAlphaStrength === 'function'
                ? recalibrateAlphaStrength({
                    sourceImageData: current.finalImageData,
                    alphaMap: current.alphaMap,
                    position: current.position,
                    originalSpatialScore: current.originalSpatialScore,
                    processedSpatialScore: current.finalProcessedSpatialScore,
                    originalNearBlackRatio: resolveNearBlackRatio({
                        calculateNearBlackRatio,
                        imageData: current.finalImageData,
                        position: current.position
                    })
                })
                : null;
        },
        computeGradientScore: (recalibrated) => {
            const current = readPipelineAlphaState(readState);
            return typeof computeRegionGradientCorrelation === 'function'
                ? computeRegionGradientCorrelation({
                    imageData: recalibrated.imageData,
                    alphaMap: current.alphaMap,
                    region: {
                        x: current.position.x,
                        y: current.position.y,
                        size: current.position.width
                    }
                })
                : undefined;
        },
        acceptRecalibrationStageResult,
        debugTimings,
        timingKey: debugTimingsEnabled ? 'recalibrationMs' : null,
        nowMs
    };
}

export function createSmallAnchorAlphaStageSequenceSpecs({
    nowMs = Date.now,
    timingAnchors = {},
    readState,
    originalImageData,
    originalGradientScore,
    alpha96,
    getAlphaMap,
    visualPostProcessingEnabled = false,
    assessWatermarkResidualVisibility,
    acceptCurrentAlphaStageResult,
    refiners = {}
} = {}) {
    const {
        refineSmallPreviewAnchorCandidate,
        refineSmallFixedLocalAnchorGeometry
    } = refiners;

    markTimingAnchor({
        timingAnchors,
        timingKey: 'smallPreviewRefinementStartedAt',
        nowMs
    });

    return [
        {
            stage: 'small-preview-refinement',
            createStage: () => {
                const state = readPipelineAlphaState(readState);
                const refined = visualPostProcessingEnabled && typeof refineSmallPreviewAnchorCandidate === 'function'
                    ? refineSmallPreviewAnchorCandidate({
                        originalImageData,
                        source: state.source,
                        position: state.position,
                        originalGradientScore,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        getAlphaMap
                    })
                    : null;
                if (!refined) return null;
                const refinedPosition = refined.position;
                return {
                    ...refined,
                    config: {
                        logoSize: refinedPosition.width,
                        marginRight: originalImageData.width - refinedPosition.x - refinedPosition.width,
                        marginBottom: originalImageData.height - refinedPosition.y - refinedPosition.height
                    }
                };
            },
            acceptCurrentAlphaStageResult,
            source: () => `${readPipelineAlphaState(readState).source}+small-preview-refine`,
        },
        {
            stage: 'small-fixed-local-anchor-relocation',
            createStage: () => {
                const state = readPipelineAlphaState(readState);
                const currentResidualVisibility = typeof assessWatermarkResidualVisibility === 'function'
                    ? assessWatermarkResidualVisibility({
                        imageData: state.finalImageData,
                        position: state.position,
                        alphaMap: state.alphaMap
                    })
                    : null;
                return typeof refineSmallFixedLocalAnchorGeometry === 'function'
                    ? refineSmallFixedLocalAnchorGeometry({
                        originalImageData,
                        currentAlphaMap: state.alphaMap,
                        currentPosition: state.position,
                        currentConfig: state.config,
                        currentSource: state.source,
                        currentGradientScore: state.finalProcessedGradientScore,
                        currentResidualVisibility,
                        alpha96,
                        getAlphaMap
                    })
                    : null;
            },
            acceptCurrentAlphaStageResult,
            source: () => `${readPipelineAlphaState(readState).source}+small-anchor-relocated`,
            stageExtras: {
                allowSameAlphaGain: true
            }
        }
    ];
}

export function createSubpixelOutlineAlphaStageSpecs({
    readState,
    calculateNearBlackRatio,
    templateWarp = null,
    visualPostProcessingEnabled = false,
    usePreviewAnchorFastCleanup = false,
    outlineConfig = {},
    acceptCurrentAlphaStageResult,
    refiners = {}
} = {}) {
    const {
        refineSubpixelOutline
    } = refiners;
    const {
        outlineRefinementThreshold,
        outlineRefinementMinGain,
        subpixelRefineShifts,
        subpixelRefineScales,
        minGradientImprovement = 0.04,
        maxSpatialDrift = 0.08
    } = outlineConfig;

    return [
        {
            stage: 'subpixel-outline-refinement',
            createStage: () => {
                const state = readPipelineAlphaState(readState);
                if (
                    !visualPostProcessingEnabled ||
                    usePreviewAnchorFastCleanup ||
                    state.finalProcessedSpatialScore > 0.3 ||
                    state.finalProcessedGradientScore < outlineRefinementThreshold
                ) {
                    return null;
                }
                const originalNearBlackRatio = resolveNearBlackRatio({
                    calculateNearBlackRatio,
                    imageData: state.finalImageData,
                    position: state.position
                });
                const baselineShift = templateWarp ?? { dx: 0, dy: 0, scale: 1 };
                return typeof refineSubpixelOutline === 'function'
                    ? refineSubpixelOutline({
                        sourceImageData: state.finalImageData,
                        alphaMap: state.alphaMap,
                        position: state.position,
                        alphaGain: state.alphaGain,
                        originalNearBlackRatio,
                        baselineSpatialScore: state.finalProcessedSpatialScore,
                        baselineGradientScore: state.finalProcessedGradientScore,
                        baselineShift,
                        minGain: outlineRefinementMinGain,
                        shiftCandidates: subpixelRefineShifts,
                        scaleCandidates: subpixelRefineScales,
                        minGradientImprovement,
                        maxSpatialDrift
                    })
                    : null;
            },
            acceptCurrentAlphaStageResult,
            source: () => `${readPipelineAlphaState(readState).source}+subpixel`,
            suppressionGain: null
        }
    ];
}

export function createLocatedAggressiveStageSpec({
    readState,
    originalImageData,
    originalSpatialScore,
    originalGradientScore,
    smallFixedLocalRelocated,
    locatedAggressiveRemovalEnabled = true,
    assessWatermarkResidualVisibility,
    shouldSkipLocatedAggressiveForCleanCanonical96,
    recordAlphaTrialEvent,
    acceptLocatedAggressiveResult,
    currentPassState,
    refiners = {}
} = {}) {
    const {
        refineLocatedAggressiveRemoval
    } = refiners;
    const state = readPipelineAlphaState(readState);
    const locatedAggressiveResidualVisibility = typeof assessWatermarkResidualVisibility === 'function'
        ? assessWatermarkResidualVisibility({
            imageData: state.finalImageData,
            position: state.position,
            alphaMap: state.alphaMap
        })
        : null;
    const baseShouldRun =
        locatedAggressiveRemovalEnabled !== false &&
        smallFixedLocalRelocated?.residualVisibility?.visible !== false &&
        locatedAggressiveResidualVisibility?.visible !== false;
    const skipCleanCanonical96 = baseShouldRun && typeof shouldSkipLocatedAggressiveForCleanCanonical96 === 'function'
        ? shouldSkipLocatedAggressiveForCleanCanonical96({
            config: state.config,
            alphaGain: state.alphaGain,
            originalSpatialScore,
            originalGradientScore,
            currentSpatialScore: state.finalProcessedSpatialScore,
            currentGradientScore: state.finalProcessedGradientScore
        })
        : false;

    return {
        shouldRun: baseShouldRun && !skipCleanCanonical96,
        createStage: ({ onRejected } = {}) => {
            const current = readPipelineAlphaState(readState);
            return typeof refineLocatedAggressiveRemoval === 'function'
                ? refineLocatedAggressiveRemoval({
                    originalImageData,
                    currentImageData: current.finalImageData,
                    alphaMap: current.alphaMap,
                    position: current.position,
                    currentSpatialScore: current.finalProcessedSpatialScore,
                    currentGradientScore: current.finalProcessedGradientScore,
                    currentAlphaGain: current.alphaGain,
                    onRejected
                })
                : null;
        },
        recordAlphaTrialEvent,
        acceptLocatedAggressiveResult,
        currentPassState,
        source: () => {
            const currentSource = readPipelineAlphaState(readState).source;
            return currentSource.includes('+located-aggressive')
                ? currentSource
                : `${currentSource}+located-aggressive`;
        },
        fromAlphaGain: state.alphaGain,
        beforeSpatialScore: state.finalProcessedSpatialScore,
        beforeGradientScore: state.finalProcessedGradientScore,
        originalSpatialScore
    };
}

function markAlphaRescueTimingAnchors({
    timingAnchors,
    nowMs,
    resolveVariantAlphaMap
}) {
    if (!timingAnchors) {
        return typeof resolveVariantAlphaMap === 'function' ? resolveVariantAlphaMap() : null;
    }

    timingAnchors.newMargin96VariantRescueStartedAt = nowMs();
    const variantAlphaMap = typeof resolveVariantAlphaMap === 'function'
        ? resolveVariantAlphaMap()
        : null;
    timingAnchors.known48AntiTemplateRescueStartedAt = nowMs();
    timingAnchors.powerProfileRescueStartedAt = nowMs();
    timingAnchors.positiveResidualRebalanceStartedAt = nowMs();
    return variantAlphaMap;
}

export function createAlphaRescueStageSequenceSpecs({
    nowMs = Date.now,
    timingAnchors = {},
    readState,
    originalImageData,
    originalSpatialScore,
    originalGradientScore,
    resolveVariantAlphaMap,
    acceptCurrentAlphaStageResult,
    refiners = {}
} = {}) {
    const {
        refineNewMargin96VariantResidual,
        refineKnown48AntiTemplateResidual,
        refineKnown48PowerProfileResidual,
        refineKnown48PositiveResidualRebalance
    } = refiners;
    const variantAlphaMap = markAlphaRescueTimingAnchors({
        timingAnchors,
        nowMs,
        resolveVariantAlphaMap
    });

    return [
        {
            stage: 'new-margin-96-variant-rescue',
            strategy: 'new-margin-96-variant',
            createStage: () => {
                const state = readPipelineAlphaState(readState);
                return typeof refineNewMargin96VariantResidual === 'function'
                    ? refineNewMargin96VariantResidual({
                        originalImageData,
                        currentImageData: state.finalImageData,
                        currentAlphaMap: state.alphaMap,
                        currentPosition: state.position,
                        currentConfig: state.config,
                        currentSpatialScore: state.finalProcessedSpatialScore,
                        currentGradientScore: state.finalProcessedGradientScore,
                        originalSpatialScore,
                        originalGradientScore,
                        variantAlphaMap
                    })
                    : null;
            },
            acceptCurrentAlphaStageResult,
            source: () => `${readPipelineAlphaState(readState).source}+new-margin-variant`,
            stageExtras: (result) => ({
                profileExponent: result.profileExponent
            })
        },
        {
            stage: 'known-48-anti-template-rescue',
            createStage: () => {
                const state = readPipelineAlphaState(readState);
                return typeof refineKnown48AntiTemplateResidual === 'function'
                    ? refineKnown48AntiTemplateResidual({
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
            acceptCurrentAlphaStageResult,
            source: () => `${readPipelineAlphaState(readState).source}+anti-template-rescue`,
            stageExtras: {
                allowSameAlphaGain: true
            }
        },
        {
            stage: 'known-48-power-profile-rescue',
            strategy: 'known-48-power-profile',
            createStage: () => {
                const state = readPipelineAlphaState(readState);
                return typeof refineKnown48PowerProfileResidual === 'function'
                    ? refineKnown48PowerProfileResidual({
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
            acceptCurrentAlphaStageResult,
            source: () => `${readPipelineAlphaState(readState).source}+power-profile-rescue`,
            stageExtras: (result) => ({
                profileExponent: result.profileExponent,
                allowSameAlphaGain: true
            })
        },
        {
            stage: 'known-48-positive-residual-rebalance',
            strategy: 'known-48-positive-residual-rebalance',
            createStage: () => {
                const state = readPipelineAlphaState(readState);
                return typeof refineKnown48PositiveResidualRebalance === 'function'
                    ? refineKnown48PositiveResidualRebalance({
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
            acceptCurrentAlphaStageResult,
            source: () => `${readPipelineAlphaState(readState).source}+residual-rebalance`,
            stageExtras: (result) => ({
                profileExponent: result.profileExponent,
                allowSameAlphaGain: true
            })
        }
    ];
}

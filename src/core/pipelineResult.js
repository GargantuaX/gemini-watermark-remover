import {
    createAcceptedWatermarkMeta,
    createRejectedWatermarkMeta,
    createUnsafeVisibleResidualWatermarkMeta
} from './pipelineMeta.js';

export function createRejectedPipelineResult({
    imageData,
    debugTimings = {},
    reason = 'no-watermark-detected',
    adaptiveConfidence = null,
    originalSpatialScore = null,
    originalGradientScore = null,
    source = 'skipped',
    decisionTier = 'insufficient',
    selectionDebug = null
} = {}) {
    return {
        imageData,
        meta: createRejectedWatermarkMeta({
            reason,
            adaptiveConfidence,
            originalSpatialScore,
            originalGradientScore,
            source,
            decisionTier,
            selectionDebug
        }),
        debugTimings
    };
}

export function createAcceptedPipelineResult({
    finalImageData,
    debugTimings = {},
    selectedTrial = null,
    selectionSource = null,
    position = null,
    config = null,
    adaptiveConfidence = null,
    originalSpatialScore = null,
    originalGradientScore = null,
    finalProcessedSpatialScore = null,
    finalProcessedGradientScore = null,
    suppressionGain = null,
    residualVisibility = null,
    templateWarp = null,
    alphaGain = 1,
    passCount = 0,
    attemptedPassCount = 0,
    passStopReason = null,
    passes = null,
    source = 'standard',
    decisionTier = null,
    subpixelShift = null,
    alphaAdjustmentStages = null,
    alphaTrialEvents = null,
    alphaMapSource = null,
    selectionDebug = null
} = {}) {
    return {
        imageData: finalImageData,
        meta: createAcceptedWatermarkMeta({
            selectedTrial,
            selectionSource,
            position,
            config,
            adaptiveConfidence,
            originalSpatialScore,
            originalGradientScore,
            processedSpatialScore: finalProcessedSpatialScore,
            processedGradientScore: finalProcessedGradientScore,
            suppressionGain,
            residualVisibility,
            templateWarp,
            alphaGain,
            passCount,
            attemptedPassCount,
            passStopReason,
            passes,
            source,
            decisionTier,
            subpixelShift,
            alphaAdjustmentStages,
            alphaTrialEvents,
            alphaMapSource,
            selectionDebug
        }),
        debugTimings
    };
}

export function createAcceptedPipelineResultFromState({
    pipelineState = {},
    passState = {},
    traceState = {},
    resultContext = {},
    residualVisibility = null,
    selectionDebug = null
} = {}) {
    return createAcceptedPipelineResult({
        finalImageData: pipelineState.finalImageData,
        debugTimings: resultContext.debugTimings,
        selectedTrial: resultContext.selectedTrial,
        selectionSource: resultContext.selectionSource,
        position: pipelineState.position,
        config: pipelineState.config,
        adaptiveConfidence: resultContext.adaptiveConfidence,
        originalSpatialScore: pipelineState.originalSpatialScore,
        originalGradientScore: pipelineState.originalGradientScore,
        finalProcessedSpatialScore: pipelineState.finalProcessedSpatialScore,
        finalProcessedGradientScore: pipelineState.finalProcessedGradientScore,
        suppressionGain: pipelineState.suppressionGain,
        residualVisibility,
        templateWarp: resultContext.templateWarp,
        alphaGain: pipelineState.alphaGain,
        passCount: passState.passCount,
        attemptedPassCount: passState.attemptedPassCount,
        passStopReason: passState.passStopReason,
        passes: passState.passes,
        source: pipelineState.source,
        decisionTier: resultContext.decisionTier,
        subpixelShift: resultContext.subpixelShift,
        alphaAdjustmentStages: traceState.alphaAdjustmentStages,
        alphaTrialEvents: traceState.alphaTrialEvents,
        alphaMapSource: pipelineState.alphaMapSource,
        selectionDebug
    });
}

export function createUnsafeVisibleResidualPipelineResultFromState({
    originalImageData = null,
    pipelineState = {},
    passState = {},
    traceState = {},
    resultContext = {},
    residualVisibility = null,
    selectionDebug = null
} = {}) {
    return {
        imageData: originalImageData ?? pipelineState.finalImageData,
        meta: createUnsafeVisibleResidualWatermarkMeta({
            selectedTrial: resultContext.selectedTrial,
            position: pipelineState.position,
            config: pipelineState.config,
            adaptiveConfidence: resultContext.adaptiveConfidence,
            originalSpatialScore: pipelineState.originalSpatialScore,
            originalGradientScore: pipelineState.originalGradientScore,
            processedSpatialScore: pipelineState.finalProcessedSpatialScore,
            processedGradientScore: pipelineState.finalProcessedGradientScore,
            suppressionGain: pipelineState.suppressionGain,
            residualVisibility,
            templateWarp: resultContext.templateWarp,
            alphaGain: pipelineState.alphaGain,
            passCount: passState.passCount,
            attemptedPassCount: passState.attemptedPassCount,
            passStopReason: passState.passStopReason,
            passes: passState.passes,
            source: pipelineState.source,
            decisionTier: resultContext.decisionTier,
            subpixelShift: resultContext.subpixelShift,
            alphaAdjustmentStages: traceState.alphaAdjustmentStages,
            alphaMapSource: pipelineState.alphaMapSource,
            selectionDebug
        }),
        debugTimings: resultContext.debugTimings
    };
}

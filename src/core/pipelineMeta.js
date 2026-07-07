import {
    createAcceptedDecisionPath,
    createDetectionCandidateFromSelectedTrial,
    createRejectedDecisionPath
} from './candidateEvaluation.js';

function normalizeMetaPosition(position) {
    if (!position) return null;

    const { x, y, width, height } = position;
    if (![x, y, width, height].every((value) => Number.isFinite(value))) {
        return null;
    }

    return { x, y, width, height };
}

function normalizeMetaConfig(config) {
    if (!config) return null;

    const { logoSize, marginRight, marginBottom } = config;
    if (![logoSize, marginRight, marginBottom].every((value) => Number.isFinite(value))) {
        return null;
    }

    return {
        logoSize,
        marginRight,
        marginBottom,
        ...(typeof config.alphaVariant === 'string' && config.alphaVariant.length > 0
            ? { alphaVariant: config.alphaVariant }
            : {})
    };
}

export function createWatermarkMeta({
    position = null,
    config = null,
    adaptiveConfidence = null,
    originalSpatialScore = null,
    originalGradientScore = null,
    processedSpatialScore = null,
    processedGradientScore = null,
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
    applied = true,
    skipReason = null,
    subpixelShift = null,
    selectionDebug = null,
    alphaAdjustmentStages = null,
    alphaMapSource = null,
    decisionPath = null
} = {}) {
    const normalizedPosition = normalizeMetaPosition(position);

    return {
        applied,
        skipReason: applied ? null : skipReason,
        size: normalizedPosition ? normalizedPosition.width : null,
        position: normalizedPosition,
        config: normalizeMetaConfig(config),
        detection: {
            adaptiveConfidence,
            originalSpatialScore,
            originalGradientScore,
            processedSpatialScore,
            processedGradientScore,
            suppressionGain,
            residualVisibility
        },
        templateWarp: templateWarp ?? null,
        alphaGain,
        passCount,
        attemptedPassCount,
        passStopReason,
        passes: Array.isArray(passes) ? passes : null,
        // decisionTier is the normalized contract used by UI and attribution.
        // source remains as a verbose execution trace for debugging/tests.
        source,
        decisionTier,
        subpixelShift: subpixelShift ?? null,
        selectionDebug,
        alphaAdjustmentStages: Array.isArray(alphaAdjustmentStages) ? alphaAdjustmentStages : null,
        alphaMapSource: alphaMapSource ?? null,
        decisionPath: decisionPath ?? null
    };
}

export function createAcceptedWatermarkMeta({
    selectedTrial = null,
    selectionSource = null,
    position = null,
    config = null,
    adaptiveConfidence = null,
    originalSpatialScore = null,
    originalGradientScore = null,
    processedSpatialScore = null,
    processedGradientScore = null,
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
    selectionDebug = null,
    alphaAdjustmentStages = null,
    alphaTrialEvents = null,
    alphaMapSource = null
} = {}) {
    const decisionPath = createAcceptedDecisionPath({
        selectedTrial,
        selectionSource,
        source,
        decisionTier,
        config,
        position,
        adaptiveConfidence,
        alphaGain,
        alphaMapSource,
        templateWarp,
        alphaAdjustmentStages,
        alphaTrialEvents,
        originalSpatialScore,
        originalGradientScore,
        processedSpatialScore,
        processedGradientScore,
        suppressionGain,
        residualVisibility
    });

    return createWatermarkMeta({
        position,
        config,
        adaptiveConfidence,
        originalSpatialScore,
        originalGradientScore,
        processedSpatialScore,
        processedGradientScore,
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
        applied: true,
        subpixelShift,
        alphaAdjustmentStages,
        alphaMapSource,
        selectionDebug,
        decisionPath
    });
}

export function createRejectedWatermarkMeta({
    reason = 'no-watermark-detected',
    source = 'skipped',
    decisionTier = 'insufficient',
    adaptiveConfidence = null,
    originalSpatialScore = null,
    originalGradientScore = null,
    selectionDebug = null
} = {}) {
    return createWatermarkMeta({
        adaptiveConfidence,
        originalSpatialScore,
        originalGradientScore,
        processedSpatialScore: originalSpatialScore,
        processedGradientScore: originalGradientScore,
        suppressionGain: 0,
        alphaGain: 1,
        source,
        decisionTier,
        applied: false,
        skipReason: reason,
        selectionDebug,
        decisionPath: createRejectedDecisionPath({
            reason,
            source,
            decisionTier,
            originalSpatialScore,
            originalGradientScore,
            adaptiveConfidence
        })
    });
}

export function createUnsafeVisibleResidualWatermarkMeta({
    selectedTrial = null,
    position = null,
    config = null,
    adaptiveConfidence = null,
    originalSpatialScore = null,
    originalGradientScore = null,
    processedSpatialScore = null,
    processedGradientScore = null,
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
    selectionDebug = null,
    alphaAdjustmentStages = null,
    alphaMapSource = null
} = {}) {
    const reason = 'visible-residual-unsafe-damage';
    const resolvedPosition = position ?? selectedTrial?.position ?? null;
    const resolvedConfig = config ?? selectedTrial?.config ?? null;
    const detectionCandidate = createDetectionCandidateFromSelectedTrial({
        selectedTrial,
        source,
        config: resolvedConfig,
        position: resolvedPosition,
        adaptiveConfidence,
        decisionTier
    });
    const decisionPath = {
        version: 1,
        decision: 'reject',
        detectionSource: detectionCandidate.source,
        alphaSource: null,
        repairSource: null,
        evaluationDecision: 'rejected',
        blockedGate: reason,
        riskFlags: [],
        detectionCandidate,
        alphaTrial: null,
        repairTrial: null,
        evaluation: {
            pathId: `${detectionCandidate.id}->reject`,
            detectionId: detectionCandidate.id,
            alphaTrialId: null,
            repairTrialId: null,
            eligible: false,
            decision: 'reject',
            blockedGate: reason,
            riskFlags: [],
            evidenceClass: 'unsafe-visible-residual',
            explanation: reason
        }
    };

    return createWatermarkMeta({
        position: resolvedPosition,
        config: resolvedConfig,
        adaptiveConfidence,
        originalSpatialScore,
        originalGradientScore,
        processedSpatialScore,
        processedGradientScore,
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
        applied: false,
        skipReason: reason,
        subpixelShift,
        alphaAdjustmentStages,
        alphaMapSource,
        selectionDebug,
        decisionPath
    });
}

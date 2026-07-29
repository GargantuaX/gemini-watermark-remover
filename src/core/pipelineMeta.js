import {
    createAcceptedDecisionPath,
    createDetectionCandidateFromSelectedTrial,
    createRejectedDecisionPath
} from './candidateEvaluation.js';
import { reconcileAlphaTrialWithFinalQualitySignals } from './pipelineAlphaTrial.js';

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

const QUALITY_STATUSES = new Set([
    'clean',
    'visible-residual',
    'possible-content-damage',
    'mixed'
]);

function normalizeQualityStatus(status) {
    return QUALITY_STATUSES.has(status) ? status : null;
}

function normalizeSelectionConfidence(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function normalizeSelectedCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    return {
        id: candidate.id ?? null,
        family: candidate.family ?? null,
        rank: Number.isFinite(candidate.rank) ? candidate.rank : null,
        source: candidate.source ?? null,
        config: normalizeMetaConfig(candidate.config),
        position: normalizeMetaPosition(candidate.position),
        alphaProfile: candidate.alphaProfile ?? null,
        polarity: candidate.polarity ?? null
    };
}

function normalizeCandidateSummary(summary) {
    if (!summary || typeof summary !== 'object') return null;
    return {
        id: summary.id ?? null,
        family: summary.family ?? null,
        rank: Number.isFinite(summary.rank) ? summary.rank : null,
        valid: summary.valid === true,
        finalScore: Number.isFinite(summary.finalScore) ? summary.finalScore : null,
        qualityStatus: normalizeQualityStatus(summary.qualityStatus),
        qualitySignals: summary.qualitySignals ?? null,
        error: typeof summary.error === 'string' ? summary.error : null
    };
}

function reconcileDecisionPathQuality(decisionPath, qualitySignals) {
    if (!decisionPath?.alphaTrial) {
        return decisionPath;
    }
    const alphaTrial = reconcileAlphaTrialWithFinalQualitySignals(
        decisionPath.alphaTrial,
        qualitySignals
    );
    if (alphaTrial === decisionPath.alphaTrial) return decisionPath;

    return {
        ...decisionPath,
        alphaTrial
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
    decisionPath = null,
    bestEffort = false,
    retryRecommended = null,
    qualityStatus = null,
    selectionConfidence = null,
    selectedCandidate = null,
    qualitySignals = null,
    candidateSummaries = null
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
        decisionPath: decisionPath ?? null,
        bestEffort: bestEffort === true,
        retryRecommended: typeof retryRecommended === 'boolean' ? retryRecommended : null,
        qualityStatus: normalizeQualityStatus(qualityStatus),
        selectionConfidence: normalizeSelectionConfidence(selectionConfidence),
        selectedCandidate: normalizeSelectedCandidate(selectedCandidate),
        qualitySignals: qualitySignals ?? null,
        candidateSummaries: Array.isArray(candidateSummaries)
            ? candidateSummaries.map(normalizeCandidateSummary).filter(Boolean)
            : null
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
    alphaMapSource = null,
    bestEffort = false,
    retryRecommended = null,
    qualityStatus = null,
    selectionConfidence = null,
    selectedCandidate = null,
    qualitySignals = null,
    candidateSummaries = null
} = {}) {
    const initialDecisionPath = createAcceptedDecisionPath({
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
    const decisionPath = reconcileDecisionPathQuality(
        initialDecisionPath,
        qualitySignals
    );

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
        decisionPath,
        bestEffort,
        retryRecommended,
        qualityStatus,
        selectionConfidence,
        selectedCandidate,
        qualitySignals,
        candidateSummaries
    });
}

export function attachTopNSelectionMeta(meta, {
    qualityStatus,
    selectionConfidence,
    selectedCandidate,
    qualitySignals,
    candidateSummaries
} = {}) {
    const normalized = createWatermarkMeta({
        applied: true,
        bestEffort: true,
        retryRecommended: false,
        qualityStatus,
        selectionConfidence,
        selectedCandidate,
        qualitySignals,
        candidateSummaries
    });
    const decisionPath = reconcileDecisionPathQuality(
        meta?.decisionPath,
        normalized.qualitySignals
    );

    return {
        ...meta,
        applied: true,
        skipReason: null,
        bestEffort: normalized.bestEffort,
        retryRecommended: normalized.retryRecommended,
        qualityStatus: normalized.qualityStatus,
        selectionConfidence: normalized.selectionConfidence,
        selectedCandidate: normalized.selectedCandidate,
        qualitySignals: normalized.qualitySignals,
        candidateSummaries: normalized.candidateSummaries,
        decisionPath
    };
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

export function createFailClosedWatermarkMeta({
    selectedTrial = null,
    reason = 'visible-residual-unsafe-damage',
    evidenceClass = 'unsafe-visible-residual',
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
            evidenceClass,
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

export function createUnsafeVisibleResidualWatermarkMeta(options = {}) {
    return createFailClosedWatermarkMeta(options);
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

export function normalizeAlphaTrialEventForTrace(event) {
    return event && typeof event === 'object' ? event : null;
}

export function normalizeAlphaAdjustmentStageForTrace(stagePayload = {}) {
    if (!stagePayload || typeof stagePayload !== 'object') return null;
    const {
        stage,
        fromAlphaGain,
        toAlphaGain,
        beforeSpatialScore,
        beforeGradientScore,
        afterSpatialScore,
        afterGradientScore,
        suppressionGain: stageSuppressionGain = null,
        cost = null,
        profileExponent = null,
        alphaStrategy = null,
        repairStrategy = null,
        allowSameAlphaGain = false,
        ...stageExtras
    } = stagePayload;

    if (!stage || !Number.isFinite(fromAlphaGain) || !Number.isFinite(toAlphaGain)) return null;
    if (!allowSameAlphaGain && Math.abs(fromAlphaGain - toAlphaGain) < 0.0001) return null;

    return {
        ...stageExtras,
        stage,
        fromAlphaGain,
        toAlphaGain,
        beforeSpatialScore: finiteOrNull(beforeSpatialScore),
        beforeGradientScore: finiteOrNull(beforeGradientScore),
        afterSpatialScore: finiteOrNull(afterSpatialScore),
        afterGradientScore: finiteOrNull(afterGradientScore),
        suppressionGain: finiteOrNull(stageSuppressionGain),
        cost: finiteOrNull(cost),
        profileExponent: finiteOrNull(profileExponent),
        alphaStrategy: typeof alphaStrategy === 'string' && alphaStrategy.length > 0 ? alphaStrategy : null,
        repairStrategy: typeof repairStrategy === 'string' && repairStrategy.length > 0 ? repairStrategy : null
    };
}

export function createAlphaTraceContractSummary({
    alphaAdjustmentStages = null,
    alphaTrialEvents = null
} = {}) {
    return {
        alphaAdjustmentStageCount: Array.isArray(alphaAdjustmentStages) ? alphaAdjustmentStages.length : 0,
        alphaTrialEventCount: Array.isArray(alphaTrialEvents) ? alphaTrialEvents.length : 0,
        hasAlphaAdjustments: Array.isArray(alphaAdjustmentStages) && alphaAdjustmentStages.length > 0,
        hasAlphaTrialEvents: Array.isArray(alphaTrialEvents) && alphaTrialEvents.length > 0
    };
}

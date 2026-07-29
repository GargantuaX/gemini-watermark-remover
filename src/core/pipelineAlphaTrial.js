import {
    scoreDamage,
    scoreResidual
} from './watermarkScoring.js';

function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeConfig(config) {
    if (!config || typeof config !== 'object') return null;
    const { logoSize, marginRight, marginBottom } = config;
    if (![logoSize, marginRight, marginBottom].every(Number.isFinite)) return null;

    return {
        logoSize,
        marginRight,
        marginBottom,
        ...(typeof config.alphaVariant === 'string' && config.alphaVariant.length > 0
            ? { alphaVariant: config.alphaVariant }
            : {})
    };
}

function normalizePosition(position) {
    if (!position || typeof position !== 'object') return null;
    const { x, y, width, height } = position;
    if (![x, y, width, height].every(Number.isFinite)) return null;
    return { x, y, width, height };
}

function compactObject(object) {
    return Object.fromEntries(
        Object.entries(object).filter(([, value]) => value !== undefined && value !== null)
    );
}

function makeCandidateId(prefix, config, position, source) {
    const normalizedConfig = normalizeConfig(config);
    const normalizedPosition = normalizePosition(position);
    const configKey = normalizedConfig
        ? `${normalizedConfig.logoSize}/${normalizedConfig.marginRight}/${normalizedConfig.marginBottom}${normalizedConfig.alphaVariant ? `/${normalizedConfig.alphaVariant}` : ''}`
        : 'none';
    const positionKey = normalizedPosition
        ? `${normalizedPosition.x},${normalizedPosition.y},${normalizedPosition.width},${normalizedPosition.height}`
        : 'none';
    return `${prefix}:${configKey}:${positionKey}:${source || 'unknown'}`;
}

function normalizeStageList(alphaAdjustmentStages) {
    return Array.isArray(alphaAdjustmentStages)
        ? alphaAdjustmentStages
            .map((stage) => (typeof stage === 'string' ? { stage } : stage))
            .filter((stage) => stage && typeof stage.stage === 'string')
        : [];
}

function normalizeAlphaTrialEvents(alphaTrialEvents) {
    return Array.isArray(alphaTrialEvents)
        ? alphaTrialEvents
            .filter((event) => event && typeof event === 'object')
            .map((event) => compactObject({
                stage: typeof event.stage === 'string' ? event.stage : null,
                strategy: typeof event.strategy === 'string' ? event.strategy : null,
                decision: typeof event.decision === 'string' ? event.decision : null,
                blockedGate: typeof event.blockedGate === 'string' ? event.blockedGate : null,
                fromAlphaGain: finiteOrNull(event.fromAlphaGain),
                toAlphaGain: finiteOrNull(event.toAlphaGain),
                alphaGain: finiteOrNull(event.alphaGain),
                repeatCount: finiteOrNull(event.repeatCount),
                edgeCleanup: typeof event.edgeCleanup === 'boolean' ? event.edgeCleanup : null,
                currentSpatialScore: finiteOrNull(event.currentSpatialScore),
                candidateSpatialScore: finiteOrNull(event.candidateSpatialScore),
                spatialDrift: finiteOrNull(event.spatialDrift),
                currentGradientScore: finiteOrNull(event.currentGradientScore),
                candidateGradientScore: finiteOrNull(event.candidateGradientScore),
                beforeSpatialScore: finiteOrNull(event.beforeSpatialScore),
                beforeGradientScore: finiteOrNull(event.beforeGradientScore),
                afterSpatialScore: finiteOrNull(event.afterSpatialScore),
                afterGradientScore: finiteOrNull(event.afterGradientScore),
                suppressionGain: finiteOrNull(event.suppressionGain),
                currentCost: finiteOrNull(event.currentCost),
                candidateCost: finiteOrNull(event.candidateCost),
                cost: finiteOrNull(event.cost)
            }))
        : [];
}

function classifyAlphaStages(alphaAdjustmentStages) {
    return normalizeStageList(alphaAdjustmentStages).filter((stage) =>
        /alpha|recalibration|over-subtraction|subpixel|new-margin-96-variant|power-profile|residual-rebalance|anti-template/i.test(stage.stage)
    );
}

function normalizeAlphaProfileStage(stage) {
    const {
        stage: stageName,
        alphaStrategy,
        repairStrategy,
        fromAlphaGain,
        toAlphaGain,
        beforeSpatialScore,
        beforeGradientScore,
        afterSpatialScore,
        afterGradientScore,
        suppressionGain,
        cost,
        profileExponent,
        allowSameAlphaGain,
        ...stageExtras
    } = stage;

    return compactObject({
        ...stageExtras,
        stage: stageName,
        alphaStrategy: typeof alphaStrategy === 'string' ? alphaStrategy : null,
        repairStrategy: typeof repairStrategy === 'string' ? repairStrategy : null,
        fromAlphaGain: finiteOrNull(fromAlphaGain),
        toAlphaGain: finiteOrNull(toAlphaGain),
        beforeSpatialScore: finiteOrNull(beforeSpatialScore),
        beforeGradientScore: finiteOrNull(beforeGradientScore),
        afterSpatialScore: finiteOrNull(afterSpatialScore),
        afterGradientScore: finiteOrNull(afterGradientScore),
        suppressionGain: finiteOrNull(suppressionGain),
        cost: finiteOrNull(cost),
        profileExponent: finiteOrNull(profileExponent)
    });
}

function inferAlphaTrialStrategy({ source = null, config = null, alphaAdjustmentStages = null } = {}) {
    const sourceText = String(source ?? '');
    const stages = normalizeStageList(alphaAdjustmentStages).map((stage) => stage.stage);
    if (sourceText.includes('new-margin-variant') || stages.includes('new-margin-96-variant-rescue')) {
        return 'new-margin-96-variant';
    }
    if (sourceText.includes('residual-rebalance') || stages.includes('known-48-positive-residual-rebalance')) {
        return 'known-48-positive-residual-rebalance';
    }
    if (sourceText.includes('power-profile-rescue') || stages.includes('known-48-power-profile-rescue')) {
        return 'known-48-power-profile';
    }
    if (
        sourceText.includes('profile-alpha-rescue') ||
        stages.includes('large-margin-48-profile-alpha-rescue')
    ) {
        return 'large-margin-48-profile-alpha';
    }
    if (
        sourceText.includes('local-alpha') ||
        stages.includes('evidence-gated-local-alpha-search')
    ) {
        return 'evidence-gated-local-alpha';
    }
    if (sourceText.includes('located-aggressive') || stages.includes('located-aggressive-removal')) {
        return 'located-aggressive-alpha';
    }
    if (stages.includes('dark-catalog-fine-alpha')) {
        return 'dark-catalog-fine-alpha';
    }
    if (
        stages.includes('over-subtraction-recalibration') ||
        stages.includes('weak-positive-residual-fine-alpha')
    ) {
        return 'over-subtraction-fine-alpha';
    }
    if (sourceText.includes('fine-alpha') || stages.some((stage) => stage.includes('fine-alpha'))) {
        return 'fine-alpha';
    }
    if (normalizeConfig(config)?.alphaVariant) {
        return 'alpha-variant';
    }
    return 'selected-alpha';
}

function isPhase2AlphaTrialStrategy(strategy) {
    return strategy === 'new-margin-96-variant' ||
        strategy === 'known-48-positive-residual-rebalance' ||
        strategy === 'known-48-power-profile' ||
        strategy === 'large-margin-48-profile-alpha' ||
        strategy === 'evidence-gated-local-alpha' ||
        strategy === 'over-subtraction-fine-alpha' ||
        strategy === 'dark-catalog-fine-alpha';
}

export function reconcileAlphaTrialWithFinalQualitySignals(
    alphaTrial = null,
    finalQualitySignals = null
) {
    const finalScores = finalQualitySignals?.final;
    const artifacts = finalQualitySignals?.artifacts;
    if (
        !alphaTrial ||
        !finalScores ||
        !artifacts ||
        !Number.isFinite(finalScores.spatialScore) ||
        !Number.isFinite(finalScores.gradientScore)
    ) {
        return alphaTrial;
    }

    const damage = scoreDamage({
        hardReject: finalQualitySignals.texture?.hardReject === true,
        nearBlackIncrease: finalQualitySignals.nearBlackIncrease,
        texturePenalty: finalQualitySignals.texture?.texturePenalty,
        newlyClippedRatio: artifacts.newlyClippedRatio,
        halo: finalQualitySignals.visibility?.halo ?? artifacts.halo ?? null
    });
    const residual = scoreResidual({
        processedSpatial: finalScores.spatialScore,
        processedGradient: finalScores.gradientScore,
        suppressionGain: alphaTrial.scores?.suppressionGain,
        artifactCost: artifacts.visualArtifactCost
    });

    return {
        ...alphaTrial,
        damage,
        artifacts,
        residual
    };
}

export function createAlphaTrialFromSelectedTrial({
    selectedTrial = null,
    detectionCandidate = null,
    source = null,
    config = null,
    position = null,
    alphaGain = null,
    alphaMapSource = null,
    templateWarp = null,
    alphaAdjustmentStages = null,
    alphaTrialEvents = null,
    processedSpatialScore = null,
    processedGradientScore = null,
    suppressionGain = null,
    finalQualitySignals = null
} = {}) {
    const resolvedConfig = normalizeConfig(config ?? selectedTrial?.config ?? detectionCandidate?.config);
    const resolvedPosition = normalizePosition(position ?? selectedTrial?.position ?? detectionCandidate?.position);
    const resolvedSource = source ?? selectedTrial?.source ?? null;
    const resolvedAlphaGain = finiteOrNull(alphaGain ?? selectedTrial?.alphaGain) ?? 1;
    const alphaStages = classifyAlphaStages(alphaAdjustmentStages);
    const trialEvents = normalizeAlphaTrialEvents(alphaTrialEvents);
    const strategy = inferAlphaTrialStrategy({
        source: resolvedSource,
        config: resolvedConfig,
        alphaAdjustmentStages
    });
    const originalSpatial = finiteOrNull(selectedTrial?.originalSpatialScore);
    const originalGradient = finiteOrNull(selectedTrial?.originalGradientScore);
    const processedSpatial = finiteOrNull(processedSpatialScore ?? selectedTrial?.processedSpatialScore);
    const processedGradient = finiteOrNull(processedGradientScore ?? selectedTrial?.processedGradientScore);

    const alphaTrial = {
        id: makeCandidateId('alpha', resolvedConfig, resolvedPosition, `${resolvedSource}:${resolvedAlphaGain}`),
        detectionId: detectionCandidate?.id ?? null,
        source: resolvedSource,
        config: resolvedConfig,
        position: resolvedPosition,
        alphaMapSource: alphaMapSource ?? selectedTrial?.provenance?.alphaMapSource ?? null,
        alphaGain: resolvedAlphaGain,
        strategy,
        migrationStage: isPhase2AlphaTrialStrategy(strategy) ? 'phase2-alpha-trial' : 'phase1-adapter',
        alphaShape: compactObject({
            variant: resolvedConfig?.alphaVariant ?? null,
            templateWarp: templateWarp ?? null,
            profileStages: alphaStages.map(normalizeAlphaProfileStage),
            stages: alphaStages.map((stage) => stage.stage)
        }),
        acceptedStrategies: trialEvents.filter((event) => event.decision === 'accept'),
        rejectedStrategies: trialEvents.filter((event) => event.decision === 'reject'),
        scores: {
            originalSpatial,
            originalGradient,
            processedSpatial,
            processedGradient,
            suppressionGain: finiteOrNull(suppressionGain ?? selectedTrial?.improvement)
        },
        gates: selectedTrial?.evaluation?.gates ?? null,
        damage: selectedTrial?.damage ?? null,
        residual: selectedTrial?.residual ?? null,
        provenance: selectedTrial?.provenance ?? null
    };

    return reconcileAlphaTrialWithFinalQualitySignals(alphaTrial, finalQualitySignals);
}

export function createAlphaTrialContractSummary(alphaTrial = null) {
    return {
        id: alphaTrial?.id ?? null,
        detectionId: alphaTrial?.detectionId ?? null,
        source: alphaTrial?.source ?? null,
        strategy: alphaTrial?.strategy ?? null,
        migrationStage: alphaTrial?.migrationStage ?? null,
        acceptedStrategyCount: Array.isArray(alphaTrial?.acceptedStrategies)
            ? alphaTrial.acceptedStrategies.length
            : 0,
        rejectedStrategyCount: Array.isArray(alphaTrial?.rejectedStrategies)
            ? alphaTrial.rejectedStrategies.length
            : 0,
        profileStageCount: Array.isArray(alphaTrial?.alphaShape?.profileStages)
            ? alphaTrial.alphaShape.profileStages.length
            : 0
    };
}

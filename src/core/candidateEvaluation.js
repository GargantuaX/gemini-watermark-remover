import { createAcceptedDecisionPath, createRejectedDecisionPath } from './pipelineDecisionPath.js';
import { createDetectionCandidateFromSelectedTrial } from './pipelineDetectionCandidate.js';
import { createAlphaTrialFromSelectedTrial } from './pipelineAlphaTrial.js';
import { createRepairTrialFromStages } from './pipelineRepairTrial.js';

const NEW_MARGIN_96_SIZE = 96;
const NEW_MARGIN_96_MARGIN = 192;
const HIGH_RISK_NEW_MARGIN_MIN_SPATIAL = 0.4;
const HIGH_RISK_NEW_MARGIN_MIN_GRADIENT = 0.08;
const DEFAULT_ALPHA_NEW_MARGIN_MAX_SPATIAL_RESIDUAL = 0.18;
const DEFAULT_ALPHA_NEW_MARGIN_MAX_GRADIENT_RESIDUAL = 0.08;
const DEFAULT_ALPHA_NEW_MARGIN_MIN_IMPROVEMENT = 0.12;
const DEFAULT_ALPHA_NEW_MARGIN_DAMAGE_ADVANTAGE = 0.03;

function numberOr(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function getConfig(candidate) {
    return candidate?.config ?? candidate ?? {};
}

function getProvenance(candidate) {
    return candidate?.provenance ?? {};
}

function isNewMargin96Candidate(candidate) {
    const config = getConfig(candidate);
    return config.logoSize === NEW_MARGIN_96_SIZE &&
        config.marginRight === NEW_MARGIN_96_MARGIN &&
        config.marginBottom === NEW_MARGIN_96_MARGIN;
}

export function isNewMarginAlphaVariantTrial(candidate) {
    const config = getConfig(candidate);
    return isNewMargin96Candidate(candidate) &&
        config.alphaVariant === '20260520';
}

export function isDefaultAlphaNewMarginTrial(candidate) {
    const config = getConfig(candidate);
    return isNewMargin96Candidate(candidate) &&
        !config.alphaVariant;
}

export function hasClearedResidual(candidate) {
    return candidate?.residual?.cleared === true ||
        candidate?.evaluation?.postResidual?.cleared === true;
}

export function hasSafeDefaultAlphaNewMarginResidual(candidate) {
    if (candidate?.evaluation?.postResidual?.safeDefaultAlphaNewMargin === true) {
        return true;
    }

    return Math.abs(numberOr(candidate?.processedSpatialScore, Infinity)) <= DEFAULT_ALPHA_NEW_MARGIN_MAX_SPATIAL_RESIDUAL &&
        Math.max(0, numberOr(candidate?.processedGradientScore, Infinity)) <= DEFAULT_ALPHA_NEW_MARGIN_MAX_GRADIENT_RESIDUAL &&
        numberOr(candidate?.improvement, -Infinity) >= DEFAULT_ALPHA_NEW_MARGIN_MIN_IMPROVEMENT;
}

export function hasHighRiskNewMarginPositiveEvidence(candidate) {
    if (getProvenance(candidate).darkPolarity === true) return true;
    if (!isNewMarginAlphaVariantTrial(candidate) && !isDefaultAlphaNewMarginTrial(candidate)) return true;

    return numberOr(candidate?.originalGradientScore) >= HIGH_RISK_NEW_MARGIN_MIN_GRADIENT ||
        numberOr(candidate?.originalSpatialScore) >= HIGH_RISK_NEW_MARGIN_MIN_SPATIAL;
}

export function shouldFailClosedForVisibleResidualUnsafeDamage({
    selectedTrial = null,
    residualVisibility = null
} = {}) {
    return isNewMarginAlphaVariantTrial(selectedTrial) &&
        residualVisibility?.visible === true &&
        selectedTrial?.damage?.safe === false;
}

function firstFalseGate(gates) {
    for (const [name, allowed] of Object.entries(gates)) {
        if (!allowed) return name;
    }
    return null;
}

function classifyCandidatePath(candidate) {
    if (isDefaultAlphaNewMarginTrial(candidate)) return 'standard-new-margin-default-alpha';
    if (isNewMarginAlphaVariantTrial(candidate)) return 'standard-new-margin-alpha-variant';
    if (candidate?.provenance?.previewAnchor === true) return 'preview-anchor';
    if (candidate?.provenance?.adaptive === true) return 'adaptive';
    if (typeof candidate?.source === 'string' && candidate.source.startsWith('standard')) return 'standard';
    return 'unknown';
}

export function createCandidateEvaluation({
    source = null,
    config = null,
    provenance = null,
    originalScores = null,
    processedScores = null,
    improvement = 0,
    residual = null,
    damage = null,
    gates = {}
}) {
    const candidateLike = {
        source,
        config,
        provenance,
        originalSpatialScore: originalScores?.spatialScore,
        originalGradientScore: originalScores?.gradientScore,
        processedSpatialScore: processedScores?.spatialScore,
        processedGradientScore: processedScores?.gradientScore,
        improvement
    };
    const originalSpatial = numberOr(originalScores?.spatialScore);
    const originalGradient = numberOr(originalScores?.gradientScore);
    const processedSpatial = numberOr(processedScores?.spatialScore);
    const processedGradient = numberOr(processedScores?.gradientScore);
    const normalizedGates = {
        ...gates,
        highRiskNewMarginEvidenceAllowed: hasHighRiskNewMarginPositiveEvidence(candidateLike)
    };
    const blockedGate = firstFalseGate(normalizedGates);

    return {
        pathType: classifyCandidatePath(candidateLike),
        eligible: blockedGate === null,
        blockedGate,
        gates: normalizedGates,
        riskFlags: normalizedGates.highRiskNewMarginEvidenceAllowed
            ? []
            : ['weak-new-margin-positive-alpha-evidence'],
        baseline: {
            spatialResidual: Math.abs(originalSpatial),
            gradientResidual: Math.max(0, originalGradient)
        },
        candidate: {
            spatialResidual: Math.abs(processedSpatial),
            gradientResidual: Math.max(0, processedGradient),
            improvement: numberOr(improvement)
        },
        postResidual: {
            cleared: residual?.cleared === true,
            safeDefaultAlphaNewMargin: Math.abs(processedSpatial) <= DEFAULT_ALPHA_NEW_MARGIN_MAX_SPATIAL_RESIDUAL &&
                Math.max(0, processedGradient) <= DEFAULT_ALPHA_NEW_MARGIN_MAX_GRADIENT_RESIDUAL &&
                numberOr(improvement, -Infinity) >= DEFAULT_ALPHA_NEW_MARGIN_MIN_IMPROVEMENT
        },
        damage: {
            safe: damage?.safe === true,
            penalty: numberOr(damage?.penalty, Infinity)
        }
    };
}

export function shouldPreferDefaultAlphaNewMarginCandidate(currentBest, candidate) {
    if (!isDefaultAlphaNewMarginTrial(candidate)) return false;

    if (isNewMarginAlphaVariantTrial(currentBest)) {
        return hasSafeDefaultAlphaNewMarginResidual(candidate) &&
            !hasClearedResidual(currentBest);
    }

    if (!isDefaultAlphaNewMarginTrial(currentBest)) return false;
    if (!hasSafeDefaultAlphaNewMarginResidual(candidate)) return false;
    if (!hasSafeDefaultAlphaNewMarginResidual(currentBest)) return false;

    const currentDamage = numberOr(currentBest?.damage?.penalty, Infinity);
    const candidateDamage = numberOr(candidate?.damage?.penalty, Infinity);
    if (!Number.isFinite(currentDamage) || !Number.isFinite(candidateDamage)) return false;

    return candidateDamage + DEFAULT_ALPHA_NEW_MARGIN_DAMAGE_ADVANTAGE < currentDamage;
}

export function arbitrateCandidateByEvaluation(currentBest, candidate) {
    if (shouldPreferDefaultAlphaNewMarginCandidate(currentBest, candidate)) {
        return candidate;
    }
    if (shouldPreferDefaultAlphaNewMarginCandidate(candidate, currentBest)) {
        return currentBest;
    }
    return null;
}

export {
    createAlphaTrialFromSelectedTrial,
    createAcceptedDecisionPath,
    createDetectionCandidateFromSelectedTrial,
    createRejectedDecisionPath,
    createRepairTrialFromStages
};

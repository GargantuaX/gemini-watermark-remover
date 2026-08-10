import { createAcceptedDecisionPath, createRejectedDecisionPath } from './pipelineDecisionPath.js';
import { createDetectionCandidateFromSelectedTrial } from './pipelineDetectionCandidate.js';
import { createAlphaTrialFromSelectedTrial } from './pipelineAlphaTrial.js';
import { createRepairTrialFromStages } from './pipelineRepairTrial.js';

const NEW_MARGIN_96_SIZE = 96;
const NEW_MARGIN_96_MARGIN = 192;
const HIGH_RISK_NEW_MARGIN_MIN_SPATIAL = 0.4;
const HIGH_RISK_NEW_MARGIN_MIN_GRADIENT = 0.08;
const SAFE_EXACT_NEW_MARGIN_MIN_SPATIAL = 0.18;
const SAFE_EXACT_NEW_MARGIN_MIN_GRADIENT = 0.05;
const SAFE_EXACT_NEW_MARGIN_MIN_IMPROVEMENT = 0.1;
const SAFE_EXACT_NEW_MARGIN_MAX_PROCESSED_SPATIAL = 0.32;
const SAFE_EXACT_NEW_MARGIN_MAX_PROCESSED_GRADIENT = 0.05;
const DEFAULT_ALPHA_NEW_MARGIN_MAX_SPATIAL_RESIDUAL = 0.18;
const DEFAULT_ALPHA_NEW_MARGIN_MAX_GRADIENT_RESIDUAL = 0.08;
const DEFAULT_ALPHA_NEW_MARGIN_MIN_IMPROVEMENT = 0.12;
const DEFAULT_ALPHA_NEW_MARGIN_DAMAGE_ADVANTAGE = 0.03;
const FULL_STRENGTH_NEW_MARGIN_MIN_ORIGINAL_GRADIENT = 0.08;
const FULL_STRENGTH_NEW_MARGIN_MAX_PROCESSED_GRADIENT = 0.1;
const FULL_STRENGTH_NEW_MARGIN_MIN_GRADIENT_ADVANTAGE = 0.03;
const FULL_STRENGTH_NEW_MARGIN_MAX_CLIPPED_RATIO = 0.02;
const UNSAFE_SHIFTED_MIN_STRONG_SPATIAL_EVIDENCE = 0.4;
const UNSAFE_SHIFTED_MIN_STRONG_GRADIENT_EVIDENCE = 0.08;

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

function isNewMarginVariantFamilyCandidate(candidate) {
    const config = getConfig(candidate);
    const provenance = getProvenance(candidate);
    return config.marginRight === NEW_MARGIN_96_MARGIN &&
        config.marginBottom === NEW_MARGIN_96_MARGIN &&
        (config.alphaVariant === '20260520' || provenance.alphaVariant === '20260520');
}

function hasSafeExactNewMarginVariantRecovery(candidate) {
    if (!isNewMarginAlphaVariantTrial(candidate)) return false;
    if (candidate?.damage?.safe !== true) return false;

    return numberOr(candidate?.originalSpatialScore) >= SAFE_EXACT_NEW_MARGIN_MIN_SPATIAL &&
        numberOr(candidate?.originalGradientScore) >= SAFE_EXACT_NEW_MARGIN_MIN_GRADIENT &&
        numberOr(candidate?.improvement, -Infinity) >= SAFE_EXACT_NEW_MARGIN_MIN_IMPROVEMENT &&
        Math.abs(numberOr(candidate?.processedSpatialScore, Infinity)) <= SAFE_EXACT_NEW_MARGIN_MAX_PROCESSED_SPATIAL &&
        Math.max(0, numberOr(candidate?.processedGradientScore, Infinity)) <= SAFE_EXACT_NEW_MARGIN_MAX_PROCESSED_GRADIENT;
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
    if (!isNewMarginVariantFamilyCandidate(candidate) && !isDefaultAlphaNewMarginTrial(candidate)) return true;

    const hasStrongEvidence = numberOr(candidate?.originalGradientScore) >= HIGH_RISK_NEW_MARGIN_MIN_GRADIENT ||
        numberOr(candidate?.originalSpatialScore) >= HIGH_RISK_NEW_MARGIN_MIN_SPATIAL;
    return hasStrongEvidence || hasSafeExactNewMarginVariantRecovery(candidate);
}

export function shouldFailClosedForVisibleResidualUnsafeDamage({
    selectedTrial = null,
    residualVisibility = null
} = {}) {
    return isNewMarginAlphaVariantTrial(selectedTrial) &&
        residualVisibility?.visible === true &&
        selectedTrial?.damage?.safe === false;
}

export function shouldFailClosedForUnsafeWeakShiftedCandidate({
    selectedTrial = null
} = {}) {
    const provenance = getProvenance(selectedTrial);
    const isShiftedFallback = provenance.localShift === true || provenance.sizeJitter === true;
    const damageSafe = selectedTrial?.damage?.safe ?? selectedTrial?.evaluation?.damage?.safe;

    if (!isShiftedFallback || damageSafe !== false) return false;

    return numberOr(selectedTrial?.originalSpatialScore) < UNSAFE_SHIFTED_MIN_STRONG_SPATIAL_EVIDENCE &&
        numberOr(selectedTrial?.originalGradientScore) < UNSAFE_SHIFTED_MIN_STRONG_GRADIENT_EVIDENCE;
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
        improvement,
        damage
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

function hasSameExactNewMarginAnchor(fullStrength, conservative) {
    if (!isNewMarginAlphaVariantTrial(fullStrength) || !isNewMargin96Candidate(conservative)) {
        return false;
    }
    const fullPosition = fullStrength?.position ?? {};
    const conservativePosition = conservative?.position ?? {};
    return fullPosition.x === conservativePosition.x &&
        fullPosition.y === conservativePosition.y &&
        fullPosition.width === NEW_MARGIN_96_SIZE &&
        fullPosition.height === NEW_MARGIN_96_SIZE &&
        conservativePosition.width === NEW_MARGIN_96_SIZE &&
        conservativePosition.height === NEW_MARGIN_96_SIZE;
}

export function shouldPreferFullStrengthNewMarginVariant(fullStrength, conservative) {
    if (!hasSameExactNewMarginAnchor(fullStrength, conservative)) return false;
    if (numberOr(fullStrength?.alphaGain) !== 1) return false;
    if (numberOr(conservative?.alphaGain) >= 1) return false;
    if (getProvenance(fullStrength).darkPolarity === true) return false;

    const originalSpatial = numberOr(fullStrength?.originalSpatialScore, -Infinity);
    const originalGradient = numberOr(fullStrength?.originalGradientScore, -Infinity);
    const fullGradient = Math.max(0, numberOr(
        fullStrength?.processedGradientScore,
        Infinity
    ));
    const conservativeGradient = Math.max(0, numberOr(
        conservative?.processedGradientScore,
        Infinity
    ));
    const clippedRatio = numberOr(
        fullStrength?.damage?.newlyClippedRatio,
        Infinity
    );
    const provenance = getProvenance(fullStrength);
    const positiveLocalizedSourceWitness =
        provenance.sourceWitnessRescue === true &&
        numberOr(
            provenance.sourceWitnessGate?.spatialSignedTarget,
            -Infinity
        ) > 0;

    // The full-strength trial scores itself with the same alpha profile it
    // applies, so a negative spatial residual or noisy damage warning is not
    // independent rejection evidence. Require positive source polarity and
    // either a real gradient advantage or the decoy-localized source witness.
    return originalSpatial > 0 &&
        originalGradient >= FULL_STRENGTH_NEW_MARGIN_MIN_ORIGINAL_GRADIENT &&
        fullGradient <= FULL_STRENGTH_NEW_MARGIN_MAX_PROCESSED_GRADIENT &&
        (
            positiveLocalizedSourceWitness ||
            conservativeGradient - fullGradient >=
                FULL_STRENGTH_NEW_MARGIN_MIN_GRADIENT_ADVANTAGE
        ) &&
        clippedRatio <= FULL_STRENGTH_NEW_MARGIN_MAX_CLIPPED_RATIO;
}

export function arbitrateCandidateByEvaluation(currentBest, candidate) {
    if (shouldPreferFullStrengthNewMarginVariant(currentBest, candidate)) {
        return currentBest;
    }
    if (shouldPreferFullStrengthNewMarginVariant(candidate, currentBest)) {
        return candidate;
    }
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

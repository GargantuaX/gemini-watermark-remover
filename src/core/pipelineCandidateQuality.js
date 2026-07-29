import {
    assessCalibratedWatermarkResidualVisibility,
    assessReferenceTextureAlignment,
    assessRemovalDiffArtifacts,
    calculateNearBlackRatio,
    calculateNearWhiteRatio,
    scoreRegion
} from './restorationMetrics.js';
import { compareRankingKey } from './watermarkScoring.js';

export const FINAL_EVIDENCE_WEIGHT = 0.35;
export const FINAL_RESIDUAL_WEIGHT = 0.40;
export const FINAL_DAMAGE_WEIGHT = 0.25;
export const FINAL_DAMAGE_WARNING_PENALTY = 0.08;

const DISCOVERY_ROLE_PENALTIES = {
    'fixed-selected': 0,
    'automatic-selected': 0.03,
    'aggressive-fallback-alternative': 0.015,
    'conservative-derived': 0.15,
    'discovered-alternative': 0.25
};
// Keep these reporting thresholds aligned with assessWatermarkResidualVisibility.
const IMPERFECTION_POSITIVE_HALO_LUM_THRESHOLD = 6;
const IMPERFECTION_GRADIENT_THRESHOLD = 0.22;
const IMPERFECTION_SPATIAL_THRESHOLD = 0.18;
const IMPERFECTION_WARNING_RATIO = 0.5;
const DARK_SUPPORT_RESOLUTION_MAX_ABS_SPATIAL = 0.18;
const DARK_SUPPORT_RESOLUTION_MAX_GRADIENT = 0.18;
const DARK_SUPPORT_RESOLUTION_MAX_NEWLY_CLIPPED_RATIO = 0.25;
const SEVERE_DARK_FLAT_TEXTURE_WARNING_THRESHOLD = 1.5;

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

export function classifyCandidateQuality({
    residualVisible = false,
    damageWarning = false
} = {}) {
    if (residualVisible && damageWarning) return 'mixed';
    if (residualVisible) return 'visible-residual';
    if (damageWarning) return 'possible-content-damage';
    return 'clean';
}

export function createCandidateImperfectionSignals(visibility = {}) {
    const darkPolarityHaloThreshold = Number.isFinite(visibility.darkPolarityHaloThreshold)
        ? visibility.darkPolarityHaloThreshold
        : IMPERFECTION_POSITIVE_HALO_LUM_THRESHOLD;
    const definitions = [
        ['spatial-residual', visibility.spatialResidual, IMPERFECTION_SPATIAL_THRESHOLD],
        ['gradient-residual', visibility.gradientResidual, IMPERFECTION_GRADIENT_THRESHOLD],
        ['positive-halo', visibility.positiveHaloLum, IMPERFECTION_POSITIVE_HALO_LUM_THRESHOLD],
        ['dark-polarity-halo', visibility.darkPolarityHaloLum, darkPolarityHaloThreshold]
    ];
    const components = Object.fromEntries(definitions.map(([type, rawValue, threshold]) => {
        const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
        return [type, {
            value,
            threshold,
            ratio: value / threshold
        }];
    }));
    const score = Math.max(0, ...Object.values(components).map((component) => component.ratio));
    const severity = score >= 1
        ? 'high'
        : score >= IMPERFECTION_WARNING_RATIO
            ? 'moderate'
            : score > 0
                ? 'low'
                : 'none';
    const types = definitions
        .map(([type]) => type)
        .filter((type) => components[type].ratio >= IMPERFECTION_WARNING_RATIO);

    return {
        detected: score >= IMPERFECTION_WARNING_RATIO,
        severity,
        score,
        types,
        components
    };
}

export function createCandidateQualitySignals({
    originalImageData,
    candidateImageData,
    hypothesis,
    finalCandidate = null
} = {}) {
    const trial = hypothesis?.trial;
    const position = finalCandidate?.position ?? trial?.position ?? hypothesis?.position;
    const alphaMap = finalCandidate?.alphaMap ?? trial?.alphaMap;
    const alphaGain = finalCandidate?.alphaGain ?? trial?.alphaGain ?? 1;
    if (!originalImageData || !candidateImageData || !position || !alphaMap) {
        throw new Error('Candidate quality measurement requires original pixels, candidate pixels, position, and alpha map');
    }

    const original = scoreRegion(originalImageData, alphaMap, position);
    const final = scoreRegion(candidateImageData, alphaMap, position);
    const visibility = assessCalibratedWatermarkResidualVisibility({
        imageData: candidateImageData,
        originalImageData,
        position,
        alphaMap,
        alphaGain
    });
    const imperfections = createCandidateImperfectionSignals(visibility);
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData,
        alphaMap,
        position,
        alphaGain
    });
    const texture = assessReferenceTextureAlignment({
        originalImageData,
        referenceImageData: originalImageData,
        candidateImageData,
        position
    });
    const originalNearBlackRatio = calculateNearBlackRatio(originalImageData, position);
    const candidateNearBlackRatio = calculateNearBlackRatio(candidateImageData, position);
    const originalNearWhiteRatio = calculateNearWhiteRatio(originalImageData, position);
    const candidateNearWhiteRatio = calculateNearWhiteRatio(candidateImageData, position);
    const nearBlackIncrease = candidateNearBlackRatio - originalNearBlackRatio;
    const nearWhiteIncrease = candidateNearWhiteRatio - originalNearWhiteRatio;

    const evidence = clamp01((
        Math.max(0, original.spatialScore) +
        Math.max(0, original.gradientScore)
    ) / 2);
    const residualComponents = {
        spatial: clamp01(Math.abs(final.spatialScore) / 0.4),
        gradient: clamp01(Math.max(0, final.gradientScore) / 0.35),
        halo: clamp01(Math.max(
            visibility?.positiveHaloLum ?? 0,
            visibility?.darkPolarityHaloLum ?? 0
        ) / 8)
    };
    const residualLoss =
        residualComponents.spatial * 0.45 +
        residualComponents.gradient * 0.35 +
        residualComponents.halo * 0.20;
    const damageComponents = {
        nearBlack: clamp01(Math.max(0, nearBlackIncrease) / 0.05),
        nearWhite: clamp01(Math.max(0, nearWhiteIncrease) / 0.05),
        texture: clamp01((texture?.texturePenalty ?? 0) / 1),
        clipped: clamp01((artifacts?.newlyClippedRatio ?? 0) / 0.02)
    };
    const damageLoss =
        damageComponents.nearBlack * 0.25 +
        damageComponents.nearWhite * 0.25 +
        damageComponents.texture * 0.25 +
        damageComponents.clipped * 0.25;
    const residualVisible = visibility?.visible === true;
    const textureWarningCorroborated = (
        texture?.visibleDarkHole === true ||
        texture?.hardReject === true
    ) && (
        damageComponents.nearBlack >= 0.4 ||
        damageComponents.nearWhite >= 0.4 ||
        damageComponents.clipped >= 0.4
    );
    const severeDarkFlatTextureWarning =
        texture?.tooDark === true &&
        texture?.tooFlat === true &&
        Number(texture?.texturePenalty ?? 0) >=
            SEVERE_DARK_FLAT_TEXTURE_WARNING_THRESHOLD;
    const rawDamageWarning = damageComponents.nearBlack >= 1 ||
        damageComponents.nearWhite >= 1 ||
        damageComponents.clipped >= 1 ||
        textureWarningCorroborated ||
        severeDarkFlatTextureWarning;
    const darkBackgroundSupportConvergence =
        finalCandidate?.darkBackgroundSupportConvergence?.accepted === true
            ? finalCandidate.darkBackgroundSupportConvergence
            : null;
    const textureHardRejectResolved =
        darkBackgroundSupportConvergence?.textureHardRejectResolved === true;
    const darkBackgroundSupportResolved = Boolean(
        rawDamageWarning &&
        darkBackgroundSupportConvergence &&
        !residualVisible &&
        (
            texture?.hardReject !== true ||
            textureHardRejectResolved
        ) &&
        Math.abs(final.spatialScore) <=
            DARK_SUPPORT_RESOLUTION_MAX_ABS_SPATIAL &&
        final.gradientScore <= DARK_SUPPORT_RESOLUTION_MAX_GRADIENT &&
        Number(artifacts?.newlyClippedRatio ?? Infinity) <=
            DARK_SUPPORT_RESOLUTION_MAX_NEWLY_CLIPPED_RATIO
    );
    const damageWarning = rawDamageWarning &&
        !darkBackgroundSupportResolved;
    const damageRiskResolution = darkBackgroundSupportResolved
        ? 'dark-background-support-converged'
        : null;
    const qualityStatus = classifyCandidateQuality({
        residualVisible,
        damageWarning
    });

    return {
        evidenceLoss: 1 - evidence,
        residualLoss,
        damageLoss,
        residualVisible,
        damageWarning,
        rawDamageWarning,
        damageRiskResolution,
        darkBackgroundSupportConvergence,
        qualityStatus,
        imperfections,
        original,
        final,
        visibility,
        artifacts,
        texture,
        originalNearBlackRatio,
        candidateNearBlackRatio,
        nearBlackIncrease,
        originalNearWhiteRatio,
        candidateNearWhiteRatio,
        nearWhiteIncrease,
        residualComponents,
        damageComponents
    };
}

function getFinalScore(signals = {}) {
    const weightedLoss = (signals.evidenceLoss ?? 1) * FINAL_EVIDENCE_WEIGHT +
        (signals.residualLoss ?? 1) * FINAL_RESIDUAL_WEIGHT +
        (signals.damageLoss ?? 1) * FINAL_DAMAGE_WEIGHT;
    return weightedLoss + (signals.damageWarning === true ? FINAL_DAMAGE_WARNING_PENALTY : 0);
}

function getDiscoveryPenalty(hypothesis = {}) {
    return DISCOVERY_ROLE_PENALTIES[hypothesis.discoveryRole] ?? 0;
}

function dominates(left, right) {
    const keys = ['evidenceLoss', 'residualLoss', 'damageLoss'];
    const noWorse = keys.every((key) => (
        (left.qualitySignals?.[key] ?? Infinity) <= (right.qualitySignals?.[key] ?? Infinity)
    )) && left.discoveryPenalty <= right.discoveryPenalty;
    const strictlyBetter = keys.some((key) => (
        (left.qualitySignals?.[key] ?? Infinity) < (right.qualitySignals?.[key] ?? Infinity)
    )) || left.discoveryPenalty < right.discoveryPenalty;
    return noWorse && strictlyBetter;
}

function hasCatastrophicBlock(signals = {}) {
    const damage = signals.damageComponents ?? {};
    return signals.texture?.hardReject === true &&
        damage.clipped >= 1 &&
        (damage.nearBlack >= 1 || damage.nearWhite >= 1);
}

function getCandidatePosition(candidate = {}) {
    return candidate.hypothesis?.trial?.position ?? candidate.hypothesis?.position ?? null;
}

function hasSameCandidateAnchor(left, right) {
    const leftPosition = getCandidatePosition(left);
    const rightPosition = getCandidatePosition(right);
    if (!leftPosition || !rightPosition) return false;
    return leftPosition.x === rightPosition.x &&
        leftPosition.y === rightPosition.y &&
        leftPosition.width === rightPosition.width &&
        leftPosition.height === rightPosition.height;
}

const SAME_ANCHOR_96_SIZE = 96;
const SAME_ANCHOR_96_IMPERFECTION_IMPROVEMENT = 0.15;
const SAME_ANCHOR_96_EVIDENCE_TOLERANCE = 0.05;
const SAME_ANCHOR_96_DAMAGE_TOLERANCE = 0.05;

function finiteOr(value, fallback = Infinity) {
    return Number.isFinite(value) ? value : fallback;
}

function isEligibleSameAnchor96Alternative(incumbent, alternative) {
    const incumbentSignals = incumbent?.qualitySignals ?? {};
    const alternativeSignals = alternative?.qualitySignals ?? {};
    const incumbentScore = incumbentSignals.imperfections?.score;
    const alternativeScore = alternativeSignals.imperfections?.score;
    return hasSameCandidateAnchor(incumbent, alternative) &&
        !hasCatastrophicBlock(alternativeSignals) &&
        Number.isFinite(alternativeScore) &&
        alternativeScore <=
            incumbentScore - SAME_ANCHOR_96_IMPERFECTION_IMPROVEMENT &&
        Number.isFinite(alternativeSignals.evidenceLoss) &&
        alternativeSignals.evidenceLoss <=
            incumbentSignals.evidenceLoss + SAME_ANCHOR_96_EVIDENCE_TOLERANCE &&
        Number.isFinite(alternativeSignals.damageLoss) &&
        alternativeSignals.damageLoss <=
            incumbentSignals.damageLoss + SAME_ANCHOR_96_DAMAGE_TOLERANCE;
}

export function applySameAnchor96ImperfectionPreference(baseRanked = []) {
    const incumbent = baseRanked[0];
    const position = getCandidatePosition(incumbent);
    const signals = incumbent?.qualitySignals ?? {};
    if (
        !position ||
        position.width !== SAME_ANCHOR_96_SIZE ||
        position.height !== SAME_ANCHOR_96_SIZE ||
        signals.imperfections?.severity !== 'high' ||
        !Number.isFinite(signals.imperfections?.score) ||
        !Number.isFinite(signals.evidenceLoss) ||
        !Number.isFinite(signals.damageLoss)
    ) {
        return baseRanked;
    }

    const eligible = baseRanked
        .slice(1)
        .map((candidate, offset) => ({ candidate, baseIndex: offset + 1 }))
        .filter(({ candidate }) =>
            isEligibleSameAnchor96Alternative(incumbent, candidate)
        )
        .sort((left, right) =>
            left.candidate.qualitySignals.imperfections.score -
                right.candidate.qualitySignals.imperfections.score ||
            finiteOr(left.candidate.qualitySignals.residualLoss) -
                finiteOr(right.candidate.qualitySignals.residualLoss) ||
            left.baseIndex - right.baseIndex ||
            String(left.candidate.hypothesis?.id ?? '').localeCompare(
                String(right.candidate.hypothesis?.id ?? '')
            )
        );
    if (eligible.length === 0) return baseRanked;

    const promoted = eligible[0].candidate;
    return [promoted, ...baseRanked.filter((candidate) => candidate !== promoted)];
}

function strictlyDominatesQuality(leftSignals = {}, rightSignals = {}) {
    const keys = ['evidenceLoss', 'residualLoss', 'damageLoss'];
    const noWorse = keys.every((key) => (
        (leftSignals[key] ?? Infinity) <= (rightSignals[key] ?? Infinity)
    ));
    const strictlyBetter = keys.some((key) => (
        (leftSignals[key] ?? Infinity) < (rightSignals[key] ?? Infinity)
    ));
    return noWorse && strictlyBetter;
}

function shouldPreferSameAnchorCleanCandidate(left, right) {
    return left.qualitySignals?.qualityStatus === 'clean' &&
        right.qualitySignals?.qualityStatus !== 'clean' &&
        hasSameCandidateAnchor(left, right) &&
        strictlyDominatesQuality(left.qualitySignals, right.qualitySignals);
}

function compareRankedCandidates(left, right) {
    const leftCatastrophic = hasCatastrophicBlock(left.qualitySignals);
    const rightCatastrophic = hasCatastrophicBlock(right.qualitySignals);
    if (leftCatastrophic !== rightCatastrophic) return leftCatastrophic ? 1 : -1;
    const leftCleanDominates = shouldPreferSameAnchorCleanCandidate(left, right);
    const rightCleanDominates = shouldPreferSameAnchorCleanCandidate(right, left);
    if (leftCleanDominates !== rightCleanDominates) return leftCleanDominates ? -1 : 1;
    if (left.dominated !== right.dominated) return left.dominated ? 1 : -1;
    if (left.finalScore !== right.finalScore) return left.finalScore - right.finalScore;
    const rankingComparison = compareRankingKey(
        left.hypothesis?.rankingKey,
        right.hypothesis?.rankingKey
    );
    if (rankingComparison !== 0) return rankingComparison;
    return String(left.hypothesis?.id ?? '').localeCompare(String(right.hypothesis?.id ?? ''));
}

export function rankCompletedCandidates(completed = []) {
    const scored = completed.map((item) => ({
        ...item,
        discoveryPenalty: getDiscoveryPenalty(item.hypothesis),
        finalScore: getFinalScore(item.qualitySignals) + getDiscoveryPenalty(item.hypothesis)
    }));
    for (const candidate of scored) {
        candidate.dominated = scored.some((other) => (
            other !== candidate && dominates(other, candidate)
        ));
    }
    scored.sort(compareRankedCandidates);
    const preferred = applySameAnchor96ImperfectionPreference(scored);

    const first = preferred[0];
    const second = preferred[1];
    const selectionConfidence = !first
        ? 0
        : !second
            ? 1
            : clamp01((second.finalScore - first.finalScore) / Math.max(0.05, second.finalScore));

    return preferred.map((item, index) => ({
        ...item,
        rank: index + 1,
        selectionConfidence: index === 0 ? selectionConfidence : 0
    }));
}

export function createCandidateSummaries(ranked = [], failures = []) {
    const valid = ranked.map((item) => ({
        id: item.hypothesis?.id ?? null,
        family: item.hypothesis?.family ?? null,
        rank: item.rank,
        valid: true,
        finalScore: item.finalScore,
        qualityStatus: item.qualitySignals?.qualityStatus ?? null,
        qualitySignals: item.qualitySignals ?? null,
        error: null
    }));
    const invalid = failures.map((item) => ({
        id: item.hypothesis?.id ?? null,
        family: item.hypothesis?.family ?? null,
        rank: null,
        valid: false,
        finalScore: null,
        qualityStatus: null,
        qualitySignals: null,
        error: item.error instanceof Error
            ? item.error.message
            : String(item.error ?? 'Candidate execution failed')
    }));
    return [...valid, ...invalid];
}

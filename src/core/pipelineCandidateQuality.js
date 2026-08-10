import {
    assessCalibratedWatermarkResidualVisibility,
    assessReferenceTextureAlignment,
    assessRemovalDiffArtifacts,
    calculateNearBlackRatio,
    calculateNearWhiteRatio,
    scoreRegion
} from './restorationMetrics.js';
import { getEmbeddedAlphaMap } from './embeddedAlphaMaps.js';
import {
    buildPreviewNeighborhoodPrior,
    measurePreviewBoundaryMetrics
} from './previewAlphaCalibration.js';
import { compareRankingKey } from './watermarkScoring.js';
import { shouldPreferFullStrengthNewMarginVariant } from './candidateEvaluation.js';

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
const INDEPENDENT_DARK_SUPPORT_SIZE = 96;
const INDEPENDENT_DARK_SUPPORT_SCRATCH_PAD = 12;
const INDEPENDENT_DARK_SUPPORT_MIN_ORIGINAL_SPATIAL = 0.95;
const INDEPENDENT_DARK_SUPPORT_MIN_ORIGINAL_GRADIENT = 0.9;
const INDEPENDENT_DARK_SUPPORT_MIN_ORIGINAL_NEAR_BLACK = 0.1;
const INDEPENDENT_DARK_SUPPORT_MIN_CANDIDATE_NEAR_BLACK = 0.25;
const INDEPENDENT_DARK_SUPPORT_MAX_OPPOSITE_HALO_LUMINANCE = 1;
const INDEPENDENT_DARK_SUPPORT_MAX_OUTSIDE_ALPHA_CLIP_RATIO = 0.03;
const INDEPENDENT_DARK_SUPPORT_MIN_STRONG_ALPHA_CLIP_RATIO = 0.8;
const INDEPENDENT_DARK_SUPPORT_ALPHA_MIN = 0.05;
const INDEPENDENT_DARK_SUPPORT_ALPHA_STRONG_MIN = 0.2;
const INDEPENDENT_DARK_SUPPORT_MAX_PRIOR_MEAN_LUMINANCE = 8;
const INDEPENDENT_DARK_SUPPORT_MAX_CANDIDATE_MEAN_LUMINANCE = 8;
const INDEPENDENT_DARK_SUPPORT_MAX_PRIOR_MEAN_DELTA = 1.5;
const INDEPENDENT_DARK_SUPPORT_MAX_PRIOR_MAE = 2.25;
const INDEPENDENT_DARK_SUPPORT_MAX_PRIOR_WEIGHTED_MAE = 3.5;
const INDEPENDENT_DARK_SUPPORT_MAX_BOUNDARY_SCORE = 0.35;
const INDEPENDENT_DARK_SUPPORT_PRIOR_RADII = Object.freeze([4, 12]);
const INDEPENDENT_DARK_SUPPORT_RELAXATION_PASSES = 0;

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function haveEqualAlphaValues(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

function resolveReferenceAlphaMap(
    hypothesis,
    explicitReferenceAlphaMap,
    selectedAlphaMap
) {
    const config = hypothesis?.config ?? hypothesis?.trial?.config;
    const logoSize = config?.logoSize;
    const alphaVariant = config?.alphaVariant;
    const catalogKey = Number.isFinite(logoSize)
        ? typeof alphaVariant === 'string' && alphaVariant.length > 0
            ? `${logoSize}-${alphaVariant}`
            : logoSize
        : null;
    // Keep one catalog-derived observer independent from any alpha profile
    // mutated or injected by the candidate being evaluated.
    const referenceAlphaMap = explicitReferenceAlphaMap ??
        (catalogKey === null ? null : getEmbeddedAlphaMap(catalogKey));
    return haveEqualAlphaValues(referenceAlphaMap, selectedAlphaMap)
        ? null
        : referenceAlphaMap;
}

function extractCandidateQualityScratch(imageData, position) {
    const x = Math.max(0, position.x - INDEPENDENT_DARK_SUPPORT_SCRATCH_PAD);
    const y = Math.max(0, position.y - INDEPENDENT_DARK_SUPPORT_SCRATCH_PAD);
    const right = Math.min(
        imageData.width,
        position.x + position.width + INDEPENDENT_DARK_SUPPORT_SCRATCH_PAD
    );
    const bottom = Math.min(
        imageData.height,
        position.y + position.height + INDEPENDENT_DARK_SUPPORT_SCRATCH_PAD
    );
    const scratch = {
        width: right - x,
        height: bottom - y,
        data: new Uint8ClampedArray((right - x) * (bottom - y) * 4)
    };
    for (let row = 0; row < scratch.height; row++) {
        const sourceStart = ((y + row) * imageData.width + x) * 4;
        const sourceEnd = sourceStart + scratch.width * 4;
        scratch.data.set(
            imageData.data.subarray(sourceStart, sourceEnd),
            row * scratch.width * 4
        );
    }
    return {
        imageData: scratch,
        position: {
            x: position.x - x,
            y: position.y - y,
            width: position.width,
            height: position.height
        }
    };
}

function measureIndependentDarkSupportClipping({
    originalImageData,
    candidateImageData,
    alphaMap,
    position
}) {
    let newlyClippedCount = 0;
    let outsideAlphaSupportCount = 0;
    let strongAlphaSupportCount = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const pixelIndex = (
                (position.y + row) * originalImageData.width +
                position.x +
                col
            ) * 4;
            const newlyClipped = [0, 1, 2].some((channel) => (
                candidateImageData.data[pixelIndex + channel] === 0 &&
                originalImageData.data[pixelIndex + channel] > 5
            ));
            if (!newlyClipped) continue;

            newlyClippedCount++;
            const alpha = Math.abs(alphaMap[localIndex]);
            if (alpha < INDEPENDENT_DARK_SUPPORT_ALPHA_MIN) {
                outsideAlphaSupportCount++;
            }
            if (alpha >= INDEPENDENT_DARK_SUPPORT_ALPHA_STRONG_MIN) {
                strongAlphaSupportCount++;
            }
        }
    }
    return {
        outsideAlphaSupportRatio: newlyClippedCount > 0
            ? outsideAlphaSupportCount / newlyClippedCount
            : 0,
        strongAlphaSupportRatio: newlyClippedCount > 0
            ? strongAlphaSupportCount / newlyClippedCount
            : 1
    };
}

function measureIndependentDarkSupportPrior({
    candidateImageData,
    priorImageData,
    alphaMap,
    position
}) {
    let absoluteDelta = 0;
    let weightedAbsoluteDelta = 0;
    let alphaWeight = 0;
    let candidateLuminance = 0;
    let priorLuminance = 0;
    let channelCount = 0;
    let pixelCount = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = Math.abs(alphaMap[localIndex]);
            const pixelIndex = (
                (position.y + row) * candidateImageData.width +
                position.x +
                col
            ) * 4;
            for (let channel = 0; channel < 3; channel++) {
                const delta = Math.abs(
                    candidateImageData.data[pixelIndex + channel] -
                    priorImageData.data[pixelIndex + channel]
                );
                absoluteDelta += delta;
                weightedAbsoluteDelta += delta * alpha;
                channelCount++;
            }
            candidateLuminance +=
                0.2126 * candidateImageData.data[pixelIndex] +
                0.7152 * candidateImageData.data[pixelIndex + 1] +
                0.0722 * candidateImageData.data[pixelIndex + 2];
            priorLuminance +=
                0.2126 * priorImageData.data[pixelIndex] +
                0.7152 * priorImageData.data[pixelIndex + 1] +
                0.0722 * priorImageData.data[pixelIndex + 2];
            alphaWeight += alpha;
            pixelCount++;
        }
    }
    const candidateMeanLuminance = candidateLuminance / Math.max(1, pixelCount);
    const priorMeanLuminance = priorLuminance / Math.max(1, pixelCount);
    return {
        meanAbsoluteDelta: absoluteDelta / Math.max(1, channelCount),
        weightedMeanAbsoluteDelta:
            weightedAbsoluteDelta / Math.max(1e-8, alphaWeight * 3),
        candidateMeanLuminance,
        priorMeanLuminance,
        meanLuminanceDelta: Math.abs(candidateMeanLuminance - priorMeanLuminance)
    };
}

function assessIndependentDarkBackgroundSupportConvergence({
    originalImageData,
    candidateImageData,
    hypothesis,
    position,
    alphaMap,
    alphaGain,
    original,
    final,
    visibility,
    artifacts,
    originalNearBlackRatio,
    candidateNearBlackRatio,
    rawDamageWarning
}) {
    const trial = hypothesis?.trial;
    const source = trial?.source;
    const catalogAlphaMap = getEmbeddedAlphaMap('96-20260520');
    if (
        rawDamageWarning !== true ||
        source !== 'standard' ||
        position.width !== INDEPENDENT_DARK_SUPPORT_SIZE ||
        position.height !== INDEPENDENT_DARK_SUPPORT_SIZE ||
        alphaGain !== 1 ||
        !haveEqualAlphaValues(alphaMap, catalogAlphaMap) ||
        original.spatialScore < INDEPENDENT_DARK_SUPPORT_MIN_ORIGINAL_SPATIAL ||
        original.gradientScore < INDEPENDENT_DARK_SUPPORT_MIN_ORIGINAL_GRADIENT ||
        visibility?.visible !== false ||
        Math.abs(final.spatialScore) > DARK_SUPPORT_RESOLUTION_MAX_ABS_SPATIAL ||
        final.gradientScore > DARK_SUPPORT_RESOLUTION_MAX_GRADIENT ||
        originalNearBlackRatio < INDEPENDENT_DARK_SUPPORT_MIN_ORIGINAL_NEAR_BLACK ||
        candidateNearBlackRatio < INDEPENDENT_DARK_SUPPORT_MIN_CANDIDATE_NEAR_BLACK ||
        Number(artifacts?.newlyClippedRatio ?? Infinity) >
            DARK_SUPPORT_RESOLUTION_MAX_NEWLY_CLIPPED_RATIO ||
        Number(artifacts?.oppositeDirectionHaloLum ?? Infinity) >
            INDEPENDENT_DARK_SUPPORT_MAX_OPPOSITE_HALO_LUMINANCE
    ) {
        return null;
    }

    const originalScratch = extractCandidateQualityScratch(
        originalImageData,
        position
    );
    const candidateScratch = extractCandidateQualityScratch(
        candidateImageData,
        position
    );
    const priorMetrics = INDEPENDENT_DARK_SUPPORT_PRIOR_RADII.map((radius) => {
        const priorImageData = buildPreviewNeighborhoodPrior({
            previewImageData: originalScratch.imageData,
            position: originalScratch.position,
            radius,
            relaxationPasses: INDEPENDENT_DARK_SUPPORT_RELAXATION_PASSES
        });
        return {
            radius,
            ...measureIndependentDarkSupportPrior({
                candidateImageData: candidateScratch.imageData,
                priorImageData,
                alphaMap,
                position: candidateScratch.position
            })
        };
    });
    const clipping = measureIndependentDarkSupportClipping({
        originalImageData: originalScratch.imageData,
        candidateImageData: candidateScratch.imageData,
        alphaMap,
        position: originalScratch.position
    });
    const boundary = measurePreviewBoundaryMetrics(
        candidateScratch.imageData,
        originalScratch.imageData,
        originalScratch.position
    );
    const maximumPriorMeanLuminance = Math.max(
        ...priorMetrics.map((item) => item.priorMeanLuminance)
    );
    const maximumCandidateMeanLuminance = Math.max(
        ...priorMetrics.map((item) => item.candidateMeanLuminance)
    );
    const maximumPriorMeanDelta = Math.max(
        ...priorMetrics.map((item) => item.meanLuminanceDelta)
    );
    const maximumPriorMae = Math.max(
        ...priorMetrics.map((item) => item.meanAbsoluteDelta)
    );
    const maximumPriorWeightedMae = Math.max(
        ...priorMetrics.map((item) => item.weightedMeanAbsoluteDelta)
    );
    const accepted = Boolean(
        clipping.outsideAlphaSupportRatio <=
            INDEPENDENT_DARK_SUPPORT_MAX_OUTSIDE_ALPHA_CLIP_RATIO &&
        clipping.strongAlphaSupportRatio >=
            INDEPENDENT_DARK_SUPPORT_MIN_STRONG_ALPHA_CLIP_RATIO &&
        maximumPriorMeanLuminance <=
            INDEPENDENT_DARK_SUPPORT_MAX_PRIOR_MEAN_LUMINANCE &&
        maximumCandidateMeanLuminance <=
            INDEPENDENT_DARK_SUPPORT_MAX_CANDIDATE_MEAN_LUMINANCE &&
        maximumPriorMeanDelta <= INDEPENDENT_DARK_SUPPORT_MAX_PRIOR_MEAN_DELTA &&
        maximumPriorMae <= INDEPENDENT_DARK_SUPPORT_MAX_PRIOR_MAE &&
        maximumPriorWeightedMae <=
            INDEPENDENT_DARK_SUPPORT_MAX_PRIOR_WEIGHTED_MAE &&
        boundary.normalizedScore <= INDEPENDENT_DARK_SUPPORT_MAX_BOUNDARY_SCORE
    );
    return {
        accepted,
        source: 'independent-standard-96-neighborhood-prior',
        textureHardRejectResolved: accepted,
        priorRadii: [...INDEPENDENT_DARK_SUPPORT_PRIOR_RADII],
        maximumPriorMeanLuminance,
        maximumCandidateMeanLuminance,
        maximumPriorMeanDelta,
        maximumPriorMae,
        maximumPriorWeightedMae,
        boundaryScore: boundary.normalizedScore,
        clipping
    };
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
    finalCandidate = null,
    referenceAlphaMap = null
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
    const resolvedReferenceAlphaMap = resolveReferenceAlphaMap(
        hypothesis,
        referenceAlphaMap,
        alphaMap
    );
    const referenceVisibility = resolvedReferenceAlphaMap
        ? assessCalibratedWatermarkResidualVisibility({
            imageData: candidateImageData,
            originalImageData,
            position,
            alphaMap: resolvedReferenceAlphaMap,
            alphaGain
        })
        : null;
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
    const rawDamageLoss =
        damageComponents.nearBlack * 0.25 +
        damageComponents.nearWhite * 0.25 +
        damageComponents.texture * 0.25 +
        damageComponents.clipped * 0.25;
    const residualVisible = visibility?.visible === true ||
        referenceVisibility?.visible === true;
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
    const explicitDarkBackgroundSupportConvergence =
        finalCandidate?.darkBackgroundSupportConvergence?.accepted === true
            ? finalCandidate.darkBackgroundSupportConvergence
            : null;
    const independentDarkBackgroundSupportConvergence =
        explicitDarkBackgroundSupportConvergence
            ? null
            : assessIndependentDarkBackgroundSupportConvergence({
                originalImageData,
                candidateImageData,
                hypothesis,
                position,
                alphaMap,
                alphaGain,
                original,
                final,
                visibility,
                artifacts,
                originalNearBlackRatio,
                candidateNearBlackRatio,
                rawDamageWarning
            });
    const darkBackgroundSupportConvergence =
        explicitDarkBackgroundSupportConvergence ??
        independentDarkBackgroundSupportConvergence;
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
    const damageLoss = darkBackgroundSupportResolved ? 0 : rawDamageLoss;
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
        rawDamageLoss,
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
        referenceVisibility,
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
    if (
        signals.damageWarning === false &&
        signals.darkBackgroundSupportConvergence?.accepted === true
    ) {
        return false;
    }
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

function applyFullStrengthNewMarginPreference(baseRanked = []) {
    const incumbent = baseRanked[0];
    if (!incumbent) return baseRanked;

    const getFinalTrialView = (candidate) => {
        const trial = candidate?.hypothesis?.trial ?? {};
        const meta = candidate?.result?.meta ?? {};
        const detection = meta.detection ?? {};
        return {
            ...trial,
            alphaGain: Number.isFinite(Number(meta.alphaGain))
                ? Number(meta.alphaGain)
                : trial.alphaGain,
            config: meta.config ?? trial.config,
            position: meta.position ?? trial.position,
            originalSpatialScore:
                detection.originalSpatialScore ?? trial.originalSpatialScore,
            originalGradientScore:
                detection.originalGradientScore ?? trial.originalGradientScore,
            processedGradientScore:
                detection.processedGradientScore ?? trial.processedGradientScore
        };
    };
    const incumbentTrial = getFinalTrialView(incumbent);

    const promoted = baseRanked.slice(1).find((candidate) => (
        !hasCatastrophicBlock(candidate.qualitySignals) &&
        shouldPreferFullStrengthNewMarginVariant(
            getFinalTrialView(candidate),
            incumbentTrial
        )
    ));
    if (!promoted) return baseRanked;

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
    const imperfectionPreferred = applySameAnchor96ImperfectionPreference(scored);
    const preferred = applyFullStrengthNewMarginPreference(imperfectionPreferred);

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

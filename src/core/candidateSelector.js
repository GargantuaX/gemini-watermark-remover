import { removeWatermark } from './blendModes.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    detectAdaptiveWatermarkRegion,
    interpolateAlphaMap,
    shouldAttemptAdaptiveFallback,
    warpAlphaMap
} from './adaptiveDetector.js';
import {
    assessReferenceTextureAlignment,
    calculateNearBlackRatio,
    cloneImageData,
    scoreRegion
} from './restorationMetrics.js';
import {
    hasReliableAdaptiveWatermarkSignal,
    hasReliableStandardWatermarkSignal
} from './watermarkPresence.js';
import { resolveGeminiWatermarkSearchConfigs } from './geminiSizeCatalog.js';

const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const VALIDATION_MIN_IMPROVEMENT = 0.08;
const VALIDATION_TARGET_RESIDUAL = 0.22;
const VALIDATION_MAX_GRADIENT_INCREASE = 0.04;
const VALIDATION_MIN_CONFIDENCE_FOR_ADAPTIVE_TRIAL = 0.25;
const TEMPLATE_ALIGN_SHIFTS = [-0.5, -0.25, 0, 0.25, 0.5];
const TEMPLATE_ALIGN_SCALES = [0.99, 1, 1.01];
const STANDARD_NEARBY_SHIFTS = [-12, -8, -4, 0, 4, 8, 12];
const STANDARD_SIZE_JITTERS = [-12, -10, -8, -6, -4, -2, 2, 4, 6, 8, 10, 12];

export { assessReferenceTextureAlignment, calculateNearBlackRatio, scoreRegion } from './restorationMetrics.js';

function mergeCandidateProvenance(...provenanceParts) {
    const merged = {};
    for (const provenance of provenanceParts) {
        if (!provenance || typeof provenance !== 'object') continue;
        Object.assign(merged, provenance);
    }

    return Object.keys(merged).length > 0 ? merged : null;
}

function buildStandardCandidateSeeds({
    originalImageData,
    config,
    position,
    alpha48,
    alpha96,
    getAlphaMap
}) {
    const configs = resolveGeminiWatermarkSearchConfigs(
        originalImageData.width,
        originalImageData.height,
        config
    );
    const seeds = [];

    for (const candidateConfig of configs) {
        const candidatePosition = candidateConfig === config
            ? position
            : {
                x: originalImageData.width - candidateConfig.marginRight - candidateConfig.logoSize,
                y: originalImageData.height - candidateConfig.marginBottom - candidateConfig.logoSize,
                width: candidateConfig.logoSize,
                height: candidateConfig.logoSize
            };
        if (
            candidatePosition.x < 0 ||
            candidatePosition.y < 0 ||
            candidatePosition.x + candidatePosition.width > originalImageData.width ||
            candidatePosition.y + candidatePosition.height > originalImageData.height
        ) {
            continue;
        }

        const alphaMap = resolveAlphaMapForSize(candidateConfig.logoSize, {
            alpha48,
            alpha96,
            getAlphaMap
        });
        if (!alphaMap) continue;

        seeds.push({
            config: candidateConfig,
            position: candidatePosition,
            alphaMap,
            source: candidateConfig === config ? 'standard' : 'standard+catalog',
            provenance: candidateConfig === config ? null : { catalogVariant: true }
        });
    }

    return seeds;
}

function inferDecisionTier(candidate, { directMatch = false } = {}) {
    if (!candidate) return 'insufficient';
    if (directMatch) return 'direct-match';
    if (candidate.source?.includes('validated')) return 'validated-match';
    if (candidate.accepted) return 'validated-match';
    return 'safe-removal';
}

export function resolveAlphaMapForSize(size, { alpha48, alpha96, getAlphaMap } = {}) {
    if (size === 48) return alpha48;
    if (size === 96) return alpha96;

    const provided = typeof getAlphaMap === 'function' ? getAlphaMap(size) : null;
    if (provided) return provided;

    return alpha96 ? interpolateAlphaMap(alpha96, 96, size) : null;
}

export function evaluateRestorationCandidate({
    originalImageData,
    alphaMap,
    position,
    source,
    config,
    baselineNearBlackRatio,
    adaptiveConfidence = null,
    alphaGain = 1,
    provenance = null
}) {
    if (!alphaMap || !position) return null;

    const originalScores = scoreRegion(originalImageData, alphaMap, position);
    const candidateImageData = cloneImageData(originalImageData);
    removeWatermark(candidateImageData, alphaMap, position, { alphaGain });

    const processedScores = scoreRegion(candidateImageData, alphaMap, position);
    const nearBlackRatio = calculateNearBlackRatio(candidateImageData, position);
    const nearBlackIncrease = nearBlackRatio - baselineNearBlackRatio;
    // Signed suppression keeps legitimate "slight overshoot" restores eligible.
    const improvement = originalScores.spatialScore - processedScores.spatialScore;
    const gradientIncrease = processedScores.gradientScore - originalScores.gradientScore;
    const textureAssessment = assessReferenceTextureAlignment({
        referenceImageData: originalImageData,
        candidateImageData,
        position
    });
    const texturePenalty = textureAssessment.texturePenalty;
    const accepted =
        textureAssessment.hardReject !== true &&
        nearBlackIncrease <= MAX_NEAR_BLACK_RATIO_INCREASE &&
        improvement >= VALIDATION_MIN_IMPROVEMENT &&
        (
            Math.abs(processedScores.spatialScore) <= VALIDATION_TARGET_RESIDUAL ||
            gradientIncrease <= VALIDATION_MAX_GRADIENT_INCREASE
        );

    return {
        accepted,
        source,
        config,
        position,
        alphaMap,
        adaptiveConfidence,
        alphaGain,
        provenance: mergeCandidateProvenance(provenance),
        imageData: candidateImageData,
        originalSpatialScore: originalScores.spatialScore,
        originalGradientScore: originalScores.gradientScore,
        processedSpatialScore: processedScores.spatialScore,
        processedGradientScore: processedScores.gradientScore,
        improvement,
        nearBlackRatio,
        nearBlackIncrease,
        gradientIncrease,
        tooDark: textureAssessment.tooDark,
        tooFlat: textureAssessment.tooFlat,
        hardReject: textureAssessment.hardReject,
        texturePenalty,
        validationCost:
            Math.abs(processedScores.spatialScore) +
            Math.max(0, processedScores.gradientScore) * 0.6 +
            Math.max(0, nearBlackIncrease) * 3 +
            texturePenalty
    };
}

export function pickBestValidatedCandidate(candidates) {
    const accepted = candidates.filter((candidate) => candidate?.accepted);
    if (accepted.length === 0) return null;

    accepted.sort((a, b) => {
        if (a.validationCost !== b.validationCost) {
            return a.validationCost - b.validationCost;
        }

        return b.improvement - a.improvement;
    });

    return accepted[0];
}

export function pickBetterCandidate(currentBest, candidate, minCostDelta = 0.005) {
    if (!candidate?.accepted) return currentBest;
    if (!currentBest) return candidate;
    if (candidate.validationCost < currentBest.validationCost - minCostDelta) {
        return candidate;
    }
    if (Math.abs(candidate.validationCost - currentBest.validationCost) <= minCostDelta &&
        candidate.improvement > currentBest.improvement + 0.01) {
        return candidate;
    }
    return currentBest;
}

export function findBestTemplateWarp({
    originalImageData,
    alphaMap,
    position,
    baselineSpatialScore,
    baselineGradientScore
}) {
    const size = position.width;
    if (!size || size <= 8) return null;

    let best = {
        spatialScore: baselineSpatialScore,
        gradientScore: baselineGradientScore,
        shift: { dx: 0, dy: 0, scale: 1 },
        alphaMap
    };

    for (const scale of TEMPLATE_ALIGN_SCALES) {
        for (const dy of TEMPLATE_ALIGN_SHIFTS) {
            for (const dx of TEMPLATE_ALIGN_SHIFTS) {
                if (dx === 0 && dy === 0 && scale === 1) continue;
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                const spatialScore = computeRegionSpatialCorrelation({
                    imageData: originalImageData,
                    alphaMap: warped,
                    region: { x: position.x, y: position.y, size }
                });
                const gradientScore = computeRegionGradientCorrelation({
                    imageData: originalImageData,
                    alphaMap: warped,
                    region: { x: position.x, y: position.y, size }
                });

                const confidence =
                    Math.max(0, spatialScore) * 0.7 +
                    Math.max(0, gradientScore) * 0.3;
                const bestConfidence =
                    Math.max(0, best.spatialScore) * 0.7 +
                    Math.max(0, best.gradientScore) * 0.3;

                if (confidence > bestConfidence + 0.01) {
                    best = {
                        spatialScore,
                        gradientScore,
                        shift: { dx, dy, scale },
                        alphaMap: warped
                    };
                }
            }
        }
    }

    const improvedSpatial = best.spatialScore >= baselineSpatialScore + 0.01;
    const improvedGradient = best.gradientScore >= baselineGradientScore + 0.01;
    return improvedSpatial || improvedGradient ? best : null;
}

function searchNearbyStandardCandidate({
    originalImageData,
    candidateSeeds,
    adaptiveConfidence = null
}) {
    if (!Array.isArray(candidateSeeds) || candidateSeeds.length === 0) return null;

    let bestCandidate = null;
    for (const seed of candidateSeeds) {
        for (const dy of STANDARD_NEARBY_SHIFTS) {
            for (const dx of STANDARD_NEARBY_SHIFTS) {
                if (dx === 0 && dy === 0) continue;

                const candidatePosition = {
                    x: seed.position.x + dx,
                    y: seed.position.y + dy,
                    width: seed.position.width,
                    height: seed.position.height
                };
                if (candidatePosition.x < 0 || candidatePosition.y < 0) continue;
                if (candidatePosition.x + candidatePosition.width > originalImageData.width) continue;
                if (candidatePosition.y + candidatePosition.height > originalImageData.height) continue;

                const candidate = evaluateRestorationCandidate({
                    originalImageData,
                    alphaMap: seed.alphaMap,
                    position: candidatePosition,
                    source: `${seed.source}+local`,
                    config: seed.config,
                    baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, candidatePosition),
                    adaptiveConfidence,
                    provenance: mergeCandidateProvenance(seed.provenance, { localShift: true })
                });

                if (!candidate?.accepted) continue;
                bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
            }
        }
    }

    return bestCandidate;
}

function searchStandardSizeJitterCandidate({
    originalImageData,
    candidateSeeds,
    alpha48,
    alpha96,
    getAlphaMap,
    adaptiveConfidence = null
}) {
    if (!Array.isArray(candidateSeeds) || candidateSeeds.length === 0) return null;

    let bestCandidate = null;
    for (const seed of candidateSeeds) {
        for (const delta of STANDARD_SIZE_JITTERS) {
            const size = seed.position.width + delta;
            if (size <= 24) continue;
            if (size === seed.position.width) continue;

            const candidatePosition = {
                x: originalImageData.width - seed.config.marginRight - size,
                y: originalImageData.height - seed.config.marginBottom - size,
                width: size,
                height: size
            };
            if (candidatePosition.x < 0 || candidatePosition.y < 0) continue;
            if (candidatePosition.x + candidatePosition.width > originalImageData.width) continue;
            if (candidatePosition.y + candidatePosition.height > originalImageData.height) continue;

            const candidateAlphaMap = resolveAlphaMapForSize(size, {
                alpha48,
                alpha96,
                getAlphaMap
            });
            if (!candidateAlphaMap) continue;

            const candidate = evaluateRestorationCandidate({
                originalImageData,
                alphaMap: candidateAlphaMap,
                position: candidatePosition,
                source: `${seed.source}+size`,
                config: {
                    logoSize: size,
                    marginRight: seed.config.marginRight,
                    marginBottom: seed.config.marginBottom
                },
                baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, candidatePosition),
                adaptiveConfidence,
                provenance: mergeCandidateProvenance(seed.provenance, { sizeJitter: true })
            });

            if (!candidate?.accepted) continue;
            bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
        }
    }

    return bestCandidate;
}

export function selectInitialCandidate({
    originalImageData,
    config,
    position,
    alpha48,
    alpha96,
    getAlphaMap,
    allowAdaptiveSearch,
    alphaGainCandidates
}) {
    let alphaMap = config.logoSize === 96 ? alpha96 : alpha48;
    const standardCandidateSeeds = buildStandardCandidateSeeds({
        originalImageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap
    });
    const standardTrials = standardCandidateSeeds
        .map((seed) => evaluateRestorationCandidate({
            originalImageData,
            alphaMap: seed.alphaMap,
            position: seed.position,
            source: seed.source,
            config: seed.config,
            baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, seed.position),
            provenance: seed.provenance
        }))
        .filter(Boolean);
    const standardTrial = standardTrials.find((candidate) => candidate.source === 'standard') ?? standardTrials[0] ?? null;
    const standardSpatialScore = standardTrial?.originalSpatialScore ?? null;
    const standardGradientScore = standardTrial?.originalGradientScore ?? null;
    const hasReliableStandardMatch = hasReliableStandardWatermarkSignal({
        spatialScore: standardSpatialScore,
        gradientScore: standardGradientScore
    });

    let adaptive = null;
    let adaptiveConfidence = null;
    let adaptiveTrial = null;
    let adaptiveEvaluated = false;

    const evaluateAdaptiveCandidate = () => {
        if (adaptiveEvaluated) return adaptiveTrial;
        adaptiveEvaluated = true;

        if (!allowAdaptiveSearch || !alpha96) {
            return adaptiveTrial;
        }

        adaptive = detectAdaptiveWatermarkRegion({
            imageData: originalImageData,
            alpha96,
            defaultConfig: config
        });
        adaptiveConfidence = adaptive?.confidence ?? null;

        if (!adaptive?.region || !(
            hasReliableAdaptiveWatermarkSignal(adaptive) ||
            adaptive.confidence >= VALIDATION_MIN_CONFIDENCE_FOR_ADAPTIVE_TRIAL
        )) {
            return adaptiveTrial;
        }

        const size = adaptive.region.size;
        const adaptivePosition = {
            x: adaptive.region.x,
            y: adaptive.region.y,
            width: size,
            height: size
        };
        const adaptiveAlphaMap = resolveAlphaMapForSize(size, {
            alpha48,
            alpha96,
            getAlphaMap
        });
        if (!adaptiveAlphaMap) {
            throw new Error(`Missing alpha map for adaptive size ${size}`);
        }
        const adaptiveConfig = {
            logoSize: size,
            marginRight: originalImageData.width - adaptivePosition.x - size,
            marginBottom: originalImageData.height - adaptivePosition.y - size
        };
        adaptiveTrial = evaluateRestorationCandidate({
            originalImageData,
            alphaMap: adaptiveAlphaMap,
            position: adaptivePosition,
            source: 'adaptive',
            config: adaptiveConfig,
            baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, adaptivePosition),
            adaptiveConfidence: adaptive.confidence,
            provenance: { adaptive: true }
        });
        return adaptiveTrial;
    };

    let baseCandidate = null;
    let baseDecisionTier = 'insufficient';
    if (hasReliableStandardMatch) {
        baseCandidate = standardTrial;
        baseDecisionTier = 'direct-match';
    } else if (standardTrial?.accepted) {
        baseCandidate = {
            ...standardTrial,
            source: `${standardTrial.source}+validated`
        };
        baseDecisionTier = 'validated-match';
    }

    for (const candidate of standardTrials) {
        if (!candidate || candidate === standardTrial) continue;
        const standardCandidate = hasReliableStandardWatermarkSignal({
            spatialScore: candidate.originalSpatialScore,
            gradientScore: candidate.originalGradientScore
        })
            ? candidate
            : (candidate.accepted
                ? {
                    ...candidate,
                    source: `${candidate.source}+validated`
                }
                : null);
        const previousCandidate = baseCandidate;
        baseCandidate = pickBetterCandidate(baseCandidate, standardCandidate, 0.002);
        if (baseCandidate !== previousCandidate && baseCandidate) {
            baseDecisionTier = hasReliableStandardWatermarkSignal({
                spatialScore: candidate.originalSpatialScore,
                gradientScore: candidate.originalGradientScore
            })
                ? 'direct-match'
                : 'validated-match';
        }
    }

    if (baseDecisionTier !== 'direct-match') {
        const sizeJitterCandidate = searchStandardSizeJitterCandidate({
            originalImageData,
            candidateSeeds: standardCandidateSeeds,
            alpha48,
            alpha96,
            getAlphaMap
        });
        if (sizeJitterCandidate) {
            const previousCandidate = baseCandidate;
            baseCandidate = pickBetterCandidate(baseCandidate, {
                ...sizeJitterCandidate,
                source: `${sizeJitterCandidate.source}+validated`
            }, 0.002);
            if (baseCandidate !== previousCandidate && baseCandidate) {
                baseDecisionTier = 'validated-match';
            }
        }
    }

    const shouldEvaluateAdaptive = () => {
        if (!allowAdaptiveSearch || !alpha96) return false;
        if (!baseCandidate) return true;

        return shouldAttemptAdaptiveFallback({
            processedImageData: baseCandidate.imageData,
            alphaMap: baseCandidate.alphaMap,
            position: baseCandidate.position,
            originalImageData,
            originalSpatialMismatchThreshold: 0
        });
    };

    if (shouldEvaluateAdaptive()) {
        evaluateAdaptiveCandidate();
    }

    if (adaptiveTrial) {
        const adaptiveCandidate = hasReliableAdaptiveWatermarkSignal(adaptive)
            ? adaptiveTrial
            : (adaptiveTrial.accepted
                ? {
                    ...adaptiveTrial,
                    source: `${adaptiveTrial.source}+validated`
                }
                : null);
        const previousCandidate = baseCandidate;
        baseCandidate = pickBetterCandidate(baseCandidate, adaptiveCandidate, 0.002);
        if (baseCandidate !== previousCandidate && baseCandidate) {
            baseDecisionTier = hasReliableAdaptiveWatermarkSignal(adaptive)
                ? 'direct-match'
                : 'validated-match';
        }
    }

    if (!baseCandidate && !hasReliableAdaptiveWatermarkSignal(adaptive)) {
        const nearbyStandardCandidate = searchNearbyStandardCandidate({
            originalImageData,
            candidateSeeds: standardCandidateSeeds,
            adaptiveConfidence
        });
        if (nearbyStandardCandidate) {
            baseCandidate = {
                ...nearbyStandardCandidate,
                source: `${nearbyStandardCandidate.source}+validated`
            };
            baseDecisionTier = 'validated-match';
        }
    }

    if (!baseCandidate) {
        const validatedCandidate = pickBestValidatedCandidate([standardTrial, adaptiveTrial]);
        if (!validatedCandidate) {
            return {
                selectedTrial: null,
                source: 'skipped',
                alphaMap,
                position,
                config,
                adaptiveConfidence,
                standardSpatialScore,
                standardGradientScore,
                templateWarp: null,
                alphaGain: 1,
                decisionTier: 'insufficient'
            };
        }
        baseCandidate = {
            ...validatedCandidate,
            source: `${validatedCandidate.source}+validated`
        };
        baseDecisionTier = 'validated-match';
    }

    let selectedTrial = baseCandidate;
    alphaMap = baseCandidate.alphaMap;
    position = baseCandidate.position;
    config = baseCandidate.config;
    let source = baseCandidate.source;
    let decisionTier = baseDecisionTier || inferDecisionTier(baseCandidate);
    let templateWarp = null;
    let selectedAlphaGain = baseCandidate.alphaGain ?? 1;

    const warpCandidate = findBestTemplateWarp({
        originalImageData,
        alphaMap,
        position,
        baselineSpatialScore: selectedTrial.originalSpatialScore,
        baselineGradientScore: selectedTrial.originalGradientScore
    });
    if (warpCandidate) {
        const warpedTrial = evaluateRestorationCandidate({
            originalImageData,
            alphaMap: warpCandidate.alphaMap,
            position,
            source: `${source}+warp`,
            config,
            baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, position),
            adaptiveConfidence,
            provenance: selectedTrial.provenance
        });
        const betterWarpTrial = pickBetterCandidate(selectedTrial, warpedTrial);
        if (betterWarpTrial !== selectedTrial) {
            alphaMap = warpedTrial.alphaMap;
            source = betterWarpTrial.source;
            selectedTrial = betterWarpTrial;
            templateWarp = warpCandidate.shift;
            decisionTier = inferDecisionTier(betterWarpTrial, {
                directMatch: decisionTier === 'direct-match'
            });
        }
    }

    let bestGainTrial = selectedTrial;
    for (const candidateGain of alphaGainCandidates) {
        const gainTrial = evaluateRestorationCandidate({
            originalImageData,
            alphaMap,
            position,
            source: `${source}+gain`,
            config,
            baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, position),
            adaptiveConfidence,
            alphaGain: candidateGain,
            provenance: selectedTrial.provenance
        });
        bestGainTrial = pickBetterCandidate(bestGainTrial, gainTrial);
    }
    if (bestGainTrial !== selectedTrial) {
        selectedTrial = bestGainTrial;
        source = bestGainTrial.source;
        selectedAlphaGain = bestGainTrial.alphaGain;
        decisionTier = inferDecisionTier(bestGainTrial, {
            directMatch: decisionTier === 'direct-match'
        });
    }

    return {
        selectedTrial,
        source,
        alphaMap,
        position,
        config,
        adaptiveConfidence,
        standardSpatialScore,
        standardGradientScore,
        templateWarp,
        alphaGain: selectedAlphaGain,
        decisionTier
    };
}

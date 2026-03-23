import { removeWatermark } from './blendModes.js';
import { removeRepeatedWatermarkLayers } from './multiPassRemoval.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    warpAlphaMap
} from './adaptiveDetector.js';
import {
    calculateNearBlackRatio,
    scoreRegion,
    selectInitialCandidate
} from './candidateSelector.js';
import { createSelectionDebugSummary } from './selectionDebug.js';
import {
    calculateWatermarkPosition,
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from './watermarkConfig.js';

const RESIDUAL_RECALIBRATION_THRESHOLD = 0.5;
const MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION = 0.18;
const MIN_RECALIBRATION_SCORE_DELTA = 0.18;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const OUTLINE_REFINEMENT_THRESHOLD = 0.42;
const OUTLINE_REFINEMENT_MIN_GAIN = 1.2;
const SUBPIXEL_REFINE_SHIFTS = [-0.25, 0, 0.25];
const SUBPIXEL_REFINE_SCALES = [0.99, 1, 1.01];
const ALPHA_GAIN_CANDIDATES = [1.05, 1.12, 1.2, 1.28, 1.36, 1.45, 1.52, 1.6, 1.7, 1.85, 2.0, 2.2, 2.4, 2.6];

function cloneImageData(imageData) {
    if (typeof ImageData !== 'undefined' && imageData instanceof ImageData) {
        return new ImageData(
            new Uint8ClampedArray(imageData.data),
            imageData.width,
            imageData.height
        );
    }

    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

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

    return { logoSize, marginRight, marginBottom };
}

function createWatermarkMeta({
    position = null,
    config = null,
    adaptiveConfidence = null,
    originalSpatialScore = null,
    originalGradientScore = null,
    processedSpatialScore = null,
    processedGradientScore = null,
    suppressionGain = null,
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
    selectionDebug = null
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
            suppressionGain
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
        selectionDebug
    };
}

function shouldRecalibrateAlphaStrength({ originalScore, processedScore, suppressionGain }) {
    return originalScore >= 0.6 &&
        processedScore >= RESIDUAL_RECALIBRATION_THRESHOLD &&
        suppressionGain <= MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION;
}

function refineSubpixelOutline({
    sourceImageData,
    alphaMap,
    position,
    alphaGain,
    originalNearBlackRatio,
    baselineSpatialScore,
    baselineGradientScore,
    baselineShift
}) {
    const size = position.width;
    if (!size || size <= 8) return null;
    if (alphaGain < OUTLINE_REFINEMENT_MIN_GAIN) return null;

    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    const gainCandidates = [alphaGain];
    const lower = Math.max(1, Number((alphaGain - 0.01).toFixed(2)));
    const upper = Number((alphaGain + 0.01).toFixed(2));
    if (lower !== alphaGain) gainCandidates.push(lower);
    if (upper !== alphaGain) gainCandidates.push(upper);

    const baseDx = baselineShift?.dx ?? 0;
    const baseDy = baselineShift?.dy ?? 0;
    const baseScale = baselineShift?.scale ?? 1;

    let best = null;
    for (const scaleDelta of SUBPIXEL_REFINE_SCALES) {
        const scale = Number((baseScale * scaleDelta).toFixed(4));
        for (const dyDelta of SUBPIXEL_REFINE_SHIFTS) {
            const dy = baseDy + dyDelta;
            for (const dxDelta of SUBPIXEL_REFINE_SHIFTS) {
                const dx = baseDx + dxDelta;
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                for (const gain of gainCandidates) {
                    const candidate = cloneImageData(sourceImageData);
                    removeWatermark(candidate, warped, position, { alphaGain: gain });
                    const nearBlackRatio = calculateNearBlackRatio(candidate, position);
                    if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

                    const spatialScore = computeRegionSpatialCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });
                    const gradientScore = computeRegionGradientCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });

                    const cost = Math.abs(spatialScore) * 0.6 + Math.max(0, gradientScore);
                    if (!best || cost < best.cost) {
                        best = {
                            imageData: candidate,
                            alphaMap: warped,
                            alphaGain: gain,
                            shift: { dx, dy, scale },
                            spatialScore,
                            gradientScore,
                            nearBlackRatio,
                            cost
                        };
                    }
                }
            }
        }
    }

    if (!best) return null;

    const improvedGradient = best.gradientScore <= baselineGradientScore - 0.04;
    const keptSpatial = Math.abs(best.spatialScore) <= Math.abs(baselineSpatialScore) + 0.08;
    if (!improvedGradient || !keptSpatial) return null;

    return best;
}

function recalibrateAlphaStrength({
    sourceImageData,
    alphaMap,
    position,
    originalSpatialScore,
    processedSpatialScore,
    originalNearBlackRatio
}) {
    let bestScore = processedSpatialScore;
    let bestGain = 1;
    let bestImageData = null;
    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);

    for (const alphaGain of ALPHA_GAIN_CANDIDATES) {
        const candidate = cloneImageData(sourceImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const candidateNearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (candidateNearBlackRatio > maxAllowedNearBlackRatio) {
            continue;
        }

        const score = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        });

        if (score < bestScore) {
            bestScore = score;
            bestGain = alphaGain;
            bestImageData = candidate;
        }
    }

    const refinedCandidates = [];
    for (let delta = -0.05; delta <= 0.05; delta += 0.01) {
        refinedCandidates.push(Number((bestGain + delta).toFixed(2)));
    }

    for (const alphaGain of refinedCandidates) {
        if (alphaGain <= 1 || alphaGain >= 3) continue;
        const candidate = cloneImageData(sourceImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const candidateNearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (candidateNearBlackRatio > maxAllowedNearBlackRatio) {
            continue;
        }

        const score = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        });

        if (score < bestScore) {
            bestScore = score;
            bestGain = alphaGain;
            bestImageData = candidate;
        }
    }

    const scoreDelta = processedSpatialScore - bestScore;
    if (!bestImageData || scoreDelta < MIN_RECALIBRATION_SCORE_DELTA) {
        return null;
    }

    return {
        imageData: bestImageData,
        alphaGain: bestGain,
        processedSpatialScore: bestScore,
        suppressionGain: originalSpatialScore - bestScore
    };
}

export function processWatermarkImageData(imageData, options = {}) {
    const adaptiveMode = options.adaptiveMode || 'auto';
    const allowAdaptiveSearch = adaptiveMode !== 'never' && adaptiveMode !== 'off';
    const originalImageData = cloneImageData(imageData);
    const { alpha48, alpha96 } = options;

    if (!alpha48 || !alpha96) {
        throw new Error('processWatermarkImageData requires alpha48 and alpha96');
    }

    const defaultConfig = detectWatermarkConfig(originalImageData.width, originalImageData.height);
    const resolvedConfig = resolveInitialStandardConfig({
        imageData: originalImageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    let config = resolvedConfig;
    let position = calculateWatermarkPosition(originalImageData.width, originalImageData.height, config);
    let alphaMap = config.logoSize === 96 ? alpha96 : alpha48;
    let source = 'standard';
    let adaptiveConfidence = null;
    let alphaGain = 1;
    let subpixelShift = null;
    let templateWarp = null;
    let decisionTier = null;
    let passCount = 0;
    let attemptedPassCount = 0;
    let passStopReason = null;
    let passes = null;

    const initialSelection = selectInitialCandidate({
        originalImageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: options.getAlphaMap,
        allowAdaptiveSearch,
        alphaGainCandidates: ALPHA_GAIN_CANDIDATES
    });

    if (!initialSelection.selectedTrial) {
        return {
            imageData: originalImageData,
            meta: createWatermarkMeta({
                adaptiveConfidence: initialSelection.adaptiveConfidence,
                originalSpatialScore: initialSelection.standardSpatialScore,
                originalGradientScore: initialSelection.standardGradientScore,
                processedSpatialScore: initialSelection.standardSpatialScore,
                processedGradientScore: initialSelection.standardGradientScore,
                suppressionGain: 0,
                alphaGain: 1,
                source: 'skipped',
                decisionTier: initialSelection.decisionTier ?? 'insufficient',
                applied: false,
                skipReason: 'no-watermark-detected',
                selectionDebug: null
            })
        };
    }

    position = initialSelection.position;
    alphaMap = initialSelection.alphaMap;
    config = initialSelection.config;
    source = initialSelection.source;
    adaptiveConfidence = initialSelection.adaptiveConfidence;
    templateWarp = initialSelection.templateWarp;
    alphaGain = initialSelection.alphaGain;
    decisionTier = initialSelection.decisionTier;

    const selectedTrial = initialSelection.selectedTrial;

    let finalImageData = selectedTrial.imageData;

    let originalSpatialScore = selectedTrial.originalSpatialScore;
    let originalGradientScore = selectedTrial.originalGradientScore;

    const firstPassSpatialScore = computeRegionSpatialCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const firstPassGradientScore = computeRegionGradientCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const firstPassNearBlackRatio = calculateNearBlackRatio(finalImageData, position);
    const firstPassRecord = {
        index: 1,
        beforeSpatialScore: originalSpatialScore,
        beforeGradientScore: originalGradientScore,
        afterSpatialScore: firstPassSpatialScore,
        afterGradientScore: firstPassGradientScore,
        improvement: Math.abs(originalSpatialScore) - Math.abs(firstPassSpatialScore),
        gradientDelta: firstPassGradientScore - originalGradientScore,
        nearBlackRatio: firstPassNearBlackRatio
    };

    const totalMaxPasses = Math.max(1, options.maxPasses ?? 4);
    const remainingPasses = Math.max(0, totalMaxPasses - 1);
    const firstPassClearedResidual = Math.abs(firstPassSpatialScore) <= 0.25;
    const extraPassResult = remainingPasses > 0 && !firstPassClearedResidual
        ? removeRepeatedWatermarkLayers({
            imageData: finalImageData,
            alphaMap,
            position,
            maxPasses: remainingPasses,
            startingPassIndex: 1,
            alphaGain
        })
        : null;
    finalImageData = extraPassResult?.imageData ?? finalImageData;
    passCount = extraPassResult?.passCount ?? 1;
    attemptedPassCount = extraPassResult?.attemptedPassCount ?? 1;
    passStopReason = extraPassResult?.stopReason ?? (firstPassClearedResidual ? 'residual-low' : 'max-passes');
    passes = [firstPassRecord, ...(extraPassResult?.passes ?? [])];
    if (passCount > 1) {
        source = `${source}+multipass`;
    }

    const processedSpatialScore = computeRegionSpatialCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    const processedGradientScore = computeRegionGradientCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    let finalProcessedSpatialScore = processedSpatialScore;
    let finalProcessedGradientScore = processedGradientScore;
    let suppressionGain = originalSpatialScore - finalProcessedSpatialScore;

    if (shouldRecalibrateAlphaStrength({
        originalScore: originalSpatialScore,
        processedScore: finalProcessedSpatialScore,
        suppressionGain
    })) {
        const originalNearBlackRatio = calculateNearBlackRatio(finalImageData, position);
        const recalibrated = recalibrateAlphaStrength({
            sourceImageData: finalImageData,
            alphaMap,
            position,
            originalSpatialScore,
            processedSpatialScore: finalProcessedSpatialScore,
            originalNearBlackRatio
        });

        if (recalibrated) {
            finalImageData = recalibrated.imageData;
            alphaGain = recalibrated.alphaGain;
            finalProcessedSpatialScore = recalibrated.processedSpatialScore;
            finalProcessedGradientScore = computeRegionGradientCorrelation({
                imageData: finalImageData,
                alphaMap,
                region: {
                    x: position.x,
                    y: position.y,
                    size: position.width
                }
            });
            suppressionGain = recalibrated.suppressionGain;
            source = source === 'adaptive' ? 'adaptive+gain' : `${source}+gain`;
        }
    }

    if (finalProcessedSpatialScore <= 0.3 && finalProcessedGradientScore >= OUTLINE_REFINEMENT_THRESHOLD) {
        const originalNearBlackRatio = calculateNearBlackRatio(finalImageData, position);
        const baselineShift = templateWarp ?? { dx: 0, dy: 0, scale: 1 };
        const refined = refineSubpixelOutline({
            sourceImageData: finalImageData,
            alphaMap,
            position,
            alphaGain,
            originalNearBlackRatio,
            baselineSpatialScore: finalProcessedSpatialScore,
            baselineGradientScore: finalProcessedGradientScore,
            baselineShift
        });

        if (refined) {
            finalImageData = refined.imageData;
            alphaMap = refined.alphaMap;
            alphaGain = refined.alphaGain;
            finalProcessedSpatialScore = refined.spatialScore;
            finalProcessedGradientScore = refined.gradientScore;
            suppressionGain = originalSpatialScore - finalProcessedSpatialScore;
            source = `${source}+subpixel`;
            subpixelShift = refined.shift;
        }
    }

    return {
        imageData: finalImageData,
        meta: createWatermarkMeta({
            position,
            config,
            adaptiveConfidence,
            originalSpatialScore,
            originalGradientScore,
            processedSpatialScore: finalProcessedSpatialScore,
            processedGradientScore: finalProcessedGradientScore,
            suppressionGain,
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
            selectionDebug: createSelectionDebugSummary({
                selectedTrial,
                selectionSource: initialSelection.source
            })
        })
    };
}

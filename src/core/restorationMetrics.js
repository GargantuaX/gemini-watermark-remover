import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation
} from './adaptiveDetector.js';

const NEAR_BLACK_THRESHOLD = 5;
const NEAR_WHITE_THRESHOLD = 250;
const TEXTURE_REFERENCE_MARGIN = 1;
const TEXTURE_STD_FLOOR_RATIO = 0.8;
const TEXTURE_DARKNESS_VISIBILITY_HARD_REJECT_THRESHOLD = 1.5;
const TEXTURE_DARKNESS_HARD_REJECT_PENALTY_THRESHOLD = 0.5;
const TEXTURE_FLATNESS_HARD_REJECT_PENALTY_THRESHOLD = 0.2;
const DEFAULT_HALO_MIN_ALPHA = 0.12;
const DEFAULT_HALO_MAX_ALPHA = 0.35;
const DEFAULT_HALO_OUTSIDE_ALPHA_MAX = 0.01;
const DEFAULT_HALO_OUTER_MARGIN = 3;
const DIFF_NEGATIVE_THRESHOLD = 1 / 255;
const DIFF_CLIP_ORIGINAL_THRESHOLD = 5;
const DIFF_CLIP_CANDIDATE_THRESHOLD = 0;
const DIFF_WHITE_CLIP_ORIGINAL_THRESHOLD = 255 - DIFF_CLIP_ORIGINAL_THRESHOLD;
const DIFF_WHITE_CLIP_CANDIDATE_THRESHOLD = 255 - DIFF_CLIP_CANDIDATE_THRESHOLD;
const RECOMPOSE_MAX_ALPHA = 0.99;
const DIFF_DARK_HALO_VISUAL_WEIGHT = 0.004;
const DIFF_NEW_CLIP_VISUAL_WEIGHT = 0.5;
const RESIDUAL_VISIBILITY_CORE_MIN_ALPHA = 0.18;
const RESIDUAL_VISIBILITY_CORE_MAX_ALPHA = 0.35;
const RESIDUAL_VISIBILITY_OUTSIDE_ALPHA_MAX = 0.012;
const RESIDUAL_VISIBILITY_OUTER_MARGIN = 4;
const RESIDUAL_VISIBILITY_POSITIVE_HALO_LUM_THRESHOLD = 6;
const RESIDUAL_VISIBILITY_DARK_POLARITY_STRONG_HALO_LUM_THRESHOLD = 6;
const RESIDUAL_VISIBILITY_DARK_POLARITY_LOW_TEXTURE_HALO_LUM_THRESHOLD = 1.75;
const RESIDUAL_VISIBILITY_DARK_POLARITY_LOW_TEXTURE_MAX_STD_LUM = 30;
const RESIDUAL_VISIBILITY_GRADIENT_THRESHOLD = 0.22;
const RESIDUAL_VISIBILITY_SPATIAL_THRESHOLD = 0.18;
const FLAT_CLIPPED_METRIC_RISK_NEAR_BLACK_RATIO = 0.92;
const FLAT_CLIPPED_METRIC_RISK_NEWLY_CLIPPED_RATIO = 0.18;
const FLAT_CLIPPED_METRIC_RISK_MAX_POSITIVE_HALO_LUM = 2;
const FLAT_CLIPPED_METRIC_RISK_MIN_NEGATIVE_SPATIAL = 0.18;
const FLAT_LOW_VARIANCE_METRIC_RISK_MIN_NEGATIVE_SPATIAL = 0.18;
const FLAT_LOW_VARIANCE_METRIC_RISK_MAX_GRADIENT = 0.08;
const FLAT_LOW_VARIANCE_METRIC_RISK_MAX_STD_LUM = 1;
const FLAT_LOW_VARIANCE_METRIC_RISK_MAX_ABS_DELTA_LUM = 1;
const NONLOCALIZED_SPATIAL_METRIC_RISK_MIN_NEGATIVE_SPATIAL = 0.18;
const NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_GRADIENT = 0.12;
const NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_POSITIVE_HALO_LUM = 2;
const NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_NEAR_BLACK_RATIO = 0.25;
const NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_NEWLY_CLIPPED_RATIO = 0.01;
const NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_ARTIFACT_COST = 0.2;
const NONLOCALIZED_SPATIAL_METRIC_RISK_MIN_LOCAL_PROMINENCE = 0.06;
const POSITIVE_SPATIAL_BACKGROUND_COLLISION_MIN_SPATIAL = 0.14;
const POSITIVE_SPATIAL_BACKGROUND_COLLISION_MAX_GRADIENT = 0.12;
const POSITIVE_SPATIAL_BACKGROUND_COLLISION_MAX_POSITIVE_HALO_LUM = 32;
const POSITIVE_SPATIAL_BACKGROUND_COLLISION_MAX_ARTIFACT_COST = 0.12;
const WEAK_HALO_BACKGROUND_COLLISION_MAX_ABS_SPATIAL = 0.14;
const WEAK_HALO_BACKGROUND_COLLISION_MAX_GRADIENT = 0.12;
const WEAK_HALO_BACKGROUND_COLLISION_MAX_POSITIVE_HALO_LUM = 10;
const WEAK_HALO_BACKGROUND_COLLISION_MAX_ARTIFACT_COST = 0.12;
const WEAK_HALO_BACKGROUND_COLLISION_MAX_NEAR_BLACK_RATIO = 0.25;
const WEAK_HALO_BACKGROUND_COLLISION_MAX_NEWLY_CLIPPED_RATIO = 0.02;
const STRUCTURED_EDGE_BACKGROUND_COLLISION_MIN_GRADIENT = 0.2;
const STRUCTURED_EDGE_BACKGROUND_COLLISION_MIN_ARTIFACT_COST = 0.2;
const STRUCTURED_EDGE_BACKGROUND_COLLISION_MAX_NEAR_BLACK_RATIO = 0.1;
const STRUCTURED_EDGE_BACKGROUND_COLLISION_MAX_NEWLY_CLIPPED_RATIO = 0.01;
const RESIDUAL_LOCALIZATION_CONTROL_OFFSETS = [
    [-1, 0],
    [0, -1],
    [-1, -1],
    [-2, 0],
    [0, -2],
    [-2, -2]
];

function meanAndVariance(values) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
    }
    const mean = values.length > 0 ? sum / values.length : 0;

    let sq = 0;
    for (let i = 0; i < values.length; i++) {
        const delta = values[i] - mean;
        sq += delta * delta;
    }

    return {
        mean,
        variance: values.length > 0 ? sq / values.length : 0
    };
}

function normalizedCorrelation(a, b) {
    if (a.length !== b.length || a.length === 0) return 0;

    const statsA = meanAndVariance(a);
    const statsB = meanAndVariance(b);
    const den = Math.sqrt(statsA.variance * statsB.variance) * a.length;
    if (den < 1e-8) return 0;

    let num = 0;
    for (let i = 0; i < a.length; i++) {
        num += (a[i] - statsA.mean) * (b[i] - statsB.mean);
    }

    return num / den;
}

function sobelMagnitude(values, width, height) {
    const out = new Float32Array(width * height);

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const gx =
                -values[i - width - 1] - 2 * values[i - 1] - values[i + width - 1] +
                values[i - width + 1] + 2 * values[i + 1] + values[i + width + 1];
            const gy =
                -values[i - width - 1] - 2 * values[i - width] - values[i - width + 1] +
                values[i + width - 1] + 2 * values[i + width] + values[i + width + 1];
            out[i] = Math.sqrt(gx * gx + gy * gy);
        }
    }

    return out;
}

export function cloneImageData(imageData) {
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

export function calculateNearBlackRatio(imageData, position) {
    let nearBlack = 0;
    let total = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
            const r = imageData.data[idx];
            const g = imageData.data[idx + 1];
            const b = imageData.data[idx + 2];
            if (r <= NEAR_BLACK_THRESHOLD && g <= NEAR_BLACK_THRESHOLD && b <= NEAR_BLACK_THRESHOLD) {
                nearBlack++;
            }
            total++;
        }
    }

    return total > 0 ? nearBlack / total : 0;
}

export function calculateNearWhiteRatio(imageData, position) {
    let nearWhite = 0;
    let total = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
            const r = imageData.data[idx];
            const g = imageData.data[idx + 1];
            const b = imageData.data[idx + 2];
            if (r >= NEAR_WHITE_THRESHOLD && g >= NEAR_WHITE_THRESHOLD && b >= NEAR_WHITE_THRESHOLD) {
                nearWhite++;
            }
            total++;
        }
    }

    return total > 0 ? nearWhite / total : 0;
}

function calculateRegionTextureStats(imageData, region) {
    let sum = 0;
    let sq = 0;
    let total = 0;

    for (let row = 0; row < region.height; row++) {
        for (let col = 0; col < region.width; col++) {
            const idx = ((region.y + row) * imageData.width + (region.x + col)) * 4;
            const lum =
                0.2126 * imageData.data[idx] +
                0.7152 * imageData.data[idx + 1] +
                0.0722 * imageData.data[idx + 2];
            sum += lum;
            sq += lum * lum;
            total++;
        }
    }

    const meanLum = total > 0 ? sum / total : 0;
    const variance = total > 0 ? Math.max(0, sq / total - meanLum * meanLum) : 0;

    return {
        meanLum,
        stdLum: Math.sqrt(variance)
    };
}

export function getRegionTextureStats(imageData, region) {
    return calculateRegionTextureStats(imageData, region);
}

export function assessAlphaBandHalo({
    imageData,
    position,
    alphaMap,
    minAlpha = DEFAULT_HALO_MIN_ALPHA,
    maxAlpha = DEFAULT_HALO_MAX_ALPHA,
    outsideAlphaMax = DEFAULT_HALO_OUTSIDE_ALPHA_MAX,
    outerMargin = DEFAULT_HALO_OUTER_MARGIN
}) {
    let bandSum = 0;
    let bandSq = 0;
    let bandCount = 0;
    let outerSum = 0;
    let outerSq = 0;
    let outerCount = 0;

    for (let row = -outerMargin; row < position.height + outerMargin; row++) {
        for (let col = -outerMargin; col < position.width + outerMargin; col++) {
            const pixelX = position.x + col;
            const pixelY = position.y + row;
            if (pixelX < 0 || pixelY < 0 || pixelX >= imageData.width || pixelY >= imageData.height) {
                continue;
            }

            const pixelIndex = (pixelY * imageData.width + pixelX) * 4;
            const luminance =
                0.2126 * imageData.data[pixelIndex] +
                0.7152 * imageData.data[pixelIndex + 1] +
                0.0722 * imageData.data[pixelIndex + 2];
            const insideRegion = row >= 0 && col >= 0 && row < position.height && col < position.width;
            const alpha = insideRegion
                ? Math.abs(alphaMap[row * position.width + col])
                : 0;

            if (insideRegion && alpha >= minAlpha && alpha <= maxAlpha) {
                bandSum += luminance;
                bandSq += luminance * luminance;
                bandCount++;
                continue;
            }

            if (!insideRegion || alpha <= outsideAlphaMax) {
                outerSum += luminance;
                outerSq += luminance * luminance;
                outerCount++;
            }
        }
    }

    const bandMeanLum = bandCount > 0 ? bandSum / bandCount : 0;
    const outerMeanLum = outerCount > 0 ? outerSum / outerCount : 0;
    const bandStdLum = bandCount > 0 ? Math.sqrt(Math.max(0, bandSq / bandCount - bandMeanLum * bandMeanLum)) : 0;
    const outerStdLum = outerCount > 0 ? Math.sqrt(Math.max(0, outerSq / outerCount - outerMeanLum * outerMeanLum)) : 0;
    const deltaLum = bandMeanLum - outerMeanLum;
    const visibility = deltaLum / Math.max(1, outerStdLum);

    return {
        bandCount,
        outerCount,
        bandMeanLum,
        outerMeanLum,
        bandStdLum,
        outerStdLum,
        deltaLum,
        positiveDeltaLum: Math.max(0, deltaLum),
        visibility
    };
}

export function assessRemovalDiffArtifacts({
    originalImageData,
    candidateImageData,
    alphaMap,
    position,
    alphaGain = 1
}) {
    if (!originalImageData || !candidateImageData || !alphaMap || !position) {
        return null;
    }

    const total = position.width * position.height;
    if (total <= 0) return null;

    const positiveDiff = new Float32Array(total);
    const signedDiff = new Float32Array(total);
    const candidateLum = new Float32Array(total);
    const gainedAlpha = new Float32Array(total);
    const signedGainedAlpha = new Float32Array(total);
    let negativeDiffCount = 0;
    let oppositeDirectionDiffCount = 0;
    let newlyClippedCount = 0;
    let newlyBlackClippedCount = 0;
    let newlyWhiteClippedCount = 0;
    let signedAlphaSum = 0;
    let firstNonZeroAlphaPolarity = 1;
    let hasNonZeroAlpha = false;
    let recomposeError = 0;
    let weightedRecomposeError = 0;
    let recomposeCount = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const pixelIndex = ((position.y + row) * originalImageData.width + position.x + col) * 4;
            const beforeR = originalImageData.data[pixelIndex];
            const beforeG = originalImageData.data[pixelIndex + 1];
            const beforeB = originalImageData.data[pixelIndex + 2];
            const afterR = candidateImageData.data[pixelIndex];
            const afterG = candidateImageData.data[pixelIndex + 1];
            const afterB = candidateImageData.data[pixelIndex + 2];
            const beforeLum = 0.2126 * beforeR + 0.7152 * beforeG + 0.0722 * beforeB;
            const afterLum = 0.2126 * afterR + 0.7152 * afterG + 0.0722 * afterB;
            const diff = (beforeLum - afterLum) / 255;
            const rawAlpha = alphaMap[localIndex] * alphaGain;
            const polarity = rawAlpha < 0 ? -1 : 1;
            const alpha = Math.min(RECOMPOSE_MAX_ALPHA, Math.abs(rawAlpha));
            const logoValue = rawAlpha < 0 ? 0 : 255;
            signedAlphaSum += rawAlpha;
            if (!hasNonZeroAlpha && rawAlpha !== 0) {
                firstNonZeroAlphaPolarity = polarity;
                hasNonZeroAlpha = true;
            }

            positiveDiff[localIndex] = Math.max(0, diff * polarity);
            signedDiff[localIndex] = diff;
            candidateLum[localIndex] = afterLum / 255;
            gainedAlpha[localIndex] = alpha;
            signedGainedAlpha[localIndex] = alpha * polarity;

            if (diff < -DIFF_NEGATIVE_THRESHOLD) {
                negativeDiffCount++;
            }
            if (diff * polarity < -DIFF_NEGATIVE_THRESHOLD) {
                oppositeDirectionDiffCount++;
            }

            const channels = [[beforeR, afterR], [beforeG, afterG], [beforeB, afterB]];
            const newlyBlackClipped = polarity > 0 && channels.some(([before, after]) => (
                after <= DIFF_CLIP_CANDIDATE_THRESHOLD &&
                before > DIFF_CLIP_ORIGINAL_THRESHOLD
            ));
            const newlyWhiteClipped = polarity < 0 && channels.some(([before, after]) => (
                after >= DIFF_WHITE_CLIP_CANDIDATE_THRESHOLD &&
                before < DIFF_WHITE_CLIP_ORIGINAL_THRESHOLD
            ));
            if (newlyBlackClipped || newlyWhiteClipped) {
                newlyClippedCount++;
            }
            if (newlyBlackClipped) newlyBlackClippedCount++;
            if (newlyWhiteClipped) newlyWhiteClippedCount++;

            for (const [before, after] of channels) {
                const recomposed = after * (1 - alpha) + logoValue * alpha;
                const error = Math.abs(recomposed - before) / 255;
                recomposeError += error;
                weightedRecomposeError += error * Math.max(0.02, alpha);
                recomposeCount++;
            }
        }
    }

    const alphaGradient = sobelMagnitude(gainedAlpha, position.width, position.height);
    const diffGradient = sobelMagnitude(positiveDiff, position.width, position.height);
    const candidateGradient = sobelMagnitude(candidateLum, position.width, position.height);
    const scores = scoreRegion(candidateImageData, alphaMap, position);
    const halo = assessAlphaBandHalo({
        imageData: candidateImageData,
        position,
        alphaMap
    });
    const alphaPolarity = signedAlphaSum > 1e-8
        ? 1
        : signedAlphaSum < -1e-8
            ? -1
            : firstNonZeroAlphaPolarity;
    const newlyClippedRatio = newlyClippedCount / total;
    const newlyBlackClippedRatio = newlyBlackClippedCount / total;
    const newlyWhiteClippedRatio = newlyWhiteClippedCount / total;
    const oppositeDirectionHaloLum = Math.max(0, -halo.deltaLum * alphaPolarity);
    const visualArtifactCost =
        Math.abs(scores.spatialScore) * 0.25 +
        Math.max(0, scores.gradientScore) +
        oppositeDirectionHaloLum * DIFF_DARK_HALO_VISUAL_WEIGHT +
        newlyClippedRatio * DIFF_NEW_CLIP_VISUAL_WEIGHT;

    return {
        spatialScore: scores.spatialScore,
        gradientScore: scores.gradientScore,
        recomposeError: recomposeError / Math.max(1, recomposeCount),
        weightedRecomposeError: weightedRecomposeError / Math.max(1, recomposeCount),
        diffTemplateCorrelation: normalizedCorrelation(positiveDiff, gainedAlpha),
        signedDiffTemplateCorrelation: normalizedCorrelation(signedDiff, signedGainedAlpha),
        diffGradientCorrelation: normalizedCorrelation(diffGradient, alphaGradient),
        candidateGradientCorrelation: normalizedCorrelation(candidateGradient, alphaGradient),
        // Kept as the raw luminance-direction metric for compatibility.
        negativeDiffRatio: negativeDiffCount / total,
        oppositeDirectionDiffRatio: oppositeDirectionDiffCount / total,
        newlyClippedRatio,
        newlyBlackClippedRatio,
        newlyWhiteClippedRatio,
        alphaPolarity,
        oppositeDirectionHaloLum,
        halo,
        visualArtifactCost
    };
}

export function assessWatermarkResidualVisibility({
    imageData,
    position,
    alphaMap
}) {
    if (!imageData || !position || !alphaMap) return null;

    const scores = scoreRegion(imageData, alphaMap, position);
    const halo = assessAlphaBandHalo({
        imageData,
        position,
        alphaMap,
        minAlpha: RESIDUAL_VISIBILITY_CORE_MIN_ALPHA,
        maxAlpha: RESIDUAL_VISIBILITY_CORE_MAX_ALPHA,
        outsideAlphaMax: RESIDUAL_VISIBILITY_OUTSIDE_ALPHA_MAX,
        outerMargin: RESIDUAL_VISIBILITY_OUTER_MARGIN
    });
    const positiveHaloLum = Math.max(0, halo.deltaLum);
    let hasPositiveAlpha = false;
    let hasNegativeAlpha = false;
    for (const alpha of alphaMap) {
        if (alpha > 1e-8) hasPositiveAlpha = true;
        if (alpha < -1e-8) hasNegativeAlpha = true;
    }
    const isDarkPolarity = hasNegativeAlpha && !hasPositiveAlpha;
    const darkPolarityHaloLum = isDarkPolarity ? Math.abs(halo.deltaLum) : 0;
    const darkPolarityHaloThreshold = halo.outerStdLum <=
        RESIDUAL_VISIBILITY_DARK_POLARITY_LOW_TEXTURE_MAX_STD_LUM
        ? RESIDUAL_VISIBILITY_DARK_POLARITY_LOW_TEXTURE_HALO_LUM_THRESHOLD
        : RESIDUAL_VISIBILITY_DARK_POLARITY_STRONG_HALO_LUM_THRESHOLD;
    const gradientResidual = Math.max(0, scores.gradientScore);
    const spatialResidual = Math.abs(scores.spatialScore);
    const visiblePositiveHalo = positiveHaloLum >= RESIDUAL_VISIBILITY_POSITIVE_HALO_LUM_THRESHOLD;
    const visibleDarkPolarityHalo = isDarkPolarity &&
        darkPolarityHaloLum >= darkPolarityHaloThreshold;
    const visibleGradientResidual = gradientResidual >= RESIDUAL_VISIBILITY_GRADIENT_THRESHOLD;
    const visibleSpatialResidual = spatialResidual >= RESIDUAL_VISIBILITY_SPATIAL_THRESHOLD;

    return {
        visible: visiblePositiveHalo || visibleDarkPolarityHalo || visibleGradientResidual || visibleSpatialResidual,
        positiveHaloLum,
        darkPolarityHaloLum,
        darkPolarityHaloThreshold,
        haloVisibility: halo.visibility,
        spatialResidual,
        gradientResidual,
        visiblePositiveHalo,
        visibleDarkPolarityHalo,
        visibleGradientResidual,
        visibleSpatialResidual,
        halo
    };
}

export function assessCalibratedWatermarkResidualVisibility({
    imageData,
    originalImageData = null,
    position,
    alphaMap,
    alphaGain = 1
}) {
    const visibility = assessWatermarkResidualVisibility({
        imageData,
        position,
        alphaMap
    });
    if (!visibility) return null;

    const scores = scoreRegion(imageData, alphaMap, position);
    const nearBlackRatio = calculateNearBlackRatio(imageData, position);
    const artifacts = originalImageData
        ? assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData: imageData,
            alphaMap,
            position,
            alphaGain
        })
        : null;
    const newlyClippedRatio = artifacts?.newlyClippedRatio ?? 0;
    const shouldMeasureSpatialProminence =
        visibility.visibleSpatialResidual === true &&
        visibility.visiblePositiveHalo !== true &&
        visibility.visibleGradientResidual !== true &&
        scores.spatialScore <= -NONLOCALIZED_SPATIAL_METRIC_RISK_MIN_NEGATIVE_SPATIAL &&
        scores.gradientScore < NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_GRADIENT &&
        visibility.positiveHaloLum <= NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_POSITIVE_HALO_LUM &&
        nearBlackRatio < NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_NEAR_BLACK_RATIO &&
        newlyClippedRatio <= NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_NEWLY_CLIPPED_RATIO &&
        artifacts?.visualArtifactCost <= NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_ARTIFACT_COST;
    const spatialLocalization = shouldMeasureSpatialProminence
        ? assessSpatialResidualLocalization({
            imageData,
            position,
            alphaMap,
            targetSpatialScore: scores.spatialScore
        })
        : null;
    const metricRisk = classifyCalibratedResidualMetricRisk({
        visibility,
        spatialScore: scores.spatialScore,
        gradientScore: scores.gradientScore,
        spatialProminence: spatialLocalization?.prominence ?? null,
        nearBlackRatio,
        newlyClippedRatio,
        visualArtifactCost: artifacts?.visualArtifactCost ?? null,
        hasOriginalImageData: Boolean(originalImageData)
    });

    return {
        ...visibility,
        rawVisible: visibility.visible,
        visible: visibility.visible && !metricRisk,
        calibratedVisible: visibility.visible && !metricRisk,
        metricRisk,
        nearBlackRatio,
        newlyClippedRatio,
        spatialProminence: spatialLocalization?.prominence ?? null,
        spatialLocalization,
        rawSpatialScore: scores.spatialScore,
        rawGradientScore: scores.gradientScore
    };
}

export function classifyCalibratedResidualMetricRisk({
    visibility,
    spatialScore,
    gradientScore,
    spatialProminence = null,
    nearBlackRatio = 0,
    newlyClippedRatio = 0,
    visualArtifactCost = null,
    hasOriginalImageData = false
}) {
    if (visibility?.visible !== true) return null;
    if (visibility.visibleDarkPolarityHalo === true) return null;

    if (
        visibility.visibleSpatialResidual === true &&
        visibility.visiblePositiveHalo !== true &&
        visibility.visibleGradientResidual !== true &&
        spatialScore <= -FLAT_CLIPPED_METRIC_RISK_MIN_NEGATIVE_SPATIAL &&
        visibility.positiveHaloLum <= FLAT_CLIPPED_METRIC_RISK_MAX_POSITIVE_HALO_LUM &&
        nearBlackRatio >= FLAT_CLIPPED_METRIC_RISK_NEAR_BLACK_RATIO &&
        (
            !hasOriginalImageData ||
            newlyClippedRatio >= FLAT_CLIPPED_METRIC_RISK_NEWLY_CLIPPED_RATIO
        )
    ) {
        return 'flat-clipped-low-texture-spatial-correlation';
    }

    if (
        visibility.visibleSpatialResidual === true &&
        visibility.visiblePositiveHalo !== true &&
        visibility.visibleGradientResidual !== true &&
        spatialScore <= -FLAT_LOW_VARIANCE_METRIC_RISK_MIN_NEGATIVE_SPATIAL &&
        gradientScore < FLAT_LOW_VARIANCE_METRIC_RISK_MAX_GRADIENT &&
        Number.isFinite(visibility.halo?.bandStdLum) &&
        visibility.halo.bandStdLum <= FLAT_LOW_VARIANCE_METRIC_RISK_MAX_STD_LUM &&
        Number.isFinite(visibility.halo?.outerStdLum) &&
        visibility.halo.outerStdLum <= FLAT_LOW_VARIANCE_METRIC_RISK_MAX_STD_LUM &&
        Number.isFinite(visibility.halo?.deltaLum) &&
        Math.abs(visibility.halo.deltaLum) <= FLAT_LOW_VARIANCE_METRIC_RISK_MAX_ABS_DELTA_LUM
    ) {
        return 'flat-low-variance-spatial-correlation';
    }

    if (
        visibility.visibleSpatialResidual === true &&
        visibility.visiblePositiveHalo !== true &&
        visibility.visibleGradientResidual !== true &&
        spatialScore <= -NONLOCALIZED_SPATIAL_METRIC_RISK_MIN_NEGATIVE_SPATIAL &&
        gradientScore < NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_GRADIENT &&
        visibility.positiveHaloLum <= NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_POSITIVE_HALO_LUM &&
        nearBlackRatio < NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_NEAR_BLACK_RATIO &&
        newlyClippedRatio <= NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_NEWLY_CLIPPED_RATIO &&
        visualArtifactCost !== null &&
        visualArtifactCost <= NONLOCALIZED_SPATIAL_METRIC_RISK_MAX_ARTIFACT_COST &&
        Number.isFinite(spatialProminence) &&
        spatialProminence < NONLOCALIZED_SPATIAL_METRIC_RISK_MIN_LOCAL_PROMINENCE
    ) {
        return 'nonlocalized-spatial-background-collision';
    }

    if (
        visibility.visibleGradientResidual !== true &&
        spatialScore >= POSITIVE_SPATIAL_BACKGROUND_COLLISION_MIN_SPATIAL &&
        gradientScore < POSITIVE_SPATIAL_BACKGROUND_COLLISION_MAX_GRADIENT &&
        visibility.positiveHaloLum <= POSITIVE_SPATIAL_BACKGROUND_COLLISION_MAX_POSITIVE_HALO_LUM &&
        visualArtifactCost !== null &&
        visualArtifactCost <= POSITIVE_SPATIAL_BACKGROUND_COLLISION_MAX_ARTIFACT_COST
    ) {
        return visibility.visiblePositiveHalo === true
            ? 'positive-halo-background-collision'
            : 'positive-spatial-background-collision';
    }

    if (
        visibility.visiblePositiveHalo === true &&
        visibility.visibleSpatialResidual !== true &&
        visibility.visibleGradientResidual !== true &&
        Math.abs(spatialScore) < WEAK_HALO_BACKGROUND_COLLISION_MAX_ABS_SPATIAL &&
        gradientScore < WEAK_HALO_BACKGROUND_COLLISION_MAX_GRADIENT &&
        visibility.positiveHaloLum <= WEAK_HALO_BACKGROUND_COLLISION_MAX_POSITIVE_HALO_LUM &&
        nearBlackRatio < WEAK_HALO_BACKGROUND_COLLISION_MAX_NEAR_BLACK_RATIO &&
        newlyClippedRatio <= WEAK_HALO_BACKGROUND_COLLISION_MAX_NEWLY_CLIPPED_RATIO &&
        visualArtifactCost !== null &&
        visualArtifactCost <= WEAK_HALO_BACKGROUND_COLLISION_MAX_ARTIFACT_COST
    ) {
        return 'weak-halo-background-collision';
    }

    if (
        visibility.visiblePositiveHalo === true &&
        visibility.visibleGradientResidual !== true &&
        gradientScore >= STRUCTURED_EDGE_BACKGROUND_COLLISION_MIN_GRADIENT &&
        nearBlackRatio < STRUCTURED_EDGE_BACKGROUND_COLLISION_MAX_NEAR_BLACK_RATIO &&
        newlyClippedRatio <= STRUCTURED_EDGE_BACKGROUND_COLLISION_MAX_NEWLY_CLIPPED_RATIO &&
        visualArtifactCost !== null &&
        visualArtifactCost >= STRUCTURED_EDGE_BACKGROUND_COLLISION_MIN_ARTIFACT_COST
    ) {
        return 'structured-edge-background-collision';
    }

    return null;
}

function assessSpatialResidualLocalization({
    imageData,
    position,
    alphaMap,
    targetSpatialScore
}) {
    const size = Number(position?.width);
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (
        !imageData?.data ||
        !Number.isInteger(size) ||
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        size <= 0 ||
        Number(position?.height) !== size ||
        !alphaMap ||
        alphaMap.length !== size * size
    ) {
        return null;
    }

    const controlScores = [];
    for (const [offsetX, offsetY] of RESIDUAL_LOCALIZATION_CONTROL_OFFSETS) {
        const controlRegion = {
            x: x + offsetX * size,
            y: y + offsetY * size,
            size
        };
        if (
            controlRegion.x < 0 ||
            controlRegion.y < 0 ||
            controlRegion.x + size > imageData.width ||
            controlRegion.y + size > imageData.height
        ) {
            continue;
        }
        controlScores.push(computeRegionSpatialCorrelation({
            imageData,
            alphaMap,
            region: controlRegion
        }));
    }
    if (controlScores.length < 3) return null;

    const sortedControlSpatialResiduals = controlScores
        .map((score) => Math.abs(score))
        .sort((left, right) => right - left);
    const maximumControlSpatialResidual = sortedControlSpatialResiduals[0];
    const robustControlSpatialResidual = sortedControlSpatialResiduals.length > 1
        ? sortedControlSpatialResiduals[1]
        : maximumControlSpatialResidual;
    return {
        targetSpatialScore,
        controlScores,
        maximumControlSpatialResidual,
        robustControlSpatialResidual,
        prominence: Math.abs(targetSpatialScore) - robustControlSpatialResidual
    };
}

function getReferenceRegion(position, imageData) {
    const referenceY = position.y - position.height;
    if (referenceY < 0) return null;

    return {
        x: position.x,
        y: referenceY,
        width: position.width,
        height: position.height
    };
}

export function assessReferenceTextureAlignment({
    originalImageData,
    referenceImageData,
    candidateImageData,
    position
}) {
    const candidateTextureStats = candidateImageData
        ? calculateRegionTextureStats(candidateImageData, position)
        : null;

    return assessReferenceTextureAlignmentFromStats({
        originalImageData,
        referenceImageData,
        candidateTextureStats,
        position
    });
}

export function assessReferenceTextureAlignmentFromStats({
    originalImageData,
    referenceImageData,
    candidateTextureStats,
    position
}) {
    const resolvedReferenceImageData = referenceImageData ?? originalImageData;
    const referenceRegion = resolvedReferenceImageData
        ? getReferenceRegion(position, resolvedReferenceImageData)
        : null;
    const referenceTextureStats = referenceRegion
        ? calculateRegionTextureStats(resolvedReferenceImageData, referenceRegion)
        : null;
    const darknessPenalty = referenceTextureStats && candidateTextureStats
        ? Math.max(0, referenceTextureStats.meanLum - candidateTextureStats.meanLum - TEXTURE_REFERENCE_MARGIN) /
            Math.max(1, referenceTextureStats.meanLum)
        : 0;
    const flatnessPenalty = referenceTextureStats && candidateTextureStats
        ? Math.max(0, referenceTextureStats.stdLum * TEXTURE_STD_FLOOR_RATIO - candidateTextureStats.stdLum) /
            Math.max(1, referenceTextureStats.stdLum)
        : 0;
    const darknessVisibility = referenceTextureStats && candidateTextureStats
        ? Math.max(0, referenceTextureStats.meanLum - candidateTextureStats.meanLum - TEXTURE_REFERENCE_MARGIN) /
            Math.max(1, referenceTextureStats.stdLum)
        : 0;
    const tooDark = darknessPenalty > 0;
    const tooFlat = flatnessPenalty > 0;
    const visibleDarkHole = tooDark && darknessVisibility >= TEXTURE_DARKNESS_VISIBILITY_HARD_REJECT_THRESHOLD;
    const strongDarkFlatCollapse =
        tooDark &&
        tooFlat &&
        darknessPenalty >= TEXTURE_DARKNESS_HARD_REJECT_PENALTY_THRESHOLD &&
        flatnessPenalty >= TEXTURE_FLATNESS_HARD_REJECT_PENALTY_THRESHOLD;

    return {
        referenceTextureStats,
        candidateTextureStats,
        darknessPenalty,
        flatnessPenalty,
        darknessVisibility,
        texturePenalty: darknessPenalty * 2 + flatnessPenalty * 2,
        tooDark,
        tooFlat,
        visibleDarkHole,
        hardReject: strongDarkFlatCollapse || visibleDarkHole
    };
}

export function scoreRegion(imageData, alphaMap, position) {
    return {
        spatialScore: computeRegionSpatialCorrelation({
            imageData,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        }),
        gradientScore: computeRegionGradientCorrelation({
            imageData,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        })
    };
}

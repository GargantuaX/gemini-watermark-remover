import { removeWatermark } from './blendModes.js';
import {
    assessReferenceTextureAlignment,
    calculateNearBlackRatio,
    cloneImageData,
    scoreRegion
} from './restorationMetrics.js';

const DEFAULT_MAX_PASSES = 4;
const DEFAULT_RESIDUAL_THRESHOLD = 0.25;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;

export function removeRepeatedWatermarkLayers(imageDataOrOptions, alphaMapArg, positionArg, optionsArg = {}) {
    const isObjectCall =
        imageDataOrOptions &&
        typeof imageDataOrOptions === 'object' &&
        'imageData' in imageDataOrOptions &&
        alphaMapArg === undefined;

    const imageData = isObjectCall ? imageDataOrOptions.imageData : imageDataOrOptions;
    const alphaMap = isObjectCall ? imageDataOrOptions.alphaMap : alphaMapArg;
    const position = isObjectCall ? imageDataOrOptions.position : positionArg;
    const options = isObjectCall ? imageDataOrOptions : optionsArg;

    const maxPasses = Math.max(1, options.maxPasses ?? DEFAULT_MAX_PASSES);
    const residualThreshold = options.residualThreshold ?? DEFAULT_RESIDUAL_THRESHOLD;
    const startingPassIndex = Math.max(0, options.startingPassIndex ?? 0);
    const alphaGain = Number.isFinite(options.alphaGain) && options.alphaGain > 0
        ? options.alphaGain
        : 1;

    let currentImageData = cloneImageData(imageData);
    const referenceImageData = currentImageData;
    const baseNearBlackRatio = calculateNearBlackRatio(currentImageData, position);
    const maxNearBlackRatio = Math.min(1, baseNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    const passes = [];
    let stopReason = 'max-passes';
    let appliedPassCount = startingPassIndex;
    let attemptedPassCount = startingPassIndex;

    for (let passIndex = 0; passIndex < maxPasses; passIndex++) {
        attemptedPassCount = startingPassIndex + passIndex + 1;
        const before = scoreRegion(currentImageData, alphaMap, position);
        const candidate = cloneImageData(currentImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });

        const after = scoreRegion(candidate, alphaMap, position);
        const nearBlackRatio = calculateNearBlackRatio(candidate, position);
        const improvement = Math.abs(before.spatialScore) - Math.abs(after.spatialScore);
        const gradientDelta = after.gradientScore - before.gradientScore;
        const textureAssessment = assessReferenceTextureAlignment({
            referenceImageData,
            candidateImageData: candidate,
            position
        });

        if (nearBlackRatio > maxNearBlackRatio) {
            stopReason = 'safety-near-black';
            break;
        }

        if (textureAssessment.hardReject) {
            stopReason = 'safety-texture-collapse';
            break;
        }

        currentImageData = candidate;
        appliedPassCount = startingPassIndex + passIndex + 1;
        passes.push({
            index: appliedPassCount,
            beforeSpatialScore: before.spatialScore,
            beforeGradientScore: before.gradientScore,
            afterSpatialScore: after.spatialScore,
            afterGradientScore: after.gradientScore,
            improvement,
            gradientDelta,
            nearBlackRatio
        });

        if (Math.abs(after.spatialScore) <= residualThreshold) {
            stopReason = 'residual-low';
            break;
        }
    }

    return {
        imageData: currentImageData,
        passCount: appliedPassCount,
        attemptedPassCount,
        stopReason,
        passes
    };
}

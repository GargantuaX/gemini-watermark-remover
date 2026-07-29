import { compositeKnownWatermark } from './synthetic-residual-ground-truth.js';

function assertImageData(imageData, name) {
    if (
        !imageData ||
        !Number.isInteger(imageData.width) ||
        !Number.isInteger(imageData.height) ||
        imageData.width <= 0 ||
        imageData.height <= 0 ||
        !imageData.data ||
        imageData.data.length !== imageData.width * imageData.height * 4
    ) {
        throw new TypeError(`${name} must be valid RGBA ImageData-like data`);
    }
}

function assertMatchingImageData(reference, candidate, name) {
    assertImageData(candidate, name);
    if (
        candidate.width !== reference.width ||
        candidate.height !== reference.height
    ) {
        throw new RangeError(`${name} dimensions must match truthImageData`);
    }
}

function assertPosition(position, imageData) {
    if (
        !position ||
        !Number.isInteger(position.x) ||
        !Number.isInteger(position.y) ||
        !Number.isInteger(position.width) ||
        !Number.isInteger(position.height) ||
        position.x < 0 ||
        position.y < 0 ||
        position.width <= 0 ||
        position.height <= 0 ||
        position.x + position.width > imageData.width ||
        position.y + position.height > imageData.height
    ) {
        throw new RangeError('position must be an in-bounds integer rectangle');
    }
}

function clampByte(value) {
    return Math.min(255, Math.max(0, Math.round(value)));
}

export function createDirectionalCandidate({
    truthImageData,
    watermarkedImageData,
    position,
    factor
}) {
    assertImageData(truthImageData, 'truthImageData');
    assertMatchingImageData(
        truthImageData,
        watermarkedImageData,
        'watermarkedImageData'
    );
    assertPosition(position, truthImageData);
    if (!Number.isFinite(factor)) {
        throw new TypeError('factor must be finite');
    }

    const candidate = {
        width: truthImageData.width,
        height: truthImageData.height,
        data: new Uint8ClampedArray(truthImageData.data)
    };

    for (let localY = 0; localY < position.height; localY++) {
        for (let localX = 0; localX < position.width; localX++) {
            const pixelIndex =
                (position.y + localY) * truthImageData.width +
                position.x +
                localX;
            const offset = pixelIndex * 4;
            for (let channel = 0; channel < 3; channel++) {
                const cleanValue = truthImageData.data[offset + channel];
                const forwardDelta =
                    watermarkedImageData.data[offset + channel] -
                    cleanValue;
                candidate.data[offset + channel] = clampByte(
                    cleanValue + factor * forwardDelta
                );
            }
        }
    }

    return candidate;
}

export function orthogonalizeVector(vector, basis) {
    if (!vector || !basis || vector.length !== basis.length) {
        throw new RangeError('vector and basis must have equal lengths');
    }
    let dot = 0;
    let basisEnergy = 0;
    for (let index = 0; index < vector.length; index++) {
        dot += vector[index] * basis[index];
        basisEnergy += basis[index] * basis[index];
    }
    const projectionScale = basisEnergy > 0 ? dot / basisEnergy : 0;
    return Float64Array.from(
        vector,
        (value, index) => value - projectionScale * basis[index]
    );
}

export function createOrthogonalDamageCandidate({
    truthImageData,
    watermarkedImageData,
    position,
    targetFraction = 0.35
}) {
    assertImageData(truthImageData, 'truthImageData');
    assertMatchingImageData(
        truthImageData,
        watermarkedImageData,
        'watermarkedImageData'
    );
    assertPosition(position, truthImageData);
    if (!Number.isFinite(targetFraction) || targetFraction <= 0) {
        throw new RangeError('targetFraction must be positive and finite');
    }

    const channelCount = position.width * position.height * 3;
    const watermarkDelta = new Float64Array(channelCount);
    const independentDamage = new Float64Array(channelCount);
    const cleanValues = new Float64Array(channelCount);
    let vectorIndex = 0;

    for (let localY = 0; localY < position.height; localY++) {
        for (let localX = 0; localX < position.width; localX++) {
            const pixelIndex =
                (position.y + localY) * truthImageData.width +
                position.x +
                localX;
            const offset = pixelIndex * 4;
            for (let channel = 0; channel < 3; channel++) {
                const cleanValue = truthImageData.data[offset + channel];
                cleanValues[vectorIndex] = cleanValue;
                watermarkDelta[vectorIndex] =
                    watermarkedImageData.data[offset + channel] -
                    cleanValue;
                independentDamage[vectorIndex] =
                    (localX + localY + channel) % 2 === 0 ? 1 : -1;
                vectorIndex++;
            }
        }
    }

    const orthogonalDamage = orthogonalizeVector(
        independentDamage,
        watermarkDelta
    );
    let watermarkEnergy = 0;
    let orthogonalEnergy = 0;
    for (let index = 0; index < channelCount; index++) {
        watermarkEnergy += watermarkDelta[index] * watermarkDelta[index];
        orthogonalEnergy +=
            orthogonalDamage[index] * orthogonalDamage[index];
    }
    if (watermarkEnergy <= 0 || orthogonalEnergy <= 0) {
        throw new RangeError(
            'watermark and orthogonal damage vectors must have non-zero energy'
        );
    }

    const desiredScale =
        targetFraction * Math.sqrt(watermarkEnergy / orthogonalEnergy);
    let safeScale = Number.POSITIVE_INFINITY;
    for (let index = 0; index < channelCount; index++) {
        const direction = orthogonalDamage[index];
        const cleanValue = cleanValues[index];
        if (direction > 0) {
            safeScale = Math.min(
                safeScale,
                (254 - cleanValue) / direction
            );
        } else if (direction < 0) {
            safeScale = Math.min(
                safeScale,
                (cleanValue - 1) / -direction
            );
        }
    }
    const appliedScale = Math.min(
        desiredScale,
        Math.max(0, safeScale * 0.98)
    );

    const imageData = {
        width: truthImageData.width,
        height: truthImageData.height,
        data: new Uint8ClampedArray(truthImageData.data)
    };
    let actualErrorEnergy = 0;
    let clippedChannelCount = 0;
    vectorIndex = 0;
    for (let localY = 0; localY < position.height; localY++) {
        for (let localX = 0; localX < position.width; localX++) {
            const pixelIndex =
                (position.y + localY) * truthImageData.width +
                position.x +
                localX;
            const offset = pixelIndex * 4;
            for (let channel = 0; channel < 3; channel++) {
                const value =
                    cleanValues[vectorIndex] +
                    appliedScale * orthogonalDamage[vectorIndex];
                if (value < 0 || value > 255) clippedChannelCount++;
                const quantized = clampByte(value);
                imageData.data[offset + channel] = quantized;
                const error = quantized - cleanValues[vectorIndex];
                actualErrorEnergy += error * error;
                vectorIndex++;
            }
        }
    }

    return {
        imageData,
        diagnostics: {
            targetFraction,
            appliedScale,
            safeScale,
            clippedChannelCount,
            achievedEnergyFraction: Math.sqrt(
                actualErrorEnergy / watermarkEnergy
            )
        }
    };
}

export function measureRecompositionConsistency({
    originalImageData,
    candidateImageData,
    alphaMap,
    position,
    alphaGain = 1,
    logoValue = 255
}) {
    assertImageData(originalImageData, 'originalImageData');
    assertMatchingImageData(
        originalImageData,
        candidateImageData,
        'candidateImageData'
    );
    assertPosition(position, originalImageData);
    if (
        !alphaMap ||
        alphaMap.length !== position.width * position.height
    ) {
        throw new RangeError(
            'alphaMap length must equal position.width * position.height'
        );
    }

    const recomposed = compositeKnownWatermark({
        truthImageData: candidateImageData,
        alphaMap,
        position,
        alphaGain,
        logoValue
    });
    let absoluteErrorSum = 0;
    let squaredErrorSum = 0;
    for (let localY = 0; localY < position.height; localY++) {
        for (let localX = 0; localX < position.width; localX++) {
            const pixelIndex =
                (position.y + localY) * originalImageData.width +
                position.x +
                localX;
            const offset = pixelIndex * 4;
            for (let channel = 0; channel < 3; channel++) {
                const error =
                    recomposed.data[offset + channel] -
                    originalImageData.data[offset + channel];
                absoluteErrorSum += Math.abs(error);
                squaredErrorSum += error * error;
            }
        }
    }
    const channelCount = position.width * position.height * 3;
    return {
        channelCount,
        mae: absoluteErrorSum / channelCount,
        rmse: Math.sqrt(squaredErrorSum / channelCount)
    };
}

/**
 * Decomposes the self-recomposition error without requiring clean pixel truth.
 *
 * The unchanged input is recomposed once more to create a local watermark
 * baseline vector. Candidate recomposition error is projected onto that
 * baseline: positive amplitude means watermark remains, negative amplitude
 * means over-removal, and the orthogonal remainder represents other damage.
 */
export function decomposeRecompositionError({
    originalImageData,
    candidateImageData,
    alphaMap,
    position,
    alphaGain = 1,
    logoValue = 255
}) {
    assertImageData(originalImageData, 'originalImageData');
    assertMatchingImageData(
        originalImageData,
        candidateImageData,
        'candidateImageData'
    );
    assertPosition(position, originalImageData);
    if (
        !alphaMap ||
        alphaMap.length !== position.width * position.height
    ) {
        throw new RangeError(
            'alphaMap length must equal position.width * position.height'
        );
    }

    const baselineRecomposition = compositeKnownWatermark({
        truthImageData: originalImageData,
        alphaMap,
        position,
        alphaGain,
        logoValue
    });
    const candidateRecomposition = compositeKnownWatermark({
        truthImageData: candidateImageData,
        alphaMap,
        position,
        alphaGain,
        logoValue
    });
    let baselineSquaredEnergy = 0;
    let candidateSquaredEnergy = 0;
    let candidateBaselineDot = 0;

    for (let localY = 0; localY < position.height; localY++) {
        for (let localX = 0; localX < position.width; localX++) {
            const pixelIndex =
                (position.y + localY) * originalImageData.width +
                position.x +
                localX;
            const offset = pixelIndex * 4;
            for (let channel = 0; channel < 3; channel++) {
                const baselineError =
                    baselineRecomposition.data[offset + channel] -
                    originalImageData.data[offset + channel];
                const candidateError =
                    candidateRecomposition.data[offset + channel] -
                    originalImageData.data[offset + channel];
                baselineSquaredEnergy += baselineError * baselineError;
                candidateSquaredEnergy += candidateError * candidateError;
                candidateBaselineDot +=
                    candidateError * baselineError;
            }
        }
    }

    const channelCount = position.width * position.height * 3;
    const baselineRmse = Math.sqrt(
        baselineSquaredEnergy / channelCount
    );
    const candidateRmse = Math.sqrt(
        candidateSquaredEnergy / channelCount
    );
    if (baselineSquaredEnergy <= Number.EPSILON) {
        return {
            status: 'unavailable',
            reason: 'zero-baseline-energy',
            channelCount,
            baselineRmse,
            candidateRmse,
            normalizedTotalError: null,
            signedTemplateAmplitude: null,
            underRemoval: null,
            overRemoval: null,
            normalizedOrthogonalError: null
        };
    }

    const signedTemplateAmplitude =
        candidateBaselineDot / baselineSquaredEnergy;
    const projectedSquaredEnergy =
        candidateBaselineDot * candidateBaselineDot /
        baselineSquaredEnergy;
    const orthogonalSquaredEnergy = Math.max(
        0,
        candidateSquaredEnergy - projectedSquaredEnergy
    );

    return {
        status: 'complete',
        reason: null,
        channelCount,
        baselineRmse,
        candidateRmse,
        normalizedTotalError: Math.sqrt(
            candidateSquaredEnergy / baselineSquaredEnergy
        ),
        signedTemplateAmplitude,
        underRemoval: Math.max(0, signedTemplateAmplitude),
        overRemoval: Math.max(0, -signedTemplateAmplitude),
        normalizedOrthogonalError: Math.sqrt(
            orthogonalSquaredEnergy / baselineSquaredEnergy
        )
    };
}

export function evaluateRecompositionProfileBank({
    originalImageData,
    candidateImageData,
    position,
    profiles,
    alphaGain = 1
}) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
        return {
            status: 'unavailable',
            best: null,
            trials: []
        };
    }
    const trials = profiles.map((profile) => {
        const decomposition = decomposeRecompositionError({
            originalImageData,
            candidateImageData,
            alphaMap: profile.alphaMap,
            position,
            alphaGain
        });
        return {
            profile: profile.name,
            alphaGain,
            candidateRmse: decomposition.candidateRmse,
            baselineRmse: decomposition.baselineRmse,
            normalizedRmse: decomposition.normalizedTotalError,
            signedTemplateAmplitude:
                decomposition.signedTemplateAmplitude,
            underRemoval: decomposition.underRemoval,
            overRemoval: decomposition.overRemoval,
            normalizedOrthogonalError:
                decomposition.normalizedOrthogonalError,
            decompositionStatus: decomposition.status,
            unavailableReason: decomposition.reason
        };
    });
    const comparable = trials.filter((trial) =>
        Number.isFinite(trial.normalizedRmse)
    );
    const best = comparable.reduce(
        (current, trial) =>
            !current || trial.normalizedRmse < current.normalizedRmse
                ? trial
                : current,
        null
    );
    return {
        status: best
            ? comparable.length === trials.length
                ? 'complete'
                : 'partial'
            : 'unavailable',
        best,
        trials
    };
}

export function createAmplitudeWeightedDirectionalEvidence({
    spatialScore,
    gradientScore,
    weightedRecomposeError
}) {
    if (
        !Number.isFinite(spatialScore) ||
        !Number.isFinite(gradientScore) ||
        !Number.isFinite(weightedRecomposeError)
    ) {
        throw new TypeError(
            'spatialScore, gradientScore, and weightedRecomposeError must be finite'
        );
    }
    const templateArtifact =
        Math.max(0, gradientScore) *
        Math.max(0, weightedRecomposeError);
    const spatialPolarity = spatialScore > 0
        ? 'positive'
        : spatialScore < 0
            ? 'negative'
            : 'neutral';
    return {
        templateArtifact,
        underRemoval:
            spatialPolarity === 'positive'
                ? templateArtifact
                : 0,
        overRemoval:
            spatialPolarity === 'negative'
                ? templateArtifact
                : 0,
        spatialPolarity
    };
}

export function calculatePairwiseOrdering(
    truthValues,
    metricValues,
    { truthTolerance = 0 } = {}
) {
    if (
        !Array.isArray(truthValues) ||
        !Array.isArray(metricValues) ||
        truthValues.length !== metricValues.length
    ) {
        throw new RangeError(
            'truthValues and metricValues must be equal-length arrays'
        );
    }
    if (!Number.isFinite(truthTolerance) || truthTolerance < 0) {
        throw new RangeError('truthTolerance must be non-negative and finite');
    }

    let correct = 0;
    let compared = 0;
    let ties = 0;
    for (let left = 0; left < truthValues.length; left++) {
        for (let right = left + 1; right < truthValues.length; right++) {
            const truthDelta =
                truthValues[left] - truthValues[right];
            if (Math.abs(truthDelta) <= truthTolerance) continue;
            const truthDirection = Math.sign(truthDelta);
            if (truthDirection === 0) continue;
            compared++;
            const metricDirection =
                Math.sign(metricValues[left] - metricValues[right]);
            if (metricDirection === 0) {
                correct += 0.5;
                ties++;
            } else if (metricDirection === truthDirection) {
                correct++;
            }
        }
    }

    return {
        accuracy: compared > 0 ? correct / compared : null,
        correct,
        compared,
        ties
    };
}

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

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Estimates an effective white-logo alpha map from watermarked/clean-control
 * pairs using W = C * (1 - alpha) + 255 * alpha.
 *
 * Each RGB channel contributes an independent observation. A per-pixel median
 * rejects isolated content or cleanup outliers; the result is experimental
 * evidence and is not a production catalog update.
 */
export function estimateWhiteLogoAlphaMap({
    pairs,
    minLogoContrast = 16,
    minAcceptedAlpha = -0.05,
    maxAcceptedAlpha = 0.5
}) {
    if (!Array.isArray(pairs) || pairs.length === 0) {
        throw new RangeError('pairs must contain at least one control pair');
    }
    if (
        !Number.isFinite(minLogoContrast) ||
        minLogoContrast <= 0 ||
        !Number.isFinite(minAcceptedAlpha) ||
        !Number.isFinite(maxAcceptedAlpha) ||
        minAcceptedAlpha >= maxAcceptedAlpha
    ) {
        throw new RangeError('alpha estimation bounds must be finite and valid');
    }

    let profileWidth = null;
    let profileHeight = null;
    const observations = [];
    for (const [pairIndex, pair] of pairs.entries()) {
        assertImageData(
            pair?.originalImageData,
            `pairs[${pairIndex}].originalImageData`
        );
        assertImageData(
            pair?.candidateImageData,
            `pairs[${pairIndex}].candidateImageData`
        );
        if (
            pair.originalImageData.width !== pair.candidateImageData.width ||
            pair.originalImageData.height !== pair.candidateImageData.height
        ) {
            throw new RangeError(
                `pairs[${pairIndex}] image dimensions must match`
            );
        }
        assertPosition(pair.position, pair.originalImageData);
        if (profileWidth === null) {
            profileWidth = pair.position.width;
            profileHeight = pair.position.height;
            for (
                let index = 0;
                index < profileWidth * profileHeight;
                index++
            ) {
                observations.push([]);
            }
        } else if (
            pair.position.width !== profileWidth ||
            pair.position.height !== profileHeight
        ) {
            throw new RangeError('all pair positions must share one geometry');
        }

        for (let localY = 0; localY < profileHeight; localY++) {
            for (let localX = 0; localX < profileWidth; localX++) {
                const localIndex = localY * profileWidth + localX;
                const pixelIndex =
                    (pair.position.y + localY) *
                    pair.originalImageData.width +
                    pair.position.x +
                    localX;
                const offset = pixelIndex * 4;
                for (let channel = 0; channel < 3; channel++) {
                    const originalValue =
                        pair.originalImageData.data[offset + channel];
                    const cleanValue =
                        pair.candidateImageData.data[offset + channel];
                    const denominator = 255 - cleanValue;
                    if (denominator < minLogoContrast) continue;
                    const alpha =
                        (originalValue - cleanValue) / denominator;
                    if (
                        !Number.isFinite(alpha) ||
                        alpha < minAcceptedAlpha ||
                        alpha > maxAcceptedAlpha
                    ) {
                        continue;
                    }
                    observations[localIndex].push(alpha);
                }
            }
        }
    }

    const alphaMap = new Float32Array(observations.length);
    const supportCounts = new Uint32Array(observations.length);
    let unsupportedPixelCount = 0;
    let totalSupportCount = 0;
    let minSupportCount = Number.POSITIVE_INFINITY;
    let maxSupportCount = 0;
    for (let index = 0; index < observations.length; index++) {
        const value = median(observations[index]);
        const supportCount = observations[index].length;
        supportCounts[index] = supportCount;
        totalSupportCount += supportCount;
        minSupportCount = Math.min(minSupportCount, supportCount);
        maxSupportCount = Math.max(maxSupportCount, supportCount);
        if (value === null) {
            unsupportedPixelCount++;
            alphaMap[index] = 0;
        } else {
            alphaMap[index] = clamp(value, 0, maxAcceptedAlpha);
        }
    }

    return {
        status: unsupportedPixelCount === 0 ? 'complete' : 'partial',
        width: profileWidth,
        height: profileHeight,
        alphaMap,
        supportCounts,
        diagnostics: {
            pairCount: pairs.length,
            unsupportedPixelCount,
            totalSupportCount,
            minSupportCount:
                Number.isFinite(minSupportCount) ? minSupportCount : 0,
            maxSupportCount
        }
    };
}

export function compareAlphaMaps(left, right) {
    if (!left || !right || left.length !== right.length || left.length === 0) {
        throw new RangeError('alpha maps must be equal-length non-empty arrays');
    }
    let absoluteErrorSum = 0;
    let squaredErrorSum = 0;
    let maxAbsoluteError = 0;
    let leftSum = 0;
    let rightSum = 0;
    for (let index = 0; index < left.length; index++) {
        const leftValue = Number(left[index]);
        const rightValue = Number(right[index]);
        if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
            throw new TypeError('alpha maps must contain finite values');
        }
        const error = leftValue - rightValue;
        absoluteErrorSum += Math.abs(error);
        squaredErrorSum += error * error;
        maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(error));
        leftSum += leftValue;
        rightSum += rightValue;
    }
    const leftMean = leftSum / left.length;
    const rightMean = rightSum / right.length;
    let covariance = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (let index = 0; index < left.length; index++) {
        const leftCentered = left[index] - leftMean;
        const rightCentered = right[index] - rightMean;
        covariance += leftCentered * rightCentered;
        leftVariance += leftCentered * leftCentered;
        rightVariance += rightCentered * rightCentered;
    }

    return {
        count: left.length,
        mae: absoluteErrorSum / left.length,
        rmse: Math.sqrt(squaredErrorSum / left.length),
        maxAbsoluteError,
        correlation:
            leftVariance > 0 && rightVariance > 0
                ? covariance / Math.sqrt(leftVariance * rightVariance)
                : null
    };
}

export function fitAlphaMapScale({
    referenceMap,
    observedMap
}) {
    if (
        !referenceMap ||
        !observedMap ||
        referenceMap.length === 0 ||
        referenceMap.length !== observedMap.length
    ) {
        throw new RangeError(
            'referenceMap and observedMap must be equal-length arrays'
        );
    }
    let referenceSquaredEnergy = 0;
    let observedReferenceDot = 0;
    for (let index = 0; index < referenceMap.length; index++) {
        const reference = Number(referenceMap[index]);
        const observed = Number(observedMap[index]);
        if (!Number.isFinite(reference) || !Number.isFinite(observed)) {
            throw new TypeError('alpha maps must contain finite values');
        }
        referenceSquaredEnergy += reference * reference;
        observedReferenceDot += observed * reference;
    }
    if (referenceSquaredEnergy <= Number.EPSILON) {
        throw new RangeError('referenceMap must contain non-zero energy');
    }
    const scale = observedReferenceDot / referenceSquaredEnergy;
    const scaledReference = Float64Array.from(
        referenceMap,
        (value) => value * scale
    );
    return {
        scale,
        residual: compareAlphaMaps(scaledReference, observedMap)
    };
}

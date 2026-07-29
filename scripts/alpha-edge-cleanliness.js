import { compositeKnownWatermark } from './synthetic-residual-ground-truth.js';

const DEFAULT_DECOY_SHIFTS = Object.freeze([
    [-12, 0],
    [-8, 0],
    [-4, 0],
    [4, 0],
    [8, 0],
    [12, 0],
    [0, -12],
    [0, -8],
    [0, -4],
    [0, 4],
    [0, 8],
    [0, 12]
]);

function assertInputs(errorVector, alphaMap, width, height) {
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 2 ||
        height <= 2
    ) {
        throw new RangeError('width and height must be integers above 2');
    }
    if (!alphaMap || alphaMap.length !== width * height) {
        throw new RangeError('alphaMap length must equal width * height');
    }
    if (!errorVector || errorVector.length !== width * height * 3) {
        throw new RangeError(
            'errorVector length must equal width * height * 3'
        );
    }
}

function alphaGradientMagnitude(alphaMap, width, height) {
    const magnitude = new Float64Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const index = y * width + x;
            const gradientX =
                (alphaMap[index + 1] - alphaMap[index - 1]) / 2;
            const gradientY =
                (alphaMap[index + width] - alphaMap[index - width]) / 2;
            magnitude[index] = Math.hypot(gradientX, gradientY);
        }
    }
    return magnitude;
}

function pixelSquaredError(errorVector, pixelCount) {
    const squaredError = new Float64Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        const offset = pixelIndex * 3;
        squaredError[pixelIndex] =
            (
                errorVector[offset] * errorVector[offset] +
                errorVector[offset + 1] * errorVector[offset + 1] +
                errorVector[offset + 2] * errorVector[offset + 2]
            ) / 3;
    }
    return squaredError;
}

function weightedMean(values, weights) {
    let weightedTotal = 0;
    let totalWeight = 0;
    for (let index = 0; index < values.length; index++) {
        weightedTotal += values[index] * weights[index];
        totalWeight += weights[index];
    }
    return totalWeight > 0 ? weightedTotal / totalWeight : null;
}

function shiftedWeightedMean(
    values,
    weights,
    width,
    height,
    shiftX,
    shiftY
) {
    let weightedTotal = 0;
    let totalWeight = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sourceX = x - shiftX;
            const sourceY = y - shiftY;
            if (
                sourceX < 0 ||
                sourceY < 0 ||
                sourceX >= width ||
                sourceY >= height
            ) {
                continue;
            }
            const valueIndex = y * width + x;
            const weight = weights[sourceY * width + sourceX];
            weightedTotal += values[valueIndex] * weight;
            totalWeight += weight;
        }
    }
    return totalWeight > 0 ? weightedTotal / totalWeight : null;
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

export function measureAlphaEdgeLocalizedError({
    errorVector,
    alphaMap,
    width,
    height,
    decoyShifts = DEFAULT_DECOY_SHIFTS
}) {
    assertInputs(errorVector, alphaMap, width, height);
    if (!Array.isArray(decoyShifts) || decoyShifts.length === 0) {
        throw new TypeError('decoyShifts must be a non-empty array');
    }
    const edgeWeights = alphaGradientMagnitude(alphaMap, width, height);
    const squaredError = pixelSquaredError(errorVector, width * height);
    const edgeWeightedMean = weightedMean(squaredError, edgeWeights);
    const decoyEdgeMeans = decoyShifts.map(([shiftX, shiftY]) =>
        shiftedWeightedMean(
            squaredError,
            edgeWeights,
            width,
            height,
            shiftX,
            shiftY
        )
    );
    const decoyEdgeMedian = median(decoyEdgeMeans);
    return {
        edgeWeightedMean,
        decoyEdgeMedian,
        edgeDecoyRatio:
            edgeWeightedMean !== null &&
            decoyEdgeMedian !== null &&
            decoyEdgeMedian > 0
                ? edgeWeightedMean / decoyEdgeMedian
                : null,
        decoyEdgeMeans
    };
}

function assertImageData(imageData, name) {
    if (
        !imageData ||
        !Number.isInteger(imageData.width) ||
        !Number.isInteger(imageData.height) ||
        !imageData.data ||
        imageData.data.length !== imageData.width * imageData.height * 4
    ) {
        throw new TypeError(`${name} must be valid RGBA ImageData-like data`);
    }
}

export function measureAlphaEdgeRecompositionEvidence({
    originalImageData,
    candidateImageData,
    alphaMap,
    position,
    alphaGain = 1,
    decoyShifts = DEFAULT_DECOY_SHIFTS
}) {
    assertImageData(originalImageData, 'originalImageData');
    assertImageData(candidateImageData, 'candidateImageData');
    if (
        originalImageData.width !== candidateImageData.width ||
        originalImageData.height !== candidateImageData.height
    ) {
        throw new RangeError(
            'candidateImageData dimensions must match originalImageData'
        );
    }
    if (
        !position ||
        !Number.isInteger(position.x) ||
        !Number.isInteger(position.y) ||
        !Number.isInteger(position.width) ||
        !Number.isInteger(position.height) ||
        position.x < 0 ||
        position.y < 0 ||
        position.x + position.width > originalImageData.width ||
        position.y + position.height > originalImageData.height
    ) {
        throw new RangeError('position must be inside originalImageData');
    }
    const baselineRecomposition = compositeKnownWatermark({
        truthImageData: originalImageData,
        alphaMap,
        position,
        alphaGain
    });
    const candidateRecomposition = compositeKnownWatermark({
        truthImageData: candidateImageData,
        alphaMap,
        position,
        alphaGain
    });
    const channelCount = position.width * position.height * 3;
    const baselineError = new Float64Array(channelCount);
    const candidateError = new Float64Array(channelCount);
    let baselineSquaredEnergy = 0;
    let candidateSquaredEnergy = 0;
    let candidateBaselineDot = 0;
    for (let localY = 0; localY < position.height; localY++) {
        for (let localX = 0; localX < position.width; localX++) {
            const localPixelIndex =
                localY * position.width + localX;
            const globalPixelIndex =
                (position.y + localY) * originalImageData.width +
                position.x +
                localX;
            for (let channel = 0; channel < 3; channel++) {
                const localOffset = localPixelIndex * 3 + channel;
                const globalOffset = globalPixelIndex * 4 + channel;
                const baselineValue =
                    baselineRecomposition.data[globalOffset] -
                    originalImageData.data[globalOffset];
                const candidateValue =
                    candidateRecomposition.data[globalOffset] -
                    originalImageData.data[globalOffset];
                baselineError[localOffset] = baselineValue;
                candidateError[localOffset] = candidateValue;
                baselineSquaredEnergy += baselineValue * baselineValue;
                candidateSquaredEnergy += candidateValue * candidateValue;
                candidateBaselineDot += baselineValue * candidateValue;
            }
        }
    }
    const signedTemplateAmplitude = baselineSquaredEnergy > 0
        ? candidateBaselineDot / baselineSquaredEnergy
        : 0;
    const orthogonalError = Float64Array.from(
        candidateError,
        (value, index) =>
            value - signedTemplateAmplitude * baselineError[index]
    );
    return {
        signedTemplateAmplitude,
        normalizedTotalError: baselineSquaredEnergy > 0
            ? Math.sqrt(candidateSquaredEnergy / baselineSquaredEnergy)
            : null,
        ...measureAlphaEdgeLocalizedError({
            errorVector: orthogonalError,
            alphaMap,
            width: position.width,
            height: position.height,
            decoyShifts
        })
    };
}

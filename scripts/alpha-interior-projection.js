const LUMA_INTERIOR_PROJECTION_RATIO_THRESHOLD = 1.5;

export const DEFAULT_INTERIOR_DECOY_SHIFTS = Object.freeze(
    Array.from({ length: 13 }, (_, index) => -12 + index * 2)
        .flatMap((shiftY) =>
            Array.from({ length: 13 }, (_, index) => -12 + index * 2)
                .map((shiftX) => Object.freeze([shiftX, shiftY]))
        )
        .filter(([shiftX, shiftY]) => Math.hypot(shiftX, shiftY) >= 4)
);

function assertInputs(imageData, alphaMap, position, decoyShifts) {
    if (
        !imageData ||
        !Number.isInteger(imageData.width) ||
        !Number.isInteger(imageData.height) ||
        !imageData.data ||
        imageData.data.length !== imageData.width * imageData.height * 4
    ) {
        throw new TypeError('imageData must be valid RGBA ImageData-like data');
    }
    if (
        !position ||
        !Number.isInteger(position.x) ||
        !Number.isInteger(position.y) ||
        !Number.isInteger(position.width) ||
        !Number.isInteger(position.height) ||
        position.width <= 2 ||
        position.height !== position.width ||
        position.x < 0 ||
        position.y < 0 ||
        position.x + position.width > imageData.width ||
        position.y + position.height > imageData.height
    ) {
        throw new RangeError('position must be a square inside imageData');
    }
    if (!alphaMap || alphaMap.length !== position.width * position.height) {
        throw new RangeError('alphaMap length must match position');
    }
    if (!Array.isArray(decoyShifts) || decoyShifts.length === 0) {
        throw new TypeError('decoyShifts must be a non-empty array');
    }
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function normalizedCorrelation(values, template) {
    let valueMean = 0;
    let templateMean = 0;
    for (let index = 0; index < values.length; index++) {
        valueMean += values[index];
        templateMean += template[index];
    }
    valueMean /= values.length;
    templateMean /= template.length;
    let numerator = 0;
    let valueEnergy = 0;
    let templateEnergy = 0;
    for (let index = 0; index < values.length; index++) {
        const value = values[index] - valueMean;
        const alpha = template[index] - templateMean;
        numerator += value * alpha;
        valueEnergy += value * value;
        templateEnergy += alpha * alpha;
    }
    const denominator = Math.sqrt(valueEnergy * templateEnergy);
    return denominator > Number.EPSILON ? numerator / denominator : 0;
}

function shiftAlphaMap(alphaMap, size, shiftX, shiftY) {
    const shifted = new Float64Array(alphaMap.length);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sourceX = x - shiftX;
            const sourceY = y - shiftY;
            if (sourceX >= 0 && sourceY >= 0 && sourceX < size && sourceY < size) {
                shifted[y * size + x] = alphaMap[sourceY * size + sourceX];
            }
        }
    }
    return shifted;
}

function extractLuminance(imageData, position) {
    const luminance = new Float64Array(position.width * position.height);
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            const localIndex = y * position.width + x;
            const offset = ((position.y + y) * imageData.width + position.x + x) * 4;
            luminance[localIndex] =
                imageData.data[offset] * 0.2126 +
                imageData.data[offset + 1] * 0.7152 +
                imageData.data[offset + 2] * 0.0722;
        }
    }
    return luminance;
}

export function measureAlphaInteriorProjection({
    imageData,
    alphaMap,
    position,
    decoyShifts = DEFAULT_INTERIOR_DECOY_SHIFTS
}) {
    assertInputs(imageData, alphaMap, position, decoyShifts);
    const luminance = extractLuminance(imageData, position);
    const lumaProjectionSigned = normalizedCorrelation(luminance, alphaMap);
    const lumaProjectionTarget = Math.abs(lumaProjectionSigned);
    const decoys = decoyShifts.map(([shiftX, shiftY]) =>
        Math.abs(normalizedCorrelation(
            luminance,
            shiftAlphaMap(alphaMap, position.width, shiftX, shiftY)
        ))
    );
    const lumaProjectionDecoyMedian = median(decoys);
    const lumaProjectionRatio =
        lumaProjectionTarget > Number.EPSILON &&
        lumaProjectionDecoyMedian > Number.EPSILON
            ? lumaProjectionTarget / lumaProjectionDecoyMedian
            : 0;
    return {
        lumaProjectionSigned,
        lumaProjectionTarget,
        lumaProjectionDecoyMedian,
        lumaProjectionRatio
    };
}

export function classifyProvisionalLumaInteriorResidual(metrics = {}) {
    const flagged =
        Number.isFinite(metrics.lumaProjectionRatio) &&
        metrics.lumaProjectionRatio >= LUMA_INTERIOR_PROJECTION_RATIO_THRESHOLD;
    return {
        flagged,
        reasons: flagged ? ['luma-interior-projection-ratio'] : [],
        evidenceStatus: 'provisional'
    };
}

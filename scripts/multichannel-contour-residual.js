const CHROMA_EDGE_RATIO_THRESHOLD = 3;
const RGB_EDGE_RATIO_THRESHOLD = 2;

export const DEFAULT_CONTOUR_DECOY_SHIFTS = Object.freeze(
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

function buildAlphaEdgeSamples(alphaMap, size) {
    const samples = [];
    for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
            const index = y * size + x;
            const gradientX = (alphaMap[index + 1] - alphaMap[index - 1]) / 2;
            const gradientY = (alphaMap[index + size] - alphaMap[index - size]) / 2;
            const weight = Math.hypot(gradientX, gradientY);
            if (weight <= Number.EPSILON) continue;
            samples.push({
                x,
                y,
                normalX: gradientX / weight,
                normalY: gradientY / weight,
                weight
            });
        }
    }
    return samples;
}

function channelAt(imageData, x, y, channel) {
    return imageData.data[(y * imageData.width + x) * 4 + channel];
}

function normalStrength(imageData, position, sample, shiftX, shiftY) {
    const x = position.x + sample.x + shiftX;
    const y = position.y + sample.y + shiftY;
    if (x <= 0 || y <= 0 || x >= imageData.width - 1 || y >= imageData.height - 1) {
        return null;
    }
    const derivatives = [0, 1, 2].map((channel) => {
        const gradientX = (
            channelAt(imageData, x + 1, y, channel) -
            channelAt(imageData, x - 1, y, channel)
        ) / 2;
        const gradientY = (
            channelAt(imageData, x, y + 1, channel) -
            channelAt(imageData, x, y - 1, channel)
        ) / 2;
        return gradientX * sample.normalX + gradientY * sample.normalY;
    });
    const [red, green, blue] = derivatives;
    return {
        rgb: Math.sqrt((red * red + green * green + blue * blue) / 3),
        chroma: Math.sqrt(((red - green) ** 2 + (blue - green) ** 2) / 2)
    };
}

function safeRatio(target, baseline) {
    if (!(target > Number.EPSILON)) return 0;
    return target / Math.max(Number.EPSILON, baseline ?? 0);
}

export function measureMultichannelContourResidual({
    imageData,
    alphaMap,
    position,
    decoyShifts = DEFAULT_CONTOUR_DECOY_SHIFTS
}) {
    assertInputs(imageData, alphaMap, position, decoyShifts);
    const samples = buildAlphaEdgeSamples(alphaMap, position.width);
    let targetWeight = 0;
    let rgbTargetTotal = 0;
    let chromaTargetTotal = 0;
    const rgbDecoyTotals = new Float64Array(decoyShifts.length);
    const chromaDecoyTotals = new Float64Array(decoyShifts.length);
    const decoyWeights = new Float64Array(decoyShifts.length);

    for (const sample of samples) {
        const target = normalStrength(imageData, position, sample, 0, 0);
        if (target) {
            targetWeight += sample.weight;
            rgbTargetTotal += target.rgb * sample.weight;
            chromaTargetTotal += target.chroma * sample.weight;
        }
        for (const [index, [shiftX, shiftY]] of decoyShifts.entries()) {
            const decoy = normalStrength(imageData, position, sample, shiftX, shiftY);
            if (!decoy) continue;
            rgbDecoyTotals[index] += decoy.rgb * sample.weight;
            chromaDecoyTotals[index] += decoy.chroma * sample.weight;
            decoyWeights[index] += sample.weight;
        }
    }
    const rgbEdgeTarget = targetWeight > 0 ? rgbTargetTotal / targetWeight : 0;
    const chromaEdgeTarget = targetWeight > 0
        ? chromaTargetTotal / targetWeight
        : 0;
    const rgbDecoyMedian = median(Array.from(rgbDecoyTotals, (total, index) =>
        decoyWeights[index] > 0 ? total / decoyWeights[index] : null
    ));
    const chromaDecoyMedian = median(Array.from(chromaDecoyTotals, (total, index) =>
        decoyWeights[index] > 0 ? total / decoyWeights[index] : null
    ));

    return {
        rgbEdgeTarget,
        rgbDecoyMedian,
        rgbEdgeRatio: safeRatio(rgbEdgeTarget, rgbDecoyMedian),
        chromaEdgeTarget,
        chromaDecoyMedian,
        chromaEdgeRatio: safeRatio(chromaEdgeTarget, chromaDecoyMedian)
    };
}

export function classifyHighPrecisionContourResidual(metrics = {}) {
    const reasons = [];
    if (
        Number.isFinite(metrics.chromaEdgeRatio) &&
        metrics.chromaEdgeRatio >= CHROMA_EDGE_RATIO_THRESHOLD
    ) {
        reasons.push('chroma-edge-ratio');
    }
    if (
        Number.isFinite(metrics.rgbEdgeRatio) &&
        metrics.rgbEdgeRatio >= RGB_EDGE_RATIO_THRESHOLD
    ) {
        reasons.push('rgb-edge-ratio');
    }
    return {
        flagged: reasons.length > 0,
        reasons
    };
}

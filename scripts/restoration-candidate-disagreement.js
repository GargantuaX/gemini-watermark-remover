function assertImageData(imageData, label) {
    if (
        !imageData ||
        !Number.isInteger(imageData.width) ||
        !Number.isInteger(imageData.height) ||
        !imageData.data ||
        imageData.data.length !== imageData.width * imageData.height * 4
    ) {
        throw new TypeError(`${label} must be RGBA ImageData-like data`);
    }
}

function luminanceAt(imageData, pixelIndex) {
    const offset = pixelIndex * 4;
    return (
        imageData.data[offset] * 2126 +
        imageData.data[offset + 1] * 7152 +
        imageData.data[offset + 2] * 722
    ) / 10000;
}

function mean(values) {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, quantile) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * quantile;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] +
        (sorted[upper] - sorted[lower]) * (position - lower);
}

export function measureRestorationCandidateDisagreement({
    candidates,
    alphaMap,
    position,
    evidenceTolerance = 0.05,
    alphaThreshold = 0.02,
    edgeMaxAlpha = 0.2
}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new TypeError('candidates must contain at least one candidate');
    }
    if (
        !position ||
        !Number.isInteger(position.x) ||
        !Number.isInteger(position.y) ||
        !Number.isInteger(position.width) ||
        !Number.isInteger(position.height) ||
        position.width <= 0 ||
        position.height <= 0
    ) {
        throw new TypeError('position must define a positive integer rectangle');
    }
    if (!alphaMap || alphaMap.length !== position.width * position.height) {
        throw new TypeError('alphaMap length must match position dimensions');
    }
    if (!Number.isFinite(evidenceTolerance) || evidenceTolerance < 0) {
        throw new TypeError('evidenceTolerance must be a non-negative number');
    }

    const normalized = candidates.map((candidate, index) => {
        assertImageData(candidate?.imageData, `candidates[${index}].imageData`);
        if (!Number.isFinite(candidate.evidenceCost)) {
            throw new TypeError(`candidates[${index}].evidenceCost must be finite`);
        }
        return {
            ...candidate,
            id: String(candidate.id ?? index)
        };
    });
    const { width, height } = normalized[0].imageData;
    for (const candidate of normalized) {
        if (
            candidate.imageData.width !== width ||
            candidate.imageData.height !== height
        ) {
            throw new TypeError('all candidate images must have identical dimensions');
        }
    }
    if (
        position.x < 0 ||
        position.y < 0 ||
        position.x + position.width > width ||
        position.y + position.height > height
    ) {
        throw new RangeError('position must stay inside candidate image dimensions');
    }

    const bestEvidenceCost = Math.min(
        ...normalized.map((candidate) => candidate.evidenceCost)
    );
    const plausible = normalized
        .filter((candidate) => (
            candidate.evidenceCost <= bestEvidenceCost + evidenceTolerance
        ))
        .sort((left, right) => left.id.localeCompare(right.id));
    const ranges = [];
    const edgeRanges = [];
    const coreRanges = [];
    let weightedRangeSum = 0;
    let alphaWeightSum = 0;

    if (plausible.length >= 2) {
        for (let row = 0; row < position.height; row++) {
            for (let col = 0; col < position.width; col++) {
                const localIndex = row * position.width + col;
                const alpha = Math.abs(alphaMap[localIndex] ?? 0);
                if (alpha < alphaThreshold) continue;
                const pixelIndex =
                    (position.y + row) * width + position.x + col;
                const values = plausible.map((candidate) =>
                    luminanceAt(candidate.imageData, pixelIndex)
                );
                const range = Math.max(...values) - Math.min(...values);
                ranges.push(range);
                weightedRangeSum += range * alpha;
                alphaWeightSum += alpha;
                if (alpha < edgeMaxAlpha) edgeRanges.push(range);
                else coreRanges.push(range);
            }
        }
    }

    return {
        status: plausible.length >= 2 ? 'complete' : 'insufficient-candidates',
        candidateCount: normalized.length,
        plausibleCandidateCount: plausible.length,
        plausibleCandidateIds: plausible.map((candidate) => candidate.id),
        bestEvidenceCost,
        evidenceTolerance,
        supportPixelCount: ranges.length,
        edgePixelCount: edgeRanges.length,
        corePixelCount: coreRanges.length,
        meanLumaRange: mean(ranges),
        p90LumaRange: percentile(ranges, 0.9),
        maximumLumaRange: ranges.length > 0 ? Math.max(...ranges) : null,
        alphaWeightedMeanLumaRange: alphaWeightSum > 0
            ? weightedRangeSum / alphaWeightSum
            : null,
        edgeMeanLumaRange: mean(edgeRanges),
        coreMeanLumaRange: mean(coreRanges)
    };
}

import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation
} from './adaptiveDetector.js';

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
        throw new RangeError(
            'alphaMap length must match the square position'
        );
    }
    if (!Array.isArray(decoyShifts) || decoyShifts.length === 0) {
        throw new TypeError('decoyShifts must be a non-empty array');
    }
}

function shiftAlphaMap(alphaMap, size, shiftX, shiftY) {
    const shifted = new Float64Array(alphaMap.length);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sourceX = x - shiftX;
            const sourceY = y - shiftY;
            if (
                sourceX >= 0 &&
                sourceY >= 0 &&
                sourceX < size &&
                sourceY < size
            ) {
                shifted[y * size + x] =
                    alphaMap[sourceY * size + sourceX];
            }
        }
    }
    return shifted;
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function summarizeLocalization(target, decoys) {
    const decoyMedian = median(decoys);
    const hasEnergy = Math.max(target, ...decoys) > Number.EPSILON;
    return {
        target,
        decoyMedian,
        prominence:
            decoyMedian === null ? null : target - decoyMedian,
        ratio:
            target > Number.EPSILON &&
            decoyMedian !== null &&
            decoyMedian > Number.EPSILON
                ? target / decoyMedian
                : null,
        percentile: hasEnergy
            ? decoys.filter((value) => value <= target).length /
                decoys.length
            : null
    };
}

function summarizeLocalDriftBank(target, decoys, decoyShifts) {
    const local = [{ value: target, shift: [0, 0] }];
    const farControls = [];
    for (const [index, shift] of decoyShifts.entries()) {
        const value = decoys[index];
        if (Math.hypot(...shift) <= 4) {
            local.push({ value, shift });
        } else {
            farControls.push(value);
        }
    }
    const winner = local.reduce(
        (best, candidate) =>
            candidate.value > best.value ? candidate : best,
        local[0]
    );
    const farMaximum =
        farControls.length > 0 ? Math.max(...farControls) : null;
    return {
        localPeak: winner.value,
        localWinnerShift: winner.shift,
        farMaximum,
        localProminence:
            farMaximum === null ? null : winner.value - farMaximum,
        localRatio:
            winner.value > Number.EPSILON &&
            farMaximum !== null &&
            farMaximum > Number.EPSILON
                ? winner.value / farMaximum
                : null
    };
}

function luminanceAt(imageData, x, y) {
    const offset = (y * imageData.width + x) * 4;
    return (
        imageData.data[offset] * 0.2126 +
        imageData.data[offset + 1] * 0.7152 +
        imageData.data[offset + 2] * 0.0722
    );
}

function buildImageGradientField(imageData, position) {
    const gradientX = new Float64Array(position.width * position.height);
    const gradientY = new Float64Array(position.width * position.height);
    for (let localY = 1; localY < position.height - 1; localY++) {
        for (let localX = 1; localX < position.width - 1; localX++) {
            const index = localY * position.width + localX;
            const x = position.x + localX;
            const y = position.y + localY;
            gradientX[index] =
                (luminanceAt(imageData, x + 1, y) -
                    luminanceAt(imageData, x - 1, y)) / 2;
            gradientY[index] =
                (luminanceAt(imageData, x, y + 1) -
                    luminanceAt(imageData, x, y - 1)) / 2;
        }
    }
    return { gradientX, gradientY };
}

function buildAlphaEdgeSamples(alphaMap, position) {
    const samples = [];
    for (let localY = 1; localY < position.height - 1; localY++) {
        for (let localX = 1; localX < position.width - 1; localX++) {
            const index = localY * position.width + localX;
            const gradientX =
                (alphaMap[index + 1] - alphaMap[index - 1]) / 2;
            const gradientY =
                (
                    alphaMap[index + position.width] -
                    alphaMap[index - position.width]
                ) / 2;
            const magnitude = Math.hypot(gradientX, gradientY);
            if (magnitude > Number.EPSILON) {
                samples.push({
                    localX,
                    localY,
                    gradientX,
                    gradientY,
                    magnitude
                });
            }
        }
    }
    return samples;
}

function measureTwoSidedAlphaEdgeStrength({
    imageGradientField,
    alphaEdgeSamples,
    position,
    shiftX = 0,
    shiftY = 0
}) {
    let weightedStrength = 0;
    let totalWeight = 0;
    for (const sample of alphaEdgeSamples) {
        const localX = sample.localX + shiftX;
        const localY = sample.localY + shiftY;
        if (
            localX <= 0 ||
            localY <= 0 ||
            localX >= position.width - 1 ||
            localY >= position.height - 1
        ) {
            continue;
        }
        const index = localY * position.width + localX;
        const normalStrength = Math.abs(
            imageGradientField.gradientX[index] * sample.gradientX +
            imageGradientField.gradientY[index] * sample.gradientY
        ) / sample.magnitude;
        weightedStrength += normalStrength * sample.magnitude;
        totalWeight += sample.magnitude;
    }
    return totalWeight > Number.EPSILON
        ? weightedStrength / totalWeight
        : 0;
}

export function measureOutputResidualLocalization({
    imageData,
    alphaMap,
    position,
    decoyShifts
}) {
    assertInputs(imageData, alphaMap, position, decoyShifts);
    const region = {
        x: position.x,
        y: position.y,
        width: position.width,
        height: position.height,
        size: position.width
    };
    const spatialSignedTarget = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region
    });
    const gradientSignedTarget = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region
    });
    const spatialDecoys = [];
    const gradientDecoys = [];
    const twoSidedEdgeDecoys = [];
    const imageGradientField = buildImageGradientField(
        imageData,
        position
    );
    const alphaEdgeSamples = buildAlphaEdgeSamples(alphaMap, position);
    const twoSidedEdgeTarget = measureTwoSidedAlphaEdgeStrength({
        imageGradientField,
        alphaEdgeSamples,
        position
    });
    for (const [shiftX, shiftY] of decoyShifts) {
        const shiftedAlpha = shiftAlphaMap(
            alphaMap,
            position.width,
            shiftX,
            shiftY
        );
        spatialDecoys.push(
            Math.abs(
                computeRegionSpatialCorrelation({
                    imageData,
                    alphaMap: shiftedAlpha,
                    region
                })
            )
        );
        gradientDecoys.push(
            Math.max(
                0,
                computeRegionGradientCorrelation({
                    imageData,
                    alphaMap: shiftedAlpha,
                    region
                })
            )
        );
        twoSidedEdgeDecoys.push(
            measureTwoSidedAlphaEdgeStrength({
                imageGradientField,
                alphaEdgeSamples,
                position,
                shiftX,
                shiftY
            })
        );
    }
    const spatial = summarizeLocalization(
        Math.abs(spatialSignedTarget),
        spatialDecoys
    );
    const gradient = summarizeLocalization(
        Math.max(0, gradientSignedTarget),
        gradientDecoys
    );
    const twoSidedEdge = summarizeLocalization(
        twoSidedEdgeTarget,
        twoSidedEdgeDecoys
    );
    const spatialDriftBank = summarizeLocalDriftBank(
        spatial.target,
        spatialDecoys,
        decoyShifts
    );
    const gradientDriftBank = summarizeLocalDriftBank(
        gradient.target,
        gradientDecoys,
        decoyShifts
    );
    const twoSidedEdgeDriftBank = summarizeLocalDriftBank(
        twoSidedEdge.target,
        twoSidedEdgeDecoys,
        decoyShifts
    );
    return {
        spatialSignedTarget,
        spatialTarget: spatial.target,
        spatialDecoyMedian: spatial.decoyMedian,
        spatialProminence: spatial.prominence,
        spatialRatio: spatial.ratio,
        spatialPercentile: spatial.percentile,
        spatialDecoys,
        spatialLocalPeak: spatialDriftBank.localPeak,
        spatialLocalWinnerShift: spatialDriftBank.localWinnerShift,
        spatialFarMaximum: spatialDriftBank.farMaximum,
        spatialLocalProminence: spatialDriftBank.localProminence,
        spatialLocalRatio: spatialDriftBank.localRatio,
        gradientSignedTarget,
        gradientTarget: gradient.target,
        gradientDecoyMedian: gradient.decoyMedian,
        gradientProminence: gradient.prominence,
        gradientRatio: gradient.ratio,
        gradientPercentile: gradient.percentile,
        gradientDecoys,
        gradientLocalPeak: gradientDriftBank.localPeak,
        gradientLocalWinnerShift: gradientDriftBank.localWinnerShift,
        gradientFarMaximum: gradientDriftBank.farMaximum,
        gradientLocalProminence: gradientDriftBank.localProminence,
        gradientLocalRatio: gradientDriftBank.localRatio,
        twoSidedEdgeTarget: twoSidedEdge.target,
        twoSidedEdgeDecoyMedian: twoSidedEdge.decoyMedian,
        twoSidedEdgeProminence: twoSidedEdge.prominence,
        twoSidedEdgeRatio: twoSidedEdge.ratio,
        twoSidedEdgePercentile: twoSidedEdge.percentile,
        twoSidedEdgeDecoys,
        twoSidedEdgeLocalPeak: twoSidedEdgeDriftBank.localPeak,
        twoSidedEdgeLocalWinnerShift:
            twoSidedEdgeDriftBank.localWinnerShift,
        twoSidedEdgeFarMaximum: twoSidedEdgeDriftBank.farMaximum,
        twoSidedEdgeLocalProminence:
            twoSidedEdgeDriftBank.localProminence,
        twoSidedEdgeLocalRatio: twoSidedEdgeDriftBank.localRatio
    };
}

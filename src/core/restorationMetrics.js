import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation
} from './adaptiveDetector.js';

const NEAR_BLACK_THRESHOLD = 5;
const TEXTURE_REFERENCE_MARGIN = 1;
const TEXTURE_STD_FLOOR_RATIO = 0.8;

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
    const resolvedReferenceImageData = referenceImageData ?? originalImageData;
    const referenceRegion = resolvedReferenceImageData
        ? getReferenceRegion(position, resolvedReferenceImageData)
        : null;
    const referenceTextureStats = referenceRegion
        ? calculateRegionTextureStats(resolvedReferenceImageData, referenceRegion)
        : null;
    const candidateTextureStats = referenceTextureStats
        ? calculateRegionTextureStats(candidateImageData, position)
        : null;
    const darknessPenalty = referenceTextureStats && candidateTextureStats
        ? Math.max(0, referenceTextureStats.meanLum - candidateTextureStats.meanLum - TEXTURE_REFERENCE_MARGIN) /
            Math.max(1, referenceTextureStats.meanLum)
        : 0;
    const flatnessPenalty = referenceTextureStats && candidateTextureStats
        ? Math.max(0, referenceTextureStats.stdLum * TEXTURE_STD_FLOOR_RATIO - candidateTextureStats.stdLum) /
            Math.max(1, referenceTextureStats.stdLum)
        : 0;
    const tooDark = darknessPenalty > 0;
    const tooFlat = flatnessPenalty > 0;

    return {
        referenceTextureStats,
        candidateTextureStats,
        darknessPenalty,
        flatnessPenalty,
        texturePenalty: darknessPenalty * 2 + flatnessPenalty * 2,
        tooDark,
        tooFlat,
        hardReject: tooDark && tooFlat
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

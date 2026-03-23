/**
 * Adaptive watermark detector
 * Uses coarse-to-fine template matching around bottom-right region.
 */

import { resolveGeminiWatermarkSearchConfigs } from './geminiSizeCatalog.js';

const DEFAULT_THRESHOLD = 0.35;
const EPSILON = 1e-8;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function meanAndVariance(values) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i];
    const mean = sum / values.length;

    let sq = 0;
    for (let i = 0; i < values.length; i++) {
        const d = values[i] - mean;
        sq += d * d;
    }
    return { mean, variance: sq / values.length };
}

function normalizedCrossCorrelation(a, b) {
    if (a.length !== b.length || a.length === 0) return 0;

    const statsA = meanAndVariance(a);
    const statsB = meanAndVariance(b);
    const den = Math.sqrt(statsA.variance * statsB.variance) * a.length;

    if (den < EPSILON) return 0;

    let num = 0;
    for (let i = 0; i < a.length; i++) {
        num += (a[i] - statsA.mean) * (b[i] - statsB.mean);
    }
    return num / den;
}

function getRegion(data, width, x, y, size) {
    const out = new Float32Array(size * size);
    for (let row = 0; row < size; row++) {
        const srcBase = (y + row) * width + x;
        const dstBase = row * size;
        for (let col = 0; col < size; col++) {
            out[dstBase + col] = data[srcBase + col];
        }
    }
    return out;
}

function toRegionGrayscale(imageData, region) {
    const { width, height, data } = imageData;
    const size = region.size ?? Math.min(region.width, region.height);
    if (!size || size <= 0) return new Float32Array(0);
    if (region.x < 0 || region.y < 0 || region.x + size > width || region.y + size > height) {
        return new Float32Array(0);
    }

    const out = new Float32Array(size * size);
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const idx = ((region.y + row) * width + (region.x + col)) * 4;
            out[row * size + col] =
                (0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]) / 255;
        }
    }
    return out;
}

function toGrayscale(imageData) {
    const { width, height, data } = imageData;
    const out = new Float32Array(width * height);

    for (let i = 0; i < out.length; i++) {
        const j = i * 4;
        out[i] = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) / 255;
    }

    return out;
}

function sobelMagnitude(gray, width, height) {
    const grad = new Float32Array(width * height);

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const gx =
                -gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1] +
                gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1];
            const gy =
                -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
                gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
            grad[i] = Math.sqrt(gx * gx + gy * gy);
        }
    }

    return grad;
}

function stdDevRegion(data, width, x, y, size) {
    let sum = 0;
    let sq = 0;
    let n = 0;

    for (let row = 0; row < size; row++) {
        const base = (y + row) * width + x;
        for (let col = 0; col < size; col++) {
            const v = data[base + col];
            sum += v;
            sq += v * v;
            n++;
        }
    }

    if (n === 0) return 0;
    const mean = sum / n;
    const variance = Math.max(0, sq / n - mean * mean);
    return Math.sqrt(variance);
}

function buildTemplateGradient(alphaMap, size) {
    return sobelMagnitude(alphaMap, size, size);
}

function scoreCandidate({ gray, grad, width, height }, alphaMap, templateGrad, candidate) {
    const { x, y, size } = candidate;
    if (x < 0 || y < 0 || x + size > width || y + size > height) {
        return null;
    }

    const grayRegion = getRegion(gray, width, x, y, size);
    const gradRegion = getRegion(grad, width, x, y, size);

    const spatial = normalizedCrossCorrelation(grayRegion, alphaMap);
    const gradient = normalizedCrossCorrelation(gradRegion, templateGrad);

    let varianceScore = 0;
    if (y > 8) {
        const refY = Math.max(0, y - size);
        const refH = Math.min(size, y - refY);
        if (refH > 8) {
            const wmStd = stdDevRegion(gray, width, x, y, size);
            const refStd = stdDevRegion(gray, width, x, refY, refH);
            if (refStd > EPSILON) {
                varianceScore = clamp(1 - wmStd / refStd, 0, 1);
            }
        }
    }

    const confidence =
        Math.max(0, spatial) * 0.5 +
        Math.max(0, gradient) * 0.3 +
        varianceScore * 0.2;

    return {
        confidence: clamp(confidence, 0, 1),
        spatialScore: spatial,
        gradientScore: gradient,
        varianceScore
    };
}

function createScaleList(minSize, maxSize) {
    const set = new Set();
    for (let s = minSize; s <= maxSize; s += 8) set.add(s);
    if (48 >= minSize && 48 <= maxSize) set.add(48);
    if (96 >= minSize && 96 <= maxSize) set.add(96);
    return [...set].sort((a, b) => a - b);
}

function buildSeedConfigs(width, height, defaultConfig) {
    // Start adaptive search from both the coarse default anchor and any
    // catalog-projected anchors for official or near-official Gemini sizes.
    return resolveGeminiWatermarkSearchConfigs(width, height, defaultConfig);
}

function getTemplate(cache, alpha96, size) {
    if (cache.has(size)) return cache.get(size);

    const alpha = size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size);
    const grad = buildTemplateGradient(alpha, size);
    const tpl = { alpha, grad };
    cache.set(size, tpl);
    return tpl;
}

export function shiftAlphaMap(alphaMap, size, dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || size <= 0) return new Float32Array(0);
    return warpAlphaMap(alphaMap, size, { dx, dy, scale: 1 });
}

export function warpAlphaMap(alphaMap, size, { dx = 0, dy = 0, scale = 1 } = {}) {
    if (size <= 0) return new Float32Array(0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(scale) || scale <= 0) {
        return new Float32Array(0);
    }
    if (dx === 0 && dy === 0 && scale === 1) return new Float32Array(alphaMap);

    const sample = (x, y) => {
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = x - x0;
        const fy = y - y0;

        const ix0 = clamp(x0, 0, size - 1);
        const iy0 = clamp(y0, 0, size - 1);
        const ix1 = clamp(x0 + 1, 0, size - 1);
        const iy1 = clamp(y0 + 1, 0, size - 1);

        const p00 = alphaMap[iy0 * size + ix0];
        const p10 = alphaMap[iy0 * size + ix1];
        const p01 = alphaMap[iy1 * size + ix0];
        const p11 = alphaMap[iy1 * size + ix1];

        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        return top + (bottom - top) * fy;
    };

    const out = new Float32Array(size * size);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sx = (x - c) / scale + c + dx;
            const sy = (y - c) / scale + c + dy;
            out[y * size + x] = sample(sx, sy);
        }
    }
    return out;
}

export function interpolateAlphaMap(sourceAlpha, sourceSize, targetSize) {
    if (targetSize <= 0) return new Float32Array(0);
    if (sourceSize === targetSize) return new Float32Array(sourceAlpha);

    const out = new Float32Array(targetSize * targetSize);
    const scale = (sourceSize - 1) / Math.max(1, targetSize - 1);

    for (let y = 0; y < targetSize; y++) {
        const sy = y * scale;
        const y0 = Math.floor(sy);
        const y1 = Math.min(sourceSize - 1, y0 + 1);
        const fy = sy - y0;

        for (let x = 0; x < targetSize; x++) {
            const sx = x * scale;
            const x0 = Math.floor(sx);
            const x1 = Math.min(sourceSize - 1, x0 + 1);
            const fx = sx - x0;

            const p00 = sourceAlpha[y0 * sourceSize + x0];
            const p10 = sourceAlpha[y0 * sourceSize + x1];
            const p01 = sourceAlpha[y1 * sourceSize + x0];
            const p11 = sourceAlpha[y1 * sourceSize + x1];

            const top = p00 + (p10 - p00) * fx;
            const bottom = p01 + (p11 - p01) * fx;
            out[y * targetSize + x] = top + (bottom - top) * fy;
        }
    }

    return out;
}

export function computeRegionSpatialCorrelation({ imageData, alphaMap, region }) {
    const patch = toRegionGrayscale(imageData, region);
    if (patch.length === 0 || patch.length !== alphaMap.length) return 0;
    return normalizedCrossCorrelation(patch, alphaMap);
}

export function computeRegionGradientCorrelation({ imageData, alphaMap, region }) {
    const patch = toRegionGrayscale(imageData, region);
    if (patch.length === 0 || patch.length !== alphaMap.length) return 0;
    const size = region.size ?? Math.min(region.width, region.height);
    if (!size || size <= 2) return 0;

    const patchGrad = sobelMagnitude(patch, size, size);
    const alphaGrad = sobelMagnitude(alphaMap, size, size);
    return normalizedCrossCorrelation(patchGrad, alphaGrad);
}

export function shouldAttemptAdaptiveFallback({
    processedImageData,
    alphaMap,
    position,
    residualThreshold = 0.22,
    originalImageData = null,
    originalSpatialMismatchThreshold = 0
}) {
    const residualScore = computeRegionSpatialCorrelation({
        imageData: processedImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width ?? position.size
        }
    });

    if (residualScore >= residualThreshold) {
        return true;
    }

    if (originalImageData) {
        const originalScore = computeRegionSpatialCorrelation({
            imageData: originalImageData,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width ?? position.size
            }
        });

        if (originalScore <= originalSpatialMismatchThreshold) {
            return true;
        }
    }

    return false;
}

export function detectAdaptiveWatermarkRegion({
    imageData,
    alpha96,
    defaultConfig,
    threshold = DEFAULT_THRESHOLD
}) {
    const { width, height } = imageData;
    const gray = toGrayscale(imageData);
    const grad = sobelMagnitude(gray, width, height);
    const context = { gray, grad, width, height };
    const templateCache = new Map();

    const seedConfigs = buildSeedConfigs(width, height, defaultConfig);
    const seedCandidates = seedConfigs
        .map((config) => {
            const size = config.logoSize;
            const candidate = {
                size,
                x: width - config.marginRight - size,
                y: height - config.marginBottom - size
            };
            if (candidate.x < 0 || candidate.y < 0 || candidate.x + size > width || candidate.y + size > height) {
                return null;
            }

            const template = getTemplate(templateCache, alpha96, size);
            const score = scoreCandidate(context, template.alpha, template.grad, candidate);
            if (!score) return null;

            return {
                ...candidate,
                ...score
            };
        })
        .filter(Boolean);

    const bestSeed = seedCandidates.reduce((best, candidate) => {
        if (!best || candidate.confidence > best.confidence) return candidate;
        return best;
    }, null);
    if (bestSeed && bestSeed.confidence >= threshold + 0.08) {
        return {
            found: true,
            confidence: bestSeed.confidence,
            spatialScore: bestSeed.spatialScore,
            gradientScore: bestSeed.gradientScore,
            varianceScore: bestSeed.varianceScore,
            region: {
                x: bestSeed.x,
                y: bestSeed.y,
                size: bestSeed.size
            }
        };
    }

    const baseSize = defaultConfig.logoSize;

    const minSize = clamp(Math.round(baseSize * 0.65), 24, 144);
    const maxSize = clamp(
        Math.min(Math.round(baseSize * 2.8), Math.floor(Math.min(width, height) * 0.4)),
        minSize,
        192
    );
    const scaleList = createScaleList(minSize, maxSize);

    const marginRange = Math.max(32, Math.round(baseSize * 0.75));
    const minMarginRight = clamp(defaultConfig.marginRight - marginRange, 8, width - minSize - 1);
    const maxMarginRight = clamp(defaultConfig.marginRight + marginRange, minMarginRight, width - minSize - 1);
    const minMarginBottom = clamp(defaultConfig.marginBottom - marginRange, 8, height - minSize - 1);
    const maxMarginBottom = clamp(defaultConfig.marginBottom + marginRange, minMarginBottom, height - minSize - 1);

    const topK = [];
    const pushTopK = (candidate) => {
        topK.push(candidate);
        topK.sort((a, b) => b.adjustedScore - a.adjustedScore);
        if (topK.length > 5) topK.length = 5;
    };

    for (const seedCandidate of seedCandidates) {
        pushTopK({
            size: seedCandidate.size,
            x: seedCandidate.x,
            y: seedCandidate.y,
            adjustedScore: seedCandidate.confidence * Math.min(1, Math.sqrt(seedCandidate.size / 96))
        });
    }

    for (const size of scaleList) {
        const tpl = getTemplate(templateCache, alpha96, size);
        for (let mr = minMarginRight; mr <= maxMarginRight; mr += 8) {
            const x = width - mr - size;
            if (x < 0) continue;
            for (let mb = minMarginBottom; mb <= maxMarginBottom; mb += 8) {
                const y = height - mb - size;
                if (y < 0) continue;

                const score = scoreCandidate(context, tpl.alpha, tpl.grad, { x, y, size });
                if (!score) continue;

                // Prefer sizes close to known watermark scales to avoid tiny-template bias.
                const adjustedScore = score.confidence * Math.min(1, Math.sqrt(size / 96));
                if (adjustedScore < 0.08) continue;

                pushTopK({
                    size,
                    x,
                    y,
                    adjustedScore
                });
            }
        }
    }

    let best = bestSeed ?? {
        x: width - defaultConfig.marginRight - defaultConfig.logoSize,
        y: height - defaultConfig.marginBottom - defaultConfig.logoSize,
        size: defaultConfig.logoSize,
        confidence: 0,
        spatialScore: 0,
        gradientScore: 0,
        varianceScore: 0
    };

    for (const coarse of topK) {
        const scaleLo = clamp(coarse.size - 10, minSize, maxSize);
        const scaleHi = clamp(coarse.size + 10, minSize, maxSize);

        for (let size = scaleLo; size <= scaleHi; size += 2) {
            const tpl = getTemplate(templateCache, alpha96, size);
            for (let x = coarse.x - 8; x <= coarse.x + 8; x += 2) {
                if (x < 0 || x + size > width) continue;
                for (let y = coarse.y - 8; y <= coarse.y + 8; y += 2) {
                    if (y < 0 || y + size > height) continue;
                    const score = scoreCandidate(context, tpl.alpha, tpl.grad, { x, y, size });
                    if (!score) continue;

                    if (score.confidence > best.confidence) {
                        best = {
                            x,
                            y,
                            size,
                            ...score
                        };
                    }
                }
            }
        }
    }

    return {
        found: best.confidence >= threshold,
        confidence: best.confidence,
        spatialScore: best.spatialScore,
        gradientScore: best.gradientScore,
        varianceScore: best.varianceScore,
        region: {
            x: best.x,
            y: best.y,
            size: best.size
        }
    };
}

import { warpAlphaMap } from './adaptiveDetector.js';
import { removeWatermark } from './blendModes.js';

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function resolveChannelAlpha(original, preview) {
    const denominator = 255 - original;
    if (!Number.isFinite(denominator) || denominator <= 0) {
        return 0;
    }

    return clamp01((preview - original) / denominator);
}

export function estimatePreviewAlphaMap({
    sourceImageData,
    previewImageData,
    position
}) {
    if (!sourceImageData || !previewImageData || !position) {
        throw new TypeError('estimatePreviewAlphaMap requires sourceImageData, previewImageData, and position');
    }
    if (sourceImageData.width !== previewImageData.width || sourceImageData.height !== previewImageData.height) {
        throw new RangeError('sourceImageData and previewImageData must have identical dimensions');
    }

    const { x, y, width, height } = position;
    if (![x, y, width, height].every((value) => Number.isInteger(value) && value >= 0)) {
        throw new RangeError('position must contain non-negative integer bounds');
    }

    const alphaMap = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const idx = ((y + row) * sourceImageData.width + (x + col)) * 4;
            const r = resolveChannelAlpha(sourceImageData.data[idx], previewImageData.data[idx]);
            const g = resolveChannelAlpha(sourceImageData.data[idx + 1], previewImageData.data[idx + 1]);
            const b = resolveChannelAlpha(sourceImageData.data[idx + 2], previewImageData.data[idx + 2]);

            alphaMap[row * width + col] = clamp01(Math.max(r, g, b));
        }
    }

    return alphaMap;
}

export function aggregatePreviewAlphaMaps(alphaMaps) {
    if (!Array.isArray(alphaMaps) || alphaMaps.length === 0) {
        throw new TypeError('aggregatePreviewAlphaMaps requires at least one alpha map');
    }

    const expectedLength = alphaMaps[0]?.length;
    if (!Number.isInteger(expectedLength) || expectedLength <= 0) {
        throw new TypeError('alpha maps must be typed arrays with a positive length');
    }

    for (const alphaMap of alphaMaps) {
        if (!alphaMap || alphaMap.length !== expectedLength) {
            throw new RangeError('all alpha maps must have identical lengths');
        }
    }

    const aggregated = new Float32Array(expectedLength);
    for (let i = 0; i < expectedLength; i++) {
        const values = alphaMaps
            .map((alphaMap) => clamp01(alphaMap[i]))
            .sort((left, right) => left - right);
        const middle = Math.floor(values.length / 2);

        aggregated[i] = values.length % 2 === 1
            ? values[middle]
            : (values[middle - 1] + values[middle]) / 2;
    }

    return aggregated;
}

export function blurAlphaMap(alphaMap, size, radius = 0) {
    const blurPasses = Number.isInteger(radius) ? radius : Math.max(0, Math.round(radius || 0));
    if (blurPasses <= 0 || size <= 0) {
        return new Float32Array(alphaMap);
    }

    let current = new Float32Array(alphaMap);
    for (let pass = 0; pass < blurPasses; pass++) {
        const next = new Float32Array(current.length);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                let sum = 0;
                let weight = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        const yy = y + dy;
                        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
                        const w = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
                        sum += current[yy * size + xx] * w;
                        weight += w;
                    }
                }
                next[y * size + x] = clamp01(sum / Math.max(1, weight));
            }
        }
        current = next;
    }

    return current;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function clampChannel(value) {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 255) return 255;
    return Math.round(value);
}

function applyPreviewWatermark(imageData, alphaMap, position, alphaGain = 1) {
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = clamp01(alphaMap[row * position.width + col] * alphaGain);
            if (alpha <= 0.001) continue;

            const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
            for (let channel = 0; channel < 3; channel++) {
                const original = imageData.data[idx + channel];
                imageData.data[idx + channel] = clampChannel(alpha * 255 + (1 - alpha) * original);
            }
        }
    }
}

function blurImageDataRegionOnce(imageData, position) {
    const blurred = cloneImageData(imageData);

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            let sumR = 0;
            let sumG = 0;
            let sumB = 0;
            let weight = 0;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const localX = Math.max(0, Math.min(position.width - 1, col + dx));
                    const localY = Math.max(0, Math.min(position.height - 1, row + dy));
                    const idx = ((position.y + localY) * imageData.width + (position.x + localX)) * 4;
                    const w = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
                    sumR += imageData.data[idx] * w;
                    sumG += imageData.data[idx + 1] * w;
                    sumB += imageData.data[idx + 2] * w;
                    weight += w;
                }
            }

            const outIdx = ((position.y + row) * blurred.width + (position.x + col)) * 4;
            blurred.data[outIdx] = clampChannel(sumR / weight);
            blurred.data[outIdx + 1] = clampChannel(sumG / weight);
            blurred.data[outIdx + 2] = clampChannel(sumB / weight);
        }
    }

    return blurred;
}

function blurImageDataRegion(imageData, position, radius = 0) {
    const blurPasses = Number.isInteger(radius) ? radius : Math.max(0, Math.round(radius || 0));
    if (blurPasses <= 0) {
        return cloneImageData(imageData);
    }

    let current = cloneImageData(imageData);
    for (let pass = 0; pass < blurPasses; pass++) {
        current = blurImageDataRegionOnce(current, position);
    }

    return current;
}

function averageStripColor(imageData, {
    xFrom,
    xTo,
    yFrom,
    yTo
}) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    const minX = Math.max(0, Math.min(xFrom, xTo));
    const maxX = Math.min(imageData.width - 1, Math.max(xFrom, xTo));
    const minY = Math.max(0, Math.min(yFrom, yTo));
    const maxY = Math.min(imageData.height - 1, Math.max(yFrom, yTo));

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const idx = (y * imageData.width + x) * 4;
            sumR += imageData.data[idx];
            sumG += imageData.data[idx + 1];
            sumB += imageData.data[idx + 2];
            count++;
        }
    }

    if (count <= 0) {
        return [0, 0, 0];
    }

    return [sumR / count, sumG / count, sumB / count];
}

function lerpColor(left, right, t) {
    return [
        left[0] * (1 - t) + right[0] * t,
        left[1] * (1 - t) + right[1] * t,
        left[2] * (1 - t) + right[2] * t
    ];
}

function measureRegionAbsDelta(candidateImageData, targetImageData, position) {
    let total = 0;
    let count = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * candidateImageData.width + (position.x + col)) * 4;
            for (let channel = 0; channel < 3; channel++) {
                total += Math.abs(candidateImageData.data[idx + channel] - targetImageData.data[idx + channel]);
                count++;
            }
        }
    }

    return count > 0 ? total / count : 0;
}

function averageSampleColor(imageData, samples) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    for (const [x, y] of samples) {
        if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) {
            continue;
        }
        const idx = (y * imageData.width + x) * 4;
        sumR += imageData.data[idx];
        sumG += imageData.data[idx + 1];
        sumB += imageData.data[idx + 2];
        count++;
    }

    if (count <= 0) {
        return [0, 0, 0];
    }

    return [sumR / count, sumG / count, sumB / count];
}

export function measurePreviewBoundaryMetrics(candidateImageData, previewImageData, position) {
    let rawTotal = 0;
    let previewBoundaryTotal = 0;
    let localContrastTotal = 0;
    let count = 0;

    const compareBoundaryPixel = (x, y, insideSamples, outsideSamples) => {
        const idx = (y * candidateImageData.width + x) * 4;
        const previewIdx = (y * previewImageData.width + x) * 4;
        const inside = averageSampleColor(previewImageData, insideSamples);
        const outside = averageSampleColor(previewImageData, outsideSamples);

        for (let channel = 0; channel < 3; channel++) {
            rawTotal += Math.abs(candidateImageData.data[idx + channel] - outside[channel]);
            previewBoundaryTotal += Math.abs(previewImageData.data[previewIdx + channel] - outside[channel]);
            localContrastTotal += Math.abs(inside[channel] - outside[channel]);
            count++;
        }
    };

    for (let col = 0; col < position.width; col++) {
        const x = position.x + col;
        compareBoundaryPixel(
            x,
            position.y,
            [
                [x - 1, position.y],
                [x, position.y],
                [x + 1, position.y]
            ],
            [
                [x - 1, position.y - 1],
                [x, position.y - 1],
                [x + 1, position.y - 1]
            ]
        );
        compareBoundaryPixel(
            x,
            position.y + position.height - 1,
            [
                [x - 1, position.y + position.height - 1],
                [x, position.y + position.height - 1],
                [x + 1, position.y + position.height - 1]
            ],
            [
                [x - 1, position.y + position.height],
                [x, position.y + position.height],
                [x + 1, position.y + position.height]
            ]
        );
    }

    for (let row = 1; row < position.height - 1; row++) {
        const y = position.y + row;
        compareBoundaryPixel(
            position.x,
            y,
            [
                [position.x, y - 1],
                [position.x, y],
                [position.x, y + 1]
            ],
            [
                [position.x - 1, y - 1],
                [position.x - 1, y],
                [position.x - 1, y + 1]
            ]
        );
        compareBoundaryPixel(
            position.x + position.width - 1,
            y,
            [
                [position.x + position.width - 1, y - 1],
                [position.x + position.width - 1, y],
                [position.x + position.width - 1, y + 1]
            ],
            [
                [position.x + position.width, y - 1],
                [position.x + position.width, y],
                [position.x + position.width, y + 1]
            ]
        );
    }

    const rawScore = count > 0 ? rawTotal / count : 0;
    const previewBoundaryScore = count > 0 ? previewBoundaryTotal / count : 0;
    const localContrastScore = count > 0 ? localContrastTotal / count : 0;
    const normalizer = Math.max(1, previewBoundaryScore, localContrastScore);

    return {
        rawScore,
        previewBoundaryScore,
        localContrastScore,
        normalizer,
        normalizedScore: rawScore / normalizer
    };
}

function measurePreviewBoundaryContinuity(candidateImageData, previewImageData, position) {
    return measurePreviewBoundaryMetrics(candidateImageData, previewImageData, position).normalizedScore;
}

export function buildPreviewNeighborhoodPrior({
    previewImageData,
    position,
    radius = 6,
    relaxationPasses = null
}) {
    if (!previewImageData || !position) {
        throw new TypeError('buildPreviewNeighborhoodPrior requires previewImageData and position');
    }

    const stripRadius = Math.max(1, Math.round(radius || 1));
    const prior = cloneImageData(previewImageData);
    const leftBoundary = [];
    const rightBoundary = [];
    const topBoundary = [];
    const bottomBoundary = [];

    for (let row = 0; row < position.height; row++) {
        const y = position.y + row;
        leftBoundary.push(averageStripColor(previewImageData, {
            xFrom: position.x - stripRadius,
            xTo: position.x - 1,
            yFrom: y - 1,
            yTo: y + 1
        }));
        rightBoundary.push(averageStripColor(previewImageData, {
            xFrom: position.x + position.width,
            xTo: position.x + position.width + stripRadius - 1,
            yFrom: y - 1,
            yTo: y + 1
        }));
    }

    for (let col = 0; col < position.width; col++) {
        const x = position.x + col;
        topBoundary.push(averageStripColor(previewImageData, {
            xFrom: x - 1,
            xTo: x + 1,
            yFrom: position.y - stripRadius,
            yTo: position.y - 1
        }));
        bottomBoundary.push(averageStripColor(previewImageData, {
            xFrom: x - 1,
            xTo: x + 1,
            yFrom: position.y + position.height,
            yTo: position.y + position.height + stripRadius - 1
        }));
    }

    for (let row = 0; row < position.height; row++) {
        const ty = position.height <= 1 ? 0.5 : row / (position.height - 1);
        for (let col = 0; col < position.width; col++) {
            const tx = position.width <= 1 ? 0.5 : col / (position.width - 1);
            const horizontal = lerpColor(leftBoundary[row], rightBoundary[row], tx);
            const vertical = lerpColor(topBoundary[col], bottomBoundary[col], ty);
            const idx = ((position.y + row) * prior.width + (position.x + col)) * 4;
            prior.data[idx] = clampChannel((horizontal[0] + vertical[0]) * 0.5);
            prior.data[idx + 1] = clampChannel((horizontal[1] + vertical[1]) * 0.5);
            prior.data[idx + 2] = clampChannel((horizontal[2] + vertical[2]) * 0.5);
        }
    }

    if (position.width <= 1 || position.height <= 1) {
        return prior;
    }

    const resolvedRelaxationPasses = Number.isInteger(relaxationPasses)
        ? Math.max(0, relaxationPasses)
        : Math.max(24, Math.round((position.width + position.height) * 2));
    for (let pass = 0; pass < resolvedRelaxationPasses; pass++) {
        for (let row = 0; row < position.height; row++) {
            const y = position.y + row;
            for (let col = 0; col < position.width; col++) {
                const x = position.x + col;
                const idx = (y * prior.width + x) * 4;
                for (let channel = 0; channel < 3; channel++) {
                    let sum = 0;
                    let weight = 0;
                    const neighbors = [
                        [x - 1, y, 1],
                        [x + 1, y, 1],
                        [x, y - 1, 1],
                        [x, y + 1, 1],
                        [x - 1, y - 1, 0.5],
                        [x + 1, y - 1, 0.5],
                        [x - 1, y + 1, 0.5],
                        [x + 1, y + 1, 0.5]
                    ];

                    for (const [neighborX, neighborY, neighborWeight] of neighbors) {
                        if (
                            neighborX < 0 ||
                            neighborY < 0 ||
                            neighborX >= prior.width ||
                            neighborY >= prior.height
                        ) {
                            continue;
                        }

                        const neighborIdx = (neighborY * prior.width + neighborX) * 4;
                        sum += prior.data[neighborIdx + channel] * neighborWeight;
                        weight += neighborWeight;
                    }

                    prior.data[idx + channel] = clampChannel(sum / Math.max(1, weight));
                }
            }
        }
    }

    return prior;
}

export function renderPreviewWatermarkObservation({
    sourceImageData,
    alphaMap,
    position,
    alphaGain = 1,
    compositeBlurRadius = 0
}) {
    if (!sourceImageData || !alphaMap || !position) {
        throw new TypeError('renderPreviewWatermarkObservation requires sourceImageData, alphaMap, and position');
    }

    const rendered = cloneImageData(sourceImageData);
    applyPreviewWatermark(rendered, alphaMap, position, alphaGain);
    return blurImageDataRegion(rendered, position, compositeBlurRadius);
}

export function fitConstrainedPreviewAlphaModel({
    sourceImageData,
    previewImageData,
    standardAlphaMap,
    position,
    shiftCandidates = [-0.5, 0, 0.5],
    scaleCandidates = [0.99, 1, 1.01],
    blurRadii = [0, 1],
    alphaGainCandidates = [1]
}) {
    if (!sourceImageData || !previewImageData || !standardAlphaMap || !position) {
        throw new TypeError('fitConstrainedPreviewAlphaModel requires sourceImageData, previewImageData, standardAlphaMap, and position');
    }

    const size = position.width;
    if (!size || size !== position.height || standardAlphaMap.length !== size * size) {
        throw new RangeError('fitConstrainedPreviewAlphaModel requires a square ROI and matching standardAlphaMap size');
    }

    let best = null;
    for (const scale of scaleCandidates) {
        for (const dy of shiftCandidates) {
            for (const dx of shiftCandidates) {
                const warped = warpAlphaMap(standardAlphaMap, size, { dx, dy, scale });
                for (const blurRadius of blurRadii) {
                    const alphaMap = blurAlphaMap(warped, size, blurRadius);
                    for (const alphaGain of alphaGainCandidates) {
                        const restored = cloneImageData(previewImageData);
                        removeWatermark(restored, alphaMap, position, { alphaGain });
                        const score = measureRegionAbsDelta(restored, sourceImageData, position);

                        if (!best || score < best.score) {
                            best = {
                                alphaMap,
                                alphaGain,
                                params: {
                                    shift: { dx, dy, scale },
                                    blurRadius
                                },
                                score
                            };
                        }
                    }
                }
            }
        }
    }

    return best;
}

export function fitPreviewRenderModel({
    sourceImageData,
    previewImageData,
    standardAlphaMap,
    position,
    shiftCandidates = [-0.5, 0, 0.5],
    scaleCandidates = [0.99, 1, 1.01],
    alphaBlurRadii = [0, 1],
    compositeBlurRadii = [0, 1],
    alphaGainCandidates = [1]
}) {
    if (!sourceImageData || !previewImageData || !standardAlphaMap || !position) {
        throw new TypeError('fitPreviewRenderModel requires sourceImageData, previewImageData, standardAlphaMap, and position');
    }

    const size = position.width;
    if (!size || size !== position.height || standardAlphaMap.length !== size * size) {
        throw new RangeError('fitPreviewRenderModel requires a square ROI and matching standardAlphaMap size');
    }

    let best = null;
    for (const scale of scaleCandidates) {
        for (const dy of shiftCandidates) {
            for (const dx of shiftCandidates) {
                const warped = warpAlphaMap(standardAlphaMap, size, { dx, dy, scale });
                for (const alphaBlurRadius of alphaBlurRadii) {
                    const alphaMap = blurAlphaMap(warped, size, alphaBlurRadius);
                    for (const compositeBlurRadius of compositeBlurRadii) {
                        for (const alphaGain of alphaGainCandidates) {
                            const rendered = renderPreviewWatermarkObservation({
                                sourceImageData,
                                alphaMap,
                                position,
                                alphaGain,
                                compositeBlurRadius
                            });
                            const score = measureRegionAbsDelta(rendered, previewImageData, position);

                            if (!best || score < best.score) {
                                best = {
                                    alphaMap,
                                    alphaGain,
                                    params: {
                                        shift: { dx, dy, scale },
                                        alphaBlurRadius,
                                        compositeBlurRadius
                                    },
                                    score
                                };
                            }
                        }
                    }
                }
            }
        }
    }

    return best;
}

export function fitPreviewOnlyRenderModel({
    previewImageData,
    standardAlphaMap,
    position,
    shiftCandidates = [-0.5, 0, 0.5],
    scaleCandidates = [0.99, 1, 1.01],
    alphaBlurRadii = [0, 1],
    compositeBlurRadii = [0, 1],
    alphaGainCandidates = [1],
    blendStrengthCandidates = [0.85],
    priorRadiusCandidates = null,
    priorRadius = 6,
    boundaryContinuityWeight = 0
}) {
    if (!previewImageData || !standardAlphaMap || !position) {
        throw new TypeError('fitPreviewOnlyRenderModel requires previewImageData, standardAlphaMap, and position');
    }

    const size = position.width;
    if (!size || size !== position.height || standardAlphaMap.length !== size * size) {
        throw new RangeError('fitPreviewOnlyRenderModel requires a square ROI and matching standardAlphaMap size');
    }

    const resolvedPriorRadiusCandidates = Array.isArray(priorRadiusCandidates) && priorRadiusCandidates.length > 0
        ? priorRadiusCandidates
        : [priorRadius];

    const alphaCandidates = [];
    for (const candidatePriorRadius of resolvedPriorRadiusCandidates) {
        const priorImageData = buildPreviewNeighborhoodPrior({
            previewImageData,
            position,
            radius: candidatePriorRadius
        });

        let alphaBestForRadius = null;
        for (const scale of scaleCandidates) {
            for (const dy of shiftCandidates) {
                for (const dx of shiftCandidates) {
                    const warped = warpAlphaMap(standardAlphaMap, size, { dx, dy, scale });
                    for (const alphaBlurRadius of alphaBlurRadii) {
                        const alphaMap = blurAlphaMap(warped, size, alphaBlurRadius);
                        for (const compositeBlurRadius of compositeBlurRadii) {
                            for (const alphaGain of alphaGainCandidates) {
                                const rendered = renderPreviewWatermarkObservation({
                                    sourceImageData: priorImageData,
                                    alphaMap,
                                    position,
                                    alphaGain,
                                    compositeBlurRadius
                                });
                                const forwardScore = measureRegionAbsDelta(rendered, previewImageData, position);

                                if (!alphaBestForRadius || forwardScore < alphaBestForRadius.forwardScore) {
                                    alphaBestForRadius = {
                                        alphaMap,
                                        alphaGain,
                                        priorImageData,
                                        params: {
                                            shift: { dx, dy, scale },
                                            alphaBlurRadius,
                                            compositeBlurRadius,
                                            priorRadius: candidatePriorRadius
                                        },
                                        forwardScore
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }

        if (alphaBestForRadius) {
            alphaCandidates.push(alphaBestForRadius);
        }
    }

    let best = null;
    for (const alphaCandidate of alphaCandidates) {
        for (const blendStrength of blendStrengthCandidates) {
            const restored = restorePreviewRegionWithNeighborhoodPrior({
                previewImageData,
                alphaMap: alphaCandidate.alphaMap,
                position,
                alphaGain: alphaCandidate.alphaGain,
                priorImageData: alphaCandidate.priorImageData,
                blendStrength
            });
            const rerendered = renderPreviewWatermarkObservation({
                sourceImageData: restored,
                alphaMap: alphaCandidate.alphaMap,
                position,
                alphaGain: alphaCandidate.alphaGain,
                compositeBlurRadius: alphaCandidate.params.compositeBlurRadius
            });
            const inverseScore = measureRegionAbsDelta(rerendered, previewImageData, position);
            const boundaryMetrics = boundaryContinuityWeight > 0
                ? measurePreviewBoundaryMetrics(restored, previewImageData, position)
                : {
                    rawScore: 0,
                    previewBoundaryScore: 0,
                    localContrastScore: 0,
                    normalizer: 1,
                    normalizedScore: 0
                };
            const boundaryScore = boundaryMetrics.normalizedScore;
            const score = inverseScore + boundaryScore * boundaryContinuityWeight;

            if (!best || score < best.score) {
                best = {
                    alphaMap: alphaCandidate.alphaMap,
                    alphaGain: alphaCandidate.alphaGain,
                    priorImageData: alphaCandidate.priorImageData,
                    params: {
                        ...alphaCandidate.params,
                        blendStrength
                    },
                    score,
                    diagnostics: {
                        forwardScore: alphaCandidate.forwardScore,
                        inverseScore,
                        boundaryScore,
                        boundaryRawScore: boundaryMetrics.rawScore,
                        boundaryPreviewScore: boundaryMetrics.previewBoundaryScore,
                        boundaryContrastScore: boundaryMetrics.localContrastScore,
                        boundaryNormalizer: boundaryMetrics.normalizer
                    }
                };
            }
        }
    }

    return best;
}

export function restorePreviewRegionWithRenderModel({
    previewImageData,
    alphaMap,
    position,
    alphaGain = 1,
    compositeBlurRadius = 0,
    iterations = 12,
    stepSize = 0.85
}) {
    if (!previewImageData || !alphaMap || !position) {
        throw new TypeError('restorePreviewRegionWithRenderModel requires previewImageData, alphaMap, and position');
    }

    let deblurred = cloneImageData(previewImageData);
    const totalIterations = Math.max(0, Math.round(iterations || 0));
    const resolvedStepSize = Number.isFinite(stepSize) ? stepSize : 0.85;

    if (compositeBlurRadius > 0 && totalIterations > 0) {
        for (let iteration = 0; iteration < totalIterations; iteration++) {
            const reblurred = blurImageDataRegion(deblurred, position, compositeBlurRadius);

            for (let row = 0; row < position.height; row++) {
                for (let col = 0; col < position.width; col++) {
                    const idx = ((position.y + row) * deblurred.width + (position.x + col)) * 4;
                    for (let channel = 0; channel < 3; channel++) {
                        const error = previewImageData.data[idx + channel] - reblurred.data[idx + channel];
                        deblurred.data[idx + channel] = clampChannel(
                            deblurred.data[idx + channel] + error * resolvedStepSize
                        );
                    }
                }
            }
        }
    }

    const restored = cloneImageData(deblurred);
    removeWatermark(restored, alphaMap, position, { alphaGain });
    return restored;
}

export function restorePreviewRegionWithNeighborhoodPrior({
    previewImageData,
    alphaMap,
    position,
    alphaGain = 1,
    priorImageData,
    blendStrength = 0.85
}) {
    if (!previewImageData || !alphaMap || !position || !priorImageData) {
        throw new TypeError('restorePreviewRegionWithNeighborhoodPrior requires previewImageData, alphaMap, position, and priorImageData');
    }

    const restored = cloneImageData(previewImageData);
    removeWatermark(restored, alphaMap, position, { alphaGain });

    const resolvedBlendStrength = Number.isFinite(blendStrength) ? blendStrength : 0.85;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = clamp01(alphaMap[row * position.width + col] * alphaGain);
            if (alpha <= 0.001) continue;

            const blend = Math.max(0, Math.min(1, Math.sqrt(alpha) * resolvedBlendStrength));
            const idx = ((position.y + row) * restored.width + (position.x + col)) * 4;
            for (let channel = 0; channel < 3; channel++) {
                restored.data[idx + channel] = clampChannel(
                    restored.data[idx + channel] * (1 - blend) +
                    priorImageData.data[idx + channel] * blend
                );
            }
        }
    }

    return restored;
}

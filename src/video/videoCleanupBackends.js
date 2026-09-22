import {
    blendAllenkDenoisedRoi,
    calculateAllenkRuntimeRoi,
    calculateAllenkVirtualPaddedRoi,
    createAllenkGradientMask,
    embedAllenkRoiWeights,
    extractAllenkVirtualImageData,
    normalizeAllenkFdncnnOptions
} from '../core/allenkFdncnnDenoise.js';

const DEFAULT_RESIDUAL_CLEANUP_STRENGTH = 1.5;
const DEFAULT_HIGH_QUALITY_CLEANUP = false;
const DEFAULT_TEXTURE_REPAIR = false;
const DEFAULT_TEXTURE_REPAIR_STRENGTH = 0.85;
const DEFAULT_DENOISE_BACKEND = 'none';
const DEFAULT_EDGE_DENOISE_STRENGTH = 0.65;
const DEFAULT_ALLENK_FDNCNN_SIGMA = 25;
const DEFAULT_ALLENK_FDNCNN_REUSE_THRESHOLD = 6.5;

// Soft residual cleanup replaces footprint pixels with an inpainted and blurred
// copy. Over a flat background that hides the rim left by alpha-map error and
// costs nothing, because there is no detail to lose. Over a detailed background
// it wipes texture the reverse alpha blend already recovered, and the resulting
// smudge reads far worse than the residual it was meant to hide - while the
// residual itself is masked by that same detail. So scale the cleanup down by
// how much detail surrounds the footprint, measured as the RMS of the local
// high-pass luma outside it.
const CLEANUP_FLAT_TEXTURE_RMS = 12;   // at or below: flat, keep full cleanup
const CLEANUP_BUSY_TEXTURE_RMS = 30;   // at or above: detailed, skip cleanup

const VIDEO_CLEANUP_BACKENDS = Object.freeze({
    CANVAS_SOFT: 'canvas-soft',
    CANVAS_BILATERAL: 'canvas-bilateral'
});

const VIDEO_DENOISE_BACKENDS = Object.freeze({
    NONE: 'none',
    ALLENK_FDNCNN_BROWSER_SPIKE: 'allenk-fdncnn-browser-spike',
    CANVAS_EDGE_DENOISE: 'canvas-edge-denoise',
    CANVAS_EDGE_BAND_DENOISE: 'canvas-edge-band-denoise',
    CANVAS_EDGE_CORE_DENOISE: 'canvas-edge-core-denoise',
    CANVAS_FOOTPRINT_POLISH: 'canvas-footprint-polish',
    CANVAS_TEMPORAL_DELTA_STABILIZE: 'canvas-temporal-delta-stabilize',
    CANVAS_TEMPORAL_MATCH_DELTA_STABILIZE: 'canvas-temporal-match-delta-stabilize',
    CANVAS_TEMPORAL_STABILIZE: 'canvas-temporal-stabilize',
    CANVAS_TEXTURE_REPAIR: 'canvas-texture-repair'
});

function lumaAt(data, idx) {
    return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
}

function createGaussianKernel(sigma, radius = Math.ceil(sigma * 3)) {
    const safeSigma = Math.max(0.01, sigma);
    const safeRadius = Math.max(1, Math.round(radius));
    const kernel = new Float32Array(safeRadius * 2 + 1);
    let sum = 0;

    for (let i = -safeRadius; i <= safeRadius; i++) {
        const value = Math.exp(-(i * i) / (2 * safeSigma * safeSigma));
        kernel[i + safeRadius] = value;
        sum += value;
    }

    for (let i = 0; i < kernel.length; i++) {
        kernel[i] /= sum;
    }

    return { kernel, radius: safeRadius };
}

function gaussianBlurFloatMap(source, width, height, sigma, radius) {
    const { kernel, radius: r } = createGaussianKernel(sigma, radius);
    const temp = new Float32Array(source.length);
    const output = new Float32Array(source.length);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let dx = -r; dx <= r; dx++) {
                const xx = Math.max(0, Math.min(width - 1, x + dx));
                sum += source[y * width + xx] * kernel[dx + r];
            }
            temp[y * width + x] = sum;
        }
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let dy = -r; dy <= r; dy++) {
                const yy = Math.max(0, Math.min(height - 1, y + dy));
                sum += temp[yy * width + x] * kernel[dy + r];
            }
            output[y * width + x] = sum;
        }
    }

    return output;
}

function smoothstep(edge0, edge1, value) {
    if (edge0 === edge1) return value >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function buildLumaStructureGuard(imageData, strength = 1) {
    if (!imageData?.data || imageData.width <= 0 || imageData.height <= 0) {
        return new Float32Array(0);
    }

    const { width, height, data } = imageData;
    const guard = new Float32Array(width * height);
    const sample = (x, y) => {
        const xx = Math.max(0, Math.min(width - 1, x));
        const yy = Math.max(0, Math.min(height - 1, y));
        return lumaAt(data, (yy * width + xx) * 4);
    };
    const safeStrength = Math.max(0, Math.min(1, Number.isFinite(strength) ? strength : 1));

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const gx =
                -sample(x - 1, y - 1) - 2 * sample(x - 1, y) - sample(x - 1, y + 1) +
                sample(x + 1, y - 1) + 2 * sample(x + 1, y) + sample(x + 1, y + 1);
            const gy =
                -sample(x - 1, y - 1) - 2 * sample(x, y - 1) - sample(x + 1, y - 1) +
                sample(x - 1, y + 1) + 2 * sample(x, y + 1) + sample(x + 1, y + 1);
            const gradient = Math.sqrt(gx * gx + gy * gy);
            guard[y * width + x] = smoothstep(42, 150, gradient) * safeStrength;
        }
    }

    return gaussianBlurFloatMap(guard, width, height, 0.65, 2);
}

function gaussianBlurPaddedImageData(imageData, sigma, radius) {
    const width = imageData.width;
    const height = imageData.height;
    const source = imageData.data;
    const { kernel, radius: r } = createGaussianKernel(sigma, radius);
    const temp = new Float32Array(source.length);
    const output = new Uint8ClampedArray(source.length);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dst = (y * width + x) * 4;
            for (let c = 0; c < 4; c++) {
                let sum = 0;
                for (let dx = -r; dx <= r; dx++) {
                    const xx = Math.max(0, Math.min(width - 1, x + dx));
                    sum += source[(y * width + xx) * 4 + c] * kernel[dx + r];
                }
                temp[dst + c] = sum;
            }
        }
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dst = (y * width + x) * 4;
            for (let c = 0; c < 4; c++) {
                let sum = 0;
                for (let dy = -r; dy <= r; dy++) {
                    const yy = Math.max(0, Math.min(height - 1, y + dy));
                    sum += temp[(yy * width + x) * 4 + c] * kernel[dy + r];
                }
                output[dst + c] = Math.max(0, Math.min(255, Math.round(sum)));
            }
        }
    }

    return output;
}

function bilateralDenoisePaddedImageData(imageData, weights, radius = 5, colorSigma = 42) {
    const { width, height, data } = imageData;
    const output = new Uint8ClampedArray(data);
    const safeRadius = Math.max(1, Math.round(radius));
    const spatialSigma = Math.max(0.1, safeRadius * 0.55);
    const safeColorSigma = Math.max(1, colorSigma);
    const spatialDen = 2 * spatialSigma * spatialSigma;
    const colorDen = 2 * safeColorSigma * safeColorSigma;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const maskWeight = weights[pixel] || 0;
            if (maskWeight <= 0.02) continue;

            const centerIdx = pixel * 4;
            const center = [
                data[centerIdx],
                data[centerIdx + 1],
                data[centerIdx + 2]
            ];
            const sum = [0, 0, 0];
            let weightSum = 0;

            for (let dy = -safeRadius; dy <= safeRadius; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;
                for (let dx = -safeRadius; dx <= safeRadius; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= width) continue;

                    const idx = (yy * width + xx) * 4;
                    const dr = data[idx] - center[0];
                    const dg = data[idx + 1] - center[1];
                    const db = data[idx + 2] - center[2];
                    const spatial = Math.exp(-(dx * dx + dy * dy) / spatialDen);
                    const color = Math.exp(-(dr * dr + dg * dg + db * db) / colorDen);
                    const localMask = Math.max(maskWeight, weights[yy * width + xx] || 0);
                    const w = spatial * (0.35 + color * 0.65) * (0.5 + localMask * 0.5);

                    sum[0] += data[idx] * w;
                    sum[1] += data[idx + 1] * w;
                    sum[2] += data[idx + 2] * w;
                    weightSum += w;
                }
            }

            if (weightSum > 0) {
                output[centerIdx] = Math.max(0, Math.min(255, Math.round(sum[0] / weightSum)));
                output[centerIdx + 1] = Math.max(0, Math.min(255, Math.round(sum[1] / weightSum)));
                output[centerIdx + 2] = Math.max(0, Math.min(255, Math.round(sum[2] / weightSum)));
            }
        }
    }

    return output;
}

function inpaintPaddedImageData(imageData, weights, iterations = 24) {
    const { width, height, data } = imageData;
    const active = new Uint8Array(width * height);
    const current = new Float32Array(data.length);
    const next = new Float32Array(data.length);
    current.set(data);
    next.set(data);

    for (let i = 0; i < weights.length; i++) {
        active[i] = weights[i] > 0.08 ? 1 : 0;
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            if (!active[pixel]) continue;

            let count = 0;
            const sum = [0, 0, 0];
            for (let radius = 1; radius <= 8 && count === 0; radius++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= height) continue;
                    for (let dx = -radius; dx <= radius; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= width) continue;
                        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                        const neighbor = yy * width + xx;
                        if (active[neighbor]) continue;

                        const idx = neighbor * 4;
                        sum[0] += data[idx];
                        sum[1] += data[idx + 1];
                        sum[2] += data[idx + 2];
                        count++;
                    }
                }
            }

            if (count > 0) {
                const idx = pixel * 4;
                current[idx] = sum[0] / count;
                current[idx + 1] = sum[1] / count;
                current[idx + 2] = sum[2] / count;
                next[idx] = current[idx];
                next[idx + 1] = current[idx + 1];
                next[idx + 2] = current[idx + 2];
            }
        }
    }

    const rounds = Math.max(4, Math.round(iterations));
    for (let round = 0; round < rounds; round++) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const pixel = y * width + x;
                const idx = pixel * 4;
                if (!active[pixel]) {
                    next[idx] = current[idx];
                    next[idx + 1] = current[idx + 1];
                    next[idx + 2] = current[idx + 2];
                    next[idx + 3] = current[idx + 3];
                    continue;
                }

                let count = 0;
                const sum = [0, 0, 0];
                const neighbors = [
                    [x - 1, y],
                    [x + 1, y],
                    [x, y - 1],
                    [x, y + 1],
                    [x - 1, y - 1],
                    [x + 1, y - 1],
                    [x - 1, y + 1],
                    [x + 1, y + 1]
                ];

                for (const [nx, ny] of neighbors) {
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const nIdx = (ny * width + nx) * 4;
                    sum[0] += current[nIdx];
                    sum[1] += current[nIdx + 1];
                    sum[2] += current[nIdx + 2];
                    count++;
                }

                if (count > 0) {
                    next[idx] = sum[0] / count;
                    next[idx + 1] = sum[1] / count;
                    next[idx + 2] = sum[2] / count;
                    next[idx + 3] = current[idx + 3];
                }
            }
        }
        current.set(next);
    }

    const output = new Uint8ClampedArray(data.length);
    for (let i = 0; i < output.length; i++) {
        output[i] = Math.max(0, Math.min(255, Math.round(current[i])));
    }
    return output;
}

function mapRoiWeightsToPaddedWeights(roiWeights, position, padded, padX, padY) {
    const paddedWeights = new Float32Array(padded.width * padded.height);

    for (let y = 0; y < position.height; y++) {
        const py = position.y - padY + y;
        if (py < 0 || py >= padded.height) continue;
        for (let x = 0; x < position.width; x++) {
            const px = position.x - padX + x;
            if (px < 0 || px >= padded.width) continue;
            paddedWeights[py * padded.width + px] = roiWeights[y * position.width + x];
        }
    }

    return paddedWeights;
}

function getAllenkRuntimeInputSize(runtime = null) {
    const shape = runtime?.inputShape;
    const height = Number(shape?.[2]);
    const width = Number(shape?.[3]);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        return null;
    }
    return { width, height };
}

function resizeImageDataLike(imageData, targetWidth, targetHeight) {
    if (
        !imageData?.data ||
        imageData.width <= 0 ||
        imageData.height <= 0 ||
        targetWidth <= 0 ||
        targetHeight <= 0
    ) {
        return imageData;
    }
    const width = Math.max(1, Math.round(targetWidth));
    const height = Math.max(1, Math.round(targetHeight));
    if (imageData.width === width && imageData.height === height) {
        return {
            width,
            height,
            data: new Uint8ClampedArray(imageData.data)
        };
    }

    const output = new Uint8ClampedArray(width * height * 4);
    const source = imageData.data;
    const scaleX = width > 1 ? (imageData.width - 1) / (width - 1) : 0;
    const scaleY = height > 1 ? (imageData.height - 1) / (height - 1) : 0;

    for (let y = 0; y < height; y++) {
        const sourceY = y * scaleY;
        const y0 = Math.floor(sourceY);
        const y1 = Math.min(imageData.height - 1, y0 + 1);
        const wy = sourceY - y0;
        for (let x = 0; x < width; x++) {
            const sourceX = x * scaleX;
            const x0 = Math.floor(sourceX);
            const x1 = Math.min(imageData.width - 1, x0 + 1);
            const wx = sourceX - x0;
            const dst = (y * width + x) * 4;
            const i00 = (y0 * imageData.width + x0) * 4;
            const i10 = (y0 * imageData.width + x1) * 4;
            const i01 = (y1 * imageData.width + x0) * 4;
            const i11 = (y1 * imageData.width + x1) * 4;

            for (let c = 0; c < 4; c++) {
                const top = source[i00 + c] * (1 - wx) + source[i10 + c] * wx;
                const bottom = source[i01 + c] * (1 - wx) + source[i11 + c] * wx;
                output[dst + c] = Math.round(top * (1 - wy) + bottom * wy);
            }
        }
    }

    return { width, height, data: output };
}

function createAllenkRuntimeInputImageData(prepared, runtimeSize) {
    if (!runtimeSize) return prepared.padded;
    if (prepared.padded.width === runtimeSize.width && prepared.padded.height === runtimeSize.height) {
        return prepared.padded;
    }
    return resizeImageDataLike(prepared.padded, runtimeSize.width, runtimeSize.height);
}

function normalizeAllenkDenoisedRuntimeOutput(prepared, denoised) {
    const imageData = denoised?.imageData;
    if (!imageData?.data) return denoised;
    if (imageData.width === prepared.padded.width && imageData.height === prepared.padded.height) {
        return denoised;
    }
    return {
        ...denoised,
        imageData: resizeImageDataLike(imageData, prepared.padded.width, prepared.padded.height)
    };
}

export function normalizeVideoCleanupOptions(options = {}) {
    const highQualityCleanup = options.highQualityCleanup === true || (
        options.highQualityCleanup !== false && DEFAULT_HIGH_QUALITY_CLEANUP
    );
    const requestedDenoiseBackend = typeof options.denoiseBackend === 'string'
        ? options.denoiseBackend
        : null;
    const denoiseBackend = Object.values(VIDEO_DENOISE_BACKENDS).includes(requestedDenoiseBackend)
        ? requestedDenoiseBackend
        : options.textureRepair === true || (options.textureRepair !== false && DEFAULT_TEXTURE_REPAIR)
            ? VIDEO_DENOISE_BACKENDS.CANVAS_TEXTURE_REPAIR
            : DEFAULT_DENOISE_BACKEND;

    const edgeDenoiseStrengthLimit = denoiseBackend === VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE
        ? 3
        : 1;
    const normalized = {
        residualCleanupStrength: Number.isFinite(options.residualCleanupStrength)
            ? Math.max(0, Math.min(1.8, options.residualCleanupStrength))
            : DEFAULT_RESIDUAL_CLEANUP_STRENGTH,
        cleanupBackend: highQualityCleanup
            ? VIDEO_CLEANUP_BACKENDS.CANVAS_BILATERAL
            : VIDEO_CLEANUP_BACKENDS.CANVAS_SOFT,
        highQualityCleanup,
        denoiseBackend,
        edgeDenoiseStrength: Number.isFinite(options.edgeDenoiseStrength)
            ? Math.max(0, Math.min(edgeDenoiseStrengthLimit, options.edgeDenoiseStrength))
            : DEFAULT_EDGE_DENOISE_STRENGTH,
        textureRepair: denoiseBackend === VIDEO_DENOISE_BACKENDS.CANVAS_TEXTURE_REPAIR,
        textureRepairStrength: Number.isFinite(options.textureRepairStrength)
            ? Math.max(0, Math.min(1, options.textureRepairStrength))
            : DEFAULT_TEXTURE_REPAIR_STRENGTH
    };

    if (denoiseBackend === VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE) {
        normalized.allenkFdncnnRuntime = options.allenkFdncnnRuntime || null;
        normalized.allenkFdncnnSigma = Number.isFinite(options.allenkFdncnnSigma)
            ? Math.max(0, Math.min(150, options.allenkFdncnnSigma))
            : DEFAULT_ALLENK_FDNCNN_SIGMA;
        normalized.allenkFdncnnPadding = Number.isFinite(options.allenkFdncnnPadding)
            ? Math.max(0, Math.round(options.allenkFdncnnPadding))
            : undefined;
        normalized.allenkFdncnnTemporalReuse = options.allenkFdncnnTemporalReuse || null;
        normalized.allenkFdncnnFrameCache = options.allenkFdncnnFrameCache || null;
        normalized.denoiseRuntimeStatus = normalized.allenkFdncnnRuntime
            ? 'available'
            : 'unavailable';
        normalized.denoiseRuntimeReason = normalized.allenkFdncnnRuntime
            ? 'allenk FDnCNN runtime provided'
            : 'allenk FDnCNN model contract is decoded, but no browser GPU inference runtime is wired yet';
    }

    return normalized;
}

export function buildGradientWeightMap(alphaMap, width, height, strength) {
    const gradient = new Float32Array(width * height);
    let maxGradient = 0;
    const sample = (x, y) => {
        const xx = Math.max(0, Math.min(width - 1, x));
        const yy = Math.max(0, Math.min(height - 1, y));
        return alphaMap[yy * width + xx] || 0;
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const gx =
                -sample(x - 1, y - 1) - 2 * sample(x - 1, y) - sample(x - 1, y + 1) +
                sample(x + 1, y - 1) + 2 * sample(x + 1, y) + sample(x + 1, y + 1);
            const gy =
                -sample(x - 1, y - 1) - 2 * sample(x, y - 1) - sample(x + 1, y - 1) +
                sample(x - 1, y + 1) + 2 * sample(x, y + 1) + sample(x + 1, y + 1);
            const value = Math.sqrt(gx * gx + gy * gy);
            gradient[i] = value;
            if (value > maxGradient) maxGradient = value;
        }
    }

    if (maxGradient <= 0) return gradient;

    const dilated = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let localMax = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= width) continue;
                    localMax = Math.max(localMax, gradient[yy * width + xx]);
                }
            }
            dilated[y * width + x] = Math.sqrt(localMax / maxGradient);
        }
    }

    const smoothed = gaussianBlurFloatMap(dilated, width, height, 1.15);
    for (let i = 0; i < smoothed.length; i++) {
        smoothed[i] = Math.min(1, smoothed[i] * strength);
    }
    return smoothed;
}

export function buildEdgeBandDenoiseWeightMap(alphaMap, width, height, strength) {
    if (!Number.isFinite(strength) || strength <= 0) return new Float32Array(width * height);

    const edgeWeights = buildGradientWeightMap(alphaMap, width, height, 1);
    const weights = new Float32Array(width * height);
    const safeStrength = Math.max(0, Math.min(1, strength));

    for (let i = 0; i < weights.length; i++) {
        const alpha = alphaMap[i] || 0;
        const edge = edgeWeights[i] || 0;
        const footprintGate = Math.max(
            smoothstep(0.006, 0.035, alpha),
            smoothstep(0.42, 0.72, edge) * 0.45
        );
        const highBody = smoothstep(0.20, 0.30, alpha);
        const edgeCore = smoothstep(0.24, 0.62, edge);
        const bodyGuard = 1 - highBody * (1 - edgeCore) * 0.86;
        weights[i] = Math.min(1, edge * footprintGate * bodyGuard * safeStrength);
    }

    return gaussianBlurFloatMap(weights, width, height, 0.65, 2);
}

function buildRawGradientWeightMap(alphaMap, width, height) {
    const gradient = new Float32Array(width * height);
    let maxGradient = 0;
    const sample = (x, y) => {
        const xx = Math.max(0, Math.min(width - 1, x));
        const yy = Math.max(0, Math.min(height - 1, y));
        return alphaMap[yy * width + xx] || 0;
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const gx =
                -sample(x - 1, y - 1) - 2 * sample(x - 1, y) - sample(x - 1, y + 1) +
                sample(x + 1, y - 1) + 2 * sample(x + 1, y) + sample(x + 1, y + 1);
            const gy =
                -sample(x - 1, y - 1) - 2 * sample(x, y - 1) - sample(x + 1, y - 1) +
                sample(x - 1, y + 1) + 2 * sample(x, y + 1) + sample(x + 1, y + 1);
            const value = Math.sqrt(gx * gx + gy * gy);
            gradient[i] = value;
            if (value > maxGradient) maxGradient = value;
        }
    }

    if (maxGradient <= 0) return gradient;
    for (let i = 0; i < gradient.length; i++) {
        gradient[i] /= maxGradient;
    }
    return gradient;
}

export function buildEdgeCoreDenoiseWeightMap(alphaMap, width, height, strength) {
    if (!Number.isFinite(strength) || strength <= 0) return new Float32Array(width * height);

    const baseWeights = buildEdgeBandDenoiseWeightMap(alphaMap, width, height, strength);
    const rawGradient = buildRawGradientWeightMap(alphaMap, width, height);
    const weights = new Float32Array(width * height);

    for (let i = 0; i < weights.length; i++) {
        const coreGate = smoothstep(0.10, 0.20, rawGradient[i] || 0);
        weights[i] = baseWeights[i] * coreGate;
    }

    return gaussianBlurFloatMap(weights, width, height, 0.35, 1);
}

/**
 * RMS of the high-pass luma outside the watermark footprint, i.e. how much real
 * detail sits around it. Reuses the caller's blurred copy as the low-pass term.
 */
export function measureSurroundingTextureRms(padded, textureBase, weights) {
    let sum = 0;
    let count = 0;

    for (let pixel = 0; pixel < weights.length; pixel++) {
        if (weights[pixel] > 0.02) continue;

        const idx = pixel * 4;
        const detail = lumaAt(padded.data, idx) - lumaAt(textureBase, idx);
        sum += detail * detail;
        count++;
    }

    return count > 0 ? Math.sqrt(sum / count) : 0;
}

export function resolveContentTextureGate(textureRms) {
    if (!Number.isFinite(textureRms)) return 1;
    return 1 - smoothstep(CLEANUP_FLAT_TEXTURE_RMS, CLEANUP_BUSY_TEXTURE_RMS, textureRms);
}

function applySoftResidualCleanup(
    ctx,
    position,
    alphaMap,
    {
        strength = 0,
        highQuality = DEFAULT_HIGH_QUALITY_CLEANUP,
        protectStructure = false
    } = {}
) {
    if (!Number.isFinite(strength) || strength <= 0) return;

    const padding = Math.max(24, Math.round(Math.min(position.width, position.height) * 0.9));
    const padX = Math.max(0, position.x - padding);
    const padY = Math.max(0, position.y - padding);
    const padRight = Math.min(ctx.canvas.width, position.x + position.width + padding);
    const padBottom = Math.min(ctx.canvas.height, position.y + position.height + padding);
    const padded = ctx.getImageData(padX, padY, padRight - padX, padBottom - padY);
    const roiWeights = buildGradientWeightMap(alphaMap, position.width, position.height, strength);
    const paddedWeights = mapRoiWeightsToPaddedWeights(roiWeights, position, padded, padX, padY);
    const weights = gaussianBlurFloatMap(paddedWeights, padded.width, padded.height, 1);
    const textureBase = gaussianBlurPaddedImageData(padded, 2.2, 5);
    const contentTextureGate = resolveContentTextureGate(
        measureSurroundingTextureRms(padded, textureBase, weights)
    );

    // Detailed background: smoothing would cost more than the residual it hides.
    // Bail out before the inpaint, which is the expensive part of this pass.
    if (contentTextureGate <= 0.01) return;

    const structureGuard = protectStructure
        ? buildLumaStructureGuard(padded, highQuality ? 0.55 : 0.78)
        : null;
    let repairedSource;

    if (highQuality) {
        repairedSource = bilateralDenoisePaddedImageData(
            padded,
            weights,
            Math.max(4, Math.round(Math.min(position.width, position.height) / 14)),
            52
        );
    } else {
        const inpainted = inpaintPaddedImageData(
            padded,
            weights,
            Math.max(18, Math.round(Math.min(position.width, position.height) / 2))
        );
        const blurRadius = Math.max(2, Math.round(Math.min(position.width, position.height) / 18));
        repairedSource = gaussianBlurPaddedImageData(
            { width: padded.width, height: padded.height, data: inpainted },
            blurRadius * 0.8,
            blurRadius
        );
    }

    for (let pixel = 0; pixel < weights.length; pixel++) {
        const weight = Math.min(1, Math.max(0, weights[pixel]));
        const baseBlendWeight = Math.min(1, weight * (highQuality ? 1.08 : 1.25));
        const watermarkEdgePressure = smoothstep(0.22, 0.55, weight);
        const effectiveStructureGuard = structureGuard
            ? (structureGuard[pixel] || 0) * (1 - watermarkEdgePressure * 0.82)
            : 0;
        const structureFactor = structureGuard
            ? Math.max(0.28, 1 - effectiveStructureGuard)
            : 1;
        const blendWeight = baseBlendWeight * structureFactor * contentTextureGate;
        if (blendWeight <= 0.01) continue;

        const idx = pixel * 4;
        for (let c = 0; c < 3; c++) {
            const texture = padded.data[idx + c] - textureBase[idx + c];
            const textureGain = highQuality
                ? Math.max(0.18, 0.72 - blendWeight * 0.48)
                : Math.max(0.05, 0.78 - blendWeight * 0.9);
            const repaired = Math.max(0, Math.min(255, repairedSource[idx + c] + texture * textureGain));
            padded.data[idx + c] = Math.round(
                padded.data[idx + c] * (1 - blendWeight) + repaired * blendWeight
            );
        }
    }

    ctx.putImageData(padded, padX, padY);
}

function applyEdgeDenoise(ctx, position, alphaMap, { strength = DEFAULT_EDGE_DENOISE_STRENGTH } = {}) {
    if (!Number.isFinite(strength) || strength <= 0) return;

    const padding = Math.max(18, Math.round(Math.min(position.width, position.height) * 0.45));
    const padX = Math.max(0, position.x - padding);
    const padY = Math.max(0, position.y - padding);
    const padRight = Math.min(ctx.canvas.width, position.x + position.width + padding);
    const padBottom = Math.min(ctx.canvas.height, position.y + position.height + padding);
    const padded = ctx.getImageData(padX, padY, padRight - padX, padBottom - padY);
    const roiWeights = buildGradientWeightMap(alphaMap, position.width, position.height, Math.max(0, Math.min(1, strength)));
    const paddedWeights = mapRoiWeightsToPaddedWeights(roiWeights, position, padded, padX, padY);
    const weights = gaussianBlurFloatMap(paddedWeights, padded.width, padded.height, 0.85, 2);
    const denoised = bilateralDenoisePaddedImageData(
        padded,
        weights,
        Math.max(3, Math.round(Math.min(position.width, position.height) / 18)),
        34
    );

    for (let pixel = 0; pixel < weights.length; pixel++) {
        const weight = Math.min(1, Math.max(0, weights[pixel] || 0));
        const blendWeight = Math.min(0.62, weight * 0.72);
        if (blendWeight <= 0.01) continue;

        const idx = pixel * 4;
        for (let c = 0; c < 3; c++) {
            padded.data[idx + c] = Math.round(
                padded.data[idx + c] * (1 - blendWeight) + denoised[idx + c] * blendWeight
            );
        }
    }

    ctx.putImageData(padded, padX, padY);
}

function applyEdgeBandDenoise(ctx, position, alphaMap, { strength = DEFAULT_EDGE_DENOISE_STRENGTH } = {}) {
    if (!Number.isFinite(strength) || strength <= 0) return;

    const padding = Math.max(16, Math.round(Math.min(position.width, position.height) * 0.4));
    const padX = Math.max(0, position.x - padding);
    const padY = Math.max(0, position.y - padding);
    const padRight = Math.min(ctx.canvas.width, position.x + position.width + padding);
    const padBottom = Math.min(ctx.canvas.height, position.y + position.height + padding);
    const padded = ctx.getImageData(padX, padY, padRight - padX, padBottom - padY);
    const roiWeights = buildEdgeBandDenoiseWeightMap(alphaMap, position.width, position.height, strength);
    const paddedWeights = mapRoiWeightsToPaddedWeights(roiWeights, position, padded, padX, padY);
    const weights = gaussianBlurFloatMap(paddedWeights, padded.width, padded.height, 0.65, 2);
    const denoised = bilateralDenoisePaddedImageData(
        padded,
        weights,
        Math.max(3, Math.round(Math.min(position.width, position.height) / 20)),
        32
    );

    for (let pixel = 0; pixel < weights.length; pixel++) {
        const weight = Math.min(1, Math.max(0, weights[pixel] || 0));
        const blendWeight = Math.min(0.54, weight * 0.78);
        if (blendWeight <= 0.01) continue;

        const idx = pixel * 4;
        for (let c = 0; c < 3; c++) {
            padded.data[idx + c] = Math.round(
                padded.data[idx + c] * (1 - blendWeight) + denoised[idx + c] * blendWeight
            );
        }
    }

    ctx.putImageData(padded, padX, padY);
}

function applyEdgeCoreDenoise(ctx, position, alphaMap, { strength = DEFAULT_EDGE_DENOISE_STRENGTH } = {}) {
    if (!Number.isFinite(strength) || strength <= 0) return;

    const padding = Math.max(16, Math.round(Math.min(position.width, position.height) * 0.4));
    const padX = Math.max(0, position.x - padding);
    const padY = Math.max(0, position.y - padding);
    const padRight = Math.min(ctx.canvas.width, position.x + position.width + padding);
    const padBottom = Math.min(ctx.canvas.height, position.y + position.height + padding);
    const padded = ctx.getImageData(padX, padY, padRight - padX, padBottom - padY);
    const roiWeights = buildEdgeCoreDenoiseWeightMap(alphaMap, position.width, position.height, strength);
    const paddedWeights = mapRoiWeightsToPaddedWeights(roiWeights, position, padded, padX, padY);
    const weights = gaussianBlurFloatMap(paddedWeights, padded.width, padded.height, 0.45, 1);
    const denoised = bilateralDenoisePaddedImageData(
        padded,
        weights,
        Math.max(3, Math.round(Math.min(position.width, position.height) / 20)),
        32
    );

    for (let pixel = 0; pixel < weights.length; pixel++) {
        const weight = Math.min(1, Math.max(0, weights[pixel] || 0));
        const blendWeight = Math.min(0.48, weight * 0.7);
        if (blendWeight <= 0.01) continue;

        const idx = pixel * 4;
        for (let c = 0; c < 3; c++) {
            padded.data[idx + c] = Math.round(
                padded.data[idx + c] * (1 - blendWeight) + denoised[idx + c] * blendWeight
            );
        }
    }

    ctx.putImageData(padded, padX, padY);
}

export function buildTextureRepairWeightMap(alphaMap, width, height, strength) {
    if (!Number.isFinite(strength) || strength <= 0) return new Float32Array(width * height);

    const edgeWeights = buildGradientWeightMap(alphaMap, width, height, 1);
    const weights = new Float32Array(width * height);
    const safeStrength = Math.max(0, Math.min(1, strength));

    for (let i = 0; i < weights.length; i++) {
        const alpha = alphaMap[i] || 0;
        if (alpha <= 0.035) continue;

        const bodyWeight = Math.min(1, Math.max(0, (alpha - 0.035) / 0.18));
        const edgeWeight = edgeWeights[i] || 0;
        weights[i] = Math.min(1, Math.max(edgeWeight * 0.75, bodyWeight * 0.32) * safeStrength);
    }

    return gaussianBlurFloatMap(weights, width, height, 0.75, 2);
}

export function buildFootprintPolishWeightMap(alphaMap, width, height, strength) {
    if (!Number.isFinite(strength) || strength <= 0) return new Float32Array(width * height);

    const edgeWeights = buildGradientWeightMap(alphaMap, width, height, 1);
    const weights = new Float32Array(width * height);
    const safeStrength = Math.max(0, Math.min(1, strength));

    for (let i = 0; i < weights.length; i++) {
        const alpha = alphaMap[i] || 0;
        const edge = edgeWeights[i] || 0;
        const footprint = smoothstep(0.018, 0.13, alpha);
        const body = smoothstep(0.10, 0.24, alpha);
        const edgeGuard = 1 - smoothstep(0.42, 0.78, edge) * 0.28;
        weights[i] = Math.min(1, (footprint * 0.34 + body * 0.22 + edge * 0.18) * edgeGuard * safeStrength);
    }

    return gaussianBlurFloatMap(weights, width, height, 0.85, 2);
}

function applyFootprintPolish(ctx, position, alphaMap, { strength = DEFAULT_EDGE_DENOISE_STRENGTH } = {}) {
    if (!Number.isFinite(strength) || strength <= 0) return;

    const padding = Math.max(22, Math.round(Math.min(position.width, position.height) * 0.55));
    const padX = Math.max(0, position.x - padding);
    const padY = Math.max(0, position.y - padding);
    const padRight = Math.min(ctx.canvas.width, position.x + position.width + padding);
    const padBottom = Math.min(ctx.canvas.height, position.y + position.height + padding);
    const padded = ctx.getImageData(padX, padY, padRight - padX, padBottom - padY);
    const roiWeights = buildFootprintPolishWeightMap(alphaMap, position.width, position.height, strength);
    const paddedWeights = mapRoiWeightsToPaddedWeights(roiWeights, position, padded, padX, padY);
    const weights = gaussianBlurFloatMap(paddedWeights, padded.width, padded.height, 0.8, 2);
    const base = gaussianBlurPaddedImageData(padded, 1.8, 4);
    const inpainted = inpaintPaddedImageData(
        padded,
        weights,
        Math.max(14, Math.round(Math.min(position.width, position.height) / 3))
    );
    const repairedSource = gaussianBlurPaddedImageData(
        { width: padded.width, height: padded.height, data: inpainted },
        1.2,
        3
    );

    for (let pixel = 0; pixel < weights.length; pixel++) {
        const weight = Math.min(1, Math.max(0, weights[pixel] || 0));
        const blendWeight = Math.min(0.36, weight * 0.72);
        if (blendWeight <= 0.012) continue;

        const idx = pixel * 4;
        const textureGain = Math.max(0.28, 0.72 - blendWeight * 1.1);
        for (let c = 0; c < 3; c++) {
            const texture = padded.data[idx + c] - base[idx + c];
            const repaired = Math.max(0, Math.min(255, repairedSource[idx + c] + texture * textureGain));
            padded.data[idx + c] = Math.round(
                padded.data[idx + c] * (1 - blendWeight) + repaired * blendWeight
            );
        }
    }

    ctx.putImageData(padded, padX, padY);
}

function applyTextureRepair(ctx, position, alphaMap, { strength = DEFAULT_TEXTURE_REPAIR_STRENGTH } = {}) {
    if (!Number.isFinite(strength) || strength <= 0) return;

    const padding = Math.max(26, Math.round(Math.min(position.width, position.height) * 0.75));
    const padX = Math.max(0, position.x - padding);
    const padY = Math.max(0, position.y - padding);
    const padRight = Math.min(ctx.canvas.width, position.x + position.width + padding);
    const padBottom = Math.min(ctx.canvas.height, position.y + position.height + padding);
    const padded = ctx.getImageData(padX, padY, padRight - padX, padBottom - padY);
    const base = gaussianBlurPaddedImageData(padded, 1.65, 4);
    const roiWeights = buildTextureRepairWeightMap(alphaMap, position.width, position.height, strength);
    const paddedWeights = mapRoiWeightsToPaddedWeights(roiWeights, position, padded, padX, padY);
    const weights = gaussianBlurFloatMap(paddedWeights, padded.width, padded.height, 0.75, 2);
    const source = new Uint8ClampedArray(padded.data);
    const searchRadius = Math.max(6, Math.round(Math.min(position.width, position.height) / 7));

    for (let y = 0; y < padded.height; y++) {
        for (let x = 0; x < padded.width; x++) {
            const pixel = y * padded.width + x;
            const weight = Math.min(1, Math.max(0, weights[pixel] || 0));
            if (weight <= 0.025) continue;

            const idx = pixel * 4;
            const targetBaseLuma = lumaAt(base, idx);
            let bestPixel = -1;
            let bestCost = Number.POSITIVE_INFINITY;

            for (let dy = -searchRadius; dy <= searchRadius; dy += 2) {
                const yy = y + dy;
                if (yy < 0 || yy >= padded.height) continue;
                for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= padded.width) continue;
                    const candidatePixel = yy * padded.width + xx;
                    if ((weights[candidatePixel] || 0) > 0.015) continue;

                    const candidateIdx = candidatePixel * 4;
                    const lumaDelta = Math.abs(lumaAt(base, candidateIdx) - targetBaseLuma);
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    const cost = lumaDelta + distance * 0.7;
                    if (cost < bestCost) {
                        bestCost = cost;
                        bestPixel = candidatePixel;
                    }
                }
            }

            if (bestPixel < 0) continue;

            const bestIdx = bestPixel * 4;
            const textureGain = Math.min(0.7, weight * 0.95);
            for (let c = 0; c < 3; c++) {
                const highpass = Math.max(-18, Math.min(18, source[bestIdx + c] - base[bestIdx + c]));
                padded.data[idx + c] = Math.max(0, Math.min(255, Math.round(
                    padded.data[idx + c] + highpass * textureGain
                )));
            }
        }
    }

    ctx.putImageData(padded, padX, padY);
}

function borrowCleanHighpassTexture({
    targetData,
    sourceData,
    weights,
    width,
    height,
    strength = 0.72
} = {}) {
    if (
        !targetData ||
        !sourceData ||
        !weights ||
        targetData.length !== sourceData.length ||
        width <= 0 ||
        height <= 0
    ) {
        return new Uint8ClampedArray(targetData || 0);
    }

    const pixelCount = Math.min(weights.length, Math.floor(targetData.length / 4), width * height);
    const safeStrength = Math.max(0, Math.min(1, Number.isFinite(strength) ? strength : 0.72));
    if (safeStrength <= 0 || pixelCount <= 0) return new Uint8ClampedArray(targetData);

    const targetBase = gaussianBlurPaddedImageData({ width, height, data: targetData }, 1.25, 3);
    const sourceBase = gaussianBlurPaddedImageData({ width, height, data: sourceData }, 1.25, 3);
    const structureGuard = buildLumaStructureGuard({ width, height, data: targetData }, 0.72);
    const output = new Uint8ClampedArray(targetData);
    const searchRadius = Math.max(6, Math.round(Math.min(width, height) / 9));

    for (let pixel = 0; pixel < pixelCount; pixel++) {
        const weight = Math.min(1, Math.max(0, weights[pixel] || 0));
        const structureFactor = Math.max(0.25, 1 - (structureGuard[pixel] || 0) * 0.72);
        const targetWeight = smoothstep(0.05, 0.32, weight) *
            (1 - smoothstep(0.74, 0.98, weight) * 0.18) *
            structureFactor;
        if (targetWeight <= 0.01) continue;

        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const idx = pixel * 4;
        const targetBaseLuma = lumaAt(targetBase, idx);
        let bestPixel = -1;
        let bestCost = Number.POSITIVE_INFINITY;

        for (let dy = -searchRadius; dy <= searchRadius; dy += 2) {
            const yy = y + dy;
            if (yy < 0 || yy >= height) continue;

            for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
                const xx = x + dx;
                if (xx < 0 || xx >= width) continue;

                const candidatePixel = yy * width + xx;
                if ((weights[candidatePixel] || 0) > 0.018) continue;

                const candidateIdx = candidatePixel * 4;
                const lumaDelta = Math.abs(lumaAt(sourceBase, candidateIdx) - targetBaseLuma);
                const distance = Math.sqrt(dx * dx + dy * dy);
                const textureEnergy = (
                    Math.abs(sourceData[candidateIdx] - sourceBase[candidateIdx]) +
                    Math.abs(sourceData[candidateIdx + 1] - sourceBase[candidateIdx + 1]) +
                    Math.abs(sourceData[candidateIdx + 2] - sourceBase[candidateIdx + 2])
                ) / 3;
                const cost = lumaDelta * 0.85 + distance * 0.35 - Math.min(18, textureEnergy) * 0.55;

                if (cost < bestCost) {
                    bestCost = cost;
                    bestPixel = candidatePixel;
                }
            }
        }

        if (bestPixel < 0) continue;

        const bestIdx = bestPixel * 4;
        const textureGain = Math.min(0.55, safeStrength * targetWeight);
        for (let c = 0; c < 3; c++) {
            const highpass = Math.max(-28, Math.min(28, sourceData[bestIdx + c] - sourceBase[bestIdx + c]));
            output[idx + c] = Math.max(0, Math.min(255, Math.round(output[idx + c] + highpass * textureGain)));
        }
    }

    return output;
}

function applyAllenkFdncnnRuntime(ctx, position, alphaMap, {
    runtime = null,
    sigma = DEFAULT_ALLENK_FDNCNN_SIGMA,
    strength = DEFAULT_EDGE_DENOISE_STRENGTH,
    padding = undefined
} = {}) {
    if (!runtime || typeof runtime.denoiseImageData !== 'function') {
        return {
            denoiseRuntimeStatus: 'unavailable',
            denoiseRuntimeReason: 'allenk FDnCNN runtime was not provided'
        };
    }

    const runtimeSize = getAllenkRuntimeInputSize(runtime);
    const prepared = prepareAllenkFdncnnRuntimeInput(ctx, position, alphaMap, {
        sigma,
        strength,
        padding,
        targetWidth: runtimeSize?.width,
        targetHeight: runtimeSize?.height
    });
    if (!prepared) {
        return {
            denoiseRuntimeStatus: 'skipped',
            denoiseRuntimeReason: 'invalid padded ROI'
        };
    }
    const denoised = runtime.denoiseImageData({
        imageData: createAllenkRuntimeInputImageData(prepared, runtimeSize),
        sigma: prepared.options.sigma
    });
    const normalizedDenoised = normalizeAllenkDenoisedRuntimeOutput(prepared, denoised);
    applyAllenkFdncnnDenoisedPatch(ctx, prepared, normalizedDenoised);

    return {
        denoiseRuntimeStatus: 'applied',
        denoiseRuntime: normalizedDenoised.runtime || runtime.id || 'allenk-fdncnn-runtime',
        denoiseRuntimeMacs: normalizedDenoised.macs ?? null,
        denoiseRuntimeRunMs: normalizedDenoised.runMs ?? null
    };
}

function prepareAllenkFdncnnRuntimeInput(ctx, position, alphaMap, {
    sigma = DEFAULT_ALLENK_FDNCNN_SIGMA,
    strength = DEFAULT_EDGE_DENOISE_STRENGTH,
    padding = undefined,
    targetWidth = null,
    targetHeight = null
} = {}) {
    const options = normalizeAllenkFdncnnOptions({ sigma, strength, padding });
    const hasFixedRuntimeSize = Number.isInteger(targetWidth) && targetWidth > 0 &&
        Number.isInteger(targetHeight) && targetHeight > 0;
    const useVirtualRoi = hasFixedRuntimeSize && Math.round(position.width) !== Math.round(position.height);
    const paddedRoi = useVirtualRoi
        ? calculateAllenkVirtualPaddedRoi({
            imageWidth: ctx.canvas.width,
            imageHeight: ctx.canvas.height,
            region: position,
            padding: options.padding,
            targetWidth,
            targetHeight
        })
        : calculateAllenkRuntimeRoi({
            imageWidth: ctx.canvas.width,
            imageHeight: ctx.canvas.height,
            region: position,
            padding: options.padding,
            targetWidth,
            targetHeight
        });
    if (!paddedRoi) return null;

    const visible = paddedRoi.visible || {
        x: paddedRoi.x,
        y: paddedRoi.y,
        width: paddedRoi.width,
        height: paddedRoi.height,
        offsetX: 0,
        offsetY: 0
    };
    const visibleImageData = ctx.getImageData(visible.x, visible.y, visible.width, visible.height);
    const padded = useVirtualRoi
        ? extractAllenkVirtualImageData({
            imageData: visibleImageData,
            imageX: visible.x,
            imageY: visible.y,
            canvasWidth: ctx.canvas.width,
            canvasHeight: ctx.canvas.height,
            roi: paddedRoi
        })
        : visibleImageData;
    const roiWeights = createAllenkGradientMask({
        alphaMap,
        width: position.width,
        height: position.height,
        strength: options.strength
    });
    const weights = embedAllenkRoiWeights({
        roiWeights,
        roiWidth: position.width,
        roiHeight: position.height,
        paddedRoi,
        blurSigma: 1
    });

    return {
        options,
        paddedRoi,
        visible,
        padded,
        weights
    };
}

function cropAllenkVisiblePatch(prepared, data) {
    const visible = prepared.visible || prepared.paddedRoi?.visible;
    const padded = prepared.padded;
    if (
        !visible ||
        !padded?.data ||
        visible.width === padded.width &&
            visible.height === padded.height &&
            visible.offsetX === 0 &&
            visible.offsetY === 0
    ) {
        if (padded?.data && data && padded.data.length === data.length) {
            padded.data.set(data);
        }
        return {
            x: prepared.paddedRoi.x,
            y: prepared.paddedRoi.y,
            imageData: padded
        };
    }

    const width = Math.max(0, Math.round(visible.width));
    const height = Math.max(0, Math.round(visible.height));
    const offsetX = Math.max(0, Math.round(visible.offsetX || 0));
    const offsetY = Math.max(0, Math.round(visible.offsetY || 0));
    const output = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const srcY = offsetY + y;
        if (srcY < 0 || srcY >= padded.height) continue;
        for (let x = 0; x < width; x++) {
            const srcX = offsetX + x;
            if (srcX < 0 || srcX >= padded.width) continue;
            const src = (srcY * padded.width + srcX) * 4;
            const dst = (y * width + x) * 4;
            output[dst] = data[src] || 0;
            output[dst + 1] = data[src + 1] || 0;
            output[dst + 2] = data[src + 2] || 0;
            output[dst + 3] = data[src + 3] ?? 255;
        }
    }

    const ImageDataCtor = typeof padded.constructor === 'function' && padded.constructor !== Object
        ? padded.constructor
        : typeof ImageData === 'function'
            ? ImageData
            : null;
    const imageData = ImageDataCtor
        ? new ImageDataCtor(output, width, height)
        : { width, height, data: output };

    return {
        x: visible.x,
        y: visible.y,
        imageData
    };
}

function applyAllenkFdncnnDenoisedPatch(ctx, prepared, denoised) {
    const originalData = new Uint8ClampedArray(prepared.padded.data);
    const blended = blendAllenkDenoisedRoi({
        originalData,
        denoisedData: denoised.imageData.data,
        weights: prepared.weights,
        width: prepared.padded.width,
        height: prepared.padded.height,
        protectStructure: true
    });

    const patch = cropAllenkVisiblePatch(prepared, blended);
    ctx.putImageData(patch.imageData, patch.x, patch.y);
}

function clonePaddedImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function cloneDenoisedResult(denoised) {
    return {
        ...denoised,
        imageData: clonePaddedImageData(denoised.imageData)
    };
}

function getImageDataLumaChangeScore(current, previous) {
    if (
        !current?.data ||
        !previous?.data ||
        current.width !== previous.width ||
        current.height !== previous.height ||
        current.data.length !== previous.data.length
    ) {
        return Infinity;
    }

    let sum = 0;
    let count = 0;
    const currentData = current.data;
    const previousData = previous.data;
    for (let i = 0; i < currentData.length; i += 16) {
        const currentLuma = 0.2126 * currentData[i] + 0.7152 * currentData[i + 1] + 0.0722 * currentData[i + 2];
        const previousLuma = 0.2126 * previousData[i] + 0.7152 * previousData[i + 1] + 0.0722 * previousData[i + 2];
        sum += Math.abs(currentLuma - previousLuma);
        count++;
    }
    return count > 0 ? sum / count : Infinity;
}

function resolveAllenkTemporalReuseConfig(config = null) {
    if (!config || config.enabled === false) {
        return null;
    }
    const maxFrames = Number.isFinite(config.maxFrames)
        ? Math.max(0, Math.round(config.maxFrames))
        : 0;
    if (maxFrames <= 0) return null;
    return {
        maxFrames,
        threshold: Number.isFinite(config.threshold)
            ? Math.max(0, config.threshold)
            : DEFAULT_ALLENK_FDNCNN_REUSE_THRESHOLD
    };
}

async function applyAllenkFdncnnRuntimeAsync(ctx, position, alphaMap, {
    runtime = null,
    sigma = DEFAULT_ALLENK_FDNCNN_SIGMA,
    strength = DEFAULT_EDGE_DENOISE_STRENGTH,
    padding = undefined,
    temporalReuse = null,
    frameCache = null
} = {}) {
    if (!runtime || typeof runtime.denoiseImageData !== 'function') {
        return {
            denoiseRuntimeStatus: 'unavailable',
            denoiseRuntimeReason: 'allenk FDnCNN runtime was not provided'
        };
    }

    const runtimeSize = getAllenkRuntimeInputSize(runtime);
    const prepared = prepareAllenkFdncnnRuntimeInput(ctx, position, alphaMap, {
        sigma,
        strength,
        padding,
        targetWidth: runtimeSize?.width,
        targetHeight: runtimeSize?.height
    });
    if (!prepared) {
        return {
            denoiseRuntimeStatus: 'skipped',
            denoiseRuntimeReason: 'invalid padded ROI'
        };
    }
    const reuseConfig = resolveAllenkTemporalReuseConfig(temporalReuse);
    const cacheInput = reuseConfig && frameCache ? clonePaddedImageData(prepared.padded) : null;
    if (reuseConfig && frameCache?.denoised && frameCache?.previousInput) {
        const changeScore = getImageDataLumaChangeScore(prepared.padded, frameCache.previousInput);
        const reuseCount = Number.isFinite(frameCache.reuseCount) ? frameCache.reuseCount : 0;
        if (reuseCount < reuseConfig.maxFrames && changeScore <= reuseConfig.threshold) {
            applyAllenkFdncnnDenoisedPatch(ctx, prepared, frameCache.denoised);
            frameCache.previousInput = cacheInput;
            frameCache.reuseCount = reuseCount + 1;
            return {
                denoiseRuntimeStatus: 'reused',
                denoiseRuntime: `${frameCache.denoised.runtime || runtime.id || 'allenk-fdncnn-runtime'}+temporal-cache`,
                denoiseRuntimeMacs: 0,
                denoiseRuntimeRunMs: 0,
                denoiseRuntimeChangeScore: changeScore,
                denoiseRuntimeReuseCount: frameCache.reuseCount
            };
        }
    }
    const denoised = await runtime.denoiseImageData({
        imageData: createAllenkRuntimeInputImageData(prepared, runtimeSize),
        sigma: prepared.options.sigma
    });
    const normalizedDenoised = normalizeAllenkDenoisedRuntimeOutput(prepared, denoised);
    applyAllenkFdncnnDenoisedPatch(ctx, prepared, normalizedDenoised);
    if (reuseConfig && frameCache) {
        frameCache.previousInput = cacheInput;
        frameCache.denoised = cloneDenoisedResult(normalizedDenoised);
        frameCache.reuseCount = 0;
    }

    return {
        denoiseRuntimeStatus: 'applied',
        denoiseRuntime: normalizedDenoised.runtime || runtime.id || 'allenk-fdncnn-runtime',
        denoiseRuntimeMacs: normalizedDenoised.macs ?? null,
        denoiseRuntimeRunMs: normalizedDenoised.runMs ?? null
    };
}

export function applyVideoResidualCleanup(ctx, position, alphaMap, options = {}) {
    const normalized = normalizeVideoCleanupOptions(options);
    const deferResidualCleanup = normalized.denoiseBackend === VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE;

    if (normalized.residualCleanupStrength > 0 && !deferResidualCleanup) {
        applySoftResidualCleanup(ctx, position, alphaMap, {
            strength: normalized.residualCleanupStrength,
            highQuality: normalized.highQualityCleanup
        });
    }

    if (normalized.denoiseBackend === VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_DENOISE) {
        applyEdgeDenoise(ctx, position, alphaMap, {
            strength: normalized.edgeDenoiseStrength
        });
    } else if (normalized.denoiseBackend === VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_BAND_DENOISE) {
        applyEdgeBandDenoise(ctx, position, alphaMap, {
            strength: normalized.edgeDenoiseStrength
        });
    } else if (normalized.denoiseBackend === VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_CORE_DENOISE) {
        applyEdgeCoreDenoise(ctx, position, alphaMap, {
            strength: normalized.edgeDenoiseStrength
        });
    } else if (normalized.denoiseBackend === VIDEO_DENOISE_BACKENDS.CANVAS_FOOTPRINT_POLISH) {
        applyFootprintPolish(ctx, position, alphaMap, {
            strength: normalized.edgeDenoiseStrength
        });
    } else if (normalized.denoiseBackend === VIDEO_DENOISE_BACKENDS.CANVAS_TEXTURE_REPAIR) {
        applyTextureRepair(ctx, position, alphaMap, {
            strength: normalized.textureRepairStrength
        });
    } else if (normalized.denoiseBackend === VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE) {
        Object.assign(normalized, applyAllenkFdncnnRuntime(ctx, position, alphaMap, {
            runtime: normalized.allenkFdncnnRuntime,
            sigma: normalized.allenkFdncnnSigma,
            strength: normalized.edgeDenoiseStrength,
            padding: normalized.allenkFdncnnPadding
        }));
    }

    if (normalized.residualCleanupStrength > 0 && deferResidualCleanup) {
        applySoftResidualCleanup(ctx, position, alphaMap, {
            strength: normalized.residualCleanupStrength,
            highQuality: normalized.highQualityCleanup,
            protectStructure: true
        });
    }

    return normalized;
}

export async function applyVideoResidualCleanupAsync(ctx, position, alphaMap, options = {}) {
    const normalized = normalizeVideoCleanupOptions(options);

    if (normalized.denoiseBackend !== VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE) {
        return applyVideoResidualCleanup(ctx, position, alphaMap, options);
    }

    Object.assign(normalized, await applyAllenkFdncnnRuntimeAsync(ctx, position, alphaMap, {
        runtime: normalized.allenkFdncnnRuntime,
        sigma: normalized.allenkFdncnnSigma,
        strength: normalized.edgeDenoiseStrength,
        padding: normalized.allenkFdncnnPadding,
        temporalReuse: normalized.allenkFdncnnTemporalReuse,
        frameCache: normalized.allenkFdncnnFrameCache
    }));

    if (normalized.residualCleanupStrength > 0) {
        applySoftResidualCleanup(ctx, position, alphaMap, {
            strength: normalized.residualCleanupStrength,
            highQuality: normalized.highQualityCleanup,
            protectStructure: true
        });
    }

    return normalized;
}

export {
    borrowCleanHighpassTexture,
    buildLumaStructureGuard,
    CLEANUP_BUSY_TEXTURE_RMS,
    CLEANUP_FLAT_TEXTURE_RMS,
    DEFAULT_DENOISE_BACKEND,
    DEFAULT_EDGE_DENOISE_STRENGTH,
    DEFAULT_HIGH_QUALITY_CLEANUP,
    DEFAULT_RESIDUAL_CLEANUP_STRENGTH,
    DEFAULT_TEXTURE_REPAIR,
    DEFAULT_TEXTURE_REPAIR_STRENGTH,
    VIDEO_CLEANUP_BACKENDS,
    VIDEO_DENOISE_BACKENDS
};

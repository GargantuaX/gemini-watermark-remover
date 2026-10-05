import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CLEANUP_BUSY_TEXTURE_RMS,
    CLEANUP_FLAT_TEXTURE_RMS,
    DEFAULT_DENOISE_BACKEND,
    DEFAULT_EDGE_DENOISE_STRENGTH,
    DEFAULT_HIGH_QUALITY_CLEANUP,
    DEFAULT_RESIDUAL_CLEANUP_STRENGTH,
    DEFAULT_TEXTURE_REPAIR,
    DEFAULT_TEXTURE_REPAIR_STRENGTH,
    VIDEO_CLEANUP_BACKENDS,
    VIDEO_DENOISE_BACKENDS,
    applyVideoResidualCleanup,
    applyVideoResidualCleanupAsync,
    borrowCleanHighpassTexture,
    buildEdgeBandDenoiseWeightMap,
    buildFootprintPolishWeightMap,
    buildGradientWeightMap,
    buildLumaStructureGuard,
    buildTextureRepairWeightMap,
    measureSurroundingTextureRms,
    normalizeVideoCleanupOptions,
    resolveContentTextureGate
} from '../../src/video/videoCleanupBackends.js';
import { resolveAllenkFdncnnRuntimeProfile } from '../../src/video/videoDenoiseRuntimePolicy.js';
import { resolveVideoWatermarkCandidates } from '../../src/video/videoWatermarkCatalog.js';
import { getVideoAlphaMap } from '../../src/video/videoWatermarkDetector.js';

function createDiamondAlphaMap(width, height) {
    const alphaMap = new Float32Array(width * height);
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const radius = Math.min(width, height) / 2;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const distance = (Math.abs(x - cx) + Math.abs(y - cy)) / radius;
            alphaMap[y * width + x] = Math.max(0, 0.28 * (1 - distance));
        }
    }

    return alphaMap;
}

test('normalizeVideoCleanupOptions should keep conservative defaults', () => {
    const normalized = normalizeVideoCleanupOptions();

    assert.equal(normalized.residualCleanupStrength, DEFAULT_RESIDUAL_CLEANUP_STRENGTH);
    assert.equal(normalized.cleanupBackend, VIDEO_CLEANUP_BACKENDS.CANVAS_SOFT);
    assert.equal(normalized.highQualityCleanup, DEFAULT_HIGH_QUALITY_CLEANUP);
    assert.equal(normalized.denoiseBackend, DEFAULT_DENOISE_BACKEND);
    assert.equal(normalized.edgeDenoiseStrength, DEFAULT_EDGE_DENOISE_STRENGTH);
    assert.equal(normalized.textureRepair, DEFAULT_TEXTURE_REPAIR);
    assert.equal(normalized.textureRepairStrength, DEFAULT_TEXTURE_REPAIR_STRENGTH);
    assert.equal(VIDEO_CLEANUP_BACKENDS.CANVAS_SOFT, 'canvas-soft');
    assert.equal(VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE, 'allenk-fdncnn-browser-spike');
    assert.equal(VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_BAND_DENOISE, 'canvas-edge-band-denoise');
    assert.equal(VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_CORE_DENOISE, 'canvas-edge-core-denoise');
    assert.equal(VIDEO_DENOISE_BACKENDS.CANVAS_FOOTPRINT_POLISH, 'canvas-footprint-polish');
    assert.equal(VIDEO_DENOISE_BACKENDS.CANVAS_TEMPORAL_DELTA_STABILIZE, 'canvas-temporal-delta-stabilize');
    assert.equal(VIDEO_DENOISE_BACKENDS.CANVAS_TEMPORAL_MATCH_DELTA_STABILIZE, 'canvas-temporal-match-delta-stabilize');
    assert.equal(VIDEO_DENOISE_BACKENDS.CANVAS_TEMPORAL_STABILIZE, 'canvas-temporal-stabilize');
    assert.equal(VIDEO_DENOISE_BACKENDS.CANVAS_TEXTURE_REPAIR, 'canvas-texture-repair');
});

test('normalizeVideoCleanupOptions should clamp numeric cleanup controls', () => {
    assert.deepEqual(
        normalizeVideoCleanupOptions({
            residualCleanupStrength: 9,
            highQualityCleanup: true,
            textureRepair: true,
            textureRepairStrength: 2
        }),
        {
            residualCleanupStrength: 1.8,
            cleanupBackend: 'canvas-bilateral',
            highQualityCleanup: true,
            denoiseBackend: 'canvas-texture-repair',
            edgeDenoiseStrength: DEFAULT_EDGE_DENOISE_STRENGTH,
            textureRepair: true,
            textureRepairStrength: 1
        }
    );
});

test('normalizeVideoCleanupOptions should prefer explicit denoise backend over legacy texture flag', () => {
    assert.equal(
        normalizeVideoCleanupOptions({
            denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_TEXTURE_REPAIR,
            textureRepair: false
        }).textureRepair,
        true
    );
    assert.equal(
        normalizeVideoCleanupOptions({
            denoiseBackend: VIDEO_DENOISE_BACKENDS.NONE,
            textureRepair: true
        }).textureRepair,
        false
    );
    const edgeDenoise = normalizeVideoCleanupOptions({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_DENOISE,
        textureRepair: true,
        edgeDenoiseStrength: 2
    });

    assert.equal(edgeDenoise.denoiseBackend, VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_DENOISE);
    assert.equal(edgeDenoise.edgeDenoiseStrength, 1);
    assert.equal(edgeDenoise.textureRepair, false);
    assert.equal(
        normalizeVideoCleanupOptions({
            denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_BAND_DENOISE
        }).denoiseBackend,
        VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_BAND_DENOISE
    );
});

test('allenk FDnCNN browser spike backend should be accepted but fail closed without runtime', () => {
    const normalized = normalizeVideoCleanupOptions({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: 1.8
    });

    assert.equal(normalized.denoiseBackend, VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE);
    assert.equal(normalized.edgeDenoiseStrength, 1.8);
    assert.equal(normalized.denoiseRuntimeStatus, 'unavailable');
    assert.match(normalized.denoiseRuntimeReason, /browser GPU inference runtime/);
});

test('applyVideoResidualCleanup should keep Veo text FDnCNN ROI at runtime size and write visible pixels only', () => {
    const position = { x: 682, y: 1254, width: 23, height: 10 };
    const alphaMap = new Float32Array(position.width * position.height).fill(0.18);
    const calls = [];
    const writes = [];
    const runtime = {
        id: 'allenk-fdncnn-86x74-test',
        inputShape: [1, 4, 74, 86],
        denoiseImageData({ imageData, sigma }) {
            calls.push({ width: imageData.width, height: imageData.height, sigma });
            return {
                runtime: 'allenk-fdncnn-86x74-test',
                imageData: {
                    width: imageData.width,
                    height: imageData.height,
                    data: new Uint8ClampedArray(imageData.data)
                }
            };
        }
    };
    const ctx = {
        canvas: { width: 720, height: 1280 },
        getImageData(x, y, width, height) {
            assert.ok(x >= 0);
            assert.ok(y >= 0);
            assert.ok(x + width <= this.canvas.width);
            assert.ok(y + height <= this.canvas.height);
            return {
                width,
                height,
                data: new Uint8ClampedArray(width * height * 4).fill(128)
            };
        },
        putImageData(imageData, x, y) {
            assert.ok(x >= 0);
            assert.ok(y >= 0);
            assert.ok(x + imageData.width <= this.canvas.width);
            assert.ok(y + imageData.height <= this.canvas.height);
            writes.push({ x, y, width: imageData.width, height: imageData.height });
        }
    };

    const result = applyVideoResidualCleanup(ctx, position, alphaMap, {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: 1,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnSigma: 20,
        allenkFdncnnPadding: 32
    });

    assert.equal(result.denoiseRuntimeStatus, 'applied');
    assert.deepEqual(calls, [{ width: 86, height: 74, sigma: 20 }]);
    assert.deepEqual(writes, [{ x: 650, y: 1222, width: 70, height: 58 }]);
});

test('buildLumaStructureGuard should protect strong image edges', () => {
    const width = 9;
    const height = 5;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const value = x < 4 ? 32 : 220;
            data[idx] = value;
            data[idx + 1] = value;
            data[idx + 2] = value;
            data[idx + 3] = 255;
        }
    }

    const guard = buildLumaStructureGuard({ width, height, data });
    const edge = guard[2 * width + 4];
    const flat = guard[2 * width + 0];

    assert.ok(edge > 0.6, `edge=${edge}`);
    assert.ok(flat < 0.12, `flat=${flat}`);
});

test('borrowCleanHighpassTexture should borrow texture only from clean low-weight neighbors', () => {
    const width = 9;
    const height = 5;
    const source = new Uint8ClampedArray(width * height * 4);
    const target = new Uint8ClampedArray(width * height * 4);
    const weights = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const cleanTexture = x < 3 ? (x + y) % 2 === 0 ? 116 : 84 : 100;
            source[idx] = cleanTexture;
            source[idx + 1] = cleanTexture;
            source[idx + 2] = cleanTexture;
            source[idx + 3] = 255;
            target[idx] = 100;
            target[idx + 1] = 100;
            target[idx + 2] = 100;
            target[idx + 3] = 255;
            weights[y * width + x] = x >= 5 ? 0.5 : 0;
        }
    }

    const output = borrowCleanHighpassTexture({
        targetData: target,
        sourceData: source,
        weights,
        width,
        height,
        strength: 1
    });

    const texturedPixel = (2 * width + 6) * 4;
    const cleanPixel = (2 * width + 1) * 4;

    assert.notEqual(output[texturedPixel], target[texturedPixel]);
    assert.equal(output[cleanPixel], target[cleanPixel]);
});

test('allenk FDnCNN browser spike backend should accept an injected runtime', () => {
    const runtime = { denoiseImageData() {} };
    const normalized = normalizeVideoCleanupOptions({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnSigma: 75,
        allenkFdncnnPadding: 0
    });

    assert.equal(normalized.denoiseBackend, VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE);
    assert.equal(normalized.allenkFdncnnRuntime, runtime);
    assert.equal(normalized.allenkFdncnnSigma, 75);
    assert.equal(normalized.allenkFdncnnPadding, 0);
    assert.equal(normalized.denoiseRuntimeStatus, 'available');
});

test('buildGradientWeightMap should emphasize alpha edges', () => {
    const width = 7;
    const height = 7;
    const alphaMap = createDiamondAlphaMap(width, height);
    const weights = buildGradientWeightMap(alphaMap, width, height, 1.5);
    const center = weights[3 * width + 3];
    const edge = weights[2 * width + 3];

    assert.equal(weights.length, width * height);
    assert.ok(edge > 0);
    assert.ok(Math.max(...weights) <= 1);
    assert.ok(edge >= center);
});

test('buildGradientWeightMap should include crop-boundary alpha edges', () => {
    const width = 3;
    const height = 3;
    const alphaMap = new Float32Array([
        0, 1, 0,
        0, 0, 0,
        0, 0, 0
    ]);
    const weights = buildGradientWeightMap(alphaMap, width, height, 1);

    assert.ok(weights[1] > 0);
    assert.ok(Math.max(...weights) <= 1);
});

test('buildEdgeBandDenoiseWeightMap should include crop-boundary alpha edges', () => {
    const width = 3;
    const height = 3;
    const alphaMap = new Float32Array([
        0, 1, 0,
        0, 0, 0,
        0, 0, 0
    ]);
    const weights = buildEdgeBandDenoiseWeightMap(alphaMap, width, height, 1);

    assert.ok(weights[1] > 0);
    assert.ok(Math.max(...weights) <= 1);
});

test('buildTextureRepairWeightMap should remain disabled at zero strength', () => {
    const width = 7;
    const height = 7;
    const alphaMap = createDiamondAlphaMap(width, height);
    const weights = buildTextureRepairWeightMap(alphaMap, width, height, 0);

    assert.equal(weights.length, width * height);
    assert.equal(Math.max(...weights), 0);
});

test('buildEdgeBandDenoiseWeightMap should guard high-alpha body pixels', () => {
    const width = 72;
    const height = 72;
    const alphaMap = getVideoAlphaMap(width);
    const gradientWeights = buildGradientWeightMap(alphaMap, width, height, 1);
    const bandWeights = buildEdgeBandDenoiseWeightMap(alphaMap, width, height, 1);
    const center = 36 * width + 36;
    const edge = 0 * width + 36;

    assert.equal(bandWeights.length, width * height);
    assert.ok(bandWeights[edge] > bandWeights[center]);
    assert.ok(bandWeights[center] < gradientWeights[center]);
    assert.ok(Math.max(...bandWeights) <= 1);
});

test('buildEdgeBandDenoiseWeightMap should remain disabled at zero strength', () => {
    const width = 7;
    const height = 7;
    const alphaMap = createDiamondAlphaMap(width, height);
    const weights = buildEdgeBandDenoiseWeightMap(alphaMap, width, height, 0);

    assert.equal(weights.length, width * height);
    assert.equal(Math.max(...weights), 0);
});

test('buildTextureRepairWeightMap should activate inside alpha footprint', () => {
    const width = 7;
    const height = 7;
    const alphaMap = createDiamondAlphaMap(width, height);
    const weights = buildTextureRepairWeightMap(alphaMap, width, height, 0.85);

    assert.equal(weights.length, width * height);
    assert.ok(weights[3 * width + 3] > 0);
    assert.ok(Math.max(...weights) <= 1);
});

test('buildFootprintPolishWeightMap should cover alpha body and edges conservatively', () => {
    const width = 72;
    const height = 72;
    const alphaMap = getVideoAlphaMap(width);
    const weights = buildFootprintPolishWeightMap(alphaMap, width, height, 0.65);
    const center = 36 * width + 36;
    const edge = 0 * width + 36;

    assert.equal(weights.length, width * height);
    assert.ok(weights[center] > 0);
    assert.ok(weights[edge] > 0);
    assert.ok(Math.max(...weights) <= 1);
});

test('applyVideoResidualCleanup should not touch canvas when cleanup is disabled', () => {
    const ctx = {
        canvas: { width: 16, height: 16 },
        getImageData() {
            throw new Error('getImageData should not be called');
        },
        putImageData() {
            throw new Error('putImageData should not be called');
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 4,
        y: 4,
        width: 4,
        height: 4
    }, new Float32Array(16), {
        residualCleanupStrength: 0,
        textureRepair: false
    });

    assert.equal(result.residualCleanupStrength, 0);
    assert.equal(result.textureRepair, false);
});

test('applyVideoResidualCleanup should not touch canvas for allenk FDnCNN before runtime is wired', () => {
    const ctx = {
        canvas: { width: 16, height: 16 },
        getImageData() {
            throw new Error('getImageData should not be called');
        },
        putImageData() {
            throw new Error('putImageData should not be called');
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 4,
        y: 4,
        width: 4,
        height: 4
    }, new Float32Array(16), {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE
    });

    assert.equal(result.denoiseBackend, VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE);
    assert.equal(result.denoiseRuntimeStatus, 'unavailable');
});

test('applyVideoResidualCleanup should run injected allenk FDnCNN runtime on the padded ROI', () => {
    const source = {
        width: 16,
        height: 16,
        data: new Uint8ClampedArray(16 * 16 * 4)
    };
    for (let i = 0; i < source.data.length; i += 4) {
        source.data[i] = 40;
        source.data[i + 1] = 50;
        source.data[i + 2] = 60;
        source.data[i + 3] = 255;
    }

    let putCalls = 0;
    let runtimeCalls = 0;
    let written = null;
    const runtime = {
        id: 'fake-allenk-runtime',
        denoiseImageData({ imageData, sigma }) {
            runtimeCalls++;
            assert.equal(sigma, 75);
            const data = new Uint8ClampedArray(imageData.data);
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 220;
            }
            return {
                runtime: 'fake-allenk-runtime',
                macs: 1234,
                imageData: {
                    width: imageData.width,
                    height: imageData.height,
                    data
                }
            };
        }
    };
    const ctx = {
        canvas: { width: source.width, height: source.height },
        getImageData(x, y, width, height) {
            assert.equal(x, 0);
            assert.equal(y, 0);
            assert.equal(width, 16);
            assert.equal(height, 16);
            return {
                width: source.width,
                height: source.height,
                data: new Uint8ClampedArray(source.data)
            };
        },
        putImageData(imageData, x, y) {
            putCalls++;
            assert.equal(x, 0);
            assert.equal(y, 0);
            written = imageData;
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 4,
        y: 4,
        width: 8,
        height: 8
    }, createDiamondAlphaMap(8, 8), {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: 1,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnSigma: 75
    });

    assert.equal(runtimeCalls, 1);
    assert.equal(putCalls, 1);
    assert.equal(result.denoiseRuntimeStatus, 'applied');
    assert.equal(result.denoiseRuntime, 'fake-allenk-runtime');
    assert.equal(result.denoiseRuntimeMacs, 1234);
    assert.ok(written.data.some((value, index) => index % 4 === 0 && value > 40));
});

test('applyVideoResidualCleanup should protect background transitions from Allenk dark artifacts', () => {
    const width = 8;
    const height = 6;
    const source = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const value = x < 4 ? 64 : 184;
            source.data[idx] = value;
            source.data[idx + 1] = value;
            source.data[idx + 2] = value;
            source.data[idx + 3] = 255;
        }
    }

    const alphaMap = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        alphaMap[y * width + 3] = 0.28;
        alphaMap[y * width + 4] = 0.28;
    }

    let written = null;
    const runtime = {
        id: 'dark-artifact-runtime',
        denoiseImageData({ imageData }) {
            const data = new Uint8ClampedArray(imageData.data);
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 20;
                data[i + 1] = 20;
                data[i + 2] = 20;
            }
            return {
                runtime: 'dark-artifact-runtime',
                imageData: {
                    width: imageData.width,
                    height: imageData.height,
                    data
                }
            };
        }
    };
    const ctx = {
        canvas: { width, height },
        getImageData(x, y, w, h) {
            assert.equal(x, 0);
            assert.equal(y, 0);
            assert.equal(w, width);
            assert.equal(h, height);
            return {
                width,
                height,
                data: new Uint8ClampedArray(source.data)
            };
        },
        putImageData(imageData, x, y) {
            assert.equal(x, 0);
            assert.equal(y, 0);
            written = imageData;
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 0,
        y: 0,
        width,
        height
    }, alphaMap, {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: 1,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnPadding: 0
    });

    assert.equal(result.denoiseRuntimeStatus, 'applied');
    const flatPixel = (3 * width + 2) * 4;
    const transitionPixel = (3 * width + 4) * 4;
    assert.ok(written.data[flatPixel] < source.data[flatPixel] - 8, `flat=${written.data[flatPixel]}`);
    assert.ok(
        written.data[transitionPixel] > source.data[transitionPixel] - 28,
        `transition=${written.data[transitionPixel]}, source=${source.data[transitionPixel]}`
    );
});

test('applyVideoResidualCleanup should expand small video ROIs to the fixed allenk runtime shape', () => {
    let runtimeCalls = 0;
    let written = null;
    const runtime = {
        id: 'fixed-shape-allenk-runtime',
        inputShape: [1, 4, 200, 200],
        denoiseImageData({ imageData, sigma }) {
            runtimeCalls++;
            assert.equal(sigma, 75);
            assert.equal(imageData.width, 200);
            assert.equal(imageData.height, 200);
            return {
                runtime: 'fixed-shape-allenk-runtime',
                imageData: {
                    width: imageData.width,
                    height: imageData.height,
                    data: new Uint8ClampedArray(imageData.data)
                }
            };
        }
    };
    const ctx = {
        canvas: { width: 1280, height: 720 },
        getImageData(x, y, width, height) {
            assert.equal(x, 1080);
            assert.equal(y, 520);
            assert.equal(width, 200);
            assert.equal(height, 200);
            return {
                width,
                height,
                data: new Uint8ClampedArray(width * height * 4).fill(128)
            };
        },
        putImageData(imageData, x, y) {
            assert.equal(x, 1080);
            assert.equal(y, 520);
            written = imageData;
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 1160,
        y: 600,
        width: 48,
        height: 48
    }, createDiamondAlphaMap(48, 48), {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: 1,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnSigma: 75,
        allenkFdncnnPadding: 64
    });

    assert.equal(runtimeCalls, 1);
    assert.equal(result.denoiseRuntimeStatus, 'applied');
    assert.equal(written.width, 200);
    assert.equal(written.height, 200);
});

test('applyVideoResidualCleanup should resize undersized canvas ROIs for fixed-shape allenk runtimes', () => {
    let runtimeCalls = 0;
    let written = null;
    const runtime = {
        id: 'resizing-allenk-runtime',
        inputShape: [1, 4, 200, 200],
        denoiseImageData({ imageData }) {
            runtimeCalls++;
            assert.equal(imageData.width, 200);
            assert.equal(imageData.height, 200);
            return {
                runtime: 'resizing-allenk-runtime',
                imageData: {
                    width: imageData.width,
                    height: imageData.height,
                    data: new Uint8ClampedArray(imageData.data)
                }
            };
        }
    };
    const ctx = {
        canvas: { width: 120, height: 100 },
        getImageData(x, y, width, height) {
            assert.equal(x, 0);
            assert.equal(y, 0);
            assert.equal(width, 120);
            assert.equal(height, 100);
            const data = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 90;
                data[i + 1] = 100;
                data[i + 2] = 110;
                data[i + 3] = 255;
            }
            return { width, height, data };
        },
        putImageData(imageData, x, y) {
            assert.equal(x, 0);
            assert.equal(y, 0);
            written = imageData;
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 35,
        y: 30,
        width: 48,
        height: 48
    }, createDiamondAlphaMap(48, 48), {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: 1,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnPadding: 64
    });

    assert.equal(runtimeCalls, 1);
    assert.equal(result.denoiseRuntimeStatus, 'applied');
    assert.equal(written.width, 120);
    assert.equal(written.height, 100);
});

test('applyVideoResidualCleanup should feed fixed-shape ONNX inputs for every video catalog position type', () => {
    const cases = [
        { label: '1080p reference', width: 1920, height: 1080 },
        { label: '720p explicit', width: 1280, height: 720 },
        { label: 'scaled down landscape', width: 960, height: 540 },
        { label: 'scaled portrait', width: 720, height: 1280 },
        { label: 'scaled up 4k', width: 3840, height: 2160 },
        { label: 'oversized 8k', width: 7680, height: 4320 },
        { label: 'tiny square', width: 96, height: 96 },
        { label: 'tiny landscape', width: 80, height: 64 }
    ];
    const covered = new Set();

    for (const testCase of cases) {
        const candidates = resolveVideoWatermarkCandidates(testCase.width, testCase.height);
        assert.ok(candidates.length > 0, `${testCase.label} should expose video watermark candidates`);

        for (const candidate of candidates) {
            const profile = resolveAllenkFdncnnRuntimeProfile(candidate);
            const expectedWidth = profile.inputShape[3];
            const expectedHeight = profile.inputShape[2];
            let runtimeCalls = 0;
            const writes = [];
            const runtime = {
                id: profile.id,
                inputShape: profile.inputShape,
                outputShape: profile.outputShape,
                denoiseImageData({ imageData }) {
                    runtimeCalls++;
                    assert.equal(
                        imageData.width,
                        expectedWidth,
                        `${testCase.label} ${candidate.id} runtime width`
                    );
                    assert.equal(
                        imageData.height,
                        expectedHeight,
                        `${testCase.label} ${candidate.id} runtime height`
                    );
                    return {
                        runtime: profile.id,
                        imageData: {
                            width: imageData.width,
                            height: imageData.height,
                            data: new Uint8ClampedArray(imageData.data)
                        }
                    };
                }
            };
            const ctx = {
                canvas: { width: testCase.width, height: testCase.height },
                getImageData(x, y, width, height) {
                    assert.ok(x >= 0, `${testCase.label} ${candidate.id} ROI x`);
                    assert.ok(y >= 0, `${testCase.label} ${candidate.id} ROI y`);
                    assert.ok(x + width <= testCase.width, `${testCase.label} ${candidate.id} ROI width`);
                    assert.ok(y + height <= testCase.height, `${testCase.label} ${candidate.id} ROI height`);

                    const data = new Uint8ClampedArray(width * height * 4);
                    for (let i = 0; i < data.length; i += 4) {
                        data[i] = 96;
                        data[i + 1] = 112;
                        data[i + 2] = 128;
                        data[i + 3] = 255;
                    }
                    return { width, height, data };
                },
                putImageData(imageData, x, y) {
                    assert.ok(x >= 0, `${testCase.label} ${candidate.id} write x`);
                    assert.ok(y >= 0, `${testCase.label} ${candidate.id} write y`);
                    assert.ok(x + imageData.width <= testCase.width, `${testCase.label} ${candidate.id} write width`);
                    assert.ok(y + imageData.height <= testCase.height, `${testCase.label} ${candidate.id} write height`);
                    writes.push({ x, y, width: imageData.width, height: imageData.height });
                }
            };

            const result = applyVideoResidualCleanup(ctx, candidate, getVideoAlphaMap(candidate.size, { candidate }), {
                residualCleanupStrength: 0,
                denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
                edgeDenoiseStrength: 1,
                allenkFdncnnRuntime: runtime,
                allenkFdncnnPadding: profile.padding
            });

            assert.equal(runtimeCalls, 1, `${testCase.label} ${candidate.id} runtime calls`);
            assert.equal(result.denoiseRuntimeStatus, 'applied', `${testCase.label} ${candidate.id} status`);
            assert.equal(writes.length, 1, `${testCase.label} ${candidate.id} writes`);
            covered.add(`${candidate.id}:${profile.id}`);
        }
    }

    assert.ok(covered.has('veo-1080p-standard:allenk-fdncnn-200'));
    assert.ok(covered.has('veo-1080p-inset:allenk-fdncnn-200'));
    assert.ok(covered.has('veo-720p-3-inset:allenk-fdncnn-104'));
    assert.ok(covered.has('veo-720p-1-standard:allenk-fdncnn-104'));
    assert.ok(covered.has('veo-720p-2-compact:allenk-fdncnn-104'));
    assert.ok(covered.has('veo-1080p-standard:allenk-fdncnn-104'));
    assert.ok(covered.has('veo-1080p-inset:allenk-fdncnn-104'));
});

test('applyVideoResidualCleanupAsync should await injected allenk FDnCNN runtime', async () => {
    const source = {
        width: 8,
        height: 8,
        data: new Uint8ClampedArray(8 * 8 * 4)
    };
    for (let i = 0; i < source.data.length; i += 4) {
        source.data[i] = 40;
        source.data[i + 1] = 50;
        source.data[i + 2] = 60;
        source.data[i + 3] = 255;
    }

    let written = null;
    const runtime = {
        id: 'async-allenk-runtime',
        async denoiseImageData({ imageData, sigma }) {
            assert.equal(sigma, 25);
            assert.equal(imageData.width, 4);
            assert.equal(imageData.height, 4);
            const data = new Uint8ClampedArray(imageData.data);
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 240;
            }
            return {
                runtime: 'async-allenk-runtime',
                macs: 4321,
                runMs: 12.5,
                imageData: {
                    width: imageData.width,
                    height: imageData.height,
                    data
                }
            };
        }
    };
    const ctx = {
        canvas: { width: source.width, height: source.height },
        getImageData(x, y, width, height) {
            assert.equal(x, 2);
            assert.equal(y, 2);
            assert.equal(width, 4);
            assert.equal(height, 4);
            const data = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 40;
                data[i + 1] = 50;
                data[i + 2] = 60;
                data[i + 3] = 255;
            }
            return { width, height, data };
        },
        putImageData(imageData, x, y) {
            assert.equal(x, 2);
            assert.equal(y, 2);
            written = imageData;
        }
    };

    const result = await applyVideoResidualCleanupAsync(ctx, {
        x: 2,
        y: 2,
        width: 4,
        height: 4
    }, createDiamondAlphaMap(4, 4), {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: 1,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnSigma: 25,
        allenkFdncnnPadding: 0
    });

    assert.equal(result.denoiseRuntimeStatus, 'applied');
    assert.equal(result.denoiseRuntime, 'async-allenk-runtime');
    assert.equal(result.denoiseRuntimeMacs, 4321);
    assert.equal(result.denoiseRuntimeRunMs, 12.5);
    assert.equal(written.width, 4);
    assert.equal(written.height, 4);
});

test('applyVideoResidualCleanupAsync should run allenk FDnCNN before residual cleanup polish', async () => {
    const events = [];
    const runtime = {
        id: 'ordered-allenk-runtime',
        async denoiseImageData({ imageData }) {
            events.push('runtime');
            return {
                runtime: 'ordered-allenk-runtime',
                imageData: {
                    width: imageData.width,
                    height: imageData.height,
                    data: new Uint8ClampedArray(imageData.data)
                }
            };
        }
    };
    const ctx = {
        canvas: { width: 8, height: 8 },
        getImageData(x, y, width, height) {
            events.push(x === 2 && y === 2 && width === 4 && height === 4 ? 'get-ai-roi' : 'get-polish-roi');
            const data = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 80;
                data[i + 1] = 90;
                data[i + 2] = 100;
                data[i + 3] = 255;
            }
            return { width, height, data };
        },
        putImageData(_imageData, x, y) {
            events.push(x === 2 && y === 2 ? 'put-ai-roi' : 'put-polish-roi');
        }
    };

    const result = await applyVideoResidualCleanupAsync(ctx, {
        x: 2,
        y: 2,
        width: 4,
        height: 4
    }, createDiamondAlphaMap(4, 4), {
        residualCleanupStrength: 1.5,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: 1,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnPadding: 0
    });

    assert.equal(result.denoiseRuntimeStatus, 'applied');
    assert.deepEqual(events, ['get-ai-roi', 'runtime', 'put-ai-roi', 'get-polish-roi', 'put-polish-roi']);
});

test('applyVideoResidualCleanup should route canvas edge denoise backend', () => {
    const image = {
        width: 20,
        height: 20,
        data: new Uint8ClampedArray(20 * 20 * 4)
    };
    for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 80 + ((i / 4) % 20);
        image.data[i + 1] = 90;
        image.data[i + 2] = 100;
        image.data[i + 3] = 255;
    }

    let putCalls = 0;
    const ctx = {
        canvas: { width: 20, height: 20 },
        getImageData() {
            return {
                width: image.width,
                height: image.height,
                data: new Uint8ClampedArray(image.data)
            };
        },
        putImageData() {
            putCalls++;
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 7,
        y: 7,
        width: 6,
        height: 6
    }, createDiamondAlphaMap(6, 6), {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_DENOISE,
        edgeDenoiseStrength: 0.5
    });

    assert.equal(result.denoiseBackend, VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_DENOISE);
    assert.equal(putCalls, 1);
});

test('applyVideoResidualCleanup should route canvas edge band denoise backend', () => {
    const image = {
        width: 20,
        height: 20,
        data: new Uint8ClampedArray(20 * 20 * 4)
    };
    for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 80 + ((i / 4) % 20);
        image.data[i + 1] = 90;
        image.data[i + 2] = 100;
        image.data[i + 3] = 255;
    }

    let putCalls = 0;
    const ctx = {
        canvas: { width: 20, height: 20 },
        getImageData() {
            return {
                width: image.width,
                height: image.height,
                data: new Uint8ClampedArray(image.data)
            };
        },
        putImageData() {
            putCalls++;
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 7,
        y: 7,
        width: 6,
        height: 6
    }, createDiamondAlphaMap(6, 6), {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_BAND_DENOISE,
        edgeDenoiseStrength: 0.5
    });

    assert.equal(result.denoiseBackend, VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_BAND_DENOISE);
    assert.equal(putCalls, 1);
});

test('applyVideoResidualCleanup should route canvas edge core denoise backend', () => {
    const image = {
        width: 20,
        height: 20,
        data: new Uint8ClampedArray(20 * 20 * 4)
    };
    for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 80 + ((i / 4) % 20);
        image.data[i + 1] = 90;
        image.data[i + 2] = 100;
        image.data[i + 3] = 255;
    }

    let putCalls = 0;
    const ctx = {
        canvas: { width: 20, height: 20 },
        getImageData() {
            return {
                width: image.width,
                height: image.height,
                data: new Uint8ClampedArray(image.data)
            };
        },
        putImageData() {
            putCalls++;
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 7,
        y: 7,
        width: 6,
        height: 6
    }, createDiamondAlphaMap(6, 6), {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_CORE_DENOISE,
        edgeDenoiseStrength: 0.5
    });

    assert.equal(result.denoiseBackend, VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_CORE_DENOISE);
    assert.equal(putCalls, 1);
});

test('applyVideoResidualCleanup should route canvas footprint polish backend', () => {
    const image = {
        width: 20,
        height: 20,
        data: new Uint8ClampedArray(20 * 20 * 4)
    };
    for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 80 + ((i / 4) % 20);
        image.data[i + 1] = 90;
        image.data[i + 2] = 100;
        image.data[i + 3] = 255;
    }

    let putCalls = 0;
    const ctx = {
        canvas: { width: 20, height: 20 },
        getImageData() {
            return {
                width: image.width,
                height: image.height,
                data: new Uint8ClampedArray(image.data)
            };
        },
        putImageData() {
            putCalls++;
        }
    };

    const result = applyVideoResidualCleanup(ctx, {
        x: 7,
        y: 7,
        width: 6,
        height: 6
    }, createDiamondAlphaMap(6, 6), {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_FOOTPRINT_POLISH,
        edgeDenoiseStrength: 0.5
    });

    assert.equal(result.denoiseBackend, VIDEO_DENOISE_BACKENDS.CANVAS_FOOTPRINT_POLISH);
    assert.equal(putCalls, 1);
});

function createSoftCleanupCtx(fillPixel) {
    let putCalls = 0;
    const ctx = {
        canvas: { width: 200, height: 200 },
        getImageData(x, y, width, height) {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let row = 0; row < height; row++) {
                for (let col = 0; col < width; col++) {
                    const idx = (row * width + col) * 4;
                    const value = fillPixel(x + col, y + row);
                    data[idx] = value;
                    data[idx + 1] = value;
                    data[idx + 2] = value;
                    data[idx + 3] = 255;
                }
            }
            return { width, height, data };
        },
        putImageData() {
            putCalls++;
        }
    };
    return { ctx, putCalls: () => putCalls };
}

function runSoftCleanup(fillPixel) {
    const { ctx, putCalls } = createSoftCleanupCtx(fillPixel);
    applyVideoResidualCleanup(ctx, {
        x: 60,
        y: 60,
        width: 48,
        height: 48
    }, createDiamondAlphaMap(48, 48), {
        residualCleanupStrength: DEFAULT_RESIDUAL_CLEANUP_STRENGTH
    });
    return putCalls();
}

test('resolveContentTextureGate should keep cleanup on flat content and drop it on detailed content', () => {
    assert.equal(resolveContentTextureGate(0), 1);
    assert.equal(resolveContentTextureGate(CLEANUP_FLAT_TEXTURE_RMS), 1);
    assert.equal(resolveContentTextureGate(CLEANUP_BUSY_TEXTURE_RMS), 0);
    assert.equal(resolveContentTextureGate(CLEANUP_BUSY_TEXTURE_RMS * 2), 0);
    assert.equal(resolveContentTextureGate(Number.NaN), 1);

    const midpoint = resolveContentTextureGate(
        (CLEANUP_FLAT_TEXTURE_RMS + CLEANUP_BUSY_TEXTURE_RMS) / 2
    );
    assert.ok(midpoint > 0 && midpoint < 1);
});

test('measureSurroundingTextureRms should ignore pixels inside the watermark footprint', () => {
    const pixelCount = 16;
    const padded = { width: 4, height: 4, data: new Uint8ClampedArray(pixelCount * 4) };
    const textureBase = new Uint8ClampedArray(pixelCount * 4);
    const weights = new Float32Array(pixelCount);

    for (let pixel = 0; pixel < pixelCount; pixel++) {
        const inFootprint = pixel < 4;
        const value = inFootprint ? 200 : 10;
        weights[pixel] = inFootprint ? 1 : 0;
        for (let c = 0; c < 3; c++) {
            padded.data[pixel * 4 + c] = value;
        }
    }

    assert.ok(Math.abs(measureSurroundingTextureRms(padded, textureBase, weights) - 10) < 0.01);
});

test('soft residual cleanup should still run over a flat background', () => {
    assert.equal(runSoftCleanup(() => 128), 1);
});

test('soft residual cleanup should be skipped over a detailed background', () => {
    // Sharp stripes: smoothing here would wipe real texture that the reverse
    // alpha blend already recovered, and the residual it hides is masked anyway.
    assert.equal(runSoftCleanup((x, y) => (Math.floor(y / 2) % 2 === 0 ? 20 : 230)), 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    interpolateAlphaMap,
    detectAdaptiveWatermarkRegion,
    computeRegionSpatialCorrelation,
    shouldAttemptAdaptiveFallback
} from '../../src/core/adaptiveDetector.js';

function createSyntheticAlpha(size = 96) {
    const alpha = new Float32Array(size * size);
    const c = (size - 1) / 2;
    const radius = size / 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - c) / radius;
            const dy = (y - c) / radius;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const diamond = Math.max(Math.abs(dx), Math.abs(dy));

            const core = Math.max(0, 1.0 - diamond * 1.65);
            const ring = Math.max(0, 0.22 - Math.abs(dist - 0.44)) * 2.4;

            alpha[y * size + x] = Math.min(1, core + ring);
        }
    }

    return alpha;
}

function resizeAlphaNearest(src, srcSize, targetSize) {
    const out = new Float32Array(targetSize * targetSize);
    const scale = srcSize / targetSize;

    for (let y = 0; y < targetSize; y++) {
        const sy = Math.min(srcSize - 1, Math.floor(y * scale));
        for (let x = 0; x < targetSize; x++) {
            const sx = Math.min(srcSize - 1, Math.floor(x * scale));
            out[y * targetSize + x] = src[sy * srcSize + sx];
        }
    }

    return out;
}

function createBaseImageData(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = 40 + ((x * 17 + y * 7) % 140);
            const g = 35 + ((x * 9 + y * 19) % 145);
            const b = 30 + ((x * 23 + y * 11) % 150);
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255;
        }
    }

    return { width, height, data };
}

function applyWatermark(imageData, alpha96, box) {
    const { width, data } = imageData;
    const alpha = resizeAlphaNearest(alpha96, 96, box.size);

    for (let row = 0; row < box.size; row++) {
        for (let col = 0; col < box.size; col++) {
            const a = alpha[row * box.size + col];
            if (a <= 0.001) continue;

            const idx = ((box.y + row) * width + (box.x + col)) * 4;
            for (let c = 0; c < 3; c++) {
                const original = data[idx + c];
                const blended = a * 255 + (1 - a) * original;
                data[idx + c] = Math.max(0, Math.min(255, Math.round(blended)));
            }
        }
    }
}

test('interpolateAlphaMap should resize alpha map and keep corner values stable', () => {
    const source = new Float32Array([
        0.0, 1.0,
        1.0, 0.0
    ]);

    const out = interpolateAlphaMap(source, 2, 4);
    assert.equal(out.length, 16);

    assert.ok(Math.abs(out[0] - 0.0) < 1e-6);
    assert.ok(Math.abs(out[3] - 1.0) < 1e-6);
    assert.ok(Math.abs(out[12] - 1.0) < 1e-6);
    assert.ok(Math.abs(out[15] - 0.0) < 1e-6);
});

test('detectAdaptiveWatermarkRegion should locate non-standard watermark size', () => {
    const alpha96 = createSyntheticAlpha(96);
    const imageData = createBaseImageData(360, 280);
    const target = {
        size: 72,
        x: 360 - 44 - 72,
        y: 280 - 52 - 72
    };
    applyWatermark(imageData, alpha96, target);

    const result = detectAdaptiveWatermarkRegion({
        imageData,
        alpha96,
        defaultConfig: {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        },
        threshold: 0.35
    });

    assert.equal(result.found, true);
    assert.ok(result.confidence >= 0.35, `confidence=${result.confidence}`);
    assert.ok(Math.abs(result.region.size - target.size) <= 4, `size=${result.region.size}`);
    assert.ok(Math.abs(result.region.x - target.x) <= 6, `x=${result.region.x}`);
    assert.ok(Math.abs(result.region.y - target.y) <= 6, `y=${result.region.y}`);
});

test('detectAdaptiveWatermarkRegion should not report confident match on clean image', () => {
    const alpha96 = createSyntheticAlpha(96);
    const clean = createBaseImageData(360, 280);

    const result = detectAdaptiveWatermarkRegion({
        imageData: clean,
        alpha96,
        defaultConfig: {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        },
        threshold: 0.35
    });

    assert.equal(result.found, false);
    assert.ok(result.confidence < 0.35, `confidence=${result.confidence}`);
});

test('detectAdaptiveWatermarkRegion should recover scaled watermark anchor for near-official dimensions', () => {
    const alpha96 = createSyntheticAlpha(96);
    const imageData = createBaseImageData(1000, 1792);
    const target = {
        size: 125,
        x: 1000 - 83 - 125,
        y: 1792 - 83 - 125
    };
    applyWatermark(imageData, alpha96, target);

    const result = detectAdaptiveWatermarkRegion({
        imageData,
        alpha96,
        defaultConfig: {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        },
        threshold: 0.35
    });

    assert.equal(result.found, true);
    assert.ok(result.confidence >= 0.35, `confidence=${result.confidence}`);
    assert.ok(Math.abs(result.region.size - target.size) <= 6, `size=${result.region.size}`);
    assert.ok(Math.abs(result.region.x - target.x) <= 8, `x=${result.region.x}`);
    assert.ok(Math.abs(result.region.y - target.y) <= 8, `y=${result.region.y}`);
});

test('computeRegionSpatialCorrelation should be higher on watermark-like patch', () => {
    const alpha96 = createSyntheticAlpha(96);
    const imageData = createBaseImageData(300, 240);
    const target = {
        size: 72,
        x: 300 - 44 - 72,
        y: 240 - 52 - 72
    };
    applyWatermark(imageData, alpha96, target);

    const alpha72 = interpolateAlphaMap(alpha96, 96, 72);
    const positive = computeRegionSpatialCorrelation({
        imageData,
        alphaMap: alpha72,
        region: { x: target.x, y: target.y, size: 72 }
    });
    const negative = computeRegionSpatialCorrelation({
        imageData,
        alphaMap: alpha72,
        region: { x: 20, y: 20, size: 72 }
    });

    assert.ok(positive > negative, `positive=${positive}, negative=${negative}`);
});

test('shouldAttemptAdaptiveFallback should return true when residual signal stays high', () => {
    const alpha96 = createSyntheticAlpha(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createBaseImageData(360, 280);
    const target = {
        size: 48,
        x: 360 - 32 - 48,
        y: 280 - 32 - 48
    };
    applyWatermark(imageData, alpha96, target);

    const shouldFallback = shouldAttemptAdaptiveFallback({
        processedImageData: imageData,
        alphaMap: alpha48,
        position: { x: target.x, y: target.y, width: target.size, height: target.size },
        residualThreshold: 0.22
    });

    assert.equal(shouldFallback, true);
});

test('shouldAttemptAdaptiveFallback should return true when original position is mismatched', () => {
    const alpha96 = createSyntheticAlpha(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const moved = createBaseImageData(360, 280);
    applyWatermark(moved, alpha96, {
        size: 72,
        x: 360 - 44 - 72,
        y: 280 - 52 - 72
    });

    const shouldFallback = shouldAttemptAdaptiveFallback({
        processedImageData: moved,
        alphaMap: alpha48,
        position: { x: 360 - 32 - 48, y: 280 - 32 - 48, width: 48, height: 48 },
        residualThreshold: 0.5,
        originalImageData: moved,
        originalSpatialMismatchThreshold: 0
    });

    assert.equal(shouldFallback, true);
});

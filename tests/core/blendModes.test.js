import test from 'node:test';
import assert from 'node:assert/strict';

import { removeWatermark } from '../../src/core/blendModes.js';

function createFlatImageData(width, height, value = 80) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        data[idx] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
        data[idx + 3] = 255;
    }
    return { width, height, data };
}

function createRadialAlphaMap(size, peakAlpha = 0.34, haloAlpha = 0.014) {
    const alphaMap = new Float32Array(size * size);
    const center = (size - 1) / 2;
    const radius = size / 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - center) / radius;
            const dy = (y - center) / radius;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const core = Math.max(0, peakAlpha * (1 - dist));
            const halo = dist < 1.05 ? haloAlpha : 0;
            alphaMap[y * size + x] = Math.max(core, halo);
        }
    }

    return alphaMap;
}

test('removeWatermark should ignore near-noise alpha map and keep ROI stable', () => {
    const width = 220;
    const height = 180;
    const position = { x: 60, y: 40, width: 96, height: 96 };
    const imageData = createFlatImageData(width, height, 72);
    const original = new Uint8ClampedArray(imageData.data);

    // Simulate low-level quantization noise from captured alpha maps.
    const alphaMap = new Float32Array(position.width * position.height).fill(0.003);

    removeWatermark(imageData, alphaMap, position);

    let changed = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * width + (position.x + col)) * 4;
            for (let c = 0; c < 3; c++) {
                if (imageData.data[idx + c] !== original[idx + c]) {
                    changed++;
                    break;
                }
            }
        }
    }

    assert.equal(changed, 0);
});

test('removeWatermark should still recover pixels for strong alpha region', () => {
    const width = 180;
    const height = 180;
    const position = { x: 42, y: 36, width: 48, height: 48 };
    const imageData = createFlatImageData(width, height, 90);

    const alpha = 0.25;
    const alphaMap = new Float32Array(position.width * position.height).fill(alpha);

    // Pre-apply watermark blend to ROI.
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * width + (position.x + col)) * 4;
            const watermarked = Math.round(alpha * 255 + (1 - alpha) * 90);
            imageData.data[idx] = watermarked;
            imageData.data[idx + 1] = watermarked;
            imageData.data[idx + 2] = watermarked;
        }
    }

    removeWatermark(imageData, alphaMap, position);

    const centerIdx = ((position.y + 12) * width + (position.x + 12)) * 4;
    assert.ok(Math.abs(imageData.data[centerIdx] - 90) <= 2);
    assert.ok(Math.abs(imageData.data[centerIdx + 1] - 90) <= 2);
    assert.ok(Math.abs(imageData.data[centerIdx + 2] - 90) <= 2);
});

test('removeWatermark should recover low-but-real alpha edge pixels', () => {
    const width = 64;
    const height = 64;
    const position = { x: 8, y: 8, width: 32, height: 32 };
    const imageData = createFlatImageData(width, height, 40);
    const original = new Uint8ClampedArray(imageData.data);

    // Edge alpha in real captures can be around this range: not pure noise.
    const edgeAlpha = 0.015;
    const alphaMap = new Float32Array(position.width * position.height).fill(edgeAlpha);

    // Simulate watermark blend.
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * width + (position.x + col)) * 4;
            const watermarked = Math.round(edgeAlpha * 255 + (1 - edgeAlpha) * 40);
            imageData.data[idx] = watermarked;
            imageData.data[idx + 1] = watermarked;
            imageData.data[idx + 2] = watermarked;
        }
    }

    removeWatermark(imageData, alphaMap, position);

    const sampleIdx = ((position.y + 10) * width + (position.x + 10)) * 4;
    const recovered = imageData.data[sampleIdx];
    const before = original[sampleIdx];

    // Should actively reverse blending for edge alpha instead of leaving residual.
    assert.ok(Math.abs(recovered - before) <= 2, `recovered=${recovered}, before=${before}`);
});

test('removeWatermark should support alpha gain for stronger watermark variants', () => {
    const width = 80;
    const height = 80;
    const position = { x: 16, y: 16, width: 32, height: 32 };
    const imageData = createFlatImageData(width, height, 80);

    // Template alpha is weaker than real-world watermark alpha.
    const templateAlpha = 0.18;
    const trueAlpha = 0.36;
    const alphaMap = new Float32Array(position.width * position.height).fill(templateAlpha);

    // Simulate a stronger watermark blend first.
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * width + (position.x + col)) * 4;
            const watermarked = Math.round(trueAlpha * 255 + (1 - trueAlpha) * 80);
            imageData.data[idx] = watermarked;
            imageData.data[idx + 1] = watermarked;
            imageData.data[idx + 2] = watermarked;
        }
    }

    // Requires gain-aware inverse solve to recover.
    removeWatermark(imageData, alphaMap, position, { alphaGain: 2 });

    const sampleIdx = ((position.y + 10) * width + (position.x + 10)) * 4;
    assert.ok(Math.abs(imageData.data[sampleIdx] - 80) <= 2, `recovered=${imageData.data[sampleIdx]}`);
});

test('removeWatermark should suppress residual watermark shape on structured alpha map', () => {
    const width = 240;
    const height = 200;
    const position = { x: 68, y: 44, width: 96, height: 96 };
    const base = 64;
    const imageData = createFlatImageData(width, height, base);
    const original = new Uint8ClampedArray(imageData.data);
    const alphaMap = createRadialAlphaMap(96, 0.34, 0.014);

    // Apply synthetic watermark first.
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const a = alphaMap[row * position.width + col];
            if (a <= 0) continue;
            const idx = ((position.y + row) * width + (position.x + col)) * 4;
            for (let c = 0; c < 3; c++) {
                const src = imageData.data[idx + c];
                imageData.data[idx + c] = Math.round(a * 255 + (1 - a) * src);
            }
        }
    }

    removeWatermark(imageData, alphaMap, position);

    let totalError = 0;
    let maxError = 0;
    const pixels = position.width * position.height;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * width + (position.x + col)) * 4;
            const err = Math.abs(imageData.data[idx] - original[idx]);
            totalError += err;
            if (err > maxError) maxError = err;
        }
    }

    const meanError = totalError / pixels;
    assert.ok(meanError <= 1.0, `meanError=${meanError}`);
    assert.ok(maxError <= 4, `maxError=${maxError}`);
});

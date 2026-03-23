import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateWatermarkPosition,
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from '../../src/core/watermarkConfig.js';

function createSyntheticAlpha(size, peak = 0.5, halo = 0.02) {
    const alpha = new Float32Array(size * size);
    const center = (size - 1) / 2;
    const radius = size / 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - center) / radius;
            const dy = (y - center) / radius;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const core = Math.max(0, peak * (1 - dist));
            const edge = dist < 1.08 ? halo : 0;
            alpha[y * size + x] = Math.min(1, Math.max(core, edge));
        }
    }

    return alpha;
}

function createImageData(width, height, value = 28) {
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

function applyWatermark(imageData, alphaMap, position) {
    const { width: imgW, data } = imageData;
    const { x, y, width } = position;

    for (let row = 0; row < width; row++) {
        for (let col = 0; col < width; col++) {
            const a = alphaMap[row * width + col];
            if (a <= 0) continue;
            const idx = ((y + row) * imgW + (x + col)) * 4;
            for (let c = 0; c < 3; c++) {
                data[idx + c] = Math.round(a * 255 + (1 - a) * data[idx + c]);
            }
        }
    }
}

test('resolveInitialStandardConfig should switch to 96 config when 48 rule is mismatched', () => {
    const imageData = createImageData(800, 1400, 16);
    const alpha48 = createSyntheticAlpha(48);
    const alpha96 = createSyntheticAlpha(96);

    const trueConfig = { logoSize: 96, marginRight: 64, marginBottom: 64 };
    applyWatermark(imageData, alpha96, calculateWatermarkPosition(imageData.width, imageData.height, trueConfig));

    const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
    assert.equal(defaultConfig.logoSize, 48);

    const resolved = resolveInitialStandardConfig({
        imageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    assert.equal(resolved.logoSize, 96);
    assert.equal(resolved.marginRight, 64);
    assert.equal(resolved.marginBottom, 64);
});

test('detectWatermarkConfig should prefer 96 config for documented Gemini 1K sizes', () => {
    const config = detectWatermarkConfig(768, 1376);

    assert.equal(config.logoSize, 96);
    assert.equal(config.marginRight, 64);
    assert.equal(config.marginBottom, 64);
});

test('resolveInitialStandardConfig should keep 48 config when it already matches', () => {
    const imageData = createImageData(960, 960, 32);
    const alpha48 = createSyntheticAlpha(48);
    const alpha96 = createSyntheticAlpha(96);

    const trueConfig = { logoSize: 48, marginRight: 32, marginBottom: 32 };
    applyWatermark(imageData, alpha48, calculateWatermarkPosition(imageData.width, imageData.height, trueConfig));

    const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
    assert.equal(defaultConfig.logoSize, 48);

    const resolved = resolveInitialStandardConfig({
        imageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    assert.equal(resolved.logoSize, 48);
    assert.equal(resolved.marginRight, 32);
    assert.equal(resolved.marginBottom, 32);
});

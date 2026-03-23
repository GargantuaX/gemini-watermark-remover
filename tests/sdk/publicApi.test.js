import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applySyntheticWatermark,
    createPatternImageData
} from '../core/syntheticWatermarkTestUtils.js';

test('package root should expose a stable sdk surface', async () => {
    const mod = await import('gemini-watermark-remover');

    assert.equal(typeof mod.createWatermarkEngine, 'function');
    assert.equal(typeof mod.removeWatermarkFromImageData, 'function');
    assert.equal(typeof mod.removeWatermarkFromImageDataSync, 'function');
    assert.equal(typeof mod.WatermarkEngine, 'function');
    assert.equal(typeof mod.detectWatermarkConfig, 'function');
    assert.equal(typeof mod.calculateWatermarkPosition, 'function');
});

test('removeWatermarkFromImageData should work without caller-provided alpha maps', async () => {
    const mod = await import('gemini-watermark-remover');
    const engine = await mod.createWatermarkEngine();
    const alpha48 = await engine.getAlphaMap(48);
    const imageData = createPatternImageData(320, 320);
    const position = { x: 320 - 32 - 48, y: 320 - 32 - 48, width: 48, height: 48 };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    const result = await mod.removeWatermarkFromImageData(imageData, {
        adaptiveMode: 'never',
        maxPasses: 1
    });

    assert.equal(result.imageData.width, 320);
    assert.equal(result.imageData.height, 320);
    assert.ok(result.meta.applied, `skipReason=${result.meta.skipReason}`);
    assert.equal(result.meta.position.width, 48);
    assert.ok(
        result.meta.detection.processedSpatialScore < 0.25,
        `score=${result.meta.detection.processedSpatialScore}`
    );
});

test('removeWatermarkFromImageDataSync should work without caller-provided alpha maps', async () => {
    const mod = await import('gemini-watermark-remover');
    const engine = await mod.createWatermarkEngine();
    const alpha48 = await engine.getAlphaMap(48);
    const imageData = createPatternImageData(320, 320);
    const position = { x: 320 - 32 - 48, y: 320 - 32 - 48, width: 48, height: 48 };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    const result = mod.removeWatermarkFromImageDataSync(imageData, {
        adaptiveMode: 'never',
        maxPasses: 1
    });

    assert.equal(result.imageData.width, 320);
    assert.equal(result.imageData.height, 320);
    assert.ok(result.meta.applied, `skipReason=${result.meta.skipReason}`);
    assert.equal(result.meta.position.width, 48);
    assert.ok(
        result.meta.detection.processedSpatialScore < 0.25,
        `score=${result.meta.detection.processedSpatialScore}`
    );
});

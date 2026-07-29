import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
    applySyntheticWatermark,
    createPatternImageData
} from '../core/syntheticWatermarkTestUtils.js';
import { decodeImageDataInNode } from '../../scripts/sample-benchmark.js';

test('package root should expose a stable sdk surface', async () => {
    const mod = await import('@pilio/gemini-watermark-remover');

    assert.equal(typeof mod.createWatermarkEngine, 'function');
    assert.equal(typeof mod.removeWatermarkFromImageData, 'function');
    assert.equal(typeof mod.removeWatermarkFromImageDataSync, 'function');
    assert.equal(typeof mod.WatermarkEngine, 'function');
    assert.equal(typeof mod.detectWatermarkConfig, 'function');
    assert.equal(typeof mod.calculateWatermarkPosition, 'function');
});

test('removeWatermarkFromImageData should work without caller-provided alpha maps', async () => {
    const mod = await import('@pilio/gemini-watermark-remover');
    const engine = await mod.createWatermarkEngine();
    const alpha48 = await engine.getAlphaMap(48);
    const imageData = createPatternImageData(320, 320);
    const position = { x: 320 - 32 - 48, y: 320 - 32 - 48, width: 48, height: 48 };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    const result = await mod.removeWatermarkFromImageData(imageData, {
        adaptiveMode: 'never'
    });

    assert.equal(result.imageData.width, 320);
    assert.equal(result.imageData.height, 320);
    assert.ok(result.meta.applied, `skipReason=${result.meta.skipReason}`);
    assert.equal(result.meta.bestEffort, true);
    assert.equal(result.meta.retryRecommended, false);
    assert.notEqual(result.meta.qualityStatus, null);
    assert.ok(Number.isFinite(result.meta.selectionConfidence));
    assert.ok(result.meta.selectedCandidate?.id);
    assert.ok(result.meta.qualitySignals);
    assert.ok(Array.isArray(result.meta.candidateSummaries));
    assert.ok(result.meta.candidateSummaries.length >= 1);
    assert.equal(result.meta.position.width, 48);
    assert.ok(
        result.meta.detection.processedSpatialScore < 0.25,
        `score=${result.meta.detection.processedSpatialScore}`
    );
});

test('removeWatermarkFromImageDataSync should work without caller-provided alpha maps', async () => {
    const mod = await import('@pilio/gemini-watermark-remover');
    const engine = await mod.createWatermarkEngine();
    const alpha48 = await engine.getAlphaMap(48);
    const imageData = createPatternImageData(320, 320);
    const position = { x: 320 - 32 - 48, y: 320 - 32 - 48, width: 48, height: 48 };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    const result = mod.removeWatermarkFromImageDataSync(imageData, {
        adaptiveMode: 'never'
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

test('removeWatermarkFromImageDataSync should use the embedded 36-v2 profile by default', async () => {
    const mod = await import('@pilio/gemini-watermark-remover');
    const engine = await mod.createWatermarkEngine();
    const alpha36V2 = await engine.getAlphaMap('36-v2');
    const imageData = createPatternImageData(1376, 768);
    const position = {
        x: 1376 - 96 - 36,
        y: 768 - 96 - 36,
        width: 36,
        height: 36
    };

    applySyntheticWatermark(imageData, alpha36V2, position, 1);
    const result = mod.removeWatermarkFromImageDataSync(imageData);

    assert.equal(result.meta.applied, true, `skipReason=${result.meta.skipReason}`);
    assert.deepEqual(result.meta.config, {
        logoSize: 36,
        marginRight: 96,
        marginBottom: 96,
        alphaVariant: 'v2'
    });
    assert.ok(
        result.meta.detection.processedSpatialScore < 0.12,
        `score=${result.meta.detection.processedSpatialScore}`
    );
});

test('removeWatermarkFromImageDataSync should include the gated issue101 outline variant by default', async () => {
    const mod = await import('@pilio/gemini-watermark-remover');
    const imageData = createPatternImageData(1728, 2464);
    const crop = await decodeImageDataInNode(path.resolve(
        'tests/fixtures/issue101-outline-light-portrait.png'
    ));
    const cropLeft = 1392;
    const cropTop = 2128;
    for (let y = 0; y < crop.height; y++) {
        for (let x = 0; x < crop.width; x++) {
            const sourceIndex = (y * crop.width + x) * 4;
            const targetIndex = ((cropTop + y) * imageData.width + cropLeft + x) * 4;
            imageData.data.set(crop.data.subarray(sourceIndex, sourceIndex + 4), targetIndex);
        }
    }

    const result = mod.removeWatermarkFromImageDataSync(imageData, {
        adaptiveMode: 'never'
    });

    assert.equal(result.meta.applied, true, `skipReason=${result.meta.skipReason}`);
    assert.equal(result.meta.config?.alphaVariant, 'outline-light');
    assert.equal(result.meta.position?.x, 1440);
    assert.equal(result.meta.position?.y, 2176);
    assert.equal(
        result.meta.decisionPath?.detectionCandidate?.provenance?.outlineLight,
        true
    );
});

test('removeWatermarkFromImageDataSync should include the gated issue101 dark-outline variant by default', async () => {
    const mod = await import('@pilio/gemini-watermark-remover');
    const imageData = createPatternImageData(2816, 1536);
    const crop = await decodeImageDataInNode(path.resolve(
        'tests/fixtures/issue101-outline-dark-landscape.png'
    ));
    const cropLeft = 2480;
    const cropTop = 1152;
    for (let y = 0; y < crop.height; y++) {
        for (let x = 0; x < crop.width; x++) {
            const sourceIndex = (y * crop.width + x) * 4;
            const targetIndex = ((cropTop + y) * imageData.width + cropLeft + x) * 4;
            imageData.data.set(crop.data.subarray(sourceIndex, sourceIndex + 4), targetIndex);
        }
    }

    const result = mod.removeWatermarkFromImageDataSync(imageData, {
        adaptiveMode: 'never'
    });

    assert.equal(result.meta.applied, true, `skipReason=${result.meta.skipReason}`);
    assert.equal(result.meta.config?.alphaVariant, 'outline-dark');
    assert.equal(result.meta.position?.x, 2528);
    assert.equal(result.meta.position?.y, 1248);
    assert.equal(
        result.meta.decisionPath?.detectionCandidate?.provenance?.outlineDark,
        true
    );
    assert.ok(
        result.meta.detection.processedGradientScore <= 0.18,
        `gradient=${result.meta.detection.processedGradientScore}`
    );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';

import {
    applySyntheticWatermark,
    createPatternImageData
} from '../core/syntheticWatermarkTestUtils.js';

function serializeImageData(imageData) {
    return Buffer.from(JSON.stringify({
        width: imageData.width,
        height: imageData.height,
        data: Array.from(imageData.data)
    }), 'utf8');
}

function decodeSyntheticImageData(buffer) {
    const payload = JSON.parse(Buffer.from(buffer).toString('utf8'));
    return {
        width: payload.width,
        height: payload.height,
        data: Uint8ClampedArray.from(payload.data)
    };
}

function encodeSyntheticImageData(imageData) {
    return serializeImageData(imageData);
}

test('removeWatermarkFromBuffer should support pluggable Node decode and encode hooks', async () => {
    const mod = await import('gemini-watermark-remover/node');
    const imageDataSdk = await import('gemini-watermark-remover/image-data');
    const alpha48 = await imageDataSdk.createWatermarkEngine().then((engine) => engine.getAlphaMap(48));
    const imageData = createPatternImageData(320, 320);
    const position = { x: 320 - 32 - 48, y: 320 - 32 - 48, width: 48, height: 48 };
    applySyntheticWatermark(imageData, alpha48, position, 1);

    const result = await mod.removeWatermarkFromBuffer(serializeImageData(imageData), {
        mimeType: 'image/png',
        decodeImageData: decodeSyntheticImageData,
        encodeImageData: encodeSyntheticImageData,
        adaptiveMode: 'never',
        maxPasses: 1
    });

    assert.ok(Buffer.isBuffer(result.buffer));
    assert.ok(result.buffer.length > 0);
    assert.ok(result.meta.applied, `skipReason=${result.meta.skipReason}`);
    assert.equal(result.meta.position.width, 48);
});

test('removeWatermarkFromFile should read input and optionally write output', async () => {
    const mod = await import('gemini-watermark-remover/node');
    const imageDataSdk = await import('gemini-watermark-remover/image-data');
    const alpha48 = await imageDataSdk.createWatermarkEngine().then((engine) => engine.getAlphaMap(48));
    const imageData = createPatternImageData(320, 320);
    const position = { x: 320 - 32 - 48, y: 320 - 32 - 48, width: 48, height: 48 };
    applySyntheticWatermark(imageData, alpha48, position, 1);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-node-sdk-'));
    const inputPath = path.join(tempDir, 'input.synthetic');
    const outputPath = path.join(tempDir, 'output.synthetic');
    await writeFile(inputPath, serializeImageData(imageData));

    const result = await mod.removeWatermarkFromFile(inputPath, {
        outputPath,
        decodeImageData: decodeSyntheticImageData,
        encodeImageData: encodeSyntheticImageData,
        adaptiveMode: 'never',
        maxPasses: 1
    });

    const saved = await readFile(outputPath);
    assert.ok(Buffer.isBuffer(result.buffer));
    assert.equal(Buffer.compare(saved, result.buffer), 0);
    assert.equal(result.outputPath, outputPath);
    assert.ok(result.meta.applied, `skipReason=${result.meta.skipReason}`);
});

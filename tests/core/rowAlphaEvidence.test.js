import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import { measureRowAlphaEvidence, supportsRowAlphaGain } from '../../src/core/rowAlphaEvidence.js';
import { removeWatermarkFromImageDataSync } from '../../src/sdk/image-data.js';

const alpha = getEmbeddedAlphaMap(48);
function createFixture(gain, width = 200, height = 180) {
    const position = { x: width - 144, y: height - 144, width: 48, height: 48 };
    const clean = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let value = y < position.y + 18 ? 100 : y < position.y + 32 ? 35 : 130;
            value += 2 * Math.sin(x * 0.14) + 1.5 * Math.sin(y * 2);
            clean.data.set([value + 12, value + 5, value, 255], (y * width + x) * 4);
        }
    }
    const input = { width, height, data: new Uint8ClampedArray(clean.data) };
    for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 48; x++) {
            const opacity = alpha[y * 48 + x] * Math.abs(gain);
            const offset = ((position.y + y) * width + position.x + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                input.data[offset + channel] = Math.round(
                    clean.data[offset + channel] * (1 - opacity) + (gain < 0 ? 0 : 255) * opacity
                );
            }
        }
    }
    return { clean, input, position };
}

test('row alpha evidence recovers white gain across a horizontal brightness boundary', () => {
    const { input, position } = createFixture(0.6);
    const evidence = measureRowAlphaEvidence(input, position, alpha);
    assert.ok(supportsRowAlphaGain(evidence));
    assert.ok(Math.abs(evidence.gain - 0.6) < 0.02);
});

test('row alpha evidence does not promote clean, weaker, stronger, or dark marks to gain 0.6', () => {
    for (const gain of [0, 0.3, 0.45, 0.85, 1, -0.6]) {
        const { input, position } = createFixture(gain);
        assert.equal(supportsRowAlphaGain(measureRowAlphaEvidence(input, position, alpha)), false, String(gain));
    }
});

test('row alpha evidence requires independent quadrant agreement', () => {
    const { input, position } = createFixture(0.6);
    for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 24; x++) {
            const offset = ((position.y + y) * input.width + position.x + x) * 4;
            input.data[offset] = 230;
            input.data[offset + 1] = 230;
            input.data[offset + 2] = 230;
        }
    }
    assert.equal(supportsRowAlphaGain(measureRowAlphaEvidence(input, position, alpha)), false);
});

test('row alpha evidence declines unsupported geometry and missing neighborhood', () => {
    const { input, position } = createFixture(0.6);
    assert.equal(measureRowAlphaEvidence(input, { ...position, x: 0 }, alpha), null);
    assert.equal(measureRowAlphaEvidence(input, { ...position, width: 96 }, alpha), null);
});

test('pipeline preserves a known clean horizontal boundary', () => {
    const { clean, input } = createFixture(0, 2400, 1792);
    const result = removeWatermarkFromImageDataSync(input);
    assert.deepEqual(result.imageData.data, clean.data);
});

test('pipeline removes a known 0.6 watermark instead of optimizing correlation against the background edge', () => {
    const { clean, input, position } = createFixture(0.6, 2400, 1792);
    const result = removeWatermarkFromImageDataSync(input);
    assert.equal(result.meta.alphaGain, 0.6);
    assert.deepEqual(result.meta.position, position);
    let error = 0;
    let outsideChanges = 0;
    for (let y = 0; y < input.height; y++) {
        for (let x = 0; x < input.width; x++) {
            const inside = x >= position.x && x < position.x + 48 && y >= position.y && y < position.y + 48;
            const offset = (y * input.width + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                if (inside) error += Math.abs(result.imageData.data[offset + channel] - clean.data[offset + channel]);
                else if (result.imageData.data[offset + channel] !== input.data[offset + channel]) outsideChanges++;
            }
        }
    }
    assert.ok(error / (48 * 48 * 3) < 0.5, `known-background error=${error / (48 * 48 * 3)}`);
    assert.equal(outsideChanges, 0);
});

test('pipeline retains the independently supported gain for the issue101 cabinet crop', async () => {
    // Unmodified bottom-right 192x192 crop of the reporter's 8-13
    // 120X120CM (1)_Scene1_processor.png (issue #101).
    // Original SHA-256: 75ae49753f59348b6d6e8e330e5a36bb7871653d0ae79fe0ec908279e4bf54c1.
    const { data, info } = await sharp(fileURLToPath(new URL('../fixtures/issue101-row-alpha-cabinet.png', import.meta.url)))
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = 2400;
    const height = 1792;
    const input = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (let offset = 0; offset < input.data.length; offset += 4) input.data.set([100, 100, 100, 255], offset);
    for (let row = 0; row < info.height; row++) {
        input.data.set(data.subarray(row * info.width * 4, (row + 1) * info.width * 4),
            ((height - info.height + row) * width + width - info.width) * 4);
    }
    const result = removeWatermarkFromImageDataSync(input);
    assert.equal(result.meta.alphaGain, 0.6);
    assert.deepEqual(result.meta.position, { x: 2256, y: 1648, width: 48, height: 48 });
    assert.ok(supportsRowAlphaGain(measureRowAlphaEvidence(result.imageData, result.meta.position, alpha), 0));
});

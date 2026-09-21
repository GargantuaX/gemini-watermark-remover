import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import { measurePlaneAlphaEvidence } from '../../src/core/planeAlphaEvidence.js';
import { removeWatermarkFromImageDataSync } from '../../src/sdk/image-data.js';

const alpha = getEmbeddedAlphaMap('96-20260520');
function fixture(gain, fullSize = false, graphic = true) {
    const width = fullSize ? 2752 : 256;
    const height = fullSize ? 1536 : 256;
    const position = { x: fullSize ? 2464 : 80, y: fullSize ? 1248 : 80, width: 96, height: 96 };
    const clean = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = x - position.x;
            const dy = y - position.y;
            const stroke = graphic && ((dx > 15 && dx < 30 && dy > 10 && dy < 85) ||
                (dx > 24 && dx < 75 && dy > 50 && dy < 65));
            clean.data.set(stroke ? [30, 65, 70, 255] : [184, 230, 220, 255], (y * width + x) * 4);
        }
    }
    const input = { width, height, data: new Uint8ClampedArray(clean.data) };
    for (let y = 0; y < 96; y++) {
        for (let x = 0; x < 96; x++) {
            const opacity = alpha[y * 96 + x] * Math.abs(gain);
            const offset = ((position.y + y) * width + position.x + x) * 4;
            for (let channel = 0; channel < 3; channel++) input.data[offset + channel] = Math.round(
                clean.data[offset + channel] * (1 - opacity) + (gain < 0 ? 0 : 255) * opacity
            );
        }
    }
    return { clean, input, position };
}

async function readFixture(name) {
    const { data, info } = await sharp(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)))
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}

test('plane evidence identifies a full white watermark over structured flat artwork', () => {
    const { input, position } = fixture(1);
    assert.equal(measurePlaneAlphaEvidence(input, position, alpha)?.gain, 1);
});

test('plane evidence rejects clean, weak-white and dark controls', () => {
    for (const gain of [0, 0.3, 0.6, -1]) {
        const { input, position } = fixture(gain);
        assert.equal(measurePlaneAlphaEvidence(input, position, alpha), null, String(gain));
    }
});

test('plane evidence rejects insufficient neighborhood and wrong template geometry', () => {
    const { input, position } = fixture(1);
    assert.equal(measurePlaneAlphaEvidence(input, { ...position, x: 0 }, alpha), null);
    assert.equal(measurePlaneAlphaEvidence(input, { ...position, width: 48 }, alpha), null);
});

test('plane evidence rejects the issue123 dark-hole source collision', async () => {
    // Raw 160x160 crop centered on the exact R192 anchor of the public issue123 original.
    const input = await readFixture('issue123-plane-negative.png');
    assert.equal(measurePlaneAlphaEvidence(input, { x: 32, y: 32, width: 96, height: 96 }, alpha), null);
});

test('pipeline restores a known clean reference where whole-region correlation caused a skip', () => {
    const { clean, input, position } = fixture(1, true);
    const result = removeWatermarkFromImageDataSync(input);
    assert.equal(result.meta.applied, true);
    assert.deepEqual(result.meta.position, position);
    assert.equal(result.meta.alphaGain, 1);
    let error = 0;
    let outsideChanges = 0;
    for (let y = 0; y < input.height; y++) {
        for (let x = 0; x < input.width; x++) {
            const inside = x >= position.x && x < position.x + 96 && y >= position.y && y < position.y + 96;
            const offset = (y * input.width + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                if (inside) error += Math.abs(result.imageData.data[offset + channel] - clean.data[offset + channel]);
                else if (result.imageData.data[offset + channel] !== input.data[offset + channel]) outsideChanges++;
            }
        }
    }
    assert.ok(error / (96 * 96 * 3) < 0.5);
    assert.equal(outsideChanges, 0);
});

test('pipeline preserves the clean structured graphic', () => {
    const { clean, input } = fixture(0, true);
    assert.deepEqual(removeWatermarkFromImageDataSync(input).imageData.data, clean.data);
});

test('plane witness does not replace an already accepted 96px selection', () => {
    const { input } = fixture(1, true, false);
    const result = removeWatermarkFromImageDataSync(input);
    assert.equal(result.meta.applied, true);
    assert.ok(!result.meta.source.includes('plane-source-witness'));
});

test('pipeline selects exact96 for both issue120 source crops', async () => {
    // Unmodified 160x160 source crops, including the 32px ring used for validation.
    for (const name of ['issue120-plane-super.png', 'issue120-plane-tax.png']) {
        const crop = await readFixture(name);
        const { clean: input } = fixture(0, true, false);
        for (let row = 0; row < crop.height; row++) input.data.set(
            crop.data.subarray(row * crop.width * 4, (row + 1) * crop.width * 4),
            ((1216 + row) * input.width + 2432) * 4
        );
        const result = removeWatermarkFromImageDataSync(input);
        assert.equal(result.meta.applied, true, name);
        assert.deepEqual(result.meta.position, { x: 2464, y: 1248, width: 96, height: 96 }, name);
        assert.equal(result.meta.alphaGain, 1, name);
    }
});

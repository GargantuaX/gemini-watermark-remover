import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeImageDataInNode } from '../../scripts/sample-benchmark.js';
import { interpolateAlphaMap, warpAlphaMap } from '../../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import { removeWatermarkFromImageDataSync } from '../../src/sdk/image-data.js';
import { applySyntheticWatermark } from './syntheticWatermarkTestUtils.js';

// This crop contains clothing, not the source image's watermark. Only the
// known template added below is present in the constructed image.
async function createBackground(fixture = 'exact48-single-watermark-background.png', width = 768, height = 1376) {
    const crop = await decodeImageDataInNode(
        `tests/fixtures/${fixture}`
    );
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([80, 80, 80, 255], i);
    for (let y = 0; y < crop.height; y++) {
        data.set(
            crop.data.subarray(y * crop.width * 4, (y + 1) * crop.width * 4),
            ((height - crop.height + y) * width + width - crop.width) * 4
        );
    }
    return { width, height, data };
}

function measureError(actual, expected, position) {
    let total = 0;
    let count = 0;
    // Include the surrounding area so a smaller candidate cannot hide damage
    // by measuring only its own selected template.
    for (let y = position.y - 16; y < position.y + 64; y++) {
        for (let x = position.x - 16; x < position.x + 64; x++) {
            for (let channel = 0; channel < 3; channel++) {
                const index = (y * actual.width + x) * 4 + channel;
                total += Math.abs(actual.data[index] - expected.data[index]);
                count++;
            }
        }
    }
    return total / count;
}

for (const gain of [0.6, 1]) {
    test(`retain the exact48 candidate for a known single watermark at gain ${gain}`, async () => {
        const clean = await createBackground();
        const input = { ...clean, data: new Uint8ClampedArray(clean.data) };
        const position = { x: 624, y: 1232, width: 48, height: 48 };
        const alpha = Float32Array.from(getEmbeddedAlphaMap(48), value => value * gain);
        applySyntheticWatermark(input, alpha, position, 1);

        const result = removeWatermarkFromImageDataSync(input);
        assert.equal(result.meta.applied, true);
        assert.deepEqual(result.meta.position, position);
        const error = measureError(result.imageData, clean, position);
        assert.ok(error < 1, `known-background error=${error}; source=${result.meta.source}`);
    });
}

test('adding an exact48 witness must preserve the existing conservative candidate', async () => {
    const input = await createBackground('exact48-conservative-dark-background.png', 1376, 768);
    const completed = [];
    const result = removeWatermarkFromImageDataSync(input, {
        onCandidateCompleted: candidate => completed.push(candidate.hypothesis)
    });
    assert.ok(completed.some(hypothesis =>
        hypothesis.trial?.provenance?.topNConservative === true &&
        hypothesis.alphaGain === 0.25 && hypothesis.position.width === 48
    ), 'the supplementary witness must not evict the established weak-strength candidate');
    assert.deepEqual(result.meta.position, { x: 1232, y: 624, width: 48, height: 48 });
    assert.equal(result.meta.alphaGain, 0.25);
});

test('localize a white landscape V2 medium watermark on texture without altering the surrounding pixels', async () => {
    const source = await decodeImageDataInNode('src/assets/samples/4-3.png');
    const width = 1376;
    const height = 768;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([135, 129, 121, 255], i);
    for (let row = 0; row < 178; row++) {
        // Use the upper-left texture, outside the sample's watermark area.
        const start = ((row + 26) * source.width + 30) * 4;
        data.set(source.data.subarray(start, start + 200 * 4),
            ((height - 178 + row) * width + width - 200) * 4);
    }
    const clean = { width, height, data };
    const input = { ...clean, data: data.slice() };
    const position = { x: 1255, y: 647, width: 48, height: 48 };
    const template = interpolateAlphaMap(getEmbeddedAlphaMap('36-v2'), 36, 48);
    const shifted = warpAlphaMap(template, 48, { dx: 0.18, dy: 0.37, scale: 0.99 });
    applySyntheticWatermark(input, shifted.map(value => 0.78 * value), position);

    const result = removeWatermarkFromImageDataSync(input);
    assert.deepEqual(result.meta.position, position);
    assert.equal(result.meta.config.alphaVariant, 'v2');
    assert.ok(measureError(result.imageData, clean, position) <
        measureError(input, clean, position) * 0.2);
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        const end = row + width * 4;
        const outside = y < position.y || y >= position.y + position.height
            ? [[row, end]]
            : [[row, row + position.x * 4], [row + (position.x + 48) * 4, end]];
        for (const [start, stop] of outside) {
            assert.deepEqual(result.imageData.data.subarray(start, stop), data.subarray(start, stop));
        }
    }

    const unmarked = removeWatermarkFromImageDataSync(clean);
    assert.equal(unmarked.meta.applied, false);
    assert.deepEqual(unmarked.imageData.data, data);
});

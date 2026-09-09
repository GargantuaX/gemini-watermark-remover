import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeImageDataInNode } from '../../scripts/sample-benchmark.js';
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

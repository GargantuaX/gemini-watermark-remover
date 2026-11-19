import assert from 'node:assert/strict';
import test from 'node:test';
import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import { findVerifiedV2LocalGeometry } from '../../src/core/v2LocalGeometry.js';

test('V2 local search recovers a verified 48px contour outside the seed-sized search radius', () => {
    const width = 200;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4);
    const seed = {x: 100, y: 110, width: 26, height: 26};
    const position = {x: 90, y: 109, width: 48, height: 48};
    const image = {width, height, data};
    for (let pixel = 0; pixel < width * height; pixel++) {
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const value = 115 + 12 * Math.sin(x / 9) + 7 * Math.cos(y / 6);
        data.set([value, value, value, 255], pixel * 4);
    }

    const alpha = getEmbeddedAlphaMap(48);
    for (let i = 0; i < alpha.length; i++) {
        const x = position.x + i % 48;
        const y = position.y + Math.floor(i / 48);
        const offset = (y * width + x) * 4;
        const value = data[offset] + (255 - data[offset]) * alpha[i] * 0.8;
        data.set([value, value, value], offset);
    }

    const seedCenteredY = seed.y + (seed.height - position.height) / 2;
    assert.ok(position.y - seedCenteredY > Math.ceil(seed.height / 4));
    assert.deepEqual(findVerifiedV2LocalGeometry(image, seed), {position, seedVerified: false});
});

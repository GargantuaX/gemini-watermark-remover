import test from 'node:test';
import assert from 'node:assert/strict';
import { refineV2MediumEdge } from '../../src/core/v2MediumEdgeRefinement.js';
import { interpolateAlphaMap } from '../../src/core/adaptiveDetector.js';
import { removeWatermark } from '../../src/core/blendModes.js';
import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import { applySyntheticWatermark } from './syntheticWatermarkTestUtils.js';

const position = { x: 1255, y: 647, width: 48, height: 48 };
const v2 = interpolateAlphaMap(getEmbeddedAlphaMap('36-v2'), 36, 48);

function makeSample(alpha) {
    const width = 1376, height = 768;
    const data = new Uint8ClampedArray(width * height * 4).fill(150);
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const offset = ((position.y + row) * width + position.x + col) * 4;
            const texture = (row + col) % 4;
            data.set([148 + texture, 152 + texture, 156 + texture, 255], offset);
        }
    }
    const truth = { width, height, data };
    const source = { ...truth, data: data.slice() };
    applySyntheticWatermark(source, alpha, position);
    const baseline = { ...truth, data: source.data.slice() };
    removeWatermark(baseline, v2, position);
    const meta = {
        applied: true,
        config: { alphaVariant: 'v2' },
        position: { ...position },
        alphaGain: 1,
        source: 'standard+confirmed-v2-medium-rescue',
        detection: { originalSpatialScore: 0.7, processedSpatialScore: 0.1, processedGradientScore: 0.2 }
    };
    return { truth, source, baseline, meta };
}

function error(actual, expected) {
    return actual.data.reduce((total, value, i) => total + Math.abs(value - expected.data[i]), 0);
}

test('shared V2 edge fit improves the matched contour and keeps the selected geometry', () => {
    const narrow = getEmbeddedAlphaMap(48).map(value => value >= 4 / 255 ? value * 0.61 : 0);
    const { truth, source, baseline, meta } = makeSample(narrow);
    const before = error(baseline, truth);
    refineV2MediumEdge(source, baseline, meta);

    assert.ok(meta.edgeRefinement);
    assert.ok(error(baseline, truth) < before);
    assert.deepEqual(meta.position, position);
    assert.equal(meta.alphaGain, 1);
    assert.equal(meta.edgeRefinement.beforeLoss.length, 2);
    assert.ok(meta.edgeRefinement.afterLoss.every((loss, i) => loss < 0.95 * meta.edgeRefinement.beforeLoss[i]));
    for (let y = 0; y < truth.height; y++) {
        const start = y * truth.width * 4;
        const stop = start + truth.width * 4;
        const inside = y >= position.y && y < position.y + position.height;
        const unchanged = inside
            ? [[start, start + position.x * 4], [start + (position.x + position.width) * 4, stop]]
            : [[start, stop]];
        for (const [from, to] of unchanged) {
            assert.deepEqual(baseline.data.subarray(from, to), source.data.subarray(from, to));
        }
    }
});

test('shared V2 edge fit leaves a well-matched V2 alpha and other routes alone', () => {
    const canonical = v2.map(value => value - 3 / 255 >= 0.002 ? value : 0);
    const { source, baseline, meta } = makeSample(canonical);
    const previous = baseline.data.slice();
    refineV2MediumEdge(source, baseline, meta);
    assert.equal(meta.edgeRefinement, undefined);
    assert.deepEqual(baseline.data, previous);

    const narrow = getEmbeddedAlphaMap(48).map(value => value * 0.61);
    const other = makeSample(narrow);
    other.meta.source = 'standard+catalog+validated';
    const unrefined = other.baseline.data.slice();
    refineV2MediumEdge(other.source, other.baseline, other.meta);
    assert.equal(other.meta.edgeRefinement, undefined);
    assert.deepEqual(other.baseline.data, unrefined);
});

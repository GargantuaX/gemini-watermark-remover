import test from 'node:test';
import assert from 'node:assert/strict';

import { interpolateAlphaMap } from '../../src/core/adaptiveDetector.js';
import { measureAlphaInteriorProjection } from '../../scripts/alpha-interior-projection.js';
import {
    classifyExternalBenchmarkCase,
    evaluateExternalBenchmarkContourResidual,
    evaluateExternalBenchmarkInteriorResidual,
    resolveExternalBenchmarkShadowGeometry
} from '../../scripts/run-external-gemini-watermark-sample-benchmark.js';

function createImageData(width, height, fill = [100, 100, 100]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) {
        const offset = index * 4;
        data[offset] = fill[0];
        data[offset + 1] = fill[1];
        data[offset + 2] = fill[2];
        data[offset + 3] = 255;
    }
    return { width, height, data };
}

function createDiamondAlpha(size) {
    const alphaMap = new Float32Array(size * size);
    const center = (size - 1) / 2;
    const radius = size * 0.38;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const distance = Math.abs(x - center) + Math.abs(y - center);
            alphaMap[y * size + x] = Math.max(0, Math.min(1, 1 - distance / radius));
        }
    }
    return alphaMap;
}

function paintColoredContour(imageData, alphaMap, position) {
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            const alpha = alphaMap[y * position.width + x];
            if (alpha < 0.08 || alpha > 0.45) continue;
            const offset = ((position.y + y) * imageData.width + position.x + x) * 4;
            imageData.data[offset] = 185;
            imageData.data[offset + 1] = 82;
            imageData.data[offset + 2] = 38;
        }
    }
}

function paintDarkInterior(imageData, alphaMap, position) {
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            const alpha = alphaMap[y * position.width + x];
            const value = Math.round(100 - alpha * 60);
            const offset = ((position.y + y) * imageData.width + position.x + x) * 4;
            imageData.data[offset] = value;
            imageData.data[offset + 1] = value;
            imageData.data[offset + 2] = value;
        }
    }
}

test('external benchmark should expose contour residual as shadow-only metrics', () => {
    const imageData = createImageData(64, 64);
    const position = { x: 24, y: 24, width: 16, height: 16 };
    const alphaMap = createDiamondAlpha(position.width);
    paintColoredContour(imageData, alphaMap, position);

    const result = evaluateExternalBenchmarkContourResidual({
        imageData,
        alphaMaps: {
            alpha96Variants: {},
            getAlphaMap: (size) => size === position.width ? alphaMap : null
        },
        meta: {
            position,
            config: { logoSize: position.width }
        }
    });

    assert.equal(result.status, 'measured');
    assert.equal(result.flagged, true);
    assert.ok(result.reasons.includes('chroma-edge-ratio'));
    assert.ok(result.metrics.chromaEdgeRatio >= 3);
});

test('external benchmark contour shadow metric should remain available-safe when geometry is absent', () => {
    assert.deepEqual(evaluateExternalBenchmarkContourResidual({
        imageData: createImageData(16, 16),
        alphaMaps: { alpha96Variants: {}, getAlphaMap: () => null },
        meta: {}
    }), {
        status: 'unavailable',
        reason: 'missing-watermark-geometry',
        flagged: false,
        reasons: [],
        metrics: null
    });
});

test('external benchmark shadow geometry should reproduce the blind-review fallback anchors', () => {
    assert.deepEqual(resolveExternalBenchmarkShadowGeometry({
        imageData: createImageData(1364, 768),
        meta: {}
    }), {
        position: { x: 1220, y: 624, width: 48, height: 48 },
        source: 'review-fallback'
    });
    assert.deepEqual(resolveExternalBenchmarkShadowGeometry({
        imageData: createImageData(3120, 4208),
        meta: {}
    }), {
        position: { x: 2832, y: 3920, width: 96, height: 96 },
        source: 'review-fallback'
    });
    const pipelinePosition = { x: 10, y: 20, width: 48, height: 48 };
    assert.deepEqual(resolveExternalBenchmarkShadowGeometry({
        imageData: createImageData(128, 128),
        meta: { position: pipelinePosition }
    }), {
        position: pipelinePosition,
        source: 'pipeline'
    });
});

test('external benchmark should report provisional luma interior residual without changing release status', () => {
    const imageData = createImageData(64, 64);
    const position = { x: 24, y: 24, width: 16, height: 16 };
    const alphaMap = createDiamondAlpha(position.width);
    paintDarkInterior(imageData, alphaMap, position);

    const result = evaluateExternalBenchmarkInteriorResidual({
        imageData,
        alphaMaps: {
            alpha96Variants: {},
            getAlphaMap: (size) => size === position.width ? alphaMap : null
        },
        meta: {
            position,
            config: { logoSize: position.width }
        }
    });

    assert.equal(result.status, 'measured');
    assert.equal(result.flagged, true);
    assert.equal(result.evidenceStatus, 'provisional');
    assert.ok(result.reasons.includes('luma-interior-projection-ratio'));
});

test('external benchmark shadow metrics should resize the selected alpha variant', () => {
    const imageData = createImageData(64, 64);
    const position = { x: 24, y: 24, width: 16, height: 16 };
    const variantMap = createDiamondAlpha(8);
    const resizedVariant = interpolateAlphaMap(variantMap, 8, position.width);
    paintDarkInterior(imageData, resizedVariant, position);
    const fallbackMap = new Float32Array(position.width * position.height);

    const result = evaluateExternalBenchmarkInteriorResidual({
        imageData,
        alphaMaps: {
            alpha96Variants: { scaled: variantMap },
            getAlphaMap: () => fallbackMap
        },
        meta: {
            position,
            config: { logoSize: position.width, alphaVariant: 'scaled' }
        }
    });
    const expected = measureAlphaInteriorProjection({
        imageData,
        alphaMap: resizedVariant,
        position
    });

    assert.equal(result.status, 'measured');
    assert.ok(Math.abs(
        result.metrics.lumaProjectionRatio - expected.lumaProjectionRatio
    ) < 1e-12);
});

test('contour shadow flags must not change the external benchmark release classification', () => {
    const record = {
        applied: true,
        actualAnchor: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        alphaGain: 1,
        residualScore: 0.1,
        processedGradientScore: 0.1,
        originalSpatialScore: 0.5,
        originalGradientScore: 0.5,
        suppressionGain: 0.5,
        qualityStatus: 'pass',
        selectionDamageSafe: true,
        decisionTier: 'direct-match',
        contourResidualShadow: {
            status: 'measured',
            flagged: true,
            reasons: ['rgb-edge-ratio']
        }
    };

    assert.deepEqual(classifyExternalBenchmarkCase(record), {
        status: 'pass',
        bucket: 'pass'
    });
});

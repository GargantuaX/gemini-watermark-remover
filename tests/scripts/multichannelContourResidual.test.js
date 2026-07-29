import test from 'node:test';
import assert from 'node:assert/strict';

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

test('multichannel contour metric should expose a localized colored outline missed by luminance-only scoring', async () => {
    const {
        classifyHighPrecisionContourResidual,
        measureMultichannelContourResidual
    } = await import('../../scripts/multichannel-contour-residual.js');
    const imageData = createImageData(64, 64);
    const position = { x: 24, y: 24, width: 16, height: 16 };
    const alphaMap = createDiamondAlpha(position.width);
    paintColoredContour(imageData, alphaMap, position);

    const metrics = measureMultichannelContourResidual({
        imageData,
        alphaMap,
        position
    });
    const classification = classifyHighPrecisionContourResidual(metrics);

    assert.ok(metrics.chromaEdgeRatio >= 3, `ratio=${metrics.chromaEdgeRatio}`);
    assert.equal(classification.flagged, true);
    assert.ok(classification.reasons.includes('chroma-edge-ratio'));
});

test('multichannel contour metric should not treat uniform output as a residual', async () => {
    const {
        classifyHighPrecisionContourResidual,
        measureMultichannelContourResidual
    } = await import('../../scripts/multichannel-contour-residual.js');
    const imageData = createImageData(64, 64);
    const position = { x: 24, y: 24, width: 16, height: 16 };
    const alphaMap = createDiamondAlpha(position.width);

    const metrics = measureMultichannelContourResidual({
        imageData,
        alphaMap,
        position
    });

    assert.equal(metrics.rgbEdgeTarget, 0);
    assert.equal(metrics.chromaEdgeTarget, 0);
    assert.deepEqual(classifyHighPrecisionContourResidual(metrics), {
        flagged: false,
        reasons: []
    });
});

test('high precision contour classifier should enforce the preregistered inclusive thresholds', async () => {
    const { classifyHighPrecisionContourResidual } = await import(
        '../../scripts/multichannel-contour-residual.js'
    );

    assert.deepEqual(
        classifyHighPrecisionContourResidual({
            chromaEdgeRatio: 2.99,
            rgbEdgeRatio: 1.99
        }),
        { flagged: false, reasons: [] }
    );
    assert.deepEqual(
        classifyHighPrecisionContourResidual({
            chromaEdgeRatio: 3,
            rgbEdgeRatio: 1
        }),
        { flagged: true, reasons: ['chroma-edge-ratio'] }
    );
    assert.deepEqual(
        classifyHighPrecisionContourResidual({
            chromaEdgeRatio: 1,
            rgbEdgeRatio: 2
        }),
        { flagged: true, reasons: ['rgb-edge-ratio'] }
    );
});

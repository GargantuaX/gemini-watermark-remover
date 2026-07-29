import test from 'node:test';
import assert from 'node:assert/strict';

function createImageData(width, height, value = 120) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) {
        const offset = index * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
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

function paintDarkInterior(imageData, alphaMap, position) {
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            const alpha = alphaMap[y * position.width + x];
            const value = Math.round(120 - alpha * 70);
            const offset = ((position.y + y) * imageData.width + position.x + x) * 4;
            imageData.data[offset] = value;
            imageData.data[offset + 1] = value;
            imageData.data[offset + 2] = value;
        }
    }
}

test('luma interior projection should flag a watermark-shaped dark fill', async () => {
    const {
        classifyProvisionalLumaInteriorResidual,
        measureAlphaInteriorProjection
    } = await import('../../scripts/alpha-interior-projection.js');
    const imageData = createImageData(64, 64);
    const position = { x: 24, y: 24, width: 16, height: 16 };
    const alphaMap = createDiamondAlpha(position.width);
    paintDarkInterior(imageData, alphaMap, position);

    const metrics = measureAlphaInteriorProjection({ imageData, alphaMap, position });
    const classification = classifyProvisionalLumaInteriorResidual(metrics);

    assert.ok(metrics.lumaProjectionRatio >= 1.5, `${metrics.lumaProjectionRatio}`);
    assert.deepEqual(classification, {
        flagged: true,
        reasons: ['luma-interior-projection-ratio'],
        evidenceStatus: 'provisional'
    });
});

test('luma interior projection should not flag a uniform output', async () => {
    const {
        classifyProvisionalLumaInteriorResidual,
        measureAlphaInteriorProjection
    } = await import('../../scripts/alpha-interior-projection.js');
    const imageData = createImageData(64, 64);
    const position = { x: 24, y: 24, width: 16, height: 16 };
    const alphaMap = createDiamondAlpha(position.width);

    const metrics = measureAlphaInteriorProjection({ imageData, alphaMap, position });

    assert.equal(metrics.lumaProjectionTarget, 0);
    assert.equal(metrics.lumaProjectionRatio, 0);
    assert.deepEqual(classifyProvisionalLumaInteriorResidual(metrics), {
        flagged: false,
        reasons: [],
        evidenceStatus: 'provisional'
    });
});

test('provisional luma interior classifier should use the frozen inclusive threshold', async () => {
    const { classifyProvisionalLumaInteriorResidual } = await import(
        '../../scripts/alpha-interior-projection.js'
    );

    assert.equal(
        classifyProvisionalLumaInteriorResidual({ lumaProjectionRatio: 1.49 }).flagged,
        false
    );
    assert.equal(
        classifyProvisionalLumaInteriorResidual({ lumaProjectionRatio: 1.5 }).flagged,
        true
    );
});

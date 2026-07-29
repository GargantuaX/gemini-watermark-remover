import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    createImageCleanlinessPixelFeatureReport,
    measureImageCleanlinessPixelFeatures
} from '../../scripts/create-image-cleanliness-pixel-feature-report.js';

test('pixel features preserve before and after contour evidence instead of scoring output alone', () => {
    const width = 40;
    const height = 40;
    const position = { x: 12, y: 12, width: 16, height: 16 };
    const alphaMap = createDiamondAlpha(position.width);
    const beforeImageData = createImageData(width, height, 120);
    const afterImageData = createImageData(width, height, 120);
    paintAlphaEdge(afterImageData, alphaMap, position, 70);

    const features = measureImageCleanlinessPixelFeatures({
        beforeImageData,
        afterImageData,
        alphaMap,
        position
    });

    assert.equal(features.before.rgbContourRatio, 0);
    assert.ok(features.after.rgbContourRatio > 1);
    assert.ok(features.contourRetention > 1);
    assert.ok(Number.isFinite(features.after.lumaInteriorProjectionRatio));
});

test('texture retention drops when watermark support is flattened but stays near one when unchanged', () => {
    const width = 40;
    const height = 40;
    const position = { x: 12, y: 12, width: 16, height: 16 };
    const alphaMap = createDiamondAlpha(position.width);
    const textured = createImageData(width, height, 120);
    paintCheckerTexture(textured, alphaMap, position, 55);
    const flattened = cloneImageData(textured);
    flattenAlphaSupport(flattened, alphaMap, position, 120);

    const unchangedFeatures = measureImageCleanlinessPixelFeatures({
        beforeImageData: textured,
        afterImageData: cloneImageData(textured),
        alphaMap,
        position
    });
    const flattenedFeatures = measureImageCleanlinessPixelFeatures({
        beforeImageData: textured,
        afterImageData: flattened,
        alphaMap,
        position
    });

    assert.ok(Math.abs(unchangedFeatures.texture.energyRetention - 1) < 1e-9);
    assert.ok(flattenedFeatures.texture.energyRetention < 0.2);
    assert.ok(flattenedFeatures.texture.energyLoss > 0.8);
});

test('feature report writer joins the blind manifest and persists measured rows', async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'gwr-pixel-features-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const manifestPath = path.join(workspace, 'manifest.json');
    const outputPath = path.join(workspace, 'features', 'latest-report.json');
    const position = { x: 12, y: 12, width: 16, height: 16 };
    const alphaMap = createDiamondAlpha(position.width);
    const before = createImageData(40, 40, 120);
    const after = cloneImageData(before);
    paintAlphaEdge(after, alphaMap, position, 70);
    await writeFile(
        manifestPath,
        JSON.stringify({
            rows: [
                {
                    blindId: 'B001',
                    fileName: 'sample.png',
                    filePath: 'before.png',
                    fullOutputPath: 'after.png',
                    position
                }
            ]
        })
    );

    const report = await createImageCleanlinessPixelFeatureReport({
        manifestPath,
        outputPath,
        decodeImage: async (filePath) => (filePath === 'before.png' ? before : after),
        getAlphaMap: (size) => (size === 16 ? alphaMap : null)
    });

    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.measured, 1);
    assert.equal(report.rows[0].blindId, 'B001');
    assert.ok(report.rows[0].features.after.rgbContourRatio > 1);
    const written = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.deepEqual(written.rows, report.rows);
});

function createImageData(width, height, value) {
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

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function createDiamondAlpha(size) {
    const alphaMap = new Float32Array(size * size);
    const center = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const distance = Math.abs(x - center) + Math.abs(y - center);
            alphaMap[y * size + x] = Math.max(0, 1 - distance / (size * 0.38));
        }
    }
    return alphaMap;
}

function paintAlphaEdge(imageData, alphaMap, position, delta) {
    for (let y = 1; y < position.height - 1; y++) {
        for (let x = 1; x < position.width - 1; x++) {
            const index = y * position.width + x;
            const edge = Math.max(
                Math.abs(alphaMap[index + 1] - alphaMap[index - 1]),
                Math.abs(alphaMap[index + position.width] - alphaMap[index - position.width])
            );
            if (edge < 0.08) continue;
            setPixel(imageData, position.x + x, position.y + y, 120 - delta);
        }
    }
}

function paintCheckerTexture(imageData, alphaMap, position, delta) {
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            if (alphaMap[y * position.width + x] < 0.2) continue;
            setPixel(
                imageData,
                position.x + x,
                position.y + y,
                120 + ((x + y) % 2 === 0 ? delta : -delta)
            );
        }
    }
}

function flattenAlphaSupport(imageData, alphaMap, position, value) {
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            if (alphaMap[y * position.width + x] < 0.2) continue;
            setPixel(imageData, position.x + x, position.y + y, value);
        }
    }
}

function setPixel(imageData, x, y, value) {
    const offset = (y * imageData.width + x) * 4;
    imageData.data[offset] = value;
    imageData.data[offset + 1] = value;
    imageData.data[offset + 2] = value;
}

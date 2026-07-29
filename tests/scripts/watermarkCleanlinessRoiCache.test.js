import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

let roiCache = {};
try {
    roiCache = await import(
        '../../scripts/watermark-cleanliness-roi-cache.js'
    );
} catch {
    // The first TDD run intentionally precedes the implementation module.
}

function createImageData(width, height, redOffset = 0) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * 10 + x;
            const offset = (y * width + x) * 4;
            data[offset] = redOffset + pixel;
            data[offset + 1] = 100 + pixel;
            data[offset + 2] = 200 + pixel;
            data[offset + 3] = 255;
        }
    }
    return { width, height, data };
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

test('writes exact lossless source, processed, and alpha ROI evidence', async () => {
    assert.equal(
        typeof roiCache.writeWatermarkCleanlinessRoiCacheEntry,
        'function',
        'writeWatermarkCleanlinessRoiCacheEntry must be exported'
    );
    const outputDir = await mkdtemp(
        path.join(os.tmpdir(), 'gwr-cleanliness-roi-cache-')
    );
    try {
        const result =
            await roiCache.writeWatermarkCleanlinessRoiCacheEntry({
                outputDir,
                id: 'case-1',
                sourceImageData: createImageData(4, 3),
                processedImageData: createImageData(4, 3, 40),
                position: { x: 1, y: 1, width: 2, height: 2 },
                alphaMap: new Float32Array([0, 0.25, 0.5, 1]),
                metadata: {
                    sourceSha256: 'source-file-hash',
                    alphaProfileId: 'fixture-alpha'
                }
            });
        const sourceBuffer = await readFile(result.sourceRoiPath);
        const processedBuffer = await readFile(result.processedRoiPath);
        const alphaBuffer = await readFile(result.alphaMapPath);
        const metadata = JSON.parse(
            await readFile(result.metadataPath, 'utf8')
        );
        const source = await sharp(sourceBuffer).raw().toBuffer({
            resolveWithObject: true
        });
        const processed = await sharp(processedBuffer).raw().toBuffer({
            resolveWithObject: true
        });

        assert.deepEqual(
            { width: source.info.width, height: source.info.height },
            { width: 2, height: 2 }
        );
        assert.deepEqual([...source.data.subarray(0, 4)], [11, 111, 211, 255]);
        assert.deepEqual([...processed.data.subarray(0, 4)], [51, 111, 211, 255]);
        assert.equal(alphaBuffer.length, 4 * Float32Array.BYTES_PER_ELEMENT);
        assert.deepEqual(
            [0, 1, 2, 3].map((index) =>
                alphaBuffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
            ),
            [0, 0.25, 0.5, 1]
        );
        assert.deepEqual(metadata.originalPosition, {
            x: 1,
            y: 1,
            width: 2,
            height: 2
        });
        assert.deepEqual(metadata.cachedPosition, {
            x: 0,
            y: 0,
            width: 2,
            height: 2
        });
        assert.equal(metadata.sourceRoiSha256, sha256(sourceBuffer));
        assert.equal(metadata.processedRoiSha256, sha256(processedBuffer));
        assert.equal(metadata.alphaMapSha256, sha256(alphaBuffer));
        assert.equal(metadata.sourceSha256, 'source-file-hash');
        assert.equal(metadata.alphaProfileId, 'fixture-alpha');
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
});

test('rejects an alpha map that does not match the ROI before writing', async () => {
    const outputDir = await mkdtemp(
        path.join(os.tmpdir(), 'gwr-cleanliness-roi-cache-invalid-')
    );
    try {
        await assert.rejects(
            () => roiCache.writeWatermarkCleanlinessRoiCacheEntry({
                outputDir,
                id: 'invalid',
                sourceImageData: createImageData(4, 3),
                processedImageData: createImageData(4, 3),
                position: { x: 1, y: 1, width: 2, height: 2 },
                alphaMap: new Float32Array(3),
                metadata: {}
            }),
            /alphaMap length must match position/
        );
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
});

test('reads a frozen ROI entry back into scoreable image and alpha data', async () => {
    assert.equal(
        typeof roiCache.readWatermarkCleanlinessRoiCacheEntry,
        'function',
        'readWatermarkCleanlinessRoiCacheEntry must be exported'
    );
    const outputDir = await mkdtemp(
        path.join(os.tmpdir(), 'gwr-cleanliness-roi-replay-')
    );
    try {
        const written =
            await roiCache.writeWatermarkCleanlinessRoiCacheEntry({
                outputDir,
                id: 'replay',
                sourceImageData: createImageData(4, 3),
                processedImageData: createImageData(4, 3, 40),
                position: { x: 1, y: 1, width: 2, height: 2 },
                alphaMap: new Float32Array([0, 0.25, 0.5, 1]),
                metadata: { sourceSha256: 'source-file-hash' }
            });
        const replayed =
            await roiCache.readWatermarkCleanlinessRoiCacheEntry(
                written.metadataPath
            );

        assert.deepEqual(
            {
                width: replayed.processedImageData.width,
                height: replayed.processedImageData.height,
                firstPixel: [...replayed.processedImageData.data.subarray(0, 4)]
            },
            { width: 2, height: 2, firstPixel: [51, 111, 211, 255] }
        );
        assert.deepEqual([...replayed.alphaMap], [0, 0.25, 0.5, 1]);
        assert.deepEqual(replayed.position, {
            x: 0,
            y: 0,
            width: 2,
            height: 2
        });
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
});

test('rejects a tampered processed ROI before decoding it', async () => {
    const outputDir = await mkdtemp(
        path.join(os.tmpdir(), 'gwr-cleanliness-roi-tamper-')
    );
    try {
        const written =
            await roiCache.writeWatermarkCleanlinessRoiCacheEntry({
                outputDir,
                id: 'tampered',
                sourceImageData: createImageData(4, 3),
                processedImageData: createImageData(4, 3, 40),
                position: { x: 1, y: 1, width: 2, height: 2 },
                alphaMap: new Float32Array([0, 0.25, 0.5, 1]),
                metadata: {}
            });
        await writeFile(written.processedRoiPath, Buffer.from('tampered'));

        await assert.rejects(
            () => roiCache.readWatermarkCleanlinessRoiCacheEntry(
                written.metadataPath
            ),
            /processed ROI sha256 mismatch/
        );
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
});

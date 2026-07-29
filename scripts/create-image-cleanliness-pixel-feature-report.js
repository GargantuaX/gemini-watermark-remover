import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { measureAlphaInteriorProjection } from './alpha-interior-projection.js';
import { measureMultichannelContourResidual } from './multichannel-contour-residual.js';
import { decodeImageDataInNode } from './sample-benchmark.js';
import { resolveExternalBenchmarkAlphaMaps } from './run-external-gemini-watermark-sample-benchmark.js';

const TEXTURE_ALPHA_THRESHOLD = 0.2;

export function measureImageCleanlinessPixelFeatures({
    beforeImageData,
    afterImageData,
    alphaMap,
    position
}) {
    assertMatchingImages(beforeImageData, afterImageData);
    const beforeContour = measureMultichannelContourResidual({
        imageData: beforeImageData,
        alphaMap,
        position
    });
    const afterContour = measureMultichannelContourResidual({
        imageData: afterImageData,
        alphaMap,
        position
    });
    const interior = measureAlphaInteriorProjection({
        imageData: afterImageData,
        alphaMap,
        position
    });
    const beforeTextureEnergy = measureSupportTextureEnergy({
        imageData: beforeImageData,
        alphaMap,
        position
    });
    const afterTextureEnergy = measureSupportTextureEnergy({
        imageData: afterImageData,
        alphaMap,
        position
    });
    const textureRetention =
        beforeTextureEnergy > Number.EPSILON
            ? afterTextureEnergy / beforeTextureEnergy
            : null;

    return {
        before: {
            rgbContourRatio: beforeContour.rgbEdgeRatio,
            chromaContourRatio: beforeContour.chromaEdgeRatio
        },
        after: {
            rgbContourRatio: afterContour.rgbEdgeRatio,
            chromaContourRatio: afterContour.chromaEdgeRatio,
            lumaInteriorProjectionRatio: interior.lumaProjectionRatio,
            lumaInteriorProjectionTarget: interior.lumaProjectionTarget
        },
        contourRetention:
            afterContour.rgbEdgeRatio / Math.max(0.05, beforeContour.rgbEdgeRatio),
        texture: {
            beforeEnergy: beforeTextureEnergy,
            afterEnergy: afterTextureEnergy,
            energyRetention: textureRetention,
            energyLoss: textureRetention === null ? 0 : Math.max(0, 1 - textureRetention)
        }
    };
}

export async function createImageCleanlinessPixelFeatureReport({
    manifestPath,
    outputPath,
    decodeImage = decodeImageDataInNode,
    getAlphaMap = null
}) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!Array.isArray(manifest?.rows)) throw new Error('manifest rows are required');
    const alphaMaps = getAlphaMap ? null : resolveExternalBenchmarkAlphaMaps();
    const resolveAlphaMap = getAlphaMap ?? ((size) => alphaMaps.getAlphaMap(size));
    const rows = [];

    for (const row of manifest.rows) {
        try {
            const position = row.position;
            const alphaMap = position ? resolveAlphaMap(position.width) : null;
            if (!position || !alphaMap) throw new Error('watermark geometry or alpha map is missing');
            const [beforeImageData, afterImageData] = await Promise.all([
                decodeImage(row.filePath),
                decodeImage(row.fullOutputPath)
            ]);
            rows.push({
                blindId: row.blindId,
                fileName: row.fileName,
                status: 'measured',
                features: measureImageCleanlinessPixelFeatures({
                    beforeImageData,
                    afterImageData,
                    alphaMap,
                    position
                })
            });
        } catch (error) {
            rows.push({
                blindId: row.blindId,
                fileName: row.fileName,
                status: 'unavailable',
                reason: error instanceof Error ? error.message : String(error),
                features: null
            });
        }
    }

    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        policy: {
            purpose: 'experimental-shadow-metric',
            blocksOutput: false,
            textureAlphaThreshold: TEXTURE_ALPHA_THRESHOLD
        },
        summary: {
            total: rows.length,
            measured: rows.filter((row) => row.status === 'measured').length,
            unavailable: rows.filter((row) => row.status !== 'measured').length
        },
        rows
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
}

function measureSupportTextureEnergy({ imageData, alphaMap, position }) {
    let total = 0;
    let count = 0;
    for (let y = 1; y < position.height - 1; y++) {
        for (let x = 1; x < position.width - 1; x++) {
            const index = y * position.width + x;
            if (
                alphaMap[index] < TEXTURE_ALPHA_THRESHOLD ||
                alphaMap[index - 1] < TEXTURE_ALPHA_THRESHOLD ||
                alphaMap[index + 1] < TEXTURE_ALPHA_THRESHOLD ||
                alphaMap[index - position.width] < TEXTURE_ALPHA_THRESHOLD ||
                alphaMap[index + position.width] < TEXTURE_ALPHA_THRESHOLD
            ) {
                continue;
            }
            const globalX = position.x + x;
            const globalY = position.y + y;
            const center = luminanceAt(imageData, globalX, globalY);
            const neighborMean =
                (luminanceAt(imageData, globalX - 1, globalY) +
                    luminanceAt(imageData, globalX + 1, globalY) +
                    luminanceAt(imageData, globalX, globalY - 1) +
                    luminanceAt(imageData, globalX, globalY + 1)) /
                4;
            const highPass = center - neighborMean;
            total += highPass * highPass;
            count += 1;
        }
    }
    return count > 0 ? total / count : 0;
}

function luminanceAt(imageData, x, y) {
    const offset = (y * imageData.width + x) * 4;
    return (
        imageData.data[offset] * 0.2126 +
        imageData.data[offset + 1] * 0.7152 +
        imageData.data[offset + 2] * 0.0722
    );
}

function assertMatchingImages(beforeImageData, afterImageData) {
    if (
        !beforeImageData?.data ||
        !afterImageData?.data ||
        beforeImageData.width !== afterImageData.width ||
        beforeImageData.height !== afterImageData.height
    ) {
        throw new RangeError('before and after image dimensions must match');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
        const flag = process.argv[index];
        const value = process.argv[index + 1];
        if (!flag?.startsWith('--') || !value) throw new Error(`invalid argument: ${flag}`);
        options[flag.slice(2)] = value;
    }
    if (!options.manifest) throw new Error('--manifest is required');
    if (!options.output) throw new Error('--output is required');
    const report = await createImageCleanlinessPixelFeatureReport({
        manifestPath: options.manifest,
        outputPath: options.output
    });
    console.log(JSON.stringify(report.summary, null, 2));
}

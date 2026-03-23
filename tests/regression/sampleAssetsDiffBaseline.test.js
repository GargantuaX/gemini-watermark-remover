import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import { chromium } from 'playwright';

import { buildFixedOutputPath } from '../../scripts/export-fixed-samples.js';
import {
    decodeImageDataInPage,
    exists,
    inferMimeType,
    isMissingPlaywrightExecutableError,
    readImageDataUrl
} from './sampleAssetTestUtils.js';

const ROOT_DIR = process.cwd();
const SAMPLE_DIR = path.resolve(ROOT_DIR, 'src/assets/samples');
const BG48_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_48.png');
const BG96_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_96.png');
const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg']);
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
};

const LOSSY_BASELINE_TOLERANCE = Object.freeze({
    maxAvgAbsDeltaPerChannel: 1.5,
    maxChannelDelta: 24
});

function isLossyMimeType(mimeType) {
    return mimeType === 'image/jpeg' || mimeType === 'image/webp';
}

function isBaselineDiffAcceptable({ compareMode, mimeType, diff }) {
    if (diff?.sizeMismatch) return false;
    if (compareMode !== 'encoded' || !isLossyMimeType(mimeType)) {
        return diff?.changedPixels === 0;
    }

    return diff.avgAbsDeltaPerChannel <= LOSSY_BASELINE_TOLERANCE.maxAvgAbsDeltaPerChannel &&
        diff.maxChannelDelta <= LOSSY_BASELINE_TOLERANCE.maxChannelDelta;
}

function formatDiffFailureMessage(result) {
    return `${result.fileName}: baseline mismatch vs ${result.baselineName}, ` +
        `compareMode=${result.compareMode}, mimeType=${result.mimeType}, ` +
        `changedPixels=${result.diff.changedPixels}, changedRatio=${result.diff.changedRatio}, ` +
        `avgAbsDelta=${result.diff.avgAbsDeltaPerChannel}, maxDelta=${result.diff.maxChannelDelta}, ` +
        `applied=${result.applied}, source=${result.source}`;
}

test('isBaselineDiffAcceptable should require exact match for lossless baselines', () => {
    assert.equal(
        isBaselineDiffAcceptable({
            compareMode: 'encoded',
            mimeType: 'image/png',
            diff: {
                sizeMismatch: false,
                changedPixels: 1,
                avgAbsDeltaPerChannel: 0.01,
                maxChannelDelta: 1
            }
        }),
        false
    );
});

test('isBaselineDiffAcceptable should allow tiny lossy encode drift', () => {
    assert.equal(
        isBaselineDiffAcceptable({
            compareMode: 'encoded',
            mimeType: 'image/webp',
            diff: {
                sizeMismatch: false,
                changedPixels: 1200,
                changedRatio: 0.8,
                avgAbsDeltaPerChannel: 0.9,
                maxChannelDelta: 12
            }
        }),
        true
    );
});

test('isBaselineDiffAcceptable should reject meaningful lossy regression drift', () => {
    assert.equal(
        isBaselineDiffAcceptable({
            compareMode: 'encoded',
            mimeType: 'image/jpeg',
            diff: {
                sizeMismatch: false,
                changedPixels: 3000,
                changedRatio: 1,
                avgAbsDeltaPerChannel: 2.4,
                maxChannelDelta: 40
            }
        }),
        false
    );
});

function startStaticServer(rootDir) {
    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            try {
                const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
                const requestPath = rawPath === '/' ? '/package.json' : rawPath;
                const targetPath = path.resolve(rootDir, `.${requestPath}`);

                if (!targetPath.startsWith(rootDir)) {
                    res.writeHead(403);
                    res.end('Forbidden');
                    return;
                }

                const ext = path.extname(targetPath).toLowerCase();
                const body = await readFile(targetPath);
                res.writeHead(200, {
                    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(body);
            } catch (error) {
                res.writeHead(404);
                res.end(String(error?.message || error));
            }
        });

        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                server,
                baseUrl: `http://127.0.0.1:${address.port}`
            });
        });
    });
}

async function openProcessingHarnessPage(page) {
    await page.setContent('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body></body></html>');
}

test('sample assets should match local -fix baselines when they are present', async (t) => {
    const fileNames = (await readdir(SAMPLE_DIR))
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .filter((name) => !name.includes('-fix.'))
        .sort((a, b) => a.localeCompare(b));

    const filesWithLocalBaselines = [];
    for (const fileName of fileNames) {
        const inputPath = path.join(SAMPLE_DIR, fileName);
        const fixedPath = buildFixedOutputPath(inputPath);
        if (await exists(fixedPath)) {
            filesWithLocalBaselines.push(fileName);
        }
    }

    if (filesWithLocalBaselines.length === 0) {
        t.skip('No local -fix baselines found under src/assets/samples');
        return;
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        if (isMissingPlaywrightExecutableError(error)) {
            t.skip('Playwright browser binaries are missing in this environment');
            return;
        }
        throw error;
    }

    const { server, baseUrl } = await startStaticServer(ROOT_DIR);
    const page = await browser.newPage();
    try {
        await openProcessingHarnessPage(page);

        const payload = await Promise.all(filesWithLocalBaselines.map(async (fileName) => {
            const inputPath = path.join(SAMPLE_DIR, fileName);
            const fixedPath = buildFixedOutputPath(inputPath);
            const baselinePath = fixedPath;

            return {
                fileName,
                baselineName: path.basename(baselinePath),
                mimeType: inferMimeType(inputPath),
                compareMode: 'encoded',
                inputUrl: await readImageDataUrl(inputPath),
                baselineUrl: await readImageDataUrl(baselinePath)
            };
        }));

        const bg48Url = await readImageDataUrl(BG48_PATH);
        const bg96Url = await readImageDataUrl(BG96_PATH);
        const results = await page.evaluate(async ({ baseUrl, bg48Url, bg96Url, payload }) => {
            const { calculateAlphaMap } = await import(`${baseUrl}/src/core/alphaMap.js`);
            const { interpolateAlphaMap } = await import(`${baseUrl}/src/core/adaptiveDetector.js`);
            const { processWatermarkImageData } = await import(`${baseUrl}/src/core/watermarkProcessor.js`);

            const decodeImageData = async (imageUrl) => {
                const img = new Image();
                img.src = imageUrl;
                await img.decode();

                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0);
                return ctx.getImageData(0, 0, canvas.width, canvas.height);
            };

            const encodeAndDecodeImageData = async (imageData, mimeType) => {
                const canvas = document.createElement('canvas');
                canvas.width = imageData.width;
                canvas.height = imageData.height;
                const ctx = canvas.getContext('2d');
                ctx.putImageData(imageData, 0, 0);

                const blob = await new Promise((resolve, reject) => {
                    canvas.toBlob((nextBlob) => {
                        if (nextBlob) {
                            resolve(nextBlob);
                        } else {
                            reject(new Error('Failed to encode baseline image blob'));
                        }
                    }, mimeType);
                });

                const blobUrl = URL.createObjectURL(blob);
                try {
                    return await decodeImageData(blobUrl);
                } finally {
                    URL.revokeObjectURL(blobUrl);
                }
            };

            const measureImageDiff = (actualImageData, expectedImageData) => {
                if (actualImageData.width !== expectedImageData.width || actualImageData.height !== expectedImageData.height) {
                    return {
                        sizeMismatch: true,
                        actualWidth: actualImageData.width,
                        actualHeight: actualImageData.height,
                        expectedWidth: expectedImageData.width,
                        expectedHeight: expectedImageData.height
                    };
                }

                let changedPixels = 0;
                let totalAbsDelta = 0;
                let maxChannelDelta = 0;
                const totalPixels = actualImageData.width * actualImageData.height;

                for (let i = 0; i < actualImageData.data.length; i += 4) {
                    let pixelChanged = false;
                    for (let channel = 0; channel < 3; channel++) {
                        const delta = Math.abs(actualImageData.data[i + channel] - expectedImageData.data[i + channel]);
                        totalAbsDelta += delta;
                        if (delta > maxChannelDelta) maxChannelDelta = delta;
                        if (delta > 0) pixelChanged = true;
                    }
                    if (pixelChanged) changedPixels++;
                }

                return {
                    sizeMismatch: false,
                    changedPixels,
                    totalPixels,
                    changedRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
                    avgAbsDeltaPerChannel: totalPixels > 0 ? totalAbsDelta / (totalPixels * 3) : 0,
                    maxChannelDelta
                };
            };

            const alpha48 = calculateAlphaMap(await decodeImageData(bg48Url));
            const alpha96 = calculateAlphaMap(await decodeImageData(bg96Url));
            const results = [];

            for (const item of payload) {
                const imageData = await decodeImageData(item.inputUrl);
                const baselineImageData = await decodeImageData(item.baselineUrl);
                const result = processWatermarkImageData(imageData, {
                    alpha48,
                    alpha96,
                    maxPasses: 4,
                    getAlphaMap: (size) => size === 48 ? alpha48 : size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size)
                });
                const actualImageData = item.compareMode === 'raw'
                    ? result.imageData
                    : await encodeAndDecodeImageData(result.imageData, item.mimeType);

                results.push({
                    fileName: item.fileName,
                    baselineName: item.baselineName,
                    mimeType: item.mimeType,
                    compareMode: item.compareMode,
                    applied: result.meta.applied,
                    source: result.meta.source,
                    diff: measureImageDiff(actualImageData, baselineImageData)
                });
            }

            return results;
        }, {
            baseUrl,
            bg48Url,
            bg96Url,
            payload
        });

        for (const result of results) {
            assert.equal(result.diff.sizeMismatch, false, `${result.fileName}: image size mismatch vs ${result.baselineName}`);
            assert.equal(isBaselineDiffAcceptable(result), true, formatDiffFailureMessage(result));
        }
    } finally {
        await browser.close();
        await new Promise((resolveClose) => server.close(resolveClose));
    }
});

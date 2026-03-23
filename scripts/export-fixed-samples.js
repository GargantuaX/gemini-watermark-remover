import path from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readdir, readFile, writeFile } from 'node:fs/promises';

import { chromium } from 'playwright';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
};

function resolvePathFlavor(filePath) {
    if (typeof filePath !== 'string') {
        return path;
    }

    if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\') || filePath.includes('\\')) {
        return path.win32;
    }

    return path.posix;
}

export function buildFixedOutputPath(inputPath) {
    const pathFlavor = resolvePathFlavor(inputPath);
    const parsed = pathFlavor.parse(inputPath);
    return pathFlavor.join(parsed.dir, `${parsed.name}-fix${parsed.ext}`);
}

export async function writeFixedOutput(outputPath, outputBuffer, { overwrite = true } = {}) {
    await writeFile(outputPath, outputBuffer, {
        flag: overwrite ? 'w' : 'wx'
    });
}

function inferMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.webp') return 'image/webp';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return 'image/png';
}

async function decodeImageDataInPage(page, filePath) {
    const buffer = await readFile(filePath);
    const mime = inferMimeType(filePath);
    return `data:${mime};base64,${buffer.toString('base64')}`;
}

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

async function listInputImages(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(dirPath, entry.name))
        .filter((filePath) => {
            const ext = path.extname(filePath).toLowerCase();
            return IMAGE_EXTENSIONS.has(ext) && !filePath.toLowerCase().includes('-fix.');
        })
        .sort((a, b) => a.localeCompare(b));
}

export async function exportFixedSamples(inputDir, { overwrite = true } = {}) {
    const rootDir = path.resolve('.');
    const { server, baseUrl } = await startStaticServer(rootDir);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        await page.goto(`${baseUrl}/public/index.html`);
        const bg48Path = path.resolve('src/assets/bg_48.png');
        const bg96Path = path.resolve('src/assets/bg_96.png');
        const files = await listInputImages(inputDir);
        const results = [];
        const bg48Url = await decodeImageDataInPage(page, bg48Path);
        const bg96Url = await decodeImageDataInPage(page, bg96Path);

        for (const filePath of files) {
            const imageUrl = await decodeImageDataInPage(page, filePath);
            const mimeType = inferMimeType(filePath);
            const outputPath = buildFixedOutputPath(filePath);
            const processed = await page.evaluate(async (payload) => {
                const { calculateAlphaMap } = await import(`${payload.baseUrl}/src/core/alphaMap.js`);
                const { interpolateAlphaMap } = await import(`${payload.baseUrl}/src/core/adaptiveDetector.js`);
                const { processWatermarkImageData } = await import(`${payload.baseUrl}/src/core/watermarkProcessor.js`);

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

                window.__wmAlphaCache ??= {};
                if (!window.__wmAlphaCache.alpha48) {
                    window.__wmAlphaCache.alpha48 = calculateAlphaMap(await decodeImageData(payload.bg48Url));
                    window.__wmAlphaCache.alpha96 = calculateAlphaMap(await decodeImageData(payload.bg96Url));
                }

                const imageData = await decodeImageData(payload.imageUrl);
                const alpha48 = window.__wmAlphaCache.alpha48;
                const alpha96 = window.__wmAlphaCache.alpha96;
                const result = processWatermarkImageData(imageData, {
                    alpha48,
                    alpha96,
                    maxPasses: 4,
                    getAlphaMap: (size) => {
                        if (size === 48) return alpha48;
                        if (size === 96) return alpha96;
                        return interpolateAlphaMap(alpha96, 96, size);
                    }
                });

                const canvas = document.createElement('canvas');
                canvas.width = result.imageData.width;
                canvas.height = result.imageData.height;
                const ctx = canvas.getContext('2d');
                ctx.putImageData(result.imageData, 0, 0);

                const blob = await new Promise((resolve, reject) => {
                    canvas.toBlob((nextBlob) => {
                        if (nextBlob) {
                            resolve(nextBlob);
                        } else {
                            reject(new Error('Failed to encode output blob'));
                        }
                    }, payload.mimeType);
                });

                const buffer = await blob.arrayBuffer();
                let binary = '';
                const bytes = new Uint8Array(buffer);
                for (let i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }

                return {
                    outputBase64: btoa(binary),
                    meta: result.meta
                };
            }, {
                baseUrl,
                bg48Url,
                bg96Url,
                imageUrl,
                mimeType
            });
            const outputBuffer = Buffer.from(processed.outputBase64, 'base64');
            await writeFixedOutput(outputPath, outputBuffer, { overwrite });

            results.push({
                inputPath: filePath,
                outputPath,
                meta: processed.meta
            });
        }

        return results;
    } finally {
        await browser.close();
        await new Promise((resolveClose) => server.close(resolveClose));
    }
}

async function runCli() {
    const args = process.argv.slice(2);
    const overwrite = !args.includes('--no-overwrite');
    const inputArg = args.find((arg) => !arg.startsWith('--'));
    const inputDir = path.resolve(inputArg || 'src/assets/samples');
    const results = await exportFixedSamples(inputDir, { overwrite });

    for (const item of results) {
        const passInfo = `${item.meta.passCount} pass(es), stop=${item.meta.passStopReason}`;
        console.log(`${path.basename(item.inputPath)} -> ${path.basename(item.outputPath)} | ${passInfo}`);
    }

    console.log(`exported ${results.length} file(s) to ${inputDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

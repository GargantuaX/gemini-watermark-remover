import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_VIDEO_DENOISE_BACKEND = 'allenk-fdncnn-browser-spike';
const DEFAULT_VIDEO_TIMEOUT_MS = 6 * 60 * 1000;

function normalizeBufferLike(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    throw new TypeError('Expected Buffer, Uint8Array, or ArrayBuffer');
}

function assertFunction(value, name) {
    if (typeof value !== 'function') {
        throw new TypeError(`${name} must be a function`);
    }
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
}

export function resolveDefaultVideoPreviewPage({ moduleUrl = import.meta.url } = {}) {
    return fileURLToPath(new URL('../../dist/video-preview.html', moduleUrl));
}

async function assertReadableFile(filePath, label) {
    try {
        await access(filePath);
    } catch (error) {
        throw new Error(`${label} is unavailable: ${filePath}`, { cause: error });
    }
}

function resolveContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
    if (ext === '.wasm') return 'application/wasm';
    if (ext === '.onnx') return 'application/octet-stream';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.png') return 'image/png';
    if (ext === '.svg') return 'image/svg+xml';
    return 'application/octet-stream';
}

function isPathInsideRoot(targetPath, rootPath) {
    const relative = path.relative(rootPath, targetPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function createLocalVideoPreviewServer(rootDir) {
    const rootPath = path.resolve(rootDir);
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url || '/', 'http://127.0.0.1');
            const requestPath = decodeURIComponent(url.pathname === '/' ? '/video-preview.html' : url.pathname);
            const targetPath = path.resolve(rootPath, `.${requestPath}`);
            if (!isPathInsideRoot(targetPath, rootPath)) {
                response.writeHead(403);
                response.end('Forbidden');
                return;
            }

            const fileInfo = await stat(targetPath);
            if (!fileInfo.isFile()) {
                response.writeHead(404);
                response.end('Not found');
                return;
            }

            response.writeHead(200, {
                'content-type': resolveContentType(targetPath),
                'content-length': String(fileInfo.size),
                'cross-origin-opener-policy': 'same-origin',
                'cross-origin-embedder-policy': 'require-corp'
            });
            createReadStream(targetPath).pipe(response);
        } catch {
            response.writeHead(404);
            response.end('Not found');
        }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return {
        url: `http://127.0.0.1:${address.port}/`,
        close() {
            return new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        }
    };
}

export async function withLocalVideoPreviewPage(pagePath, callback) {
    if (isHttpUrl(pagePath)) {
        return await callback(pagePath, { served: false, server: null });
    }

    const resolvedPagePath = path.resolve(pagePath);
    const rootDir = path.dirname(resolvedPagePath);
    const pageName = path.basename(resolvedPagePath);
    const server = await createLocalVideoPreviewServer(rootDir);
    try {
        return await callback(new URL(pageName, server.url).href, { served: true, server });
    } finally {
        await server.close();
    }
}

export function inferVideoMimeTypeFromPath(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mov') return 'video/quicktime';
    return 'application/octet-stream';
}

export function isVideoMimeType(mimeType) {
    return String(mimeType || '').toLowerCase().startsWith('video/');
}

async function setControlValue(page, selector, value) {
    await page.evaluate(({ selector: targetSelector, value: targetValue }) => {
        const control = document.querySelector(targetSelector);
        if (!control) throw new Error(`Cannot find control: ${targetSelector}`);
        control.value = String(targetValue);
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, value });
}

async function setCheckboxValue(page, selector, checked) {
    await page.evaluate(({ selector: targetSelector, checked: targetChecked }) => {
        const checkbox = document.querySelector(targetSelector);
        if (!checkbox) throw new Error(`Cannot find control: ${targetSelector}`);
        checkbox.checked = Boolean(targetChecked);
        checkbox.dispatchEvent(new Event('input', { bubbles: true }));
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, checked });
}

async function setNumericInputValue(page, selector, value) {
    await page.evaluate(({ selector: targetSelector, value: targetValue }) => {
        const input = document.querySelector(targetSelector);
        if (!input) throw new Error(`Cannot find control: ${targetSelector}`);
        if (input.hasAttribute('max') && Number(targetValue) > Number(input.getAttribute('max'))) {
            input.setAttribute('max', String(targetValue));
        }
        input.value = String(targetValue);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, value });
}

async function readDownloadBufferFromPage(page) {
    const base64 = await page.evaluate(async () => {
        const link = document.getElementById('downloadBtn');
        if (!link?.href || link.getAttribute('aria-disabled') === 'true') {
            throw new Error('Video export has no downloadable result');
        }
        const blob = await fetch(link.href).then((response) => response.blob());
        const reader = new FileReader();
        return await new Promise((resolve, reject) => {
            reader.onerror = () => reject(reader.error);
            reader.onload = () => {
                const result = String(reader.result || '');
                resolve(result.includes(',') ? result.split(',')[1] : result);
            };
            reader.readAsDataURL(blob);
        });
    });
    return Buffer.from(base64, 'base64');
}

async function collectVideoControls(page) {
    return page.evaluate(() => ({
        denoiseBackend: document.getElementById('denoiseBackend')?.value || '',
        edgeDenoiseStrength: Number(document.getElementById('edgeDenoiseStrength')?.value),
        residualCleanupStrength: Number(document.getElementById('residualCleanup')?.value),
        videoBitrateMbps: Number(document.getElementById('videoBitrateMbps')?.value),
        allowLowConfidence: Boolean(document.getElementById('allowLowConfidence')?.checked)
    }));
}

async function processVideoWithPreviewPage(inputPath, options = {}) {
    const {
        pagePath = resolveDefaultVideoPreviewPage(),
        denoiseBackend = DEFAULT_VIDEO_DENOISE_BACKEND,
        allowLowConfidence = false,
        timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS,
        edgeDenoiseStrength,
        residualCleanupStrength,
        videoBitrate,
        adaptiveAlpha = false,
        alphaGain,
        alphaProfile
    } = options;

    if (!isHttpUrl(pagePath)) {
        await assertReadableFile(pagePath, 'Video preview page');
    }

    const { chromium } = await import('playwright').catch((error) => {
        throw new Error('Video processing requires the optional "playwright" dependency', { cause: error });
    });
    const browser = await chromium.launch({ headless: true });
    try {
        return await withLocalVideoPreviewPage(pagePath, async (pageUrl) => {
            const page = await browser.newPage();
            page.setDefaultTimeout(timeoutMs);
            await page.goto(pageUrl);
            await page.locator('#fileInput').setInputFiles(inputPath);
            await page.evaluate((value) => {
                window.__gwrVideoOverrideDenoiseBackend = value;
            }, denoiseBackend);
            await setControlValue(page, '#denoiseBackend', denoiseBackend);

            if (adaptiveAlpha) {
                await setCheckboxValue(page, '#adaptiveAlpha', true);
            }
            if (allowLowConfidence) {
                await page.evaluate(() => {
                    window.__gwrVideoOverrideAllowLowConfidence = true;
                });
                await setCheckboxValue(page, '#allowLowConfidence', true);
            }
            if (Number.isFinite(alphaGain) && alphaGain > 0) {
                await setNumericInputValue(page, '#alphaGain', Math.max(0.25, Math.min(1.35, alphaGain)));
            }
            if (typeof alphaProfile === 'string' && alphaProfile) {
                await page.evaluate((value) => {
                    window.__gwrVideoAlphaProfile = value;
                }, alphaProfile);
            }
            if (Number.isFinite(edgeDenoiseStrength)) {
                const value = Math.max(0, Math.min(3, edgeDenoiseStrength));
                await page.evaluate((nextValue) => {
                    window.__gwrVideoOverrideEdgeDenoiseStrength = nextValue;
                }, value);
                await setNumericInputValue(page, '#edgeDenoiseStrength', value);
            }
            if (Number.isFinite(residualCleanupStrength)) {
                const value = Math.max(0, Math.min(1.8, residualCleanupStrength));
                await page.evaluate((nextValue) => {
                    window.__gwrVideoOverrideResidualCleanupStrength = nextValue;
                }, value);
                await setNumericInputValue(page, '#residualCleanup', value);
            }
            if (Number.isFinite(videoBitrate) && videoBitrate > 0) {
                await setNumericInputValue(page, '#videoBitrateMbps', videoBitrate / 1000 / 1000);
            }

            await page.locator('#processBtn').click();
            await page.waitForFunction(() => {
                const status = document.getElementById('status');
                return status?.dataset?.tone === 'success' || status?.dataset?.tone === 'error';
            }, null, { timeout: timeoutMs });

            const status = await page.locator('#status').textContent();
            const tone = await page.locator('#status').getAttribute('data-tone');
            if (tone !== 'success') {
                throw new Error(status || 'Video export failed');
            }

            const controls = await collectVideoControls(page);
            const buffer = await readDownloadBufferFromPage(page);
            return {
                buffer,
                meta: {
                    status,
                    denoiseBackend,
                    actualDenoiseBackend: controls.denoiseBackend,
                    actualControls: controls,
                    pagePath: pageUrl
                }
            };
        });
    } finally {
        await browser.close();
    }
}

export async function removeVideoWatermarkFromFile(inputPath, options = {}) {
    const {
        outputPath = null,
        mimeType = inferVideoMimeTypeFromPath(inputPath),
        processVideoFile = null,
        ...videoOptions
    } = options;

    if (processVideoFile !== null) {
        assertFunction(processVideoFile, 'processVideoFile');
        const customResult = await processVideoFile(inputPath, {
            ...videoOptions,
            outputPath,
            mimeType,
            filePath: inputPath
        });
        const buffer = customResult?.buffer
            ? normalizeBufferLike(customResult.buffer)
            : outputPath
                ? await readFile(outputPath)
                : null;
        if (!buffer) {
            throw new Error('processVideoFile must return a buffer or write outputPath');
        }
        if (outputPath && customResult?.buffer) {
            await mkdir(path.dirname(outputPath), { recursive: true });
            await writeFile(outputPath, buffer);
        }
        return {
            buffer,
            outputPath,
            mimeType,
            meta: customResult?.meta ?? null
        };
    }

    const result = await processVideoWithPreviewPage(inputPath, videoOptions);
    if (outputPath) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, result.buffer);
    }
    return {
        buffer: result.buffer,
        outputPath,
        mimeType,
        meta: result.meta
    };
}

export async function removeVideoWatermarkFromBuffer(inputBuffer, options = {}) {
    const { processVideoBuffer = null, ...videoOptions } = options;
    assertFunction(processVideoBuffer, 'processVideoBuffer');
    const result = await processVideoBuffer(normalizeBufferLike(inputBuffer), videoOptions);
    return {
        buffer: normalizeBufferLike(result?.buffer),
        mimeType: videoOptions.mimeType || 'video/mp4',
        meta: result?.meta ?? null
    };
}

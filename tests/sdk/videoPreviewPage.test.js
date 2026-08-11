import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import {
    removeVideoWatermarkFromFile,
    resolveDefaultVideoPreviewPage,
    withLocalVideoPreviewPage
} from '../../src/sdk/video.js';

test('resolveDefaultVideoPreviewPage should resolve packaged dist relative to sdk module', () => {
    const resolved = resolveDefaultVideoPreviewPage({
        moduleUrl: new URL('../../src/sdk/video.js', import.meta.url).href
    });

    assert.equal(resolved, path.resolve('dist/video-preview.html'));
});

test('withLocalVideoPreviewPage should serve local preview assets over http', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-video-page-'));
    const pagePath = path.join(tempDir, 'video-preview.html');
    const modelDir = path.join(tempDir, 'models', 'allenk-fdncnn');
    const modelPath = path.join(modelDir, 'model_core_fp32_86x74.onnx');

    await mkdir(modelDir, { recursive: true });
    await writeFile(pagePath, '<!doctype html><title>video</title>', 'utf8');
    await writeFile(modelPath, Buffer.from('onnx-model'));

    await withLocalVideoPreviewPage(pagePath, async (pageUrl, context) => {
        assert.equal(context.served, true);
        assert.match(pageUrl, /^http:\/\/127\.0\.0\.1:\d+\/video-preview\.html$/);

        const pageResponse = await fetch(pageUrl);
        assert.equal(pageResponse.ok, true);
        assert.equal(await pageResponse.text(), '<!doctype html><title>video</title>');

        const modelResponse = await fetch(new URL('models/allenk-fdncnn/model_core_fp32_86x74.onnx', pageUrl));
        assert.equal(modelResponse.ok, true);
        assert.equal(Buffer.compare(Buffer.from(await modelResponse.arrayBuffer()), Buffer.from('onnx-model')), 0);
    });

    const saved = await readFile(modelPath);
    assert.equal(saved.toString('utf8'), 'onnx-model');
});

test('withLocalVideoPreviewPage should leave http preview pages unchanged', async () => {
    await withLocalVideoPreviewPage('http://127.0.0.1:4173/video-preview.html', async (pageUrl, context) => {
        assert.equal(pageUrl, 'http://127.0.0.1:4173/video-preview.html');
        assert.equal(context.served, false);
        assert.equal(context.server, null);
    });
});

test('SDK video export should keep explicit bitrate through page auto presets', async () => {
    const source = await readFile(new URL('../../src/sdk/video.js', import.meta.url), 'utf8');

    assert.match(source, /__gwrVideoOverrideBitrate/);
});

test('SDK video export forwards page progress to the caller', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-video-progress-page-'));
    const pagePath = path.join(tempDir, 'video-preview.html');
    const inputPath = path.join(tempDir, 'input.mp4');
    await writeFile(inputPath, Buffer.from('video'));
    await writeFile(pagePath, `<!doctype html>
        <input id="fileInput" type="file">
        <select id="denoiseBackend"><option value="allenk-fdncnn-browser-spike">default</option></select>
        <input id="adaptiveAlpha" type="checkbox">
        <input id="allowLowConfidence" type="checkbox">
        <input id="alphaGain" type="number">
        <input id="edgeDenoiseStrength" type="number">
        <input id="residualCleanup" type="number">
        <input id="videoBitrateMbps" type="number" value="12">
        <button id="processBtn">Process</button>
        <div id="status" data-tone="">Ready</div>
        <div id="progressBar" style="width: 0%"></div>
        <div id="progressText">Ready</div>
        <a id="downloadBtn" aria-disabled="true">Download</a>
        <script>
            document.getElementById('processBtn').addEventListener('click', () => {
                globalThis.__gwrVideoCliProgress = {
                    phase: 'export',
                    progress: 1,
                    processedFrames: 1,
                    frameEstimate: 1,
                    aiDenoiseFrames: 0,
                    aiReuseFrames: 0
                };
                document.getElementById('progressBar').style.width = '100%';
                document.getElementById('progressText').textContent = 'Done';
                const status = document.getElementById('status');
                status.dataset.tone = 'success';
                status.textContent = 'Done';
                const link = document.getElementById('downloadBtn');
                link.href = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }));
                link.setAttribute('aria-disabled', 'false');
            });
        </script>`, 'utf8');
    const progressEvents = [];

    const result = await removeVideoWatermarkFromFile(inputPath, {
        pagePath,
        onProgress(progress) {
            progressEvents.push(progress);
        }
    });

    assert.deepEqual([...result.buffer], [1, 2, 3]);
    assert.deepEqual(progressEvents.map((progress) => progress.processedFrames), [1]);
});

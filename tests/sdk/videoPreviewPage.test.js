import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import {
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

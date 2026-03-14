import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

async function exists(filePath) {
    try {
        await access(new URL(filePath, import.meta.url), fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

test('package should expose browser and image-data sdk subpaths', async () => {
    const browserSdk = await import('gemini-watermark-remover/browser');
    const imageDataSdk = await import('gemini-watermark-remover/image-data');

    assert.equal(typeof browserSdk.removeWatermarkFromImage, 'function');
    assert.equal(typeof browserSdk.createWatermarkEngine, 'function');
    assert.equal(typeof imageDataSdk.removeWatermarkFromImageData, 'function');
    assert.equal(typeof imageDataSdk.removeWatermarkFromImageDataSync, 'function');
    assert.equal(typeof imageDataSdk.createWatermarkEngine, 'function');
});

test('package exports should declare type entrypoints for public sdk surface', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const exportsMap = packageJson.exports || {};

    assert.equal(typeof exportsMap['.'], 'object');
    assert.equal(typeof exportsMap['./browser'], 'object');
    assert.equal(typeof exportsMap['./image-data'], 'object');
    assert.equal(typeof packageJson.types, 'string');

    assert.equal(await exists('../../src/sdk/index.d.ts'), true);
    assert.equal(await exists('../../src/sdk/browser.d.ts'), true);
    assert.equal(await exists('../../src/sdk/image-data.d.ts'), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('root sdk declarations should stay portable for non-DOM consumers', async () => {
    const rootDts = await readFile(new URL('../../src/sdk/index.d.ts', import.meta.url), 'utf8');

    assert.match(rootDts, /export interface ImageDataLike/);
    assert.match(rootDts, /export interface BrowserImageLike/);
    assert.match(rootDts, /export interface BrowserCanvasLike/);
    assert.match(rootDts, /export type BrowserImageInput/);
    assert.match(rootDts, /export type BrowserCanvasOutput/);
    assert.doesNotMatch(rootDts, /HTMLImageElement \| HTMLCanvasElement/);
    assert.doesNotMatch(rootDts, /OffscreenCanvas \| HTMLCanvasElement/);
    assert.doesNotMatch(rootDts, /imageData: ImageData \|/);
});

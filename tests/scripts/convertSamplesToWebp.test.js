import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';

import {
    buildWebpOutputPath,
    convertDirectoryToWebp
} from '../../scripts/convert-samples-to-webp.js';

const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0b8AAAAASUVORK5CYII=';

test('buildWebpOutputPath should write into a sibling webp directory with a webp extension', () => {
    const output = buildWebpOutputPath('Z:\\fixtures\\project\\src\\assets\\samples\\16-9.png');
    assert.equal(output, 'Z:\\fixtures\\project\\src\\assets\\samples\\webp\\16-9.webp');
});

test('convertDirectoryToWebp should generate webp copies without deleting the source files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-webp-'));
    const inputDir = path.join(tempDir, 'samples');
    await mkdir(inputDir, { recursive: true });

    const inputPath = path.join(inputDir, 'tiny.png');
    await writeFile(inputPath, Buffer.from(TINY_PNG_BASE64, 'base64'));

    const results = await convertDirectoryToWebp(inputDir, { quality: 80 });

    assert.equal(results.length, 1);
    assert.equal(path.basename(results[0].outputPath), 'tiny.webp');

    const output = await readFile(results[0].outputPath);
    assert.equal(output.subarray(0, 4).toString('ascii'), 'RIFF');

    const original = await readFile(inputPath);
    assert.equal(original.equals(Buffer.from(TINY_PNG_BASE64, 'base64')), true);
});

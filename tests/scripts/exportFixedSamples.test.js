import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import {
    buildFixedOutputPath,
    exportFixedSamples,
    writeFixedOutput
} from '../../scripts/export-fixed-samples.js';

test('buildFixedOutputPath should place outputs under a sibling fix directory', () => {
    const output = buildFixedOutputPath('Z:\\fixtures\\project\\src\\assets\\samples\\16-9.png');
    assert.equal(output, 'Z:\\fixtures\\project\\src\\assets\\samples\\fix\\16-9.png');
});

test('buildFixedOutputPath should preserve extension case and nested dots', () => {
    const output = buildFixedOutputPath('D:\\tmp\\foo.bar.WEBP');
    assert.equal(output, 'D:\\tmp\\fix\\foo.bar.WEBP');
});

test('buildFixedOutputPath should preserve POSIX paths on non-Windows runners', () => {
    const output = buildFixedOutputPath('/tmp/foo.bar.webp');
    assert.equal(output, '/tmp/fix/foo.bar.webp');
});

test('buildFixedOutputPath should keep paths inside fix directory stable', () => {
    const output = buildFixedOutputPath('D:\\tmp\\fix\\foo.bar.WEBP');
    assert.equal(output, 'D:\\tmp\\fix\\foo.bar.WEBP');
});

test('writeFixedOutput should create the fix directory and overwrite existing files by default', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-export-'));
    const outputPath = path.join(tempDir, 'fix', 'sample.png');

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from('old'));
    await writeFixedOutput(outputPath, Buffer.from('new'));

    const saved = await readFile(outputPath, 'utf8');
    assert.equal(saved, 'new');
    await access(path.join(tempDir, 'fix'));
});

test('export-fixed-samples script should not depend on playwright', async () => {
    const source = await readFile(new URL('../../scripts/export-fixed-samples.js', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /playwright/);
    assert.doesNotMatch(source, /chromium\.launch/);
});

test('exportFixedSamples should process local sample files without a browser runtime', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-export-run-'));
    const inputPath = path.join(tempDir, '1-1.png');
    await copyFile(path.resolve('src/assets/samples/1-1.png'), inputPath);

    const results = await exportFixedSamples(tempDir);

    assert.equal(results.length, 1);
    assert.equal(path.basename(results[0].outputPath), '1-1.png');
    assert.ok(results[0].meta?.applied, `skipReason=${results[0].meta?.skipReason}`);
    await access(path.join(tempDir, 'fix', '1-1.png'));
});

test('exportFixedSamples should skip derived after snapshots in the input directory', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-export-after-'));
    const primaryInputPath = path.join(tempDir, '1-1.png');
    const derivedInputPath = path.join(tempDir, '1-1-after.png');

    await copyFile(path.resolve('src/assets/samples/1-1.png'), primaryInputPath);
    await copyFile(path.resolve('src/assets/samples/1-1.png'), derivedInputPath);

    const results = await exportFixedSamples(tempDir);

    assert.equal(results.length, 1);
    assert.equal(path.basename(results[0].inputPath), '1-1.png');
});

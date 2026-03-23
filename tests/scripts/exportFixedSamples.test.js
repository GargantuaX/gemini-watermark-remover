import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { buildFixedOutputPath, writeFixedOutput } from '../../scripts/export-fixed-samples.js';

test('buildFixedOutputPath should append -fix before extension', () => {
    const output = buildFixedOutputPath('D:\\Project\\gemini-watermark-remover\\src\\assets\\samples\\5.png');
    assert.equal(output, 'D:\\Project\\gemini-watermark-remover\\src\\assets\\samples\\5-fix.png');
});

test('buildFixedOutputPath should preserve extension case and nested dots', () => {
    const output = buildFixedOutputPath('D:\\tmp\\foo.bar.WEBP');
    assert.equal(output, 'D:\\tmp\\foo.bar-fix.WEBP');
});

test('buildFixedOutputPath should preserve POSIX paths on non-Windows runners', () => {
    const output = buildFixedOutputPath('/tmp/foo.bar.webp');
    assert.equal(output, '/tmp/foo.bar-fix.webp');
});

test('writeFixedOutput should overwrite existing fix file by default', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-export-'));
    const outputPath = path.join(tempDir, 'sample-fix.png');

    await writeFile(outputPath, Buffer.from('old'));
    await writeFixedOutput(outputPath, Buffer.from('new'));

    const saved = await readFile(outputPath, 'utf8');
    assert.equal(saved, 'new');
});

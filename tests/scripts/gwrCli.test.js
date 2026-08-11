import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import {
  applySyntheticWatermark,
  createPatternImageData
} from '../core/syntheticWatermarkTestUtils.js';

function serializeSyntheticImageData(imageData) {
  return Buffer.from(
    JSON.stringify({
      width: imageData.width,
      height: imageData.height,
      data: Array.from(imageData.data)
    }),
    'utf8'
  );
}

function parseSyntheticImageData(buffer) {
  const payload = JSON.parse(Buffer.from(buffer).toString('utf8'));
  return {
    width: payload.width,
    height: payload.height,
    data: Uint8ClampedArray.from(payload.data)
  };
}

let alpha48Promise = null;
const REPO_ROOT_URL = new URL('../../', import.meta.url);
const REPO_ROOT_PATH = fileURLToPath(REPO_ROOT_URL);

function getAlpha48() {
  if (!alpha48Promise) {
    alpha48Promise = import('@pilio/gemini-watermark-remover/image-data')
      .then((mod) => mod.createWatermarkEngine())
      .then((engine) => engine.getAlphaMap(48));
  }
  return alpha48Promise;
}

async function writeSyntheticFixture(filePath) {
  const imageData = createPatternImageData(320, 320);
  const alpha48 = await getAlpha48();
  applySyntheticWatermark(imageData, alpha48, { x: 240, y: 240, width: 48, height: 48 }, 1);
  await writeFile(filePath, serializeSyntheticImageData(imageData));
  return imageData;
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/gwr.mjs', ...args], {
      cwd: REPO_ROOT_URL,
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('gwr help should list video timeout and bitrate controls', async () => {
  const result = await runCli(['--help']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /--video-timeout-ms <ms>/);
  assert.match(result.stdout, /--video-bitrate-mbps <Mbps>/);
});

test('gwr remove should fail with exit code 2 when output target is missing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-cli-missing-output-'));
  const inputPath = path.join(tempDir, 'input.synthetic');
  await writeSyntheticFixture(inputPath);

  const result = await runCli([
    'remove',
    inputPath,
    '--decoder',
    'synthetic',
    '--encoder',
    'synthetic'
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /output/i);
});

test('gwr remove should process one file and emit json when requested', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-cli-'));
  const inputPath = path.join(tempDir, 'input.synthetic');
  const outputPath = path.join(tempDir, 'output.synthetic');
  const original = await writeSyntheticFixture(inputPath);

  const result = await runCli([
    'remove',
    inputPath,
    '--output',
    outputPath,
    '--json',
    '--decoder',
    'synthetic',
    '--encoder',
    'synthetic'
  ]);

  assert.equal(result.code, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(typeof summary, 'object');
  assert.ok(summary);
  assert.equal(summary.output, outputPath);
  const outputBuffer = await readFile(outputPath);
  assert.ok(outputBuffer.length > 0);
  const outputImage = parseSyntheticImageData(outputBuffer);
  assert.equal(outputImage.width, original.width);
  assert.equal(outputImage.height, original.height);
  assert.notEqual(Buffer.compare(outputBuffer, serializeSyntheticImageData(original)), 0);
});

test('gwr remove should process directory inputs into an output directory', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-cli-dir-'));
  const inputDir = path.join(tempDir, 'in');
  const outputDir = path.join(tempDir, 'out');
  const inputAPath = path.join(inputDir, 'a.synthetic');
  const inputBPath = path.join(inputDir, 'b.synthetic');
  const outputAPath = path.join(outputDir, 'a.synthetic');
  const outputBPath = path.join(outputDir, 'b.synthetic');
  await mkdir(inputDir);
  await mkdir(outputDir);

  const originalA = await writeSyntheticFixture(inputAPath);
  const originalB = await writeSyntheticFixture(inputBPath);

  const result = await runCli([
    'remove',
    inputDir,
    '--out-dir',
    outputDir,
    '--decoder',
    'synthetic',
    '--encoder',
    'synthetic'
  ]);

  assert.equal(result.code, 0);
  const outputA = parseSyntheticImageData(await readFile(outputAPath));
  const outputB = parseSyntheticImageData(await readFile(outputBPath));
  assert.equal(outputA.width, originalA.width);
  assert.equal(outputA.height, originalA.height);
  assert.equal(outputB.width, originalB.width);
  assert.equal(outputB.height, originalB.height);
});

test('gwr remove should accept -- as option terminator for output values that start with --', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-cli-terminator-'));
  const inputPath = path.join(tempDir, 'input.synthetic');
  const outputDirName = `--gwr-cli-terminator-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const outputRelativePath = `${outputDirName}/output.synthetic`;
  const outputPath = path.join(REPO_ROOT_PATH, outputDirName, 'output.synthetic');
  await writeSyntheticFixture(inputPath);

  try {
    const result = await runCli([
      'remove',
      inputPath,
      '--output',
      '--',
      outputRelativePath,
      '--decoder',
      'synthetic',
      '--encoder',
      'synthetic'
    ]);

    assert.equal(result.code, 0);
    await readFile(outputPath);
  } finally {
    await rm(path.join(REPO_ROOT_PATH, outputDirName), { recursive: true, force: true });
  }
});

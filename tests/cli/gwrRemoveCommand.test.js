import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';

import { parseRemoveArgs, runRemoveCommand } from '../../src/cli/gwrRemoveCommand.js';

test('video CLI help lists timeout and bitrate controls', async () => {
  let stdout = '';
  const code = await runRemoveCommand(['--help'], {
    stdout: {
      write(value) {
        stdout += value;
      }
    },
    stderr: { write() {} }
  });

  assert.equal(code, 0);
  assert.match(stdout, /--video-timeout-ms <ms>/);
  assert.match(stdout, /--video-bitrate-mbps <Mbps>/);
});

test('video bitrate option accepts a positive Mbps value', () => {
  const options = parseRemoveArgs([
    'input.mp4',
    '--output',
    'output.mp4',
    '--video-bitrate-mbps',
    '20'
  ]);

  assert.equal(options.ok, true);
  assert.equal(options.videoBitrateMbps, 20);
});

test('video bitrate option rejects zero', () => {
  const options = parseRemoveArgs([
    'input.mp4',
    '--output',
    'output.mp4',
    '--video-bitrate-mbps',
    '0'
  ]);

  assert.equal(options.ok, false);
  assert.match(options.error, /positive number/);
});

test('video CLI forwards timeout and bitrate to the video processor', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-video-cli-options-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const outputPath = path.join(tempDir, 'output.mp4');
  const missingPagePath = path.join(tempDir, 'missing-preview.html');
  await writeFile(inputPath, Buffer.from('video'));
  let receivedOptions = null;
  const io = {
    stdout: { write() {} },
    stderr: { write() {} }
  };

  const code = await runRemoveCommand([
    inputPath,
    '--output',
    outputPath,
    '--video-page',
    missingPagePath,
    '--video-timeout-ms',
    '2500',
    '--video-bitrate-mbps',
    '20'
  ], io, {
    async removeVideoWatermarkFromFile(_inputPath, options) {
      receivedOptions = options;
      return { meta: { status: 'done' } };
    }
  });

  assert.equal(code, 0);
  assert.equal(receivedOptions.timeoutMs, 2500);
  assert.equal(receivedOptions.videoBitrate, 20_000_000);
});

test('video CLI writes frame progress to stderr', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-video-cli-progress-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const outputPath = path.join(tempDir, 'output.mp4');
  await writeFile(inputPath, Buffer.from('video'));
  let stderr = '';
  const io = {
    stdout: { write() {} },
    stderr: {
      write(value) {
        stderr += value;
      }
    }
  };

  const code = await runRemoveCommand([
    inputPath,
    '--output',
    outputPath
  ], io, {
    async removeVideoWatermarkFromFile(_inputPath, options) {
      options.onProgress({
        phase: 'export',
        progress: 0.5,
        processedFrames: 5,
        frameEstimate: 10,
        aiDenoiseFrames: 3,
        aiReuseFrames: 2
      });
      return { meta: { status: 'done' } };
    }
  });

  assert.equal(code, 0);
  assert.equal(stderr, '[video] 50% 5/10 frames (AI 3, reused 2)\n');
});

test('video CLI throttles progress updates within the same phase', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-video-cli-throttle-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const outputPath = path.join(tempDir, 'output.mp4');
  await writeFile(inputPath, Buffer.from('video'));
  let stderr = '';
  const io = {
    stdout: { write() {} },
    stderr: {
      write(value) {
        stderr += value;
      }
    }
  };

  const code = await runRemoveCommand([inputPath, '--output', outputPath], io, {
    async removeVideoWatermarkFromFile(_inputPath, options) {
      options.onProgress({ phase: 'export', progress: 0.01, processedFrames: 1 });
      options.onProgress({ phase: 'export', progress: 0.03, processedFrames: 3 });
      options.onProgress({ phase: 'export', progress: 0.06, processedFrames: 6 });
      return { meta: { status: 'done' } };
    }
  });

  assert.equal(code, 0);
  assert.equal(stderr, '[video] 1% 1 frames\n[video] 6% 6 frames\n');
});

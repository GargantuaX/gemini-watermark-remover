import path from 'node:path';
import { mkdir, readdir, stat } from 'node:fs/promises';

import {
  inferMimeTypeFromPath,
  inferVideoMimeTypeFromPath,
  isVideoMimeType,
  removeVideoWatermarkFromFile,
  removeWatermarkFromFile
} from '../sdk/node.js';

const REMOVE_USAGE =
  'Usage: gwr remove <input> [--output <file> | --out-dir <dir>] [--overwrite] [--json] [--video-page <url-or-file>] [--video-timeout-ms <ms>] [--video-bitrate-mbps <Mbps>]';

export async function runRemoveCommand(argv, io, dependencies = {}) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    io.stdout.write(`${REMOVE_USAGE}\n`);
    return 0;
  }

  const options = parseRemoveArgs(argv);
  if (!options.ok) {
    io.stderr.write(`${options.error}\n`);
    return 2;
  }

  const commandOptions = {
    ...options,
    imageCodecPromise: null,
    onVideoProgress: createVideoProgressReporter(io.stderr),
    removeVideoFile: dependencies.removeVideoWatermarkFromFile || removeVideoWatermarkFromFile
  };
  const inputStats = await stat(commandOptions.input).catch(() => null);
  if (!inputStats) {
    io.stderr.write(`Input not found: ${commandOptions.input}\n`);
    return 3;
  }

  if (inputStats.isDirectory() && commandOptions.output) {
    io.stderr.write('Directory input requires --out-dir and does not support --output.\n');
    return 2;
  }

  let results = null;
  try {
    results = inputStats.isDirectory()
      ? await processDirectory(commandOptions)
      : [await processOneFile(commandOptions.input, resolveSingleFileOutput(commandOptions), commandOptions)];
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 4;
  }

  if (commandOptions.json) {
    io.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results)}\n`);
  }

  return 0;
}

function parseRemoveArgs(argv) {
  const options = {
    ok: true,
    input: null,
    output: null,
    outDir: null,
    overwrite: false,
    json: false,
    decoder: null,
    encoder: null,
    videoPage: null,
    videoDenoiseBackend: null,
    videoTimeoutMs: null,
    videoBitrateMbps: null,
    allowLowConfidence: false
  };

  let parseOptions = true;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (parseOptions && token === '--') {
      parseOptions = false;
      continue;
    }

    if (!parseOptions || !token.startsWith('--')) {
      if (options.input) {
        return { ok: false, error: `Unexpected argument: ${token}` };
      }
      options.input = token;
      continue;
    }

    if (token === '--output') {
      const parsed = parseOptionValue(argv, index, '--output');
      if (!parsed.ok) return parsed;
      options.output = parsed.value;
      index = parsed.index;
      continue;
    }

    if (token === '--out-dir') {
      const parsed = parseOptionValue(argv, index, '--out-dir');
      if (!parsed.ok) return parsed;
      options.outDir = parsed.value;
      index = parsed.index;
      continue;
    }

    if (token === '--decoder') {
      const parsed = parseOptionValue(argv, index, '--decoder');
      if (!parsed.ok) return parsed;
      options.decoder = parsed.value;
      index = parsed.index;
      continue;
    }

    if (token === '--encoder') {
      const parsed = parseOptionValue(argv, index, '--encoder');
      if (!parsed.ok) return parsed;
      options.encoder = parsed.value;
      index = parsed.index;
      continue;
    }

    if (token === '--video-page') {
      const parsed = parseOptionValue(argv, index, '--video-page');
      if (!parsed.ok) return parsed;
      options.videoPage = parsed.value;
      index = parsed.index;
      continue;
    }

    if (token === '--video-denoise-backend') {
      const parsed = parseOptionValue(argv, index, '--video-denoise-backend');
      if (!parsed.ok) return parsed;
      options.videoDenoiseBackend = parsed.value;
      index = parsed.index;
      continue;
    }

    if (token === '--video-timeout-ms') {
      const parsed = parseOptionValue(argv, index, '--video-timeout-ms');
      if (!parsed.ok) return parsed;
      options.videoTimeoutMs = Number(parsed.value);
      index = parsed.index;
      continue;
    }

    if (token === '--video-bitrate-mbps') {
      const parsed = parseOptionValue(argv, index, '--video-bitrate-mbps');
      if (!parsed.ok) return parsed;
      options.videoBitrateMbps = Number(parsed.value);
      index = parsed.index;
      continue;
    }

    if (token === '--overwrite') {
      options.overwrite = true;
      continue;
    }

    if (token === '--json') {
      options.json = true;
      continue;
    }

    if (token === '--allow-low-confidence') {
      options.allowLowConfidence = true;
      continue;
    }

    return { ok: false, error: `Unknown option: ${token}` };
  }

  if (!options.input) {
    return { ok: false, error: 'Missing required argument: <input>' };
  }

  if (options.output && options.outDir) {
    return { ok: false, error: 'Use either --output or --out-dir, not both.' };
  }

  if (!options.output && !options.outDir) {
    return { ok: false, error: 'Missing output target. Use --output <file> or --out-dir <dir>.' };
  }

  if ((options.decoder && !options.encoder) || (!options.decoder && options.encoder)) {
    return { ok: false, error: '--decoder and --encoder must be used together.' };
  }

  if (options.videoTimeoutMs !== null && (!Number.isFinite(options.videoTimeoutMs) || options.videoTimeoutMs <= 0)) {
    return { ok: false, error: '--video-timeout-ms must be a positive number.' };
  }

  if (options.videoBitrateMbps !== null && (!Number.isFinite(options.videoBitrateMbps) || options.videoBitrateMbps <= 0)) {
    return { ok: false, error: '--video-bitrate-mbps must be a positive number.' };
  }

  return options;
}

function parseOptionValue(argv, optionIndex, optionName) {
  const nextToken = argv[optionIndex + 1];
  if (!nextToken) {
    return { ok: false, error: `Missing value for ${optionName}` };
  }

  if (nextToken === '--') {
    const escapedValue = argv[optionIndex + 2];
    if (!escapedValue) {
      return { ok: false, error: `Missing value for ${optionName}` };
    }
    return { ok: true, value: escapedValue, index: optionIndex + 2 };
  }

  if (nextToken.startsWith('--')) {
    return { ok: false, error: `Missing value for ${optionName}` };
  }

  return { ok: true, value: nextToken, index: optionIndex + 1 };
}

function createVideoProgressReporter(stderr) {
  let lastPercent = -1;
  let lastPhase = null;

  return (progress = {}) => {
    const percent = Number.isFinite(progress.progress)
      ? Math.max(0, Math.min(100, Math.round(progress.progress * 100)))
      : null;
    const phaseChanged = progress.phase && progress.phase !== lastPhase;
    const percentChanged = percent !== null && (percent === 100 || percent >= lastPercent + 5);
    if (!phaseChanged && !percentChanged) return;

    const frameLabel = Number.isFinite(progress.processedFrames)
      ? ` ${progress.processedFrames}${Number.isFinite(progress.frameEstimate) ? `/${progress.frameEstimate}` : ''} frames`
      : '';
    const inferenceLabel = Number.isFinite(progress.aiDenoiseFrames) || Number.isFinite(progress.aiReuseFrames)
      ? ` (AI ${progress.aiDenoiseFrames || 0}, reused ${progress.aiReuseFrames || 0})`
      : '';
    stderr.write(`[video] ${percent ?? '?'}%${frameLabel}${inferenceLabel}\n`);
    if (percent !== null) lastPercent = percent;
    lastPhase = progress.phase || lastPhase;
  };
}

async function resolveCodecOptions(options) {
  if (!options.decoder && !options.encoder) {
    return createSharpCodec();
  }

  const decoderPreset = resolveCodecPreset(options.decoder);
  const encoderPreset = resolveCodecPreset(options.encoder);

  if (!decoderPreset || !decoderPreset.decodeImageData) {
    throw new Error(`Unsupported decoder preset: ${options.decoder}`);
  }
  if (!encoderPreset || !encoderPreset.encodeImageData) {
    throw new Error(`Unsupported encoder preset: ${options.encoder}`);
  }

  return {
    decodeImageData: decoderPreset.decodeImageData,
    encodeImageData: encoderPreset.encodeImageData
  };
}

function resolveCodecPreset(name) {
  if (name === 'synthetic') {
    return {
      decodeImageData(buffer) {
        const payload = JSON.parse(Buffer.from(buffer).toString('utf8'));
        return {
          width: payload.width,
          height: payload.height,
          data: Uint8ClampedArray.from(payload.data)
        };
      },
      encodeImageData(imageData) {
        return Buffer.from(
          JSON.stringify({
            width: imageData.width,
            height: imageData.height,
            data: Array.from(imageData.data)
          }),
          'utf8'
        );
      }
    };
  }
  return null;
}

async function createSharpCodec() {
  let sharpModule = null;
  try {
    sharpModule = await import('sharp');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Image codec is unavailable. Failed to load "sharp": ${reason}`,
      { cause: error }
    );
  }

  const sharp = sharpModule.default ?? sharpModule;
  return {
    async decodeImageData(buffer) {
      const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return {
        width: info.width,
        height: info.height,
        data: Uint8ClampedArray.from(data)
      };
    },
    async encodeImageData(imageData, context = {}) {
      const format = resolveOutputFormat(context.mimeType, context.filePath);
      let encoder = sharp(Buffer.from(imageData.data), {
        raw: {
          width: imageData.width,
          height: imageData.height,
          channels: 4
        }
      });

      if (format === 'jpeg') {
        encoder = encoder.jpeg({ quality: 95 });
      } else if (format === 'webp') {
        encoder = encoder.webp({ quality: 95 });
      } else {
        encoder = encoder.png();
      }

      return encoder.toBuffer();
    }
  };
}

function resolveOutputFormat(mimeType = '', filePath = '') {
  if (mimeType === 'image/jpeg') return 'jpeg';
  if (mimeType === 'image/webp') return 'webp';

  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  return 'png';
}

function resolveSingleFileOutput(options) {
  if (options.output) return options.output;
  return path.join(options.outDir, path.basename(options.input));
}

async function processDirectory(options) {
  await mkdir(options.outDir, { recursive: true });
  const entries = await readdir(options.input, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const results = [];
  for (const fileName of files) {
    const inputPath = path.join(options.input, fileName);
    const outputPath = path.join(options.outDir, fileName);
    results.push(await processOneFile(inputPath, outputPath, options));
  }

  return results;
}

async function processOneFile(inputPath, outputPath, options) {
  const outputStats = await stat(outputPath).catch(() => null);
  if (outputStats && !options.overwrite) {
    throw new Error(`Output already exists: ${outputPath}. Use --overwrite to replace it.`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  if (isVideoPath(inputPath) || isVideoPath(outputPath)) {
    const result = await options.removeVideoFile(inputPath, {
      outputPath,
      mimeType: inferVideoMimeTypeFromPath(outputPath || inputPath),
      pagePath: options.videoPage || undefined,
      denoiseBackend: options.videoDenoiseBackend || undefined,
      timeoutMs: Number.isFinite(options.videoTimeoutMs) && options.videoTimeoutMs > 0
        ? options.videoTimeoutMs
        : undefined,
      videoBitrate: Number.isFinite(options.videoBitrateMbps) && options.videoBitrateMbps > 0
        ? options.videoBitrateMbps * 1_000_000
        : undefined,
      onProgress: options.onVideoProgress,
      allowLowConfidence: options.allowLowConfidence
    });

    return {
      input: inputPath,
      output: outputPath,
      kind: 'video',
      meta: result.meta
    };
  }

  const codec = await getImageCodec(options);
  const mimeType = inferMimeTypeFromPath(outputPath);
  const result = await removeWatermarkFromFile(inputPath, {
    outputPath,
    mimeType,
    decodeImageData: codec.decodeImageData,
    encodeImageData: codec.encodeImageData
  });

  return {
    input: inputPath,
    output: outputPath,
    kind: 'image',
    meta: result.meta
  };
}

function isVideoPath(filePath) {
  return isVideoMimeType(inferVideoMimeTypeFromPath(filePath));
}

async function getImageCodec(options) {
  if (!options.imageCodecPromise) {
    options.imageCodecPromise = resolveCodecOptions(options);
  }
  return options.imageCodecPromise;
}

export { parseRemoveArgs };

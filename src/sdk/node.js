import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { removeWatermarkFromImageDataSync } from './image-data.js';

function normalizeBufferLike(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    throw new TypeError('Expected Buffer, Uint8Array, or ArrayBuffer');
}

function assertFunction(value, name) {
    if (typeof value !== 'function') {
        throw new TypeError(`${name} must be a function`);
    }
}

export function inferMimeTypeFromPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.png') return 'image/png';
    return 'application/octet-stream';
}

export async function removeWatermarkFromBuffer(inputBuffer, options = {}) {
    const {
        decodeImageData,
        encodeImageData,
        mimeType = 'application/octet-stream',
        filePath,
        ...removeOptions
    } = options;

    assertFunction(decodeImageData, 'decodeImageData');
    assertFunction(encodeImageData, 'encodeImageData');

    const normalizedInput = normalizeBufferLike(inputBuffer);
    const imageData = await decodeImageData(normalizedInput, { mimeType, filePath });
    const result = removeWatermarkFromImageDataSync(imageData, removeOptions);
    const encoded = await encodeImageData(result.imageData, {
        mimeType,
        filePath,
        meta: result.meta
    });

    return {
        buffer: normalizeBufferLike(encoded),
        imageData: result.imageData,
        meta: result.meta
    };
}

export async function removeWatermarkFromFile(inputPath, options = {}) {
    const {
        outputPath = null,
        mimeType = inferMimeTypeFromPath(inputPath),
        ...restOptions
    } = options;

    const inputBuffer = await readFile(inputPath);
    const result = await removeWatermarkFromBuffer(inputBuffer, {
        ...restOptions,
        mimeType,
        filePath: inputPath
    });

    if (outputPath) {
        await writeFile(outputPath, result.buffer);
    }

    return {
        ...result,
        outputPath
    };
}

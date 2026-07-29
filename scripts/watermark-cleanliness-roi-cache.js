import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

function assertImageData(imageData, name) {
    if (
        !imageData ||
        !Number.isInteger(imageData.width) ||
        !Number.isInteger(imageData.height) ||
        !imageData.data ||
        imageData.data.length !== imageData.width * imageData.height * 4
    ) {
        throw new TypeError(`${name} must be valid RGBA ImageData-like data`);
    }
}

function assertInputs({
    id,
    sourceImageData,
    processedImageData,
    position,
    alphaMap
}) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
        throw new TypeError('id must be a safe non-empty file stem');
    }
    assertImageData(sourceImageData, 'sourceImageData');
    assertImageData(processedImageData, 'processedImageData');
    if (
        sourceImageData.width !== processedImageData.width ||
        sourceImageData.height !== processedImageData.height
    ) {
        throw new RangeError('source and processed dimensions must match');
    }
    if (
        !position ||
        !Number.isInteger(position.x) ||
        !Number.isInteger(position.y) ||
        !Number.isInteger(position.width) ||
        !Number.isInteger(position.height) ||
        position.width <= 0 ||
        position.height <= 0 ||
        position.x < 0 ||
        position.y < 0 ||
        position.x + position.width > sourceImageData.width ||
        position.y + position.height > sourceImageData.height
    ) {
        throw new RangeError('position must be inside the source image');
    }
    if (!alphaMap || alphaMap.length !== position.width * position.height) {
        throw new RangeError('alphaMap length must match position');
    }
}

function extractRgba(imageData, position) {
    const output = Buffer.alloc(position.width * position.height * 4);
    for (let localY = 0; localY < position.height; localY++) {
        const sourceStart =
            ((position.y + localY) * imageData.width + position.x) * 4;
        const sourceEnd = sourceStart + position.width * 4;
        output.set(
            imageData.data.subarray(sourceStart, sourceEnd),
            localY * position.width * 4
        );
    }
    return output;
}

function encodeAlphaMap(alphaMap) {
    const output = Buffer.alloc(alphaMap.length * Float32Array.BYTES_PER_ELEMENT);
    for (let index = 0; index < alphaMap.length; index++) {
        output.writeFloatLE(alphaMap[index], index * Float32Array.BYTES_PER_ELEMENT);
    }
    return output;
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

async function encodePng(rgba, width, height) {
    return sharp(rgba, {
        raw: { width, height, channels: 4 }
    }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

export async function writeWatermarkCleanlinessRoiCacheEntry({
    outputDir,
    id,
    sourceImageData,
    processedImageData,
    position,
    alphaMap,
    metadata = {}
}) {
    assertInputs({
        id,
        sourceImageData,
        processedImageData,
        position,
        alphaMap
    });
    const [sourceRoi, processedRoi] = [
        extractRgba(sourceImageData, position),
        extractRgba(processedImageData, position)
    ];
    const [sourcePng, processedPng] = await Promise.all([
        encodePng(sourceRoi, position.width, position.height),
        encodePng(processedRoi, position.width, position.height)
    ]);
    const alphaBuffer = encodeAlphaMap(alphaMap);
    const sourceRoiPath = path.join(outputDir, `${id}.source.png`);
    const processedRoiPath = path.join(outputDir, `${id}.processed.png`);
    const alphaMapPath = path.join(outputDir, `${id}.alpha.f32`);
    const metadataPath = path.join(outputDir, `${id}.json`);
    const cacheMetadata = {
        ...metadata,
        schemaVersion: 1,
        id,
        fullImage: {
            width: sourceImageData.width,
            height: sourceImageData.height
        },
        originalPosition: { ...position },
        cachedPosition: {
            x: 0,
            y: 0,
            width: position.width,
            height: position.height
        },
        sourceRoiFile: path.basename(sourceRoiPath),
        processedRoiFile: path.basename(processedRoiPath),
        alphaMapFile: path.basename(alphaMapPath),
        sourceRoiSha256: sha256(sourcePng),
        processedRoiSha256: sha256(processedPng),
        alphaMapSha256: sha256(alphaBuffer)
    };
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
        writeFile(sourceRoiPath, sourcePng),
        writeFile(processedRoiPath, processedPng),
        writeFile(alphaMapPath, alphaBuffer),
        writeFile(
            metadataPath,
            `${JSON.stringify(cacheMetadata, null, 2)}\n`,
            'utf8'
        )
    ]);
    return {
        sourceRoiPath,
        processedRoiPath,
        alphaMapPath,
        metadataPath,
        metadata: cacheMetadata
    };
}

function assertHash(buffer, expected, label) {
    if (sha256(buffer) !== expected) {
        throw new Error(`${label} sha256 mismatch`);
    }
}

async function decodeRgbaPng(buffer, expectedPosition, label) {
    const decoded = await sharp(buffer).ensureAlpha().raw().toBuffer({
        resolveWithObject: true
    });
    if (
        decoded.info.width !== expectedPosition.width ||
        decoded.info.height !== expectedPosition.height ||
        decoded.info.channels !== 4
    ) {
        throw new RangeError(`${label} dimensions do not match metadata`);
    }
    return {
        width: decoded.info.width,
        height: decoded.info.height,
        data: new Uint8ClampedArray(decoded.data)
    };
}

export async function readWatermarkCleanlinessRoiCacheEntry(metadataPath) {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const directory = path.dirname(metadataPath);
    const [sourceBuffer, processedBuffer, alphaBuffer] = await Promise.all([
        readFile(path.join(directory, metadata.sourceRoiFile)),
        readFile(path.join(directory, metadata.processedRoiFile)),
        readFile(path.join(directory, metadata.alphaMapFile))
    ]);
    assertHash(sourceBuffer, metadata.sourceRoiSha256, 'source ROI');
    assertHash(
        processedBuffer,
        metadata.processedRoiSha256,
        'processed ROI'
    );
    assertHash(alphaBuffer, metadata.alphaMapSha256, 'alpha map');
    const position = metadata.cachedPosition;
    const expectedAlphaBytes =
        position.width *
        position.height *
        Float32Array.BYTES_PER_ELEMENT;
    if (alphaBuffer.length !== expectedAlphaBytes) {
        throw new RangeError('alpha map byte length does not match metadata');
    }
    const [sourceImageData, processedImageData] = await Promise.all([
        decodeRgbaPng(sourceBuffer, position, 'source ROI'),
        decodeRgbaPng(processedBuffer, position, 'processed ROI')
    ]);
    const alphaMap = new Float32Array(position.width * position.height);
    for (let index = 0; index < alphaMap.length; index++) {
        alphaMap[index] = alphaBuffer.readFloatLE(
            index * Float32Array.BYTES_PER_ELEMENT
        );
    }
    return {
        sourceImageData,
        processedImageData,
        alphaMap,
        position: { ...position },
        metadata
    };
}

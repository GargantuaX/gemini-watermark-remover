import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { removeWatermarkFromImageDataSync } from '../src/sdk/image-data.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT =
    '.artifacts/shadow-residual-profile-ensemble/latest.json';
const DEFAULT_ANALYSIS =
    '.artifacts/shadow-residual-profile-ensemble/analysis.json';
const DEFAULT_OUTPUT_DIR =
    '.artifacts/shadow-residual-profile-ensemble/top-review';
const PANEL_SIZE = 360;
const LABEL_HEIGHT = 58;
const GAP = 8;

function parseInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0
        ? parsed
        : fallback;
}

export function parseArgs(argv = process.argv.slice(2)) {
    const parsed = {
        reportPath: path.resolve(DEFAULT_REPORT),
        analysisPath: path.resolve(DEFAULT_ANALYSIS),
        outputDir: path.resolve(DEFAULT_OUTPUT_DIR),
        offset: 0,
        limit: 12
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() ?? DEFAULT_REPORT);
        } else if (arg === '--analysis') {
            parsed.analysisPath = path.resolve(
                args.shift() ?? DEFAULT_ANALYSIS
            );
        } else if (arg === '--output-dir') {
            parsed.outputDir = path.resolve(
                args.shift() ?? DEFAULT_OUTPUT_DIR
            );
        } else if (arg === '--offset') {
            parsed.offset = parseInteger(args.shift(), parsed.offset);
        } else if (arg === '--limit') {
            parsed.limit = parseInteger(args.shift(), parsed.limit);
        }
    }
    return parsed;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function createCrop(position, imageData) {
    const padding = Math.max(48, Math.round(position.width * 0.8));
    const left = Math.max(0, position.x - padding);
    const top = Math.max(0, position.y - padding);
    return {
        left,
        top,
        width: Math.min(
            imageData.width - left,
            position.width + padding * 2
        ),
        height: Math.min(
            imageData.height - top,
            position.height + padding * 2
        )
    };
}

function cropImageData(imageData, crop) {
    const data = new Uint8ClampedArray(crop.width * crop.height * 4);
    for (let y = 0; y < crop.height; y++) {
        const sourceStart =
            ((crop.top + y) * imageData.width + crop.left) * 4;
        const targetStart = y * crop.width * 4;
        data.set(
            imageData.data.subarray(
                sourceStart,
                sourceStart + crop.width * 4
            ),
            targetStart
        );
    }
    return {
        width: crop.width,
        height: crop.height,
        data
    };
}

function createAmplifiedDiff(before, after, scale = 4) {
    const data = new Uint8ClampedArray(before.data.length);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = Math.min(
            255,
            Math.abs(before.data[index] - after.data[index]) * scale
        );
        data[index + 1] = Math.min(
            255,
            Math.abs(before.data[index + 1] - after.data[index + 1]) *
                scale
        );
        data[index + 2] = Math.min(
            255,
            Math.abs(before.data[index + 2] - after.data[index + 2]) *
                scale
        );
        data[index + 3] = 255;
    }
    return {
        width: before.width,
        height: before.height,
        data
    };
}

function imageDataSharp(imageData) {
    return sharp(
        Buffer.from(
            imageData.data.buffer,
            imageData.data.byteOffset,
            imageData.data.byteLength
        ),
        {
            raw: {
                width: imageData.width,
                height: imageData.height,
                channels: 4
            }
        }
    );
}

async function createPanel(imageData) {
    return imageDataSharp(imageData)
        .resize(PANEL_SIZE, PANEL_SIZE, {
            fit: 'contain',
            kernel: 'nearest',
            background: { r: 20, g: 20, b: 20, alpha: 1 }
        })
        .png()
        .toBuffer();
}

function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function shortNumber(value) {
    return Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}

async function renderRecord(record, outputDir) {
    const original = await decodeImageDataInNode(record.filePath);
    const startedAt = performance.now();
    const processed = removeWatermarkFromImageDataSync(
        cloneImageData(original)
    );
    const position = processed.meta?.position ?? record.replay?.position;
    if (!position) throw new Error(`No position for ${record.fileName}`);
    const crop = createCrop(position, original);
    const beforeCrop = cropImageData(original, crop);
    const afterCrop = cropImageData(processed.imageData, crop);
    const diffCrop = createAmplifiedDiff(beforeCrop, afterCrop);
    const panels = await Promise.all([
        createPanel(beforeCrop),
        createPanel(afterCrop),
        createPanel(diffCrop)
    ]);
    const title =
        `${path.basename(record.fileName)} | size=${position.width} | ` +
        `bestJoint=${shortNumber(record.rProfile?.bestJointEvidence)} | ` +
        `risk=${record.replay?.residualVisibility?.metricRisk ?? 'none'}`;
    const label = Buffer.from(
        `<svg width="${PANEL_SIZE * 3 + GAP * 2}" ` +
        `height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        '<rect width="100%" height="100%" fill="#111"/>' +
        `<text x="8" y="23" fill="#fff" font-size="15" ` +
        `font-family="sans-serif">${escapeXml(title)}</text>` +
        '<text x="8" y="47" fill="#aaa" font-size="13" ' +
        'font-family="sans-serif">source | output | abs diff x4</text>' +
        '</svg>'
    );
    const rowWidth = PANEL_SIZE * 3 + GAP * 2;
    const rowHeight = LABEL_HEIGHT + PANEL_SIZE;
    const row = await sharp({
        create: {
            width: rowWidth,
            height: rowHeight,
            channels: 4,
            background: { r: 18, g: 18, b: 18, alpha: 1 }
        }
    })
        .composite([
            { input: label, left: 0, top: 0 },
            ...panels.map((input, index) => ({
                input,
                left: index * (PANEL_SIZE + GAP),
                top: LABEL_HEIGHT
            }))
        ])
        .png()
        .toBuffer();
    const outputPath = path.join(
        outputDir,
        `${path.parse(record.fileName).name}.png`
    );
    await writeFile(outputPath, row);
    return {
        fileName: record.fileName,
        filePath: record.filePath,
        sourceSha256: createHash('sha256')
            .update(await readFile(record.filePath))
            .digest('hex'),
        outputPath,
        processingMs: Number((performance.now() - startedAt).toFixed(3)),
        position,
        crop,
        bestJointEvidence: record.rProfile?.bestJointEvidence ?? null,
        marginalJointEvidence:
            record.rProfile?.marginalJointEvidence ?? null,
        currentMetricRisk:
            record.replay?.residualVisibility?.metricRisk ?? null,
        currentQualityStatus: processed.meta?.qualityStatus ?? null,
        currentResidualVisibility:
            processed.meta?.detection?.residualVisibility ?? null
    };
}

async function createSheet(rows, outputPath) {
    if (rows.length === 0) return null;
    const buffers = await Promise.all(
        rows.map((row) => readFile(row.outputPath))
    );
    const metadata = await sharp(buffers[0]).metadata();
    const rowWidth = metadata.width;
    const rowHeight = metadata.height;
    await sharp({
        create: {
            width: rowWidth,
            height: rowHeight * buffers.length + GAP * (buffers.length - 1),
            channels: 4,
            background: { r: 10, g: 10, b: 10, alpha: 1 }
        }
    })
        .composite(
            buffers.map((input, index) => ({
                input,
                left: 0,
                top: index * (rowHeight + GAP)
            }))
        )
        .png()
        .toFile(outputPath);
    return outputPath;
}

export async function runShadowResidualProfileReview({
    reportPath = path.resolve(DEFAULT_REPORT),
    analysisPath = path.resolve(DEFAULT_ANALYSIS),
    outputDir = path.resolve(DEFAULT_OUTPUT_DIR),
    offset = 0,
    limit = 12
} = {}) {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const analysis = JSON.parse(await readFile(analysisPath, 'utf8'));
    const recordsByPath = new Map(
        report.records.map((record) => [record.filePath, record])
    );
    const seenHashes = new Set();
    const unique = [];
    for (const candidate of analysis.topBestJoint ?? []) {
        const buffer = await readFile(candidate.filePath);
        const hash = createHash('sha256').update(buffer).digest('hex');
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
        const record = recordsByPath.get(candidate.filePath);
        if (record) unique.push(record);
    }
    const selected = unique.slice(offset, offset + limit);
    await mkdir(outputDir, { recursive: true });
    const rows = [];
    for (const [index, record] of selected.entries()) {
        console.log(
            `shadow profile review: ${index + 1}/${selected.length} ` +
            record.fileName
        );
        rows.push(await renderRecord(record, outputDir));
    }
    const sheetPath = await createSheet(
        rows,
        path.join(outputDir, 'contact-sheet.png')
    );
    const manifest = {
        generatedAt: new Date().toISOString(),
        reportPath,
        analysisPath,
        offset,
        limit,
        uniqueCandidateCount: unique.length,
        sheetPath,
        records: rows
    };
    await writeFile(
        path.join(outputDir, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`
    );
    return manifest;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    runShadowResidualProfileReview(parseArgs())
        .then((manifest) => {
            console.log(JSON.stringify({
                sheetPath: manifest.sheetPath,
                count: manifest.records.length
            }, null, 2));
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}

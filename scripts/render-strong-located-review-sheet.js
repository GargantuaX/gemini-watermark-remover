import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import {
    indexExternalBenchmarkImages,
    listExternalBenchmarkImages
} from './external-benchmark-dataset.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve('.artifacts/sample-files-gemini-watermark/latest-strong-located-report.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/sample-files-gemini-watermark/strong-located-review');
const PANEL_SIZE = 180;
const LABEL_HEIGHT = 42;
const HEADER_HEIGHT = 56;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#111111';
const REVIEW_PANEL_SIZE = 420;
const REVIEW_LABEL_HEIGHT = 72;
const REVIEW_COLUMNS = 4;
const REVIEW_ROWS_PER_SHEET = 5;

function takeRequiredValue(args, option) {
    const value = args.shift();
    if (value == null || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
}

export function parseExternalBenchmarkReviewArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        sampleRoot: null,
        allUniqueContent: false,
        labelTemplatePath: null
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(takeRequiredValue(args, arg));
        } else if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(takeRequiredValue(args, arg));
        } else if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(takeRequiredValue(args, arg));
        } else if (arg === '--all-unique-content') {
            parsed.allUniqueContent = true;
        } else if (arg === '--label-template') {
            parsed.labelTemplatePath = path.resolve(takeRequiredValue(args, arg));
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }

    return parsed;
}

export function buildExternalBenchmarkLabelTemplate(indexedCases, datasetId) {
    const samples = {};
    const sortedCases = [...indexedCases]
        .sort((left, right) => left.paths[0].localeCompare(right.paths[0]));
    for (const record of sortedCases) {
        for (const fileName of [...record.paths].sort((left, right) => left.localeCompare(right))) {
            samples[fileName] = {
                sha256: record.sha256,
                label: null,
                reviewConfidence: null,
                watermarkFamily: null,
                expectedAnchor: null,
                note: ''
            };
        }
    }
    return { version: 1, datasetId, samples };
}

export function selectExternalBenchmarkReviewRecords(report, { allUniqueContent = false } = {}) {
    if (!allUniqueContent) {
        return (report.failures ?? []).filter((record) => record.bucket === 'missed-detection');
    }
    const byHash = new Map();
    for (const record of report.results ?? []) {
        const key = record.contentSha256 || record.fileName;
        if (!byHash.has(key)) byHash.set(key, record);
    }
    return [...byHash.values()]
        .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function escapeSvgText(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function resolveAlphaMaps() {
    const alpha48 = getEmbeddedAlphaMap(48);
    const alpha96 = getEmbeddedAlphaMap(96);
    const alpha96NewMargin = getEmbeddedAlphaMap('96-20260520');
    const alpha36V2 = getEmbeddedAlphaMap('36-v2');
    const cache = new Map([
        [48, alpha48],
        [96, alpha96],
        ['96-20260520', alpha96NewMargin],
        ['36-v2', alpha36V2]
    ]);

    return {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (cache.has(size)) return cache.get(size);
            if (typeof size === 'string') return null;
            const alphaMap = interpolateAlphaMap(alpha96, 96, size);
            cache.set(size, alphaMap);
            return alphaMap;
        }
    };
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function cropImageData(imageData, cropBox) {
    const data = new Uint8ClampedArray(cropBox.width * cropBox.height * 4);
    for (let row = 0; row < cropBox.height; row++) {
        const sourceStart = ((cropBox.top + row) * imageData.width + cropBox.left) * 4;
        const targetStart = row * cropBox.width * 4;
        data.set(
            imageData.data.subarray(sourceStart, sourceStart + cropBox.width * 4),
            targetStart
        );
    }
    return {
        width: cropBox.width,
        height: cropBox.height,
        data
    };
}

function calculatePositionCropBox(position, imageData) {
    const targetSize = Math.max(180, Math.min(420, Math.round(position.width * 3.4)));
    const width = Math.min(targetSize, imageData.width);
    const height = Math.min(targetSize, imageData.height);
    const centerX = position.x + position.width / 2;
    const centerY = position.y + position.height / 2;
    return {
        left: Math.max(0, Math.min(imageData.width - width, Math.round(centerX - width / 2))),
        top: Math.max(0, Math.min(imageData.height - height, Math.round(centerY - height / 2))),
        width,
        height
    };
}

function calculateBottomRightCropBox(imageData) {
    const width = Math.min(420, imageData.width);
    const height = Math.min(420, imageData.height);
    return {
        left: imageData.width - width,
        top: imageData.height - height,
        width,
        height
    };
}

function createDiffImageData(before, after) {
    const data = new Uint8ClampedArray(before.data.length);
    for (let offset = 0; offset < data.length; offset += 4) {
        const beforeLum = (before.data[offset] + before.data[offset + 1] + before.data[offset + 2]) / 3;
        const afterLum = (after.data[offset] + after.data[offset + 1] + after.data[offset + 2]) / 3;
        const signedDelta = beforeLum - afterLum;
        const amplified = Math.min(255, Math.abs(signedDelta) * 5);
        if (signedDelta >= 0) {
            data[offset] = amplified;
            data[offset + 1] = Math.round(amplified * 0.48);
            data[offset + 2] = Math.round(amplified * 0.16);
        } else {
            data[offset] = Math.round(amplified * 0.18);
            data[offset + 1] = Math.round(amplified * 0.5);
            data[offset + 2] = amplified;
        }
        data[offset + 3] = 255;
    }
    return {
        width: before.width,
        height: before.height,
        data
    };
}

function blendPixel(data, offset, red, green, blue, alpha = 0.78) {
    data[offset] = Math.round(data[offset] * (1 - alpha) + red * alpha);
    data[offset + 1] = Math.round(data[offset + 1] * (1 - alpha) + green * alpha);
    data[offset + 2] = Math.round(data[offset + 2] * (1 - alpha) + blue * alpha);
    data[offset + 3] = 255;
}

function drawCornerMarkers(imageData, position, cropBox) {
    const data = new Uint8ClampedArray(imageData.data);
    const local = {
        x: Math.round(position.x - cropBox.left),
        y: Math.round(position.y - cropBox.top),
        width: Math.round(position.width),
        height: Math.round(position.height)
    };
    const left = Math.max(0, Math.min(imageData.width - 1, local.x));
    const top = Math.max(0, Math.min(imageData.height - 1, local.y));
    const right = Math.max(left, Math.min(imageData.width - 1, local.x + local.width));
    const bottom = Math.max(top, Math.min(imageData.height - 1, local.y + local.height));
    const tickLength = Math.max(10, Math.min(28, Math.round(Math.min(local.width, local.height) * 0.32)));
    const strokeWidth = 2;
    const paint = (x, y) => blendPixel(data, (y * imageData.width + x) * 4, 255, 77, 77);

    for (let inset = 0; inset < strokeWidth; inset++) {
        const x0 = Math.min(imageData.width - 1, left + inset);
        const x1 = Math.max(0, right - inset);
        const y0 = Math.min(imageData.height - 1, top + inset);
        const y1 = Math.max(0, bottom - inset);
        for (let x = x0; x <= Math.min(x1, x0 + tickLength); x++) {
            paint(x, y0);
            paint(x, y1);
        }
        for (let x = Math.max(x0, x1 - tickLength); x <= x1; x++) {
            paint(x, y0);
            paint(x, y1);
        }
        for (let y = y0; y <= Math.min(y1, y0 + tickLength); y++) {
            paint(x0, y);
            paint(x1, y);
        }
        for (let y = Math.max(y0, y1 - tickLength); y <= y1; y++) {
            paint(x0, y);
            paint(x1, y);
        }
    }

    return {
        width: imageData.width,
        height: imageData.height,
        data
    };
}

async function encodePanel(imageData, labelLines) {
    const imageBuffer = await sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .resize(PANEL_SIZE, PANEL_SIZE, { fit: 'cover', position: 'center' })
        .png()
        .toBuffer();
    const labelSvg = Buffer.from(`
        <svg width="${PANEL_SIZE}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#171717"/>
          ${labelLines.slice(0, 2).map((line, index) => `
            <text x="8" y="${17 + index * 17}" fill="${index === 0 ? '#f2f2f2' : '#b8b8b8'}"
              font-family="Arial, sans-serif" font-size="${index === 0 ? 11 : 10}">${escapeSvgText(line)}</text>
          `).join('')}
        </svg>
    `);

    return sharp({
        create: {
            width: PANEL_SIZE,
            height: PANEL_SIZE + LABEL_HEIGHT,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite([
            { input: imageBuffer, left: 0, top: 0 },
            { input: labelSvg, left: 0, top: PANEL_SIZE }
        ])
        .png()
        .toBuffer();
}

async function encodeReviewPanel(imageData, labelLines) {
    const imageBuffer = await sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .resize(REVIEW_PANEL_SIZE, REVIEW_PANEL_SIZE, {
            fit: 'contain',
            position: 'southeast',
            background: BACKGROUND
        })
        .png()
        .toBuffer();
    const labelSvg = Buffer.from(`
        <svg width="${REVIEW_PANEL_SIZE}" height="${REVIEW_LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#171717"/>
          ${labelLines.slice(0, 3).map((line, index) => `
            <text x="8" y="${18 + index * 21}" fill="${index === 0 ? '#f2f2f2' : '#b8b8b8'}"
              font-family="Arial, sans-serif" font-size="${index === 0 ? 12 : 11}">${escapeSvgText(line)}</text>
          `).join('')}
        </svg>
    `);

    return sharp({
        create: {
            width: REVIEW_PANEL_SIZE,
            height: REVIEW_PANEL_SIZE + REVIEW_LABEL_HEIGHT,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite([
            { input: imageBuffer, left: 0, top: 0 },
            { input: labelSvg, left: 0, top: REVIEW_PANEL_SIZE }
        ])
        .png()
        .toBuffer();
}

async function createHeader(width, title, subtitle) {
    return Buffer.from(`
        <svg width="${width}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#0b0b0b"/>
          <text x="10" y="22" fill="#ffffff" font-family="Arial, sans-serif" font-size="15" font-weight="700">${escapeSvgText(title)}</text>
          <text x="10" y="43" fill="#bdbdbd" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(subtitle)}</text>
        </svg>
    `);
}

async function writeSheet({ rows, outputPath, title, subtitle, columnsPerRow }) {
    const panelWidth = PANEL_SIZE;
    const panelHeight = PANEL_SIZE + LABEL_HEIGHT;
    const rowWidth = columnsPerRow * panelWidth + (columnsPerRow - 1) * PANEL_GAP;
    const width = rowWidth;
    const emptyHeight = 96;
    const height = rows.length > 0
        ? HEADER_HEIGHT + rows.length * panelHeight + Math.max(0, rows.length - 1) * ROW_GAP
        : HEADER_HEIGHT + emptyHeight;
    const composites = [
        {
            input: await createHeader(width, title, subtitle),
            left: 0,
            top: 0
        }
    ];

    if (rows.length === 0) {
        composites.push({
            input: Buffer.from(`
                <svg width="${width}" height="${emptyHeight}" xmlns="http://www.w3.org/2000/svg">
                  <rect width="100%" height="100%" fill="#111111"/>
                  <text x="10" y="40" fill="#d6d6d6" font-family="Arial, sans-serif" font-size="13">No cases.</text>
                </svg>
            `),
            left: 0,
            top: HEADER_HEIGHT
        });
    }

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const top = HEADER_HEIGHT + rowIndex * (panelHeight + ROW_GAP);
        for (let column = 0; column < rows[rowIndex].length; column++) {
            composites.push({
                input: rows[rowIndex][column],
                left: column * (panelWidth + PANEL_GAP),
                top
            });
        }
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite(composites)
        .png()
        .toFile(outputPath);
    return outputPath;
}

async function writeReviewSheet({ panels, outputPath, title, subtitle }) {
    const panelHeight = REVIEW_PANEL_SIZE + REVIEW_LABEL_HEIGHT;
    const rowCount = Math.ceil(panels.length / REVIEW_COLUMNS);
    const width = REVIEW_COLUMNS * REVIEW_PANEL_SIZE + (REVIEW_COLUMNS - 1) * PANEL_GAP;
    const height = HEADER_HEIGHT + rowCount * panelHeight + Math.max(0, rowCount - 1) * ROW_GAP;
    const composites = [{
        input: await createHeader(width, title, subtitle),
        left: 0,
        top: 0
    }];
    for (let index = 0; index < panels.length; index++) {
        const row = Math.floor(index / REVIEW_COLUMNS);
        const column = index % REVIEW_COLUMNS;
        composites.push({
            input: panels[index],
            left: column * (REVIEW_PANEL_SIZE + PANEL_GAP),
            top: HEADER_HEIGHT + row * (panelHeight + ROW_GAP)
        });
    }

    await sharp({
        create: { width, height, channels: 4, background: BACKGROUND }
    })
        .composite(composites)
        .png()
        .toFile(outputPath);
    return outputPath;
}

function findResult(report, fileName) {
    return report.results.find((record) => record.fileName === fileName) ?? null;
}

function resolveSamplePath(report, fileName, sampleRoot) {
    const record = findResult(report, fileName);
    if (record?.filePath) return record.filePath;
    return path.join(sampleRoot, fileName);
}

async function renderNewlyPassingRows(report, alphaMaps, sampleRoot) {
    const rows = [];
    for (const fileName of report.newlyPassing ?? []) {
        const record = findResult(report, fileName);
        const sourcePath = resolveSamplePath(report, fileName, sampleRoot);
        const original = await decodeImageDataInNode(sourcePath);
        const result = processWatermarkImageData(cloneImageData(original), alphaMaps);
        if (!result.meta.applied || !result.meta.position) continue;

        const cropBox = calculatePositionCropBox(result.meta.position, original);
        const beforeCrop = cropImageData(original, cropBox);
        const beforeOverlay = drawCornerMarkers(beforeCrop, result.meta.position, cropBox);
        const afterCrop = cropImageData(result.imageData, cropBox);
        const diffCrop = createDiffImageData(beforeCrop, afterCrop);
        const shortName = fileName.split(/[\\/]/).pop();
        const anchor = result.meta.config
            ? `${result.meta.config.logoSize}/${result.meta.config.marginRight}/${result.meta.config.marginBottom}`
            : 'none';

        rows.push([
            await encodePanel(beforeOverlay, [shortName, `before ${original.width}x${original.height}`]),
            await encodePanel(afterCrop, ['after', `${result.meta.source}`]),
            await encodePanel(diffCrop, ['diff x5', `anchor ${anchor}, gain ${formatNumber(result.meta.alphaGain, 2)}`]),
            await encodePanel(afterCrop, [
                record?.classification?.bucket ?? 'pass',
                `res ${formatNumber(result.meta.detection.processedSpatialScore)} grad ${formatNumber(result.meta.detection.processedGradientScore)}`
            ])
        ]);
    }
    return rows;
}

async function renderRemainingMissedRows(report, sampleRoot) {
    const panels = [];
    const missed = (report.failures ?? []).filter((failure) => failure.bucket === 'missed-detection');
    for (const failure of missed) {
        const sourcePath = resolveSamplePath(report, failure.fileName, sampleRoot);
        const original = await decodeImageDataInNode(sourcePath);
        const crop = cropImageData(original, calculateBottomRightCropBox(original));
        const shortName = failure.fileName.split(/[\\/]/).pop();
        panels.push(await encodePanel(crop, [shortName, `${original.width}x${original.height}`]));
    }

    const rows = [];
    for (let index = 0; index < panels.length; index += 5) {
        rows.push(panels.slice(index, index + 5));
    }
    return rows;
}

async function renderAllUniqueContentReview({ report, indexedCases, outputDir, reportPath }) {
    const selected = selectExternalBenchmarkReviewRecords(report, { allUniqueContent: true });
    const groupsByHash = new Map(indexedCases.map((record) => [record.sha256, record]));
    if (selected.length !== indexedCases.length) {
        throw new Error(`review report covers ${selected.length} unique contents, expected ${indexedCases.length}`);
    }

    const cropsDir = path.join(outputDir, 'crops');
    const panelsDir = path.join(outputDir, 'panels');
    await mkdir(cropsDir, { recursive: true });
    await mkdir(panelsDir, { recursive: true });
    const panels = [];
    const records = [];

    for (let index = 0; index < selected.length; index++) {
        const selectedRecord = selected[index];
        const group = groupsByHash.get(selectedRecord.contentSha256);
        if (!group) throw new Error(`review report hash is absent from sample index: ${selectedRecord.contentSha256}`);
        const canonical = group.images[0];
        const original = await decodeImageDataInNode(canonical.filePath);
        const crop = cropImageData(original, calculateBottomRightCropBox(original));
        const sequence = String(index + 1).padStart(3, '0');
        const stem = `${sequence}-${group.sha256.slice(0, 12)}`;
        const cropPath = path.join(cropsDir, `${stem}.png`);
        const panelPath = path.join(panelsDir, `${stem}.png`);
        await sharp(Buffer.from(crop.data), {
            raw: { width: crop.width, height: crop.height, channels: 4 }
        }).png().toFile(cropPath);
        const panel = await encodeReviewPanel(crop, [
            canonical.fileName,
            `${original.width}x${original.height} · sha ${group.sha256.slice(0, 12)}`,
            `paths ${group.paths.length} · duplicate paths ${group.paths.length - 1}`
        ]);
        await writeFile(panelPath, panel);
        panels.push(panel);
        records.push({
            index: index + 1,
            fileName: canonical.fileName,
            sourcePath: canonical.filePath,
            paths: group.paths,
            width: original.width,
            height: original.height,
            contentSha256: group.sha256,
            duplicatePathCount: group.paths.length - 1,
            cropPath,
            panelPath,
            sheetPath: null
        });
    }

    const sheetPaths = [];
    const panelsPerSheet = REVIEW_COLUMNS * REVIEW_ROWS_PER_SHEET;
    for (let offset = 0; offset < panels.length; offset += panelsPerSheet) {
        const sheetNumber = sheetPaths.length + 1;
        const sheetPath = path.join(
            outputDir,
            `all-unique-content-review-${String(sheetNumber).padStart(2, '0')}.png`
        );
        const sheetPanels = panels.slice(offset, offset + panelsPerSheet);
        await writeReviewSheet({
            panels: sheetPanels,
            outputPath: sheetPath,
            title: `External Benchmark Human Review ${sheetNumber}`,
            subtitle: `Items ${offset + 1}-${offset + sheetPanels.length} of ${panels.length}; full-resolution bottom-right crops`
        });
        sheetPaths.push(sheetPath);
        for (let index = offset; index < offset + sheetPanels.length; index++) {
            records[index].sheetPath = sheetPath;
        }
    }

    const pathCount = indexedCases.reduce((sum, record) => sum + record.paths.length, 0);
    const reviewIndex = {
        reportPath,
        outputDir,
        pathCount,
        uniqueContentCount: indexedCases.length,
        duplicatePathCount: pathCount - indexedCases.length,
        sheetPaths,
        records
    };
    const reviewIndexPath = path.join(outputDir, 'review-index.json');
    await writeFile(reviewIndexPath, `${JSON.stringify(reviewIndex, null, 2)}\n`, 'utf8');
    return { ...reviewIndex, reviewIndexPath };
}

async function main() {
    const args = parseExternalBenchmarkReviewArgs(process.argv.slice(2));
    const report = JSON.parse(stripBom(await readFile(args.reportPath, 'utf8')));
    const sampleRoot = args.sampleRoot ?? report.sampleRoot;
    if (!sampleRoot) throw new Error('sampleRoot is required');

    await mkdir(args.outputDir, { recursive: true });
    let indexedCases = null;
    if (args.allUniqueContent || args.labelTemplatePath) {
        const images = await listExternalBenchmarkImages(sampleRoot);
        indexedCases = [...(await indexExternalBenchmarkImages(images)).values()];
    }
    const datasetId = report.dataset?.datasetId || path.basename(path.dirname(sampleRoot));
    if (args.labelTemplatePath) {
        const template = buildExternalBenchmarkLabelTemplate(indexedCases, datasetId);
        await mkdir(path.dirname(args.labelTemplatePath), { recursive: true });
        await writeFile(args.labelTemplatePath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
    }
    const alphaMaps = resolveAlphaMaps();
    const newlyPassingRows = await renderNewlyPassingRows(report, alphaMaps, sampleRoot);
    const missedRows = await renderRemainingMissedRows(report, sampleRoot);
    const newlyPassingSheetPath = path.join(args.outputDir, 'newly-passing-before-after-sheet.png');
    const missedSheetPath = path.join(args.outputDir, 'remaining-missed-bottom-right-sheet.png');

    await writeSheet({
        rows: newlyPassingRows,
        outputPath: newlyPassingSheetPath,
        title: 'Strong Located Fallback: Newly Passing',
        subtitle: `${newlyPassingRows.length} cases, before/after/diff generated with current worktree`,
        columnsPerRow: 4
    });
    await writeSheet({
        rows: missedRows,
        outputPath: missedSheetPath,
        title: 'Remaining Missed Detection',
        subtitle: `${(report.failures ?? []).filter((failure) => failure.bucket === 'missed-detection').length} cases, bottom-right crops`,
        columnsPerRow: 5
    });

    const allUniqueReview = args.allUniqueContent
        ? await renderAllUniqueContentReview({
            report,
            indexedCases,
            outputDir: args.outputDir,
            reportPath: args.reportPath
        })
        : null;

    const summary = {
        reportPath: args.reportPath,
        outputDir: args.outputDir,
        newlyPassingCount: newlyPassingRows.length,
        remainingMissedCount: (report.failures ?? []).filter((failure) => failure.bucket === 'missed-detection').length,
        newlyPassingSheetPath,
        missedSheetPath,
        ...(allUniqueReview ? {
            pathCount: allUniqueReview.pathCount,
            uniqueContentCount: allUniqueReview.uniqueContentCount,
            duplicatePathCount: allUniqueReview.duplicatePathCount,
            allUniqueReviewIndexPath: allUniqueReview.reviewIndexPath,
            allUniqueReviewSheetPaths: allUniqueReview.sheetPaths
        } : {}),
        ...(args.labelTemplatePath ? { labelTemplatePath: args.labelTemplatePath } : {})
    };
    await writeFile(path.join(args.outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.join(args.outputDir, 'index.md'), [
        '# Strong Located Review',
        '',
        `- Report: \`${args.reportPath}\``,
        `- Newly passing sheet: \`${newlyPassingSheetPath}\``,
        `- Remaining missed sheet: \`${missedSheetPath}\``,
        `- Newly passing count: ${summary.newlyPassingCount}`,
        `- Remaining missed count: ${summary.remainingMissedCount}`,
        ...(allUniqueReview ? [
            `- All unique content review index: \`${allUniqueReview.reviewIndexPath}\``,
            `- Path count: ${allUniqueReview.pathCount}`,
            `- Unique content count: ${allUniqueReview.uniqueContentCount}`,
            `- Duplicate path count: ${allUniqueReview.duplicatePathCount}`
        ] : []),
        ...(args.labelTemplatePath ? [`- Label template: \`${args.labelTemplatePath}\``] : []),
        ''
    ].join('\n'), 'utf8');

    console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

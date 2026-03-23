import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import {
    calculateWatermarkPosition,
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from '../src/core/watermarkConfig.js';

const KNOWN_GEMINI_SAMPLE_ASSETS = Object.freeze([
    '4.png',
    '5.png',
    '5.webp',
    '6.png',
    '7.png',
    'large.png',
    'large2.png',
    'large3.png'
]);

const KNOWN_NON_GEMINI_SAMPLE_ASSETS = Object.freeze([
    'no-gemini.jpg'
]);

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/sample-benchmark/latest.json');
const RESIDUAL_FAIL_THRESHOLD = 0.22;
const MIN_EXPECTED_SUPPRESSION_GAIN = 0.3;
const NON_GEMINI_MAX_CHANGED_RATIO = 0.01;
const NON_GEMINI_MAX_AVG_DELTA = 0.5;

function inferMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.webp') return 'image/webp';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return 'image/png';
}

async function exists(filePath) {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function decodeImageDataInPage(page, filePath) {
    const buffer = await readFile(filePath);
    const dataUrl = `data:${inferMimeType(filePath)};base64,${buffer.toString('base64')}`;

    const output = await page.evaluate(async (imageUrl) => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
            width: imageData.width,
            height: imageData.height,
            data: Array.from(imageData.data)
        };
    }, dataUrl);

    return {
        width: output.width,
        height: output.height,
        data: new Uint8ClampedArray(output.data)
    };
}

function measureRegionDelta(originalImageData, processedImageData, position) {
    let changedPixels = 0;
    let totalPixels = 0;
    let totalAbsoluteDelta = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * originalImageData.width + (position.x + col)) * 4;
            let pixelChanged = false;

            for (let channel = 0; channel < 3; channel++) {
                const delta = Math.abs(processedImageData.data[idx + channel] - originalImageData.data[idx + channel]);
                totalAbsoluteDelta += delta;
                if (delta > 0) pixelChanged = true;
            }

            if (pixelChanged) changedPixels++;
            totalPixels++;
        }
    }

    return {
        changedPixels,
        totalPixels,
        changedRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
        avgAbsoluteDeltaPerChannel: totalPixels > 0 ? totalAbsoluteDelta / (totalPixels * 3) : 0
    };
}

function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveBenchmarkPosition({ imageData, meta, alpha48, alpha96 }) {
    if (meta?.position) return meta.position;

    const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
    const resolvedConfig = resolveInitialStandardConfig({
        imageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    return calculateWatermarkPosition(imageData.width, imageData.height, resolvedConfig);
}

export function classifyBenchmarkCase(caseRecord) {
    if (caseRecord.expectedGemini) {
        if (caseRecord.applied !== true) {
            return {
                status: 'fail',
                bucket: 'missed-detection'
            };
        }

        if (
            toFiniteNumber(caseRecord.residualScore) !== null &&
            caseRecord.residualScore >= RESIDUAL_FAIL_THRESHOLD
        ) {
            if (
                toFiniteNumber(caseRecord.suppressionGain) === null ||
                caseRecord.suppressionGain < MIN_EXPECTED_SUPPRESSION_GAIN
            ) {
                return {
                    status: 'fail',
                    bucket: 'weak-suppression'
                };
            }

            return {
                status: 'fail',
                bucket: 'residual-edge'
            };
        }

        if (caseRecord.decisionTier === 'insufficient' || caseRecord.decisionTier == null) {
            return {
                status: 'fail',
                bucket: 'attribution-mismatch'
            };
        }

        return {
            status: 'pass',
            bucket: 'pass'
        };
    }

    if (
        caseRecord.applied === true ||
        (toFiniteNumber(caseRecord.changedRatio) !== null && caseRecord.changedRatio > NON_GEMINI_MAX_CHANGED_RATIO) ||
        (toFiniteNumber(caseRecord.avgAbsoluteDeltaPerChannel) !== null &&
            caseRecord.avgAbsoluteDeltaPerChannel > NON_GEMINI_MAX_AVG_DELTA)
    ) {
        return {
            status: 'fail',
            bucket: 'false-positive'
        };
    }

    return {
        status: 'pass',
        bucket: 'pass'
    };
}

export function summarizeBenchmarkResults(results) {
    const summary = {
        total: results.length,
        passCount: 0,
        failCount: 0,
        buckets: {}
    };

    for (const item of results) {
        const bucket = item.classification?.bucket || 'unknown';
        summary.buckets[bucket] = (summary.buckets[bucket] ?? 0) + 1;

        if (item.classification?.status === 'fail') {
            summary.failCount++;
        } else {
            summary.passCount++;
        }
    }

    return summary;
}

async function buildBenchmarkReport({
    sampleDir = path.resolve('src/assets/samples')
} = {}) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        const bg48Path = path.resolve('src/assets/bg_48.png');
        const bg96Path = path.resolve('src/assets/bg_96.png');
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, bg48Path));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, bg96Path));
        const alphaResolver = (size) => {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return interpolateAlphaMap(alpha96, 96, size);
        };

        const results = [];
        const sampleItems = [
            ...KNOWN_GEMINI_SAMPLE_ASSETS.map((fileName) => ({ fileName, expectedGemini: true })),
            ...KNOWN_NON_GEMINI_SAMPLE_ASSETS.map((fileName) => ({ fileName, expectedGemini: false }))
        ];

        for (const item of sampleItems) {
            const filePath = path.join(sampleDir, item.fileName);
            if (!(await exists(filePath))) continue;

            const imageData = await decodeImageDataInPage(page, filePath);
            const processed = processWatermarkImageData(imageData, {
                alpha48,
                alpha96,
                maxPasses: 4,
                getAlphaMap: alphaResolver
            });
            const position = resolveBenchmarkPosition({
                imageData,
                meta: processed.meta,
                alpha48,
                alpha96
            });
            const regionDelta = measureRegionDelta(imageData, processed.imageData, position);
            const record = {
                fileName: item.fileName,
                filePath,
                expectedGemini: item.expectedGemini,
                applied: processed.meta.applied === true,
                skipReason: processed.meta.skipReason || null,
                source: processed.meta.source || '',
                decisionTier: processed.meta.decisionTier || null,
                position,
                size: processed.meta.size ?? position.width,
                passCount: processed.meta.passCount ?? 0,
                attemptedPassCount: processed.meta.attemptedPassCount ?? 0,
                passStopReason: processed.meta.passStopReason || null,
                residualScore: toFiniteNumber(processed.meta.detection?.processedSpatialScore),
                originalSpatialScore: toFiniteNumber(processed.meta.detection?.originalSpatialScore),
                suppressionGain: toFiniteNumber(processed.meta.detection?.suppressionGain),
                adaptiveConfidence: toFiniteNumber(processed.meta.detection?.adaptiveConfidence),
                changedRatio: regionDelta.changedRatio,
                avgAbsoluteDeltaPerChannel: regionDelta.avgAbsoluteDeltaPerChannel,
                selectionDebug: processed.meta.selectionDebug ?? null
            };
            record.classification = classifyBenchmarkCase(record);
            results.push(record);
        }

        return {
            generatedAt: new Date().toISOString(),
            sampleDir,
            summary: summarizeBenchmarkResults(results),
            results
        };
    } finally {
        await browser.close();
    }
}

export async function runSampleBenchmark({
    sampleDir = path.resolve('src/assets/samples'),
    outputPath = DEFAULT_OUTPUT_PATH
} = {}) {
    const report = await buildBenchmarkReport({ sampleDir });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
}

function parseCliArgs(argv) {
    const args = [...argv];
    const parsed = {
        sampleDir: path.resolve('src/assets/samples'),
        outputPath: DEFAULT_OUTPUT_PATH
    };

    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--sample-dir') {
            parsed.sampleDir = path.resolve(args.shift() || parsed.sampleDir);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
        }
    }

    return parsed;
}

async function runCli() {
    const options = parseCliArgs(process.argv.slice(2));
    const report = await runSampleBenchmark(options);

    for (const item of report.results) {
        if (item.classification.status === 'fail') {
            console.log(
                `[FAIL] ${item.fileName} bucket=${item.classification.bucket} ` +
                `tier=${item.decisionTier || 'null'} source=${item.source || 'null'} ` +
                `residual=${item.residualScore ?? 'null'} gain=${item.suppressionGain ?? 'null'}`
            );
        }
    }

    console.log(`summary: pass=${report.summary.passCount} fail=${report.summary.failCount} total=${report.summary.total}`);
    console.log(`report: ${options.outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

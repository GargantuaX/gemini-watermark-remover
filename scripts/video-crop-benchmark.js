import path from 'node:path';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';
import { loadLocalEnv } from './local-env.js';

import {
    formatTimestampFileSuffix,
    parseTimestampList,
    renderVideoCropSheet
} from './render-video-crop-sheet.js';
import {
    buildVideoWatermarkPolarityProbe,
    classifyVideoWatermarkEvidenceSummary,
    classifyVideoWatermarkFramePolarity,
    computeVideoBackgroundNormalizedAlphaContrast,
    getVideoAlphaMap,
    scoreVideoWatermarkFramePolarity,
    summarizeVideoWatermarkFrameEvidence
} from '../src/video/videoWatermarkDetector.js';
import {
    summarizeResidualFrames,
    summarizeWatermarkResidual
} from './analyze-video-residual.js';

loadLocalEnv();

const DEFAULT_MANIFEST_PATH = path.resolve('scripts/video-crop-benchmark-manifest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-crop-benchmark');
const DEFAULT_SUMMARY_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-summary.json');
const DEFAULT_DIFF_AMPLIFY = 4;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clonePlainObject(value) {
    return isObject(value) ? JSON.parse(JSON.stringify(value)) : null;
}

function isWindowsAbsolutePath(filePath) {
    return /^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\[^\\]/.test(filePath);
}

function resolveManifestPath(filePath, manifestDir) {
    if (typeof filePath !== 'string' || filePath.length === 0) return null;
    return path.isAbsolute(filePath) || isWindowsAbsolutePath(filePath)
        ? filePath
        : path.resolve(manifestDir, '..', filePath);
}

async function fileExists(filePath) {
    if (!filePath) return false;
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function loadVideoCropBenchmarkManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
    const resolvedManifestPath = path.resolve(manifestPath);
    const manifestDir = path.dirname(resolvedManifestPath);
    const manifest = JSON.parse(await readFile(resolvedManifestPath, 'utf8'));
    const cases = Array.isArray(manifest.cases) ? manifest.cases : [];

    return {
        version: manifest.version ?? 1,
        manifestPath: resolvedManifestPath,
        timestamps: Array.isArray(manifest.timestamps)
            ? parseTimestampList(manifest.timestamps)
            : null,
        cases: cases.map((caseItem) => normalizeVideoBenchmarkCase(caseItem, { manifestDir }))
    };
}

export function normalizeVideoBenchmarkCase(caseItem, {
    manifestDir = process.cwd(),
    sampleRoot = process.env.GWR_VIDEO_SAMPLE_ROOT || 'src/assets/video-samples'
} = {}) {
    if (!isObject(caseItem)) {
        throw new Error('视频 benchmark case 必须是对象');
    }
    const id = String(caseItem.id || '').trim();
    if (!id) {
        throw new Error('视频 benchmark case 缺少 id');
    }

    return {
        id,
        label: String(caseItem.label || id),
        originalPath: caseItem.originalPath
            ? resolveManifestPath(caseItem.originalPath, manifestDir)
            : (caseItem.originalFile ? path.resolve(sampleRoot, caseItem.originalFile) : null),
        currentPath: resolveManifestPath(caseItem.currentPath, manifestDir),
        referencePath: resolveManifestPath(caseItem.referencePath, manifestDir),
        expected: isObject(caseItem.expected) ? caseItem.expected : null,
        currentProfile: clonePlainObject(caseItem.currentProfile),
        referenceProfile: clonePlainObject(caseItem.referenceProfile),
        tags: Array.isArray(caseItem.tags) ? caseItem.tags.filter((tag) => typeof tag === 'string') : [],
        notes: typeof caseItem.notes === 'string' ? caseItem.notes : null
    };
}

export function resolveExpectedWatermarkCandidate(expected, metadata = {}) {
    if (!isObject(expected?.anchor)) return null;
    const anchor = expected.anchor;
    const size = Number(anchor.size ?? anchor.width ?? anchor.height);
    const x = Number(anchor.x);
    const y = Number(anchor.y);
    if (![size, x, y].every(Number.isFinite) || size <= 0) return null;

    const videoWidth = Number(metadata.width ?? expected.width);
    const videoHeight = Number(metadata.height ?? expected.height);
    return {
        id: 'expected-anchor',
        label: 'expected anchor',
        size: Math.round(size),
        width: Math.round(size),
        height: Math.round(size),
        x: Math.round(x),
        y: Math.round(y),
        marginRight: Number.isFinite(Number(anchor.marginRight))
            ? Number(anchor.marginRight)
            : Number.isFinite(videoWidth)
                ? videoWidth - Math.round(x) - Math.round(size)
                : null,
        marginBottom: Number.isFinite(Number(anchor.marginBottom))
            ? Number(anchor.marginBottom)
            : Number.isFinite(videoHeight)
                ? videoHeight - Math.round(y) - Math.round(size)
                : null,
        videoWidth: Number.isFinite(videoWidth) ? videoWidth : null,
        videoHeight: Number.isFinite(videoHeight) ? videoHeight : null,
        source: 'manifest-expected'
    };
}

export function resolveBenchmarkPrimaryCandidate(renderResult, caseItem) {
    return resolveExpectedWatermarkCandidate(caseItem?.expected, renderResult?.metadata) ||
        renderResult?.primaryCandidate ||
        null;
}

export function calculateRawDiffMetrics(leftData, rightData, { width, height, threshold = 2 } = {}) {
    if (!leftData || !rightData || leftData.length !== rightData.length) {
        throw new Error('左右图像数据尺寸不一致，无法计算 diff 指标');
    }
    const pixelCount = Number.isFinite(width) && Number.isFinite(height)
        ? width * height
        : leftData.length / 4;
    let totalAbsDelta = 0;
    let maxAbsDelta = 0;
    let changedPixels = 0;

    for (let i = 0; i < leftData.length; i += 4) {
        let changed = false;
        for (let channel = 0; channel < 3; channel++) {
            const delta = Math.abs(leftData[i + channel] - rightData[i + channel]);
            totalAbsDelta += delta;
            if (delta > maxAbsDelta) maxAbsDelta = delta;
            if (delta > threshold) changed = true;
        }
        if (changed) changedPixels++;
    }

    return {
        pixels: pixelCount,
        meanAbsDeltaPerChannel: pixelCount > 0 ? totalAbsDelta / (pixelCount * 3) : 0,
        maxAbsDelta,
        changedRatio: pixelCount > 0 ? changedPixels / pixelCount : 0
    };
}

function mergeMetricTotals(total, metrics) {
    if (!metrics) return total;
    total.frames++;
    total.pixels += metrics.pixels;
    total.meanAbsDeltaPerChannelSum += metrics.meanAbsDeltaPerChannel;
    total.maxAbsDelta = Math.max(total.maxAbsDelta, metrics.maxAbsDelta);
    total.changedRatioSum += metrics.changedRatio;
    return total;
}

function finalizeMetricTotals(total) {
    if (!total || total.frames === 0) return null;
    return {
        frames: total.frames,
        pixels: total.pixels,
        meanAbsDeltaPerChannel: total.meanAbsDeltaPerChannelSum / total.frames,
        maxAbsDelta: total.maxAbsDelta,
        changedRatio: total.changedRatioSum / total.frames
    };
}

async function calculateImagePairMetrics(leftPath, rightPath) {
    const { data: leftData, info } = await sharp(leftPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const { data: rightData } = await sharp(rightPath)
        .ensureAlpha()
        .resize(info.width, info.height, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    return calculateRawDiffMetrics(leftData, rightData, {
        width: info.width,
        height: info.height
    });
}

async function decodeImageData(filePath) {
    const { data, info } = await sharp(filePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

export function summarizeFrameScores(frameScores) {
    return summarizeVideoWatermarkFrameEvidence(frameScores);
}

export function classifyOriginalFrameEvidence(score) {
    return classifyVideoWatermarkFramePolarity(score);
}

export function computeBackgroundNormalizedAlphaContrast(imageData, position, alphaMap, {
    highAlphaThreshold = 0.18,
    lowAlphaThreshold = 0.035
} = {}) {
    return computeVideoBackgroundNormalizedAlphaContrast(imageData, position, alphaMap, {
        highAlphaThreshold,
        lowAlphaThreshold
    });
}

export function buildPolarityProbe(score, backgroundProbe = {}) {
    return buildVideoWatermarkPolarityProbe(score, backgroundProbe);
}

export function classifyOriginalEvidence(summary) {
    return classifyVideoWatermarkEvidenceSummary(summary);
}

async function scoreOriginalFrames({ frameDir, timestamps, cropBox, primaryCandidate }) {
    if (!primaryCandidate || !cropBox) {
        const summary = summarizeFrameScores([]);
        return {
            frames: [],
            summary,
            classification: classifyOriginalEvidence(summary)
        };
    }

    const localPosition = {
        x: primaryCandidate.x - cropBox.left,
        y: primaryCandidate.y - cropBox.top,
        width: primaryCandidate.size,
        height: primaryCandidate.size
    };
    const alphaMap = getVideoAlphaMap(primaryCandidate.size, { candidate: primaryCandidate });
    const frames = [];

    for (const timestamp of timestamps) {
        const suffix = formatTimestampFileSuffix(timestamp);
        const originalPath = path.join(frameDir, `original-${suffix}.png`);
        const imageData = await decodeImageData(originalPath);
        const score = scoreVideoWatermarkFramePolarity(imageData, localPosition, alphaMap);
        frames.push({
            timestamp,
            ...score
        });
    }

    const summary = summarizeFrameScores(frames);
    return {
        frames,
        summary,
        classification: classifyOriginalEvidence(summary)
    };
}

async function calculateFrameDirMetrics({ frameDir, timestamps, hasCurrent, hasReference }) {
    const totals = {
        originalVsCurrent: { frames: 0, pixels: 0, meanAbsDeltaPerChannelSum: 0, maxAbsDelta: 0, changedRatioSum: 0 },
        currentVsReference: { frames: 0, pixels: 0, meanAbsDeltaPerChannelSum: 0, maxAbsDelta: 0, changedRatioSum: 0 },
        originalVsReference: { frames: 0, pixels: 0, meanAbsDeltaPerChannelSum: 0, maxAbsDelta: 0, changedRatioSum: 0 }
    };

    for (const timestamp of timestamps) {
        const suffix = formatTimestampFileSuffix(timestamp);
        const originalPath = path.join(frameDir, `original-${suffix}.png`);
        const currentPath = path.join(frameDir, `current-${suffix}.png`);
        const referencePath = path.join(frameDir, `reference-${suffix}.png`);

        if (hasCurrent) {
            mergeMetricTotals(
                totals.originalVsCurrent,
                await calculateImagePairMetrics(originalPath, currentPath)
            );
        }
        if (hasCurrent && hasReference) {
            mergeMetricTotals(
                totals.currentVsReference,
                await calculateImagePairMetrics(currentPath, referencePath)
            );
        }
        if (hasReference) {
            mergeMetricTotals(
                totals.originalVsReference,
                await calculateImagePairMetrics(originalPath, referencePath)
            );
        }
    }

    return {
        originalVsCurrent: finalizeMetricTotals(totals.originalVsCurrent),
        currentVsReference: finalizeMetricTotals(totals.currentVsReference),
        originalVsReference: finalizeMetricTotals(totals.originalVsReference)
    };
}

async function calculateFrameDirResidualMetrics({
    frameDir,
    timestamps,
    cropBox,
    primaryCandidate,
    hasCurrent,
    hasReference
}) {
    if (!hasCurrent || !hasReference || !cropBox || !primaryCandidate) {
        return null;
    }

    const localPosition = {
        x: primaryCandidate.x - cropBox.left,
        y: primaryCandidate.y - cropBox.top,
        width: primaryCandidate.size,
        height: primaryCandidate.size
    };
    const alphaMap = getVideoAlphaMap(primaryCandidate.size, { candidate: primaryCandidate });
    const frames = [];

    for (const timestamp of timestamps) {
        const suffix = formatTimestampFileSuffix(timestamp);
        const currentPath = path.join(frameDir, `current-${suffix}.png`);
        const referencePath = path.join(frameDir, `reference-${suffix}.png`);
        const residual = summarizeWatermarkResidual({
            currentImage: await decodeImageData(currentPath),
            referenceImage: await decodeImageData(referencePath),
            alphaMap,
            watermarkPosition: localPosition
        });

        frames.push({
            timestamp,
            backgroundMean: residual.backgroundMean,
            buckets: residual.buckets
        });
    }

    return {
        aggregate: summarizeResidualFrames(frames),
        frames
    };
}

function buildMissingList(existence) {
    return Object.entries(existence)
        .filter(([, exists]) => !exists)
        .map(([key]) => key);
}

export function summarizeVideoCropBenchmark(results) {
    const summary = {
        total: results.length,
        rendered: 0,
        renderedComparison: 0,
        renderedOriginalOnly: 0,
        skippedMissingOriginal: 0,
        failed: 0,
        missing: {
            original: 0,
            current: 0,
            reference: 0
        }
    };

    for (const result of results) {
        if (result.status === 'rendered-comparison') {
            summary.rendered++;
            summary.renderedComparison++;
        }
        if (result.status === 'rendered-original-only') {
            summary.rendered++;
            summary.renderedOriginalOnly++;
        }
        if (result.status === 'skipped-missing-original') summary.skippedMissingOriginal++;
        if (result.status === 'failed') summary.failed++;
        for (const key of result.missing || []) {
            if (Object.hasOwn(summary.missing, key)) {
                summary.missing[key]++;
            }
        }
    }

    return summary;
}

function buildVariantGroupKey(result) {
    const anchor = result?.expected?.anchor || {};
    return JSON.stringify({
        original: result?.paths?.original || null,
        reference: result?.paths?.reference || null,
        x: anchor.x ?? null,
        y: anchor.y ?? null,
        size: anchor.size ?? anchor.width ?? anchor.height ?? null
    });
}

function hasResidualAggregate(result) {
    return Boolean(result?.residualMetrics?.aggregate?.active);
}

function isVariantResult(result) {
    return Array.isArray(result?.tags) && result.tags.includes('variant');
}

function isBaselineResult(result) {
    return hasResidualAggregate(result) &&
        !isVariantResult(result) &&
        (result.currentProfile?.denoiseBackend || 'none') === 'none';
}

function compareResidualBucket(variantBucket, baselineBucket, neutralThreshold = 0.02) {
    if (!variantBucket || !baselineBucket) return null;
    const meanAbsDelta = variantBucket.meanAbs - baselineBucket.meanAbs;
    const rmsDelta = variantBucket.rms - baselineBucket.rms;
    const meanDelta = variantBucket.mean - baselineBucket.mean;
    return {
        meanAbsDelta,
        rmsDelta,
        meanDelta,
        verdict: meanAbsDelta < -neutralThreshold
            ? 'improved'
            : meanAbsDelta > neutralThreshold
                ? 'regressed'
                : 'neutral'
    };
}

function buildVariantRiskNotes(variantAggregate, deltas) {
    const notes = [];
    const active = variantAggregate?.active;
    const lowBody = variantAggregate?.lowBody;
    const lowBodyDelta = deltas?.lowBody;
    const activeDelta = deltas?.active;
    const highBodyDelta = deltas?.highBody;
    const edgeDelta = deltas?.edge;
    const activeCount = Number(active?.n);
    const lowBodyCount = Number(lowBody?.n);
    const lowBodyShare = activeCount > 0 && Number.isFinite(lowBodyCount)
        ? lowBodyCount / activeCount
        : null;

    if (
        lowBodyDelta?.verdict === 'regressed' &&
        Number.isFinite(lowBodyShare) &&
        lowBodyCount <= 64 &&
        lowBodyShare <= 0.006 &&
        activeDelta?.verdict === 'improved' &&
        highBodyDelta?.verdict === 'improved'
    ) {
        notes.push({
            code: 'sparse-low-body-regression',
            severity: 'warning',
            bucket: 'lowBody',
            count: lowBodyCount,
            activeShare: lowBodyShare,
            meanAbsDelta: lowBodyDelta.meanAbsDelta,
            message: 'lowBody regression is sparse while active/highBody improve; inspect visibility before rejecting the candidate.'
        });
    }

    if (
        edgeDelta?.verdict === 'regressed' &&
        Number.isFinite(edgeDelta.meanAbsDelta) &&
        edgeDelta.meanAbsDelta <= 0.03 &&
        activeDelta?.verdict === 'improved'
    ) {
        notes.push({
            code: 'marginal-edge-regression',
            severity: 'warning',
            bucket: 'edge',
            meanAbsDelta: edgeDelta.meanAbsDelta,
            message: 'edge regression is close to the neutral threshold and active residual improves.'
        });
    }

    return notes;
}

export function summarizeVideoBenchmarkVariants(results, {
    buckets = ['active', 'edge', 'lowBody', 'highBody'],
    neutralThreshold = 0.02
} = {}) {
    const baselines = new Map();
    for (const result of results) {
        if (!isBaselineResult(result)) continue;
        const key = buildVariantGroupKey(result);
        if (!baselines.has(key)) {
            baselines.set(key, result);
        }
    }

    return results
        .filter((result) => isVariantResult(result) && hasResidualAggregate(result))
        .map((variant) => {
            const baseline = baselines.get(buildVariantGroupKey(variant)) || null;
            if (!baseline) {
                return {
                    baselineId: null,
                    variantId: variant.id,
                    status: 'missing-baseline'
                };
            }

            const deltas = {};
            for (const bucket of buckets) {
                deltas[bucket] = compareResidualBucket(
                    variant.residualMetrics.aggregate[bucket],
                    baseline.residualMetrics.aggregate[bucket],
                    neutralThreshold
                );
            }
            const riskNotes = buildVariantRiskNotes(variant.residualMetrics.aggregate, deltas);

            return {
                baselineId: baseline.id,
                variantId: variant.id,
                status: 'compared',
                currentProfile: variant.currentProfile || null,
                baselineProfile: baseline.currentProfile || null,
                deltas,
                riskNotes
            };
        });
}

async function runCase(caseItem, {
    outputDir,
    timestamps,
    keepFrames,
    diffAmplify
}) {
    const caseOutputPath = path.join(outputDir, `${caseItem.id}.png`);
    const existence = {
        original: await fileExists(caseItem.originalPath),
        current: await fileExists(caseItem.currentPath),
        reference: await fileExists(caseItem.referencePath)
    };
    const missing = buildMissingList(existence);
    const baseRecord = {
        id: caseItem.id,
        label: caseItem.label,
        tags: caseItem.tags,
        expected: caseItem.expected,
        currentProfile: caseItem.currentProfile,
        referenceProfile: caseItem.referenceProfile,
        paths: {
            original: caseItem.originalPath,
            current: caseItem.currentPath,
            reference: caseItem.referencePath
        },
        missing
    };

    if (!existence.original) {
        return {
            ...baseRecord,
            status: 'skipped-missing-original',
            skipReason: 'missing-original'
        };
    }

    let renderResult = null;
    try {
        const hasComparison = existence.current || existence.reference;
        renderResult = await renderVideoCropSheet({
            originalPath: caseItem.originalPath,
            currentPath: existence.current ? caseItem.currentPath : null,
            referencePath: existence.reference ? caseItem.referencePath : null,
            outputPath: caseOutputPath,
            timestamps,
            keepFrames: true,
            diffAmplify,
            allowOriginalOnly: !hasComparison
        });
        const analysisCandidate = resolveBenchmarkPrimaryCandidate(renderResult, caseItem);
        const metrics = await calculateFrameDirMetrics({
            frameDir: renderResult.frameDir,
            timestamps: renderResult.timestamps,
            hasCurrent: existence.current,
            hasReference: existence.reference
        });
        const residualMetrics = await calculateFrameDirResidualMetrics({
            frameDir: renderResult.frameDir,
            timestamps: renderResult.timestamps,
            cropBox: renderResult.cropBox,
            primaryCandidate: analysisCandidate,
            hasCurrent: existence.current,
            hasReference: existence.reference
        });
        const originalEvidence = await scoreOriginalFrames({
            frameDir: renderResult.frameDir,
            timestamps: renderResult.timestamps,
            cropBox: renderResult.cropBox,
            primaryCandidate: analysisCandidate
        });
        renderResult = await renderVideoCropSheet({
            originalPath: caseItem.originalPath,
            currentPath: existence.current ? caseItem.currentPath : null,
            referencePath: existence.reference ? caseItem.referencePath : null,
            outputPath: caseOutputPath,
            timestamps,
            keepFrames: true,
            diffAmplify,
            allowOriginalOnly: !hasComparison,
            caseNote: originalEvidence.classification.shortLabel || originalEvidence.classification.class
        });

        return {
            ...baseRecord,
            status: hasComparison ? 'rendered-comparison' : 'rendered-original-only',
            outputPath: renderResult.outputPath,
            cropBox: renderResult.cropBox,
            timestamps: renderResult.timestamps,
            columns: renderResult.columns,
            candidates: renderResult.candidates,
            primaryCandidate: analysisCandidate,
            metadata: renderResult.metadata,
            originalEvidence,
            metrics,
            residualMetrics
        };
    } catch (error) {
        return {
            ...baseRecord,
            status: 'failed',
            error: error?.message || String(error)
        };
    } finally {
        if (renderResult?.frameDir && !keepFrames) {
            await rm(renderResult.frameDir, { recursive: true, force: true });
        }
    }
}

export async function runVideoCropBenchmark({
    manifestPath = DEFAULT_MANIFEST_PATH,
    outputDir = DEFAULT_OUTPUT_DIR,
    summaryPath = DEFAULT_SUMMARY_PATH,
    only = null,
    timestamps = null,
    keepFrames = false,
    diffAmplify = DEFAULT_DIFF_AMPLIFY
} = {}) {
    const manifest = await loadVideoCropBenchmarkManifest(manifestPath);
    const selectedIds = Array.isArray(only) && only.length
        ? new Set(only)
        : null;
    const selectedCases = selectedIds
        ? manifest.cases.filter((caseItem) => selectedIds.has(caseItem.id))
        : manifest.cases;
    const resolvedTimestamps = timestamps ? parseTimestampList(timestamps) : (manifest.timestamps || null);
    const finalTimestamps = resolvedTimestamps || undefined;
    const resolvedOutputDir = path.resolve(outputDir);
    const resolvedSummaryPath = path.resolve(summaryPath);
    const results = [];

    await mkdir(resolvedOutputDir, { recursive: true });

    for (const caseItem of selectedCases) {
        results.push(await runCase(caseItem, {
            outputDir: resolvedOutputDir,
            timestamps: finalTimestamps,
            keepFrames,
            diffAmplify
        }));
    }

    const report = {
        generatedAt: new Date().toISOString(),
        manifestPath: manifest.manifestPath,
        outputDir: resolvedOutputDir,
        summaryPath: resolvedSummaryPath,
        timestamps: finalTimestamps || null,
        summary: summarizeVideoCropBenchmark(results),
        variantComparisons: summarizeVideoBenchmarkVariants(results),
        results
    };

    await mkdir(path.dirname(resolvedSummaryPath), { recursive: true });
    await writeFile(resolvedSummaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
}

function parseCliArgs(argv) {
    const parsed = {
        manifestPath: DEFAULT_MANIFEST_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        summaryPath: DEFAULT_SUMMARY_PATH,
        only: null,
        timestamps: null,
        keepFrames: false,
        diffAmplify: DEFAULT_DIFF_AMPLIFY
    };
    const args = [...argv];

    while (args.length) {
        const arg = args.shift();
        if (arg === '--') continue;
        if (arg === '--manifest') {
            parsed.manifestPath = path.resolve(args.shift() || parsed.manifestPath);
            continue;
        }
        if (arg === '--output-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
            continue;
        }
        if (arg === '--summary') {
            parsed.summaryPath = path.resolve(args.shift() || parsed.summaryPath);
            continue;
        }
        if (arg === '--only') {
            parsed.only = String(args.shift() || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
            continue;
        }
        if (arg === '--timestamps') {
            parsed.timestamps = parseTimestampList(args.shift());
            continue;
        }
        if (arg === '--keep-frames') {
            parsed.keepFrames = true;
            continue;
        }
        if (arg === '--diff-amplify') {
            const value = Number(args.shift());
            if (Number.isFinite(value) && value > 0) parsed.diffAmplify = value;
        }
    }

    return parsed;
}

async function runCli() {
    const report = await runVideoCropBenchmark(parseCliArgs(process.argv.slice(2)));

    for (const result of report.results) {
        if (result.status === 'rendered-comparison' || result.status === 'rendered-original-only') {
            console.log(`[rendered] ${result.id} -> ${result.outputPath}`);
        } else {
            console.log(`[${result.status}] ${result.id} reason=${result.skipReason || result.error || 'n/a'}`);
        }
    }
    console.log(
        `summary: rendered=${report.summary.rendered} ` +
        `comparison=${report.summary.renderedComparison} ` +
        `originalOnly=${report.summary.renderedOriginalOnly} ` +
        `missingOriginal=${report.summary.skippedMissingOriginal} ` +
        `failed=${report.summary.failed} total=${report.summary.total}`
    );
    console.log(`report: ${report.summaryPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

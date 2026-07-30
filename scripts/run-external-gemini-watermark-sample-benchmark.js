import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { loadLocalEnv } from './local-env.js';
import {
    decodeImageDataInNode
} from './sample-benchmark.js';
import {
    classifyExternalBenchmarkCase,
    classifyLabeledExternalBenchmarkCase,
    compareTrustedExternalBenchmarkResults,
    summarizeTrustedExternalBenchmarkResults
} from './external-benchmark-evaluation.js';
import {
    createAssumedWatermarkedDataset,
    listExternalBenchmarkImages,
    loadTrustedExternalBenchmarkDataset
} from './external-benchmark-dataset.js';
import {
    classifyHighPrecisionContourResidual,
    measureMultichannelContourResidual
} from './multichannel-contour-residual.js';
import {
    classifyProvisionalLumaInteriorResidual,
    measureAlphaInteriorProjection
} from './alpha-interior-projection.js';

export { classifyExternalBenchmarkCase } from './external-benchmark-evaluation.js';

loadLocalEnv();

const DEFAULT_SAMPLE_ROOT = path.resolve(process.env.GWR_SAMPLE_ROOT || 'sample-files/gemini-watermark');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/sample-files-gemini-watermark');
const DEFAULT_OUTPUT_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-strong-located-report.json');
const DEFAULT_MARKDOWN_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-strong-located-report.md');
const DEFAULT_RESULTS_CSV_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-strong-located-results.csv');
const DEFAULT_FAILURES_CSV_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-strong-located-failures.csv');
const RESIDUAL_FAIL_THRESHOLD = 0.22;
const GRADIENT_FAIL_THRESHOLD = 0.22;
const MIN_EXPECTED_SUPPRESSION_GAIN = 0.3;
const CONSERVATIVE_CANONICAL_96_MAX_RESIDUAL = 0.35;
const CONSERVATIVE_CANONICAL_96_MAX_GRADIENT = 0.08;
const CONSERVATIVE_CANONICAL_96_MIN_SUPPRESSION_GAIN = 0.38;
const CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_SPATIAL = 0.55;
const CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_GRADIENT = 0.2;

export function parseExternalBenchmarkArgs(argv) {
    const parsed = {
        sampleRoot: DEFAULT_SAMPLE_ROOT,
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        resultsCsvPath: DEFAULT_RESULTS_CSV_PATH,
        failuresCsvPath: DEFAULT_FAILURES_CSV_PATH,
        baselinePath: null,
        labelManifestPath: null,
        assumeWatermarked: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(args.shift() || parsed.sampleRoot);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
        } else if (arg === '--markdown') {
            parsed.markdownPath = path.resolve(args.shift() || parsed.markdownPath);
        } else if (arg === '--results-csv') {
            parsed.resultsCsvPath = path.resolve(args.shift() || parsed.resultsCsvPath);
        } else if (arg === '--failures-csv') {
            parsed.failuresCsvPath = path.resolve(args.shift() || parsed.failuresCsvPath);
        } else if (arg === '--baseline') {
            parsed.baselinePath = path.resolve(args.shift());
        } else if (arg === '--labels') {
            parsed.labelManifestPath = path.resolve(args.shift());
        } else if (arg === '--assume-watermarked') {
            parsed.assumeWatermarked = true;
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }

    const selected = Number(Boolean(parsed.labelManifestPath)) + Number(parsed.assumeWatermarked);
    if (selected !== 1) {
        throw new Error('exactly one of --labels or --assume-watermarked is required');
    }
    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function formatRate(pass, total) {
    return total > 0 ? `${(pass / total * 100).toFixed(2)}%` : '0.00%';
}

function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundNumber(value, digits = 6) {
    if (!Number.isFinite(value)) return null;
    return Number(value.toFixed(digits));
}

export function imageDataPixelsChanged(before, after) {
    if (
        before.width !== after.width ||
        before.height !== after.height ||
        before.data.length !== after.data.length
    ) {
        return true;
    }
    for (let index = 0; index < before.data.length; index++) {
        if (before.data[index] !== after.data[index]) return true;
    }
    return false;
}

export function resolveExternalBenchmarkAlphaMaps() {
    const alpha48 = getEmbeddedAlphaMap(48);
    const alpha96 = getEmbeddedAlphaMap(96);
    const alpha96NewMargin = getEmbeddedAlphaMap('96-20260520');
    const alpha96OutlineLight = getEmbeddedAlphaMap('96-outline-light');
    const alpha96OutlineDark = getEmbeddedAlphaMap('96-outline-dark');
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
            '20260520': alpha96NewMargin,
            'outline-light': alpha96OutlineLight,
            'outline-dark': alpha96OutlineDark
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

function resolveExternalBenchmarkShadowAlphaMap(alphaMaps, meta) {
    const position = meta?.position ?? null;
    if (!position) return null;
    const alphaVariant = meta?.config?.alphaVariant ?? null;
    const variantMap = alphaVariant
        ? alphaMaps?.alpha96Variants?.[alphaVariant] ?? null
        : null;
    if (variantMap) {
        const variantSize = Math.sqrt(variantMap.length);
        if (Number.isInteger(variantSize)) {
            return variantSize === position.width
                ? variantMap
                : interpolateAlphaMap(variantMap, variantSize, position.width);
        }
    }
    return alphaMaps?.getAlphaMap?.(position.width) ?? null;
}

export function resolveExternalBenchmarkShadowGeometry({ imageData, meta }) {
    if (meta?.position) {
        return {
            position: meta.position,
            source: 'pipeline'
        };
    }
    if (!imageData || !Number.isInteger(imageData.width) || !Number.isInteger(imageData.height)) {
        return null;
    }
    const logoSize = Math.min(imageData.width, imageData.height) <= 1400 ? 48 : 96;
    const margin = logoSize * 2;
    return {
        position: {
            x: Math.max(0, imageData.width - margin - logoSize),
            y: Math.max(0, imageData.height - margin - logoSize),
            width: logoSize,
            height: logoSize
        },
        source: 'review-fallback'
    };
}

export function evaluateExternalBenchmarkContourResidual({ imageData, alphaMaps, meta }) {
    const position = meta?.position ?? null;
    if (!position) {
        return {
            status: 'unavailable',
            reason: 'missing-watermark-geometry',
            flagged: false,
            reasons: [],
            metrics: null
        };
    }

    const alphaMap = resolveExternalBenchmarkShadowAlphaMap(alphaMaps, meta);
    if (!alphaMap || alphaMap.length !== position.width * position.height) {
        return {
            status: 'unavailable',
            reason: 'missing-alpha-map',
            flagged: false,
            reasons: [],
            metrics: null
        };
    }

    const metrics = measureMultichannelContourResidual({
        imageData,
        alphaMap,
        position
    });
    const classification = classifyHighPrecisionContourResidual(metrics);
    return {
        status: 'measured',
        flagged: classification.flagged,
        reasons: classification.reasons,
        metrics
    };
}

export function evaluateExternalBenchmarkInteriorResidual({ imageData, alphaMaps, meta }) {
    const position = meta?.position ?? null;
    if (!position) {
        return {
            status: 'unavailable',
            reason: 'missing-watermark-geometry',
            flagged: false,
            reasons: [],
            evidenceStatus: 'provisional',
            metrics: null
        };
    }

    const alphaMap = resolveExternalBenchmarkShadowAlphaMap(alphaMaps, meta);
    if (!alphaMap || alphaMap.length !== position.width * position.height) {
        return {
            status: 'unavailable',
            reason: 'missing-alpha-map',
            flagged: false,
            reasons: [],
            evidenceStatus: 'provisional',
            metrics: null
        };
    }

    const metrics = measureAlphaInteriorProjection({ imageData, alphaMap, position });
    const classification = classifyProvisionalLumaInteriorResidual(metrics);
    return {
        status: 'measured',
        flagged: classification.flagged,
        reasons: classification.reasons,
        evidenceStatus: classification.evidenceStatus,
        metrics
    };
}

function anchorKey(anchor) {
    if (!anchor) return 'none';
    const suffix = anchor.alphaVariant ? `/${anchor.alphaVariant}` : '';
    return `${anchor.logoSize}/${anchor.marginRight}/${anchor.marginBottom}${suffix}`;
}

async function loadBaseline(baselinePath) {
    if (!baselinePath) return null;
    try {
        return JSON.parse(stripBom(await readFile(baselinePath, 'utf8')));
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return null;
    }
}

export async function benchmarkExternalSamples({
    sampleRoot = DEFAULT_SAMPLE_ROOT,
    labelManifestPath = null,
    assumeWatermarked = false,
    baselinePath = null,
    outputPath = DEFAULT_OUTPUT_PATH
} = {}) {
    const alphaMaps = resolveExternalBenchmarkAlphaMaps();
    const images = await listExternalBenchmarkImages(sampleRoot);
    const selected = Number(Boolean(labelManifestPath)) + Number(assumeWatermarked);
    if (selected !== 1) {
        throw new Error('exactly one of --labels or --assume-watermarked is required');
    }
    const loaded = labelManifestPath
        ? await loadTrustedExternalBenchmarkDataset({ sampleRoot, labelManifestPath, images })
        : await createAssumedWatermarkedDataset({ sampleRoot, images });
    const results = [];

    for (const item of loaded.cases) {
        const imageData = await decodeImageDataInNode(item.filePath);
        const originalImageData = {
            width: imageData.width,
            height: imageData.height,
            data: new Uint8ClampedArray(imageData.data)
        };
        const processed = processWatermarkImageData(imageData, alphaMaps);
        const meta = processed.meta;
        const shadowGeometry = resolveExternalBenchmarkShadowGeometry({
            imageData: processed.imageData,
            meta
        });
        const shadowPosition = shadowGeometry?.position;
        const shadowGeometryFits = Boolean(
            shadowPosition &&
            shadowPosition.x >= 0 &&
            shadowPosition.y >= 0 &&
            shadowPosition.width > 0 &&
            shadowPosition.height > 0 &&
            shadowPosition.x + shadowPosition.width <= processed.imageData.width &&
            shadowPosition.y + shadowPosition.height <= processed.imageData.height
        );
        const shadowMeta = shadowGeometryFits
            ? {
                ...meta,
                position: shadowGeometry.position,
                config: meta.config ?? { logoSize: shadowGeometry.position.width }
            }
            : meta;
        const contourResidualEvaluation = evaluateExternalBenchmarkContourResidual({
            imageData: processed.imageData,
            alphaMaps,
            meta: shadowMeta
        });
        const contourResidualShadow = {
            ...contourResidualEvaluation,
            geometrySource: shadowGeometryFits ? shadowGeometry.source : null
        };
        const interiorResidualEvaluation = evaluateExternalBenchmarkInteriorResidual({
            imageData: processed.imageData,
            alphaMaps,
            meta: shadowMeta
        });
        const interiorResidualShadow = {
            ...interiorResidualEvaluation,
            geometrySource: shadowGeometryFits ? shadowGeometry.source : null
        };
        const record = {
            fileName: item.fileName,
            filePath: item.filePath,
            paths: item.paths,
            contentSha256: item.contentSha256,
            label: item.label,
            reviewConfidence: item.reviewConfidence,
            watermarkFamily: item.watermarkFamily,
            expectedAnchor: item.expectedAnchor,
            note: item.note,
            group: item.group,
            expectedGemini: true,
            width: imageData.width,
            height: imageData.height,
            pixelsChanged: imageDataPixelsChanged(originalImageData, processed.imageData),
            applied: meta.applied === true,
            skipReason: meta.skipReason || null,
            source: meta.source || '',
            decisionTier: meta.decisionTier || null,
            actualAnchor: meta.config
                ? {
                    logoSize: meta.config.logoSize,
                    marginRight: meta.config.marginRight,
                    marginBottom: meta.config.marginBottom,
                    ...(meta.config.alphaVariant ? { alphaVariant: meta.config.alphaVariant } : {})
                }
                : null,
            alphaGain: toFiniteNumber(meta.alphaGain),
            position: meta.position ?? null,
            size: meta.size ?? null,
            passCount: meta.passCount ?? 0,
            attemptedPassCount: meta.attemptedPassCount ?? 0,
            passStopReason: meta.passStopReason || null,
            residualScore: roundNumber(meta.detection?.processedSpatialScore),
            processedGradientScore: roundNumber(meta.detection?.processedGradientScore),
            originalSpatialScore: roundNumber(meta.detection?.originalSpatialScore),
            originalGradientScore: roundNumber(meta.detection?.originalGradientScore),
            suppressionGain: roundNumber(meta.detection?.suppressionGain),
            adaptiveConfidence: roundNumber(meta.detection?.adaptiveConfidence),
            residualVisibility: meta.detection?.residualVisibility ?? null,
            qualityStatus:
                meta.qualityStatus ??
                meta.qualitySignals?.qualityStatus ??
                null,
            finalDamageWarning:
                typeof meta.qualitySignals?.damageWarning === 'boolean'
                    ? meta.qualitySignals.damageWarning
                    : null,
            qualitySignals: meta.qualitySignals ?? null,
            selectionDamageSafe: meta.selectionDebug?.damage?.safe ?? null,
            decisionPath: meta.decisionPath ?? null,
            contourResidualShadow,
            interiorResidualShadow
        };
        record.classification = classifyLabeledExternalBenchmarkCase(record);
        results.push(record);
    }

    const baseline = await loadBaseline(baselinePath);
    const aggregate = summarizeTrustedExternalBenchmarkResults(results);
    const comparison = compareTrustedExternalBenchmarkResults({
        dataset: loaded.dataset,
        results,
        baseline
    });
    const failures = results
        .filter((record) => record.classification.status === 'fail');

    return {
        generatedAt: new Date().toISOString(),
        sampleRoot,
        outputDir: path.dirname(outputPath ?? DEFAULT_OUTPUT_PATH),
        dataset: loaded.dataset,
        policy: {
            residualFailThreshold: RESIDUAL_FAIL_THRESHOLD,
            negativeResidualOvershootThreshold: -RESIDUAL_FAIL_THRESHOLD,
            gradientFailThreshold: GRADIENT_FAIL_THRESHOLD,
            minExpectedSuppressionGain: MIN_EXPECTED_SUPPRESSION_GAIN,
            damageSignalPriority: [
                'qualitySignals.damageWarning',
                'qualityStatus',
                'selectionDebug.damage.safe (legacy fallback)'
            ],
            conservativeCanonical96: {
                maxResidualScore: CONSERVATIVE_CANONICAL_96_MAX_RESIDUAL,
                maxGradientScore: CONSERVATIVE_CANONICAL_96_MAX_GRADIENT,
                minSuppressionGain: CONSERVATIVE_CANONICAL_96_MIN_SUPPRESSION_GAIN
            }
        },
        previousSummary: baseline?.summary ?? null,
        labels: aggregate.labels,
        metrics: aggregate.metrics,
        summary: aggregate.summary,
        reviewQueue: aggregate.reviewQueue,
        comparison,
        newlyPassing: comparison.newlyPassing,
        newlyFailing: comparison.newlyFailing,
        failures,
        results
    };
}

export function renderExternalBenchmarkMarkdown(report) {
    const metricNames = [
        'watermarkDetectionRecall',
        'watermarkEndToEndPassRate',
        'restorationPassRateAmongApplied',
        'cleanSkipRate',
        'falsePositiveRate',
        'qualifiedOverallPassRate'
    ];
    const dataset = report.dataset ?? {};
    const summary = report.summary ?? {};
    const contour = summary.contourResidualShadow ?? {};
    const interior = summary.interiorResidualShadow ?? {};
    const comparison = report.comparison ?? { status: 'not-requested' };
    const lines = [
        '# External Gemini Watermark Sample Benchmark',
        '',
        `- Generated: ${report.generatedAt}`,
        `- Sample root: \`${report.sampleRoot}\``,
        `- Dataset mode: ${dataset.mode ?? 'unknown'}`,
        `- Trusted release evidence: ${dataset.trusted === true}`,
        `- Dataset ID: ${dataset.datasetId ?? 'null'}`,
        `- Label manifest SHA-256: ${dataset.labelManifestSha256 ?? 'null'}`,
        `- Content set SHA-256: ${dataset.contentSetSha256 ?? 'null'}`,
        `- Paths: ${dataset.pathCount ?? 0}`,
        `- Unique content: ${dataset.uniqueContentCount ?? 0}`,
        `- Duplicate paths: ${dataset.duplicatePathCount ?? 0}`,
        `- Pass: ${summary.passCount ?? 0}`,
        `- Fail: ${summary.failCount ?? 0}`,
        `- Excluded: ${summary.excludedCount ?? 0}`,
        `- Buckets: ${Object.entries(summary.buckets ?? {}).map(([key, value]) => `${key}=${value}`).join(', ')}`,
        `- Contour residual shadow flags: ${contour.flaggedCount ?? 0}/` +
            `${contour.measuredCount ?? 0} measured ` +
            `(${contour.unavailableCount ?? 0} unavailable; ` +
            `${contour.fallbackGeometryCount ?? 0} review fallback; non-blocking)`,
        `- Provisional interior residual shadow flags: ${interior.flaggedCount ?? 0}/` +
            `${interior.measuredCount ?? 0} measured ` +
            `(${interior.unavailableCount ?? 0} unavailable; ` +
            `${interior.fallbackGeometryCount ?? 0} review fallback; non-blocking)`,
        `- Baseline comparison: ${comparison.status}`,
        `- Newly passing vs baseline: ${report.newlyPassing.length}`,
        `- Newly failing vs baseline: ${report.newlyFailing.length}`,
        ''
    ];

    lines.push('## Labels');
    lines.push('');
    for (const label of ['watermarked', 'clean', 'ambiguous', 'unlabeled']) {
        lines.push(`- ${label}: ${report.labels?.[label] ?? 0}`);
    }
    lines.push('');

    lines.push('## Metrics');
    lines.push('');
    for (const name of metricNames) {
        const metric = report.metrics?.[name] ?? {};
        const rate = Number.isFinite(metric.rate) ? `${(metric.rate * 100).toFixed(2)}%` : 'null';
        lines.push(`- ${name}: ${metric.numerator ?? 0}/${metric.denominator ?? 0} (${rate})`);
    }
    lines.push('');

    if (summary.sourceOnly) {
        lines.push('## Task Source');
        lines.push('');
        lines.push(
            `- Pass: ${summary.sourceOnly.passCount}/${summary.sourceOnly.qualifiedTotal ?? summary.sourceOnly.total} ` +
            `(${formatRate(summary.sourceOnly.passCount, summary.sourceOnly.qualifiedTotal ?? summary.sourceOnly.total)})`
        );
        lines.push(`- Fail: ${summary.sourceOnly.failCount}`);
        lines.push(`- Excluded: ${summary.sourceOnly.excludedCount ?? 0}`);
        lines.push(`- Buckets: ${Object.entries(summary.sourceOnly.buckets).map(([key, value]) => `${key}=${value}`).join(', ')}`);
        lines.push('');
    }

    lines.push('## Failures');
    lines.push('');
    for (const failure of report.failures) {
        lines.push(
            `- ${failure.fileName} | ${failure.classification.bucket} | applied=${failure.applied} | ` +
            `label=${failure.label} | sha256=${failure.contentSha256} | ` +
            `source=${failure.source || 'null'} | anchor=${anchorKey(failure.actualAnchor)} | ` +
            `residual=${failure.residualScore ?? 'null'} | gradient=${failure.processedGradientScore ?? 'null'} | ` +
            `finalDamageWarning=${failure.finalDamageWarning ?? 'null'} | ` +
            `selectionDamageSafe=${failure.selectionDamageSafe ?? 'null'}`
        );
    }
    lines.push('');

    for (const label of ['ambiguous', 'unlabeled']) {
        lines.push(`## ${label[0].toUpperCase()}${label.slice(1)} Review Queue`);
        lines.push('');
        for (const record of report.reviewQueue?.[label] ?? []) {
            lines.push(
                `- ${record.fileName} | paths=${record.paths?.join(' | ') ?? record.fileName} | ` +
                `sha256=${record.contentSha256} | confidence=${record.reviewConfidence ?? 'null'} | ` +
                `note=${record.note ?? 'null'}`
            );
        }
        lines.push('');
    }

    return `${lines.join('\n')}\n`;
}

function csvCell(value) {
    const text = value == null ? '' : String(value);
    if (!/[",\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

export function renderExternalBenchmarkResultsCsv(results) {
    const header = [
        'fileName',
        'paths',
        'contentSha256',
        'label',
        'includedInMetrics',
        'status',
        'bucket',
        'reviewConfidence',
        'watermarkFamily',
        'expectedAnchor',
        'note',
        'group',
        'width',
        'height',
        'applied',
        'pixelsChanged',
        'skipReason',
        'source',
        'decisionTier',
        'anchor',
        'alphaGain',
        'residualScore',
        'processedGradientScore',
        'originalSpatialScore',
        'originalGradientScore',
        'suppressionGain',
        'adaptiveConfidence',
        'residualVisibility',
        'qualityStatus',
        'finalDamageWarning',
        'selectionDamageSafe',
        'qualitySignals',
        'decisionPath'
    ];
    const rows = results.map((record) => [
        record.fileName,
        record.paths?.join(' | ') ?? record.fileName,
        record.contentSha256,
        record.label,
        record.classification?.includedInMetrics,
        record.classification?.status,
        record.classification?.bucket,
        record.reviewConfidence,
        record.watermarkFamily,
        record.expectedAnchor == null ? null : JSON.stringify(record.expectedAnchor),
        record.note,
        record.group,
        record.width,
        record.height,
        record.applied,
        record.pixelsChanged,
        record.skipReason,
        record.source,
        record.decisionTier,
        anchorKey(record.actualAnchor),
        record.alphaGain,
        record.residualScore,
        record.processedGradientScore,
        record.originalSpatialScore,
        record.originalGradientScore,
        record.suppressionGain,
        record.adaptiveConfidence,
        record.residualVisibility,
        record.qualityStatus,
        record.finalDamageWarning,
        record.selectionDamageSafe,
        record.qualitySignals == null ? null : JSON.stringify(record.qualitySignals),
        record.decisionPath == null ? null : JSON.stringify(record.decisionPath)
    ]);

    return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function renderFailuresCsv(failures) {
    return renderExternalBenchmarkResultsCsv(failures);
}

async function main() {
    const args = parseExternalBenchmarkArgs(process.argv.slice(2));
    if (args.assumeWatermarked) {
        console.warn('diagnostic-only: assumed-watermarked labels are not release evidence');
    }
    const report = await benchmarkExternalSamples(args);
    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await mkdir(path.dirname(args.markdownPath), { recursive: true });
    await mkdir(path.dirname(args.resultsCsvPath), { recursive: true });
    await mkdir(path.dirname(args.failuresCsvPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(args.markdownPath, renderExternalBenchmarkMarkdown(report), 'utf8');
    await writeFile(args.resultsCsvPath, renderExternalBenchmarkResultsCsv(report.results), 'utf8');
    await writeFile(args.failuresCsvPath, renderFailuresCsv(report.failures), 'utf8');

    console.log(
        `summary: pass=${report.summary.passCount} fail=${report.summary.failCount} ` +
        `excluded=${report.summary.excludedCount} total=${report.summary.total}`
    );
    console.log(`newlyPassing=${report.newlyPassing.length} newlyFailing=${report.newlyFailing.length}`);
    console.log(`report: ${args.outputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

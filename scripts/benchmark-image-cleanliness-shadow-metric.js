import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { measureImageCleanlinessPixelFeatures } from './create-image-cleanliness-pixel-feature-report.js';
import { resolveExternalBenchmarkAlphaMaps } from './run-external-gemini-watermark-sample-benchmark.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

export function summarizeShadowBenchmarkSamples(samples) {
    return {
        count: samples.length,
        decodeMs: summarizeValues(samples.map((sample) => sample.decodeMs)),
        featureMs: summarizeValues(samples.map((sample) => sample.featureMs)),
        totalMs: summarizeValues(samples.map((sample) => sample.totalMs))
    };
}

export function assessShadowBenchmark(
    summary,
    { featureP95BudgetMs = 20 } = {}
) {
    const reasons = [];
    if (!summary || summary.count === 0) reasons.push('no-benchmark-samples');
    if (!(summary?.featureMs?.p95 <= featureP95BudgetMs)) {
        reasons.push('feature-p95-exceeds-budget');
    }
    return {
        readyForInteractiveRuntime: reasons.length === 0,
        featureP95BudgetMs,
        reasons
    };
}

export async function runImageCleanlinessShadowBenchmark({
    manifestPath,
    outputPath,
    limit = Number.POSITIVE_INFINITY,
    featureP95BudgetMs = 20
}) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!Array.isArray(manifest?.rows) || manifest.rows.length === 0) {
        throw new Error('manifest rows are required');
    }
    const rows = manifest.rows.slice(0, limit);
    const alphaMaps = resolveExternalBenchmarkAlphaMaps();
    await warmUp(rows[0], alphaMaps);
    const samples = [];

    for (const row of rows) {
        const startedAt = performance.now();
        const [beforeImageData, afterImageData] = await Promise.all([
            decodeImageDataInNode(row.filePath),
            decodeImageDataInNode(row.fullOutputPath)
        ]);
        const decodedAt = performance.now();
        const alphaMap = alphaMaps.getAlphaMap(row.position.width);
        measureImageCleanlinessPixelFeatures({
            beforeImageData,
            afterImageData,
            alphaMap,
            position: row.position
        });
        const completedAt = performance.now();
        samples.push({
            blindId: row.blindId,
            width: beforeImageData.width,
            height: beforeImageData.height,
            logoSize: row.position.width,
            decodeMs: roundMs(decodedAt - startedAt),
            featureMs: roundMs(completedAt - decodedAt),
            totalMs: roundMs(completedAt - startedAt)
        });
    }

    const summary = summarizeShadowBenchmarkSamples(samples);
    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        policy: {
            benchmarkSurface: 'predecoded-full-image-data-with-roi-local-feature-computation',
            featureSet: [
                'before-and-after-rgb-chroma-contour',
                'after-luma-interior-projection',
                'alpha-support-texture-retention'
            ],
            blocksOutput: false
        },
        summary,
        assessment: assessShadowBenchmark(summary, { featureP95BudgetMs }),
        samples
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
}

async function warmUp(row, alphaMaps) {
    const [beforeImageData, afterImageData] = await Promise.all([
        decodeImageDataInNode(row.filePath),
        decodeImageDataInNode(row.fullOutputPath)
    ]);
    measureImageCleanlinessPixelFeatures({
        beforeImageData,
        afterImageData,
        alphaMap: alphaMaps.getAlphaMap(row.position.width),
        position: row.position
    });
}

function summarizeValues(values) {
    const ordered = [...values].sort((left, right) => left - right);
    if (ordered.length === 0) return { mean: null, p50: null, p95: null, max: null };
    return {
        mean: roundMs(ordered.reduce((sum, value) => sum + value, 0) / ordered.length),
        p50: nearestRank(ordered, 0.5),
        p95: nearestRank(ordered, 0.95),
        max: ordered.at(-1)
    };
}

function nearestRank(ordered, percentile) {
    return ordered[Math.max(0, Math.ceil(ordered.length * percentile) - 1)];
}

function roundMs(value) {
    return Math.round(value * 1000) / 1000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
        const flag = process.argv[index];
        const value = process.argv[index + 1];
        if (!flag?.startsWith('--') || !value) throw new Error(`invalid argument: ${flag}`);
        options[flag.slice(2)] = value;
    }
    if (!options.manifest) throw new Error('--manifest is required');
    if (!options.output) throw new Error('--output is required');
    const report = await runImageCleanlinessShadowBenchmark({
        manifestPath: options.manifest,
        outputPath: options.output,
        limit: options.limit ? Number(options.limit) : Number.POSITIVE_INFINITY,
        featureP95BudgetMs: options['feature-p95-budget-ms']
            ? Number(options['feature-p95-budget-ms'])
            : 20
    });
    console.log(JSON.stringify({ summary: report.summary, assessment: report.assessment }, null, 2));
}

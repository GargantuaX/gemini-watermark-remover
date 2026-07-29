import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
        options[token.slice(2)] = value;
        index += 1;
    }
    return options;
}

function roundRate(numerator, denominator) {
    if (denominator === 0) return null;
    return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function formatRate(value) {
    return value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function isCompleteDecision(decision) {
    return (
        typeof decision?.outputClean === 'boolean' &&
        typeof decision?.contentDamage === 'boolean'
    );
}

function predictDamage(metric) {
    return (
        metric.finalDamageWarning === true ||
        metric.qualitySignals?.damageWarning === true ||
        metric.classification?.bucket === 'content-damage'
    );
}

export function analyzeImageCleanlinessReview({
    metricReport,
    manifest,
    reviews,
    minimumReviewers = 1
}) {
    if (!Number.isInteger(minimumReviewers) || minimumReviewers < 1) {
        throw new Error('minimumReviewers must be a positive integer');
    }
    if (!Array.isArray(manifest?.rows) || !Array.isArray(metricReport?.results)) {
        throw new Error('manifest rows and metric report results are required');
    }
    const reviewerIds = new Set();
    for (const review of reviews) {
        if (typeof review.reviewerId !== 'string' || reviewerIds.has(review.reviewerId)) {
            throw new Error(`duplicate or invalid reviewerId: ${review.reviewerId}`);
        }
        reviewerIds.add(review.reviewerId);
    }
    const frozenReviews = reviews.filter((review) => review.frozen === true);
    const reviewMaps = frozenReviews.map((review) => ({
        reviewerId: review.reviewerId,
        decisions: new Map((review.decisions ?? []).map((decision) => [decision.blindId, decision]))
    }));
    const metricsByFile = new Map(metricReport.results.map((result) => [result.fileName, result]));
    const rows = [];
    const unscored = [];
    const reviewerDisagreements = [];

    for (const manifestRow of manifest.rows) {
        const metric = metricsByFile.get(manifestRow.fileName);
        if (!metric) {
            unscored.push({ blindId: manifestRow.blindId, reason: 'metric-result-missing' });
            continue;
        }
        const labels = reviewMaps
            .map(({ reviewerId, decisions }) => ({ reviewerId, decision: decisions.get(manifestRow.blindId) }))
            .filter(({ decision }) => isCompleteDecision(decision));
        if (labels.length < minimumReviewers) {
            unscored.push({ blindId: manifestRow.blindId, reason: 'insufficient-frozen-labels' });
            continue;
        }
        const first = labels[0].decision;
        const agrees = labels.every(
            ({ decision }) =>
                decision.outputClean === first.outputClean &&
                decision.contentDamage === first.contentDamage
        );
        if (!agrees) {
            reviewerDisagreements.push({
                blindId: manifestRow.blindId,
                fileName: manifestRow.fileName,
                labels
            });
            unscored.push({ blindId: manifestRow.blindId, reason: 'reviewer-disagreement' });
            continue;
        }

        const actualClean = first.outputClean === true && first.contentDamage === false;
        const actualDamage = first.contentDamage === true;
        const predictedClean = metric.classification?.status === 'pass';
        const predictedDamage = predictDamage(metric);
        let type = 'agreement';
        if (!actualClean && predictedClean) type = 'false-clean';
        if (actualClean && !predictedClean) type = 'false-dirty';
        rows.push({
            blindId: manifestRow.blindId,
            fileName: manifestRow.fileName,
            actualClean,
            actualDamage,
            predictedClean,
            predictedDamage,
            type,
            metricBucket: metric.classification?.bucket ?? null,
            source: metric.source ?? null,
            residualScore: metric.residualScore ?? null,
            gradientScore: metric.processedGradientScore ?? null,
            confidence: first.confidence ?? null,
            notes: first.notes ?? ''
        });
    }

    const count = (predicate) => rows.filter(predicate).length;
    const actualClean = count((row) => row.actualClean);
    const actualDirty = rows.length - actualClean;
    const predictedClean = count((row) => row.predictedClean);
    const predictedDirty = rows.length - predictedClean;
    const falseClean = count((row) => row.type === 'false-clean');
    const falseDirty = count((row) => row.type === 'false-dirty');
    const damageCases = count((row) => row.actualDamage);
    const damageDetected = count((row) => row.actualDamage && row.predictedDamage);
    const damageMissed = damageCases - damageDetected;
    const summary = {
        total: manifest.rows.length,
        scored: rows.length,
        unscored: unscored.length,
        reviewerDisagreements: reviewerDisagreements.length,
        actualClean,
        actualDirty,
        predictedClean,
        predictedDirty,
        trueClean: count((row) => row.actualClean && row.predictedClean),
        trueDirty: count((row) => !row.actualClean && !row.predictedClean),
        falseClean,
        falseDirty,
        falseCleanRate: roundRate(falseClean, actualDirty),
        falseDirtyRate: roundRate(falseDirty, actualClean),
        damageCases,
        damageDetected,
        damageMissed,
        damageMissRate: roundRate(damageMissed, damageCases)
    };
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        policy: {
            minimumReviewers,
            frozenReviewsOnly: true,
            predictedClean: 'classification.status === pass',
            predictedDamage: 'damage warning or content-damage bucket'
        },
        reviewers: reviews.map((review) => ({ reviewerId: review.reviewerId, frozen: review.frozen === true })),
        summary,
        disagreements: rows.filter((row) => row.type !== 'agreement'),
        reviewerDisagreements,
        unscored,
        rows
    };
}

function renderMarkdown(report) {
    const { summary } = report;
    const lines = [
        '# Image Cleanliness Metric Review',
        '',
        `- Generated: ${report.generatedAt}`,
        `- Scored: ${summary.scored}/${summary.total}`,
        `- Frozen reviewers: ${report.reviewers.filter((item) => item.frozen).length}`,
        '',
        '## Calibration summary',
        '',
        '| Signal | Count | Rate |',
        '|---|---:|---:|',
        `| False-clean | ${summary.falseClean}/${summary.actualDirty} | ${formatRate(summary.falseCleanRate)} |`,
        `| False-dirty | ${summary.falseDirty}/${summary.actualClean} | ${formatRate(summary.falseDirtyRate)} |`,
        `| Damage missed | ${summary.damageMissed}/${summary.damageCases} | ${formatRate(summary.damageMissRate)} |`,
        `| Reviewer disagreement | ${summary.reviewerDisagreements}/${summary.total} | ${formatRate(roundRate(summary.reviewerDisagreements, summary.total))} |`,
        '',
        '## Metric disagreements',
        '',
        '| Blind ID | File | Type | Metric bucket | Residual | Gradient |',
        '|---|---|---|---|---:|---:|'
    ];
    for (const row of report.disagreements) {
        lines.push(
            `| ${row.blindId} | ${row.fileName} | ${row.type} | ${row.metricBucket ?? ''} | ${row.residualScore ?? ''} | ${row.gradientScore ?? ''} |`
        );
    }
    if (report.disagreements.length === 0) lines.push('| — | — | none | — | — | — |');
    lines.push('');
    return `${lines.join('\n')}\n`;
}

export async function createImageCleanlinessReviewReport({
    metricReportPath,
    manifestPath,
    reviewPaths,
    outputDir,
    minimumReviewers = 1
}) {
    if (!metricReportPath || !manifestPath || !outputDir || !Array.isArray(reviewPaths) || reviewPaths.length === 0) {
        throw new Error('metricReportPath, manifestPath, reviewPaths, and outputDir are required');
    }
    const [metricReport, manifest, ...reviews] = await Promise.all([
        readFile(path.resolve(metricReportPath), 'utf8').then(JSON.parse),
        readFile(path.resolve(manifestPath), 'utf8').then(JSON.parse),
        ...reviewPaths.map((reviewPath) => readFile(path.resolve(reviewPath), 'utf8').then(JSON.parse))
    ]);
    const report = analyzeImageCleanlinessReview({
        metricReport,
        manifest,
        reviews,
        minimumReviewers
    });
    const resolvedOutputDir = path.resolve(outputDir);
    await mkdir(resolvedOutputDir, { recursive: true });
    await Promise.all([
        writeFile(path.join(resolvedOutputDir, 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`),
        writeFile(path.join(resolvedOutputDir, 'latest-report.md'), renderMarkdown(report))
    ]);
    return report;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const reviewPaths = (options.reviews ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const report = await createImageCleanlinessReviewReport({
        metricReportPath: options['metric-report'],
        manifestPath: options.manifest,
        reviewPaths,
        outputDir: options['output-dir'],
        minimumReviewers: Number(options['minimum-reviewers'] ?? 1)
    });
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RESIDUAL_FEATURES = [
    feature('absolute-gradient-residual', 'higher', (metric) =>
        absolute(metric.processedGradientScore)
    ),
    feature(
        'visual-artifact-cost',
        'higher',
        (metric) => metric.qualitySignals?.artifacts?.visualArtifactCost
    ),
    feature('residual-loss', 'higher', (metric) => metric.qualitySignals?.residualLoss),
    feature(
        'weighted-recompose-error',
        'higher',
        (metric) => metric.qualitySignals?.artifacts?.weightedRecomposeError
    )
];

const DAMAGE_FEATURES = [
    feature(
        'recompose-error',
        'higher',
        (metric) => metric.qualitySignals?.artifacts?.recomposeError
    ),
    feature(
        'weighted-recompose-error',
        'higher',
        (metric) => metric.qualitySignals?.artifacts?.weightedRecomposeError
    ),
    feature(
        'signed-template-correlation',
        'lower',
        (metric) => metric.qualitySignals?.artifacts?.signedDiffTemplateCorrelation
    ),
    feature(
        'diff-gradient-correlation',
        'lower',
        (metric) => metric.qualitySignals?.artifacts?.diffGradientCorrelation
    ),
    feature('suppression-gain', 'lower', (metric) =>
        metric.applied === false ? undefined : metric.suppressionGain
    ),
    feature('evidence-loss', 'higher', (metric) => metric.qualitySignals?.evidenceLoss)
];

export function splitImageCleanlinessRows(
    rows,
    { seed = 'gwr-image-cleanliness-v2', calibrationFraction = 2 / 3 } = {}
) {
    if (!(calibrationFraction > 0 && calibrationFraction < 1)) {
        throw new Error('calibrationFraction must be between 0 and 1');
    }
    const groups = new Map([
        ['clean', []],
        ['residual', []],
        ['damage', []]
    ]);
    for (const row of rows) groups.get(visualClass(row)).push(row);

    const calibration = [];
    const holdout = [];
    for (const classRows of groups.values()) {
        const ordered = [...classRows].sort((left, right) => {
            const order = stableOrder(seed, left.blindId).localeCompare(
                stableOrder(seed, right.blindId)
            );
            return order || left.blindId.localeCompare(right.blindId);
        });
        const calibrationCount = partitionCount(ordered.length, calibrationFraction);
        calibration.push(...ordered.slice(0, calibrationCount));
        holdout.push(...ordered.slice(calibrationCount));
    }
    return {
        calibration: calibration.sort(byBlindId),
        holdout: holdout.sort(byBlindId)
    };
}

export function evaluateImageCleanlinessMetricV2({
    metricReport,
    reviewReport,
    seed = 'gwr-image-cleanliness-v2',
    calibrationFraction = 2 / 3
}) {
    if (!Array.isArray(metricReport?.results) || !Array.isArray(reviewReport?.rows)) {
        throw new Error('metric report results and review report rows are required');
    }
    const metricsByFile = new Map(metricReport.results.map((metric) => [metric.fileName, metric]));
    const rows = reviewReport.rows.map((row) => {
        const metric = metricsByFile.get(row.fileName);
        if (!metric) throw new Error(`metric result missing for ${row.fileName}`);
        return { ...row, metric };
    });
    const split = splitImageCleanlinessRows(rows, { seed, calibrationFraction });
    const residualModel = selectModel(
        split.calibration.filter((row) => !row.actualDamage),
        RESIDUAL_FEATURES,
        (row) => !row.actualClean
    );
    const damageModel = selectModel(
        split.calibration,
        DAMAGE_FEATURES,
        (row) => row.actualDamage
    );
    const models = {
        residual: publicModel(residualModel),
        damage: publicModel(damageModel)
    };

    return {
        schemaVersion: 1,
        policy: {
            experimentalOnly: true,
            labelSource: 'frozen visual review',
            split: 'deterministic stratified calibration/holdout',
            seed,
            calibrationFraction
        },
        split: {
            calibration: split.calibration.map((row) => row.blindId),
            holdout: split.holdout.map((row) => row.blindId),
            classCounts: {
                calibration: countClasses(split.calibration),
                holdout: countClasses(split.holdout)
            }
        },
        models,
        calibration: comparePredictions(split.calibration, residualModel, damageModel),
        holdout: comparePredictions(split.holdout, residualModel, damageModel),
        recommendation: {
            promoteToProduction: false,
            reason:
                'Experimental single-reviewer pilot; independent reviewers and a larger untouched holdout are required before production promotion.'
        }
    };
}

export async function createImageCleanlinessMetricV2Report({
    metricReportPath,
    reviewReportPath,
    outputDir,
    seed = 'gwr-image-cleanliness-v2',
    calibrationFraction = 2 / 3
}) {
    const [metricReport, reviewReport] = await Promise.all([
        readJson(metricReportPath),
        readJson(reviewReportPath)
    ]);
    const report = {
        generatedAt: new Date().toISOString(),
        ...evaluateImageCleanlinessMetricV2({
            metricReport,
            reviewReport,
            seed,
            calibrationFraction
        })
    };
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
        writeFile(
            path.join(outputDir, 'latest-report.json'),
            `${JSON.stringify(report, null, 2)}\n`
        ),
        writeFile(path.join(outputDir, 'latest-report.md'), renderMarkdown(report))
    ]);
    return report;
}

function comparePredictions(rows, residualModel, damageModel) {
    return {
        current: summarize(rows, (row) => ({
            dirty: row.metric.classification?.status !== 'pass',
            damage:
                row.metric.finalDamageWarning === true ||
                row.metric.qualitySignals?.damageWarning === true ||
                row.metric.classification?.bucket === 'content-damage'
        })),
        v2: summarize(rows, (row) => {
            const residual = predict(residualModel, row);
            const damage = predict(damageModel, row);
            return { dirty: residual || damage, damage };
        })
    };
}

function selectModel(rows, features, isPositive) {
    let best = null;
    for (const spec of features) {
        const values = rows.map((row) => spec.read(row.metric)).filter(Number.isFinite);
        for (const threshold of [...new Set(values)].sort((a, b) => a - b)) {
            const candidate = scoreModel({ spec, threshold }, rows, isPositive);
            if (!best || compareCandidates(candidate, best) > 0) best = candidate;
        }
    }
    if (!best) throw new Error('no finite feature values are available for model selection');
    return best;
}

function scoreModel(model, rows, isPositive) {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    let trueNegative = 0;
    for (const row of rows) {
        const actual = isPositive(row);
        const predicted = predict(model, row);
        if (actual && predicted) truePositive += 1;
        else if (!actual && predicted) falsePositive += 1;
        else if (actual) falseNegative += 1;
        else trueNegative += 1;
    }
    const precision = rate(truePositive, truePositive + falsePositive);
    const recall = rate(truePositive, truePositive + falseNegative);
    const betaSquared = 4;
    const f2 =
        precision === null || recall === null || precision + recall === 0
            ? 0
            : ((1 + betaSquared) * precision * recall) / (betaSquared * precision + recall);
    return {
        ...model,
        calibration: {
            f2,
            recall,
            falsePositive,
            trueNegative
        }
    };
}

function compareCandidates(left, right) {
    return (
        left.calibration.f2 - right.calibration.f2 ||
        (left.calibration.recall ?? -1) - (right.calibration.recall ?? -1) ||
        right.calibration.falsePositive - left.calibration.falsePositive
    );
}

function predict(model, row) {
    const value = model.spec.read(row.metric);
    if (!Number.isFinite(value)) return false;
    return model.spec.direction === 'higher'
        ? value >= model.threshold
        : value <= model.threshold;
}

function summarize(rows, predictionFor) {
    const summary = {
        total: rows.length,
        trueClean: 0,
        trueDirty: 0,
        falseClean: 0,
        falseDirty: 0,
        falseCleanRate: null,
        falseDirtyRate: null,
        accuracy: null,
        damageCases: 0,
        damageDetected: 0,
        damageMissed: 0,
        damageMissRate: null
    };
    let actualCleanCount = 0;
    let actualDirtyCount = 0;
    for (const row of rows) {
        const prediction = predictionFor(row);
        if (row.actualClean) {
            actualCleanCount += 1;
            if (prediction.dirty) summary.falseDirty += 1;
            else summary.trueClean += 1;
        } else {
            actualDirtyCount += 1;
            if (prediction.dirty) summary.trueDirty += 1;
            else summary.falseClean += 1;
        }
        if (row.actualDamage) {
            summary.damageCases += 1;
            if (prediction.damage) summary.damageDetected += 1;
            else summary.damageMissed += 1;
        }
    }
    summary.falseCleanRate = roundedRate(summary.falseClean, actualDirtyCount);
    summary.falseDirtyRate = roundedRate(summary.falseDirty, actualCleanCount);
    summary.accuracy = roundedRate(summary.trueClean + summary.trueDirty, rows.length);
    summary.damageMissRate = roundedRate(summary.damageMissed, summary.damageCases);
    return summary;
}

function feature(name, direction, read) {
    return { name, direction, read };
}

function publicModel(model) {
    return {
        feature: model.spec.name,
        direction: model.spec.direction,
        threshold: model.threshold,
        calibration: {
            f2: round(model.calibration.f2),
            recall: round(model.calibration.recall),
            falsePositive: model.calibration.falsePositive,
            trueNegative: model.calibration.trueNegative
        }
    };
}

function visualClass(row) {
    if (row.actualClean) return 'clean';
    return row.actualDamage ? 'damage' : 'residual';
}

function countClasses(rows) {
    const counts = { clean: 0, residual: 0, damage: 0 };
    for (const row of rows) counts[visualClass(row)] += 1;
    return counts;
}

function partitionCount(length, fraction) {
    if (length < 2) return length;
    return Math.max(1, Math.min(length - 1, Math.round(length * fraction)));
}

function stableOrder(seed, blindId) {
    return createHash('sha256').update(`${seed}\0${blindId}`).digest('hex');
}

function byBlindId(left, right) {
    return left.blindId.localeCompare(right.blindId);
}

function absolute(value) {
    return Number.isFinite(value) ? Math.abs(value) : value;
}

function rate(numerator, denominator) {
    return denominator === 0 ? null : numerator / denominator;
}

function roundedRate(numerator, denominator) {
    return round(rate(numerator, denominator));
}

function round(value) {
    return value === null ? null : Math.round(value * 10_000) / 10_000;
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

function renderMarkdown(report) {
    const rows = [
        ['False-clean rate', 'falseCleanRate'],
        ['False-dirty rate', 'falseDirtyRate'],
        ['Accuracy', 'accuracy'],
        ['Damage miss rate', 'damageMissRate']
    ];
    const table = rows
        .map(
            ([label, key]) =>
                `| ${label} | ${formatRate(report.holdout.current[key])} | ${formatRate(report.holdout.v2[key])} |`
        )
        .join('\n');
    return `# Image cleanliness metric V2 — Experimental only

This report uses a deterministic stratified calibration/holdout split. It must not be used as a production release gate yet.

## Selected calibration models

- Residual: \`${report.models.residual.feature}\` ${report.models.residual.direction} \`${report.models.residual.threshold}\`
- Damage: \`${report.models.damage.feature}\` ${report.models.damage.direction} \`${report.models.damage.threshold}\`

## Holdout

| Metric | Current | Experimental V2 |
| --- | ---: | ---: |
${table}

## Decision

Promotion: **no** — ${report.recommendation.reason}
`;
}

function formatRate(value) {
    return value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
        const flag = process.argv[index];
        const value = process.argv[index + 1];
        if (!flag?.startsWith('--') || !value) throw new Error(`invalid argument: ${flag}`);
        options[flag.slice(2)] = value;
    }
    const required = ['metric-report', 'review-report', 'output-dir'];
    for (const name of required) {
        if (!options[name]) throw new Error(`--${name} is required`);
    }
    const report = await createImageCleanlinessMetricV2Report({
        metricReportPath: options['metric-report'],
        reviewReportPath: options['review-report'],
        outputDir: options['output-dir'],
        seed: options.seed
    });
    console.log(JSON.stringify({ outputDir: options['output-dir'], holdout: report.holdout }, null, 2));
}

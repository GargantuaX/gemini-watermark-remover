import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { splitImageCleanlinessRows } from './evaluate-image-cleanliness-metric-v2.js';

const TEXTURE_DAMAGE_FALSE_POSITIVE_BUDGET = 0.1;

export function evaluateImageCleanlinessShadowMetric({
    reviewReport,
    pixelFeatureReport,
    seed = 'gwr-image-cleanliness-shadow-v1',
    calibrationFraction = 2 / 3
}) {
    if (!Array.isArray(reviewReport?.rows) || !Array.isArray(pixelFeatureReport?.rows)) {
        throw new Error('review and pixel feature rows are required');
    }
    const featuresByBlindId = new Map(
        pixelFeatureReport.rows
            .filter((row) => row.status === 'measured' && row.features)
            .map((row) => [row.blindId, row.features])
    );
    const rows = reviewReport.rows.map((row) => {
        const features = featuresByBlindId.get(row.blindId);
        if (!features) throw new Error(`pixel features missing for ${row.blindId}`);
        return { ...row, features };
    });
    const split = splitImageCleanlinessRows(rows, { seed, calibrationFraction });
    const currentCalibration = summarize(split.calibration, currentPrediction);
    const falseDirtyBudget = currentCalibration.falseDirtyRate;
    const model = selectContourThreshold(split.calibration, falseDirtyBudget);
    const textureModel = selectTextureDamageThreshold(
        split.calibration,
        TEXTURE_DAMAGE_FALSE_POSITIVE_BUDGET
    );

    return {
        schemaVersion: 1,
        policy: {
            blocksOutput: false,
            developmentOnly: true,
            thresholdSelection:
                'minimize calibration false-clean without exceeding current calibration false-dirty rate',
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
        model: {
            feature: 'after-rgb-alpha-contour-ratio',
            direction: 'higher',
            threshold: model.threshold,
            calibrationFalseDirtyBudget: falseDirtyBudget
        },
        diagnosticModels: {
            textureDistortion: {
                feature: 'absolute-log2-texture-retention',
                direction: 'higher',
                threshold: textureModel.threshold,
                calibrationFalsePositiveBudget: TEXTURE_DAMAGE_FALSE_POSITIVE_BUDGET
            }
        },
        diagnosticSignals: [
            'contour-retention',
            'absolute-log2-texture-retention',
            'luma-interior-projection-ratio',
            'luma-interior-projection-target'
        ],
        calibration: {
            current: currentCalibration,
            shadow: summarize(split.calibration, (row) => shadowPrediction(row, model)),
            textureDamageDiagnostic: summarizeDamageDiagnostic(
                split.calibration,
                textureModel
            )
        },
        holdout: {
            current: summarize(split.holdout, currentPrediction),
            shadow: summarize(split.holdout, (row) => shadowPrediction(row, model)),
            textureDamageDiagnostic: summarizeDamageDiagnostic(split.holdout, textureModel)
        },
        risks: {
            calibration: split.calibration.map((row) => riskRow(row, model, textureModel)),
            holdout: split.holdout.map((row) => riskRow(row, model, textureModel))
        },
        recommendation: {
            promoteToProduction: false,
            reason:
                'Shadow-only development result; the inspected pilot holdout cannot be reused as untouched promotion evidence.'
        }
    };
}

function selectTextureDamageThreshold(rows, falsePositiveBudget) {
    const thresholds = [
        ...new Set(rows.map(textureDistortion).filter(Number.isFinite))
    ].sort((left, right) => left - right);
    let best = null;
    for (const threshold of thresholds) {
        const candidate = { threshold };
        const summary = summarizeDamageDiagnostic(rows, candidate);
        if (summary.falsePositiveRate > falsePositiveBudget) continue;
        if (
            !best ||
            summary.damageMissed < best.summary.damageMissed ||
            (summary.damageMissed === best.summary.damageMissed &&
                summary.falsePositives < best.summary.falsePositives)
        ) {
            best = { threshold, summary };
        }
    }
    if (!best) throw new Error('no texture threshold satisfies the calibration budget');
    return best;
}

export async function createImageCleanlinessShadowMetricReport({
    reviewReportPath,
    pixelFeatureReportPath,
    outputDir,
    seed = 'gwr-image-cleanliness-shadow-v1',
    calibrationFraction = 2 / 3
}) {
    const [reviewReport, pixelFeatureReport] = await Promise.all([
        readJson(reviewReportPath),
        readJson(pixelFeatureReportPath)
    ]);
    const report = {
        generatedAt: new Date().toISOString(),
        ...evaluateImageCleanlinessShadowMetric({
            reviewReport,
            pixelFeatureReport,
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

function selectContourThreshold(rows, falseDirtyBudget) {
    const thresholds = [
        ...new Set(
            rows
                .map((row) => row.features.after.rgbContourRatio)
                .filter(Number.isFinite)
        )
    ].sort((left, right) => left - right);
    let best = null;
    for (const threshold of thresholds) {
        const candidate = { threshold };
        const summary = summarize(rows, (row) => shadowPrediction(row, candidate));
        if (summary.falseDirtyRate > falseDirtyBudget) continue;
        if (
            !best ||
            summary.falseClean < best.summary.falseClean ||
            (summary.falseClean === best.summary.falseClean &&
                summary.falseDirty < best.summary.falseDirty)
        ) {
            best = { threshold, summary };
        }
    }
    if (!best) throw new Error('no contour threshold satisfies the calibration budget');
    return best;
}

function currentPrediction(row) {
    return {
        dirty: row.predictedClean !== true,
        damage: row.predictedDamage === true
    };
}

function shadowPrediction(row, model) {
    const flagged = row.features.after.rgbContourRatio >= model.threshold;
    return { dirty: flagged, damage: flagged };
}

function summarizeDamageDiagnostic(rows, model) {
    const summary = {
        damageCases: 0,
        damageFlagged: 0,
        damageMissed: 0,
        damageMissRate: null,
        nonDamageCases: 0,
        falsePositives: 0,
        falsePositiveRate: null
    };
    for (const row of rows) {
        const flagged = textureDistortion(row) >= model.threshold;
        if (row.actualDamage) {
            summary.damageCases += 1;
            flagged ? (summary.damageFlagged += 1) : (summary.damageMissed += 1);
        } else {
            summary.nonDamageCases += 1;
            if (flagged) summary.falsePositives += 1;
        }
    }
    summary.damageMissRate = roundedRate(summary.damageMissed, summary.damageCases);
    summary.falsePositiveRate = roundedRate(
        summary.falsePositives,
        summary.nonDamageCases
    );
    return summary;
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
        damageFlagged: 0,
        damageMissed: 0,
        damageMissRate: null
    };
    let cleanCount = 0;
    let dirtyCount = 0;
    for (const row of rows) {
        const prediction = predictionFor(row);
        if (row.actualClean) {
            cleanCount += 1;
            prediction.dirty ? (summary.falseDirty += 1) : (summary.trueClean += 1);
        } else {
            dirtyCount += 1;
            prediction.dirty ? (summary.trueDirty += 1) : (summary.falseClean += 1);
        }
        if (row.actualDamage) {
            summary.damageCases += 1;
            prediction.damage ? (summary.damageFlagged += 1) : (summary.damageMissed += 1);
        }
    }
    summary.falseCleanRate = roundedRate(summary.falseClean, dirtyCount);
    summary.falseDirtyRate = roundedRate(summary.falseDirty, cleanCount);
    summary.accuracy = roundedRate(summary.trueClean + summary.trueDirty, rows.length);
    summary.damageMissRate = roundedRate(summary.damageMissed, summary.damageCases);
    return summary;
}

function riskRow(row, model, textureModel) {
    const textureRetention = row.features.texture.energyRetention;
    const distortion = textureDistortion(row);
    return {
        blindId: row.blindId,
        actualClean: row.actualClean,
        actualDamage: row.actualDamage,
        currentPredictedClean: row.predictedClean,
        shadowFlagged: row.features.after.rgbContourRatio >= model.threshold,
        textureDamageFlagged: distortion >= textureModel.threshold,
        signals: {
            afterRgbContourRatio: row.features.after.rgbContourRatio,
            contourRetention: row.features.contourRetention,
            absoluteLog2TextureRetention: distortion,
            lumaInteriorProjectionRatio:
                row.features.after.lumaInteriorProjectionRatio,
            lumaInteriorProjectionTarget:
                row.features.after.lumaInteriorProjectionTarget
        }
    };
}

function textureDistortion(row) {
    const textureRetention = row.features.texture.energyRetention;
    return Number.isFinite(textureRetention) && textureRetention > 0
        ? Math.abs(Math.log2(textureRetention))
        : Number.POSITIVE_INFINITY;
}

function countClasses(rows) {
    const counts = { clean: 0, residual: 0, damage: 0 };
    for (const row of rows) {
        if (row.actualClean) counts.clean += 1;
        else if (row.actualDamage) counts.damage += 1;
        else counts.residual += 1;
    }
    return counts;
}

function roundedRate(numerator, denominator) {
    if (denominator === 0) return null;
    return Math.round((numerator / denominator) * 10_000) / 10_000;
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

function renderMarkdown(report) {
    return `# Image cleanliness shadow metric

This report is **development-only** and does not block output.

Threshold: \`${report.model.threshold}\` on \`${report.model.feature}\`.

## Holdout

| Metric | Current | Shadow |
| --- | ---: | ---: |
| False-clean rate | ${formatRate(report.holdout.current.falseCleanRate)} | ${formatRate(report.holdout.shadow.falseCleanRate)} |
| False-dirty rate | ${formatRate(report.holdout.current.falseDirtyRate)} | ${formatRate(report.holdout.shadow.falseDirtyRate)} |
| Accuracy | ${formatRate(report.holdout.current.accuracy)} | ${formatRate(report.holdout.shadow.accuracy)} |
| Damage miss rate | ${formatRate(report.holdout.current.damageMissRate)} | ${formatRate(report.holdout.shadow.damageMissRate)} |

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
    for (const name of ['review-report', 'pixel-report', 'output-dir']) {
        if (!options[name]) throw new Error(`--${name} is required`);
    }
    const report = await createImageCleanlinessShadowMetricReport({
        reviewReportPath: options['review-report'],
        pixelFeatureReportPath: options['pixel-report'],
        outputDir: options['output-dir'],
        seed: options.seed
    });
    console.log(JSON.stringify({ model: report.model, holdout: report.holdout }, null, 2));
}

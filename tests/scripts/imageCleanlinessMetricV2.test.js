import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as metricV2Module from '../../scripts/evaluate-image-cleanliness-metric-v2.js';
import {
    evaluateImageCleanlinessMetricV2,
    splitImageCleanlinessRows
} from '../../scripts/evaluate-image-cleanliness-metric-v2.js';

test('stratified split keeps clean, residual, and damage classes in both partitions', () => {
    const rows = [
        ...labelRows('clean', 6),
        ...labelRows('residual', 6),
        ...labelRows('damage', 6)
    ];

    const split = splitImageCleanlinessRows(rows, {
        seed: 'fixed-pilot',
        calibrationFraction: 2 / 3
    });

    assert.deepEqual(classCounts(split.calibration), { clean: 4, residual: 4, damage: 4 });
    assert.deepEqual(classCounts(split.holdout), { clean: 2, residual: 2, damage: 2 });
    assert.deepEqual(
        splitImageCleanlinessRows(rows, {
            seed: 'fixed-pilot',
            calibrationFraction: 2 / 3
        }),
        split
    );
});

test('holdout feature changes affect evaluation but cannot change calibration-selected models', () => {
    const rows = [
        ...labelRows('clean', 9),
        ...labelRows('residual', 9),
        ...labelRows('damage', 9)
    ];
    const split = splitImageCleanlinessRows(rows, {
        seed: 'no-leakage',
        calibrationFraction: 2 / 3
    });
    const holdoutIds = new Set(split.holdout.map((row) => row.blindId));
    const metricReport = metricFixture(rows, (row) => {
        const className = visualClass(row);
        return {
            gradient: className === 'residual' ? 0.8 : 0.1,
            recompose: className === 'damage' ? 0.8 : 0.1
        };
    });
    const reviewReport = { rows };

    const baseline = evaluateImageCleanlinessMetricV2({
        metricReport,
        reviewReport,
        seed: 'no-leakage',
        calibrationFraction: 2 / 3
    });
    const mutatedMetricReport = structuredClone(metricReport);
    for (const result of mutatedMetricReport.results) {
        if (!holdoutIds.has(result.blindId)) continue;
        result.processedGradientScore = result.processedGradientScore === 0.8 ? 0 : 1;
        result.qualitySignals.artifacts.recomposeError =
            result.qualitySignals.artifacts.recomposeError === 0.8 ? 0 : 1;
    }
    const mutated = evaluateImageCleanlinessMetricV2({
        metricReport: mutatedMetricReport,
        reviewReport,
        seed: 'no-leakage',
        calibrationFraction: 2 / 3
    });

    assert.deepEqual(mutated.models, baseline.models);
    assert.notDeepEqual(mutated.holdout.v2, baseline.holdout.v2);
});

test('evaluation selects separate residual and damage signals and compares them with current predictions', () => {
    const rows = [
        ...labelRows('clean', 9),
        ...labelRows('residual', 9),
        ...labelRows('damage', 9)
    ];
    const metricReport = metricFixture(rows, (row) => {
        const className = visualClass(row);
        return {
            gradient: className === 'residual' ? 0.9 : 0.05,
            recompose: className === 'damage' ? 0.9 : 0.05
        };
    });

    const report = evaluateImageCleanlinessMetricV2({
        metricReport,
        reviewReport: { rows },
        seed: 'separate-signals',
        calibrationFraction: 2 / 3
    });

    assert.equal(report.policy.experimentalOnly, true);
    assert.equal(report.models.residual.feature, 'absolute-gradient-residual');
    assert.equal(report.models.damage.feature, 'recompose-error');
    assert.deepEqual(report.split.classCounts, {
        calibration: { clean: 6, residual: 6, damage: 6 },
        holdout: { clean: 3, residual: 3, damage: 3 }
    });
    assert.deepEqual(report.holdout.v2, {
        total: 9,
        trueClean: 3,
        trueDirty: 6,
        falseClean: 0,
        falseDirty: 0,
        falseCleanRate: 0,
        falseDirtyRate: 0,
        accuracy: 1,
        damageCases: 3,
        damageDetected: 3,
        damageMissed: 0,
        damageMissRate: 0
    });
    assert.equal(report.recommendation.promoteToProduction, false);
    assert.match(report.recommendation.reason, /single-reviewer pilot/);
});

test('report writer persists machine-readable results and an experimental holdout summary', async (t) => {
    assert.equal(typeof metricV2Module.createImageCleanlinessMetricV2Report, 'function');
    const workspace = await mkdtemp(path.join(tmpdir(), 'gwr-cleanliness-v2-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const rows = [
        ...labelRows('clean', 9),
        ...labelRows('residual', 9),
        ...labelRows('damage', 9)
    ];
    const metricReportPath = path.join(workspace, 'metric.json');
    const reviewReportPath = path.join(workspace, 'review.json');
    const outputDir = path.join(workspace, 'output');
    await writeFile(
        metricReportPath,
        JSON.stringify(
            metricFixture(rows, (row) => ({
                gradient: visualClass(row) === 'residual' ? 0.9 : 0.05,
                recompose: visualClass(row) === 'damage' ? 0.9 : 0.05
            }))
        )
    );
    await writeFile(reviewReportPath, JSON.stringify({ rows }));

    const report = await metricV2Module.createImageCleanlinessMetricV2Report({
        metricReportPath,
        reviewReportPath,
        outputDir,
        seed: 'writer-fixture'
    });

    const written = JSON.parse(await readFile(path.join(outputDir, 'latest-report.json'), 'utf8'));
    assert.deepEqual(written.holdout, report.holdout);
    const markdown = await readFile(path.join(outputDir, 'latest-report.md'), 'utf8');
    assert.match(markdown, /Experimental only/);
    assert.match(markdown, /Holdout/);
    assert.match(markdown, /False-clean rate/);
    assert.match(markdown, /single-reviewer pilot/);
});

test('skipped processing does not turn suppression gain sentinel zero into a damage signal', () => {
    const rows = [
        ...labelRows('clean', 9),
        ...labelRows('residual', 9),
        ...labelRows('damage', 9)
    ];
    const metricReport = metricFixture(rows, (row) => ({
        gradient: visualClass(row) === 'residual' ? 0.9 : 0.05,
        recompose: 0.1
    }));
    for (const result of metricReport.results) {
        const row = rows.find((candidate) => candidate.fileName === result.fileName);
        const className = visualClass(row);
        result.applied = className !== 'clean';
        result.suppressionGain = className === 'clean' ? 0 : className === 'damage' ? 0.1 : 0.5;
    }

    const report = evaluateImageCleanlinessMetricV2({
        metricReport,
        reviewReport: { rows },
        seed: 'skip-sentinel',
        calibrationFraction: 2 / 3
    });

    assert.equal(report.models.damage.feature, 'suppression-gain');
    assert.equal(report.holdout.v2.falseDirty, 0);
    assert.equal(report.holdout.v2.damageMissed, 0);
});

function labelRows(className, count) {
    return Array.from({ length: count }, (_, index) => {
        const suffix = `${className}-${String(index + 1).padStart(2, '0')}`;
        return {
            blindId: `B-${suffix}`,
            fileName: `${suffix}.png`,
            actualClean: className === 'clean',
            actualDamage: className === 'damage',
            predictedClean: index % 2 === 0,
            predictedDamage: false
        };
    });
}

function visualClass(row) {
    if (row.actualClean) return 'clean';
    return row.actualDamage ? 'damage' : 'residual';
}

function classCounts(rows) {
    const counts = { clean: 0, residual: 0, damage: 0 };
    for (const row of rows) counts[visualClass(row)] += 1;
    return counts;
}

function metricFixture(rows, featureValues) {
    return {
        results: rows.map((row) => {
            const values = featureValues(row);
            return {
                blindId: row.blindId,
                fileName: row.fileName,
                applied: true,
                processedGradientScore: values.gradient,
                residualScore: 0,
                suppressionGain: 0.5,
                qualitySignals: {
                    artifacts: {
                        visualArtifactCost: values.gradient,
                        recomposeError: values.recompose,
                        weightedRecomposeError: values.recompose,
                        signedDiffTemplateCorrelation: 1 - values.recompose,
                        diffGradientCorrelation: 1 - values.recompose
                    },
                    evidenceLoss: values.recompose,
                    residualLoss: values.gradient
                },
                classification: {
                    status: row.predictedClean ? 'pass' : 'fail',
                    bucket: row.predictedClean ? 'pass' : 'residual-edge'
                },
                finalDamageWarning: row.predictedDamage
            };
        })
    };
}

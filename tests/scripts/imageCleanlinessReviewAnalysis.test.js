import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createImageCleanlinessReviewReport } from '../../scripts/analyze-image-cleanliness-review.js';

test('review analysis reports false-clean, false-dirty, and damage misses from frozen blind labels', async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'gwr-review-analysis-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));

    const manifestPath = path.join(workspace, 'manifest.json');
    const metricReportPath = path.join(workspace, 'metric-report.json');
    const labelsPath = path.join(workspace, 'labels.frozen.json');
    const outputDir = path.join(workspace, 'report');
    await writeFile(
        manifestPath,
        JSON.stringify({
            rows: [
                { blindId: 'B001', fileName: 'A.png' },
                { blindId: 'B002', fileName: 'B.png' },
                { blindId: 'B003', fileName: 'C.png' },
                { blindId: 'B004', fileName: 'D.png' },
                { blindId: 'B005', fileName: 'E.png' }
            ]
        })
    );
    await writeFile(
        metricReportPath,
        JSON.stringify({
            results: [
                metricResult('A.png', 'pass', 'pass'),
                metricResult('B.png', 'pass', 'pass'),
                metricResult('C.png', 'fail', 'content-damage', true),
                metricResult('D.png', 'fail', 'residual-edge'),
                metricResult('E.png', 'pass', 'pass')
            ]
        })
    );
    await writeFile(
        labelsPath,
        JSON.stringify({
            reviewerId: 'reviewer-a',
            frozen: true,
            decisions: [
                decision('B001', true, false),
                decision('B002', false, false),
                decision('B003', false, true),
                decision('B004', true, false),
                decision('B005', null, null)
            ]
        })
    );

    const report = await createImageCleanlinessReviewReport({
        metricReportPath,
        manifestPath,
        reviewPaths: [labelsPath],
        outputDir,
        minimumReviewers: 1
    });

    assert.deepEqual(report.summary, {
        total: 5,
        scored: 4,
        unscored: 1,
        reviewerDisagreements: 0,
        actualClean: 2,
        actualDirty: 2,
        predictedClean: 2,
        predictedDirty: 2,
        trueClean: 1,
        trueDirty: 1,
        falseClean: 1,
        falseDirty: 1,
        falseCleanRate: 0.5,
        falseDirtyRate: 0.5,
        damageCases: 1,
        damageDetected: 1,
        damageMissed: 0,
        damageMissRate: 0
    });
    assert.deepEqual(
        report.disagreements.map(({ blindId, type }) => ({ blindId, type })),
        [
            { blindId: 'B002', type: 'false-clean' },
            { blindId: 'B004', type: 'false-dirty' }
        ]
    );

    const writtenJson = JSON.parse(await readFile(path.join(outputDir, 'latest-report.json'), 'utf8'));
    assert.equal(writtenJson.summary.falseClean, 1);
    const markdown = await readFile(path.join(outputDir, 'latest-report.md'), 'utf8');
    assert.match(markdown, /False-clean \| 1\/2 \| 50\.00%/);
    assert.match(markdown, /B002 \| B\.png \| false-clean/);
});

function metricResult(fileName, status, bucket, finalDamageWarning = false) {
    return {
        fileName,
        source: 'fixture-path',
        residualScore: 0.1,
        processedGradientScore: 0.1,
        finalDamageWarning,
        classification: { status, bucket }
    };
}

function decision(blindId, outputClean, contentDamage) {
    return { blindId, outputClean, contentDamage, confidence: 0.9, notes: '' };
}

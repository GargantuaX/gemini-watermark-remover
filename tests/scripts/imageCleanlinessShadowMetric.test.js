import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateImageCleanlinessShadowMetric } from '../../scripts/evaluate-image-cleanliness-shadow-metric.js';

test('shadow metric calibrates contour threshold without blocking output and keeps texture signals diagnostic', () => {
    const reviewRows = [
        ...labelRows('clean', 9),
        ...labelRows('residual', 9),
        ...labelRows('damage', 9)
    ];
    const pixelRows = reviewRows.map((row) => {
        const className = visualClass(row);
        const textureRetention = className === 'damage' ? 0.25 : 1;
        return {
            blindId: row.blindId,
            status: 'measured',
            features: {
                after: {
                    rgbContourRatio: className === 'clean' ? 0.1 : 0.9,
                    lumaInteriorProjectionRatio: className === 'damage' ? 2 : 0.5,
                    lumaInteriorProjectionTarget: 0.1
                },
                contourRetention: className === 'clean' ? 0.1 : 0.8,
                texture: { energyRetention: textureRetention }
            }
        };
    });

    const report = evaluateImageCleanlinessShadowMetric({
        reviewReport: { rows: reviewRows },
        pixelFeatureReport: { rows: pixelRows },
        seed: 'shadow-fixture',
        calibrationFraction: 2 / 3
    });

    assert.equal(report.policy.blocksOutput, false);
    assert.equal(report.policy.developmentOnly, true);
    assert.equal(report.model.feature, 'after-rgb-alpha-contour-ratio');
    assert.equal(report.model.threshold, 0.9);
    assert.deepEqual(report.diagnosticModels.textureDistortion, {
        feature: 'absolute-log2-texture-retention',
        direction: 'higher',
        threshold: 2,
        calibrationFalsePositiveBudget: 0.1
    });
    assert.deepEqual(report.holdout.shadow, {
        total: 9,
        trueClean: 3,
        trueDirty: 6,
        falseClean: 0,
        falseDirty: 0,
        falseCleanRate: 0,
        falseDirtyRate: 0,
        accuracy: 1,
        damageCases: 3,
        damageFlagged: 3,
        damageMissed: 0,
        damageMissRate: 0
    });
    assert.deepEqual(report.diagnosticSignals, [
        'contour-retention',
        'absolute-log2-texture-retention',
        'luma-interior-projection-ratio',
        'luma-interior-projection-target'
    ]);
    assert.deepEqual(report.holdout.textureDamageDiagnostic, {
        damageCases: 3,
        damageFlagged: 3,
        damageMissed: 0,
        damageMissRate: 0,
        nonDamageCases: 6,
        falsePositives: 0,
        falsePositiveRate: 0
    });
    assert.equal(report.recommendation.promoteToProduction, false);
});

function labelRows(className, count) {
    return Array.from({ length: count }, (_, index) => ({
        blindId: `${className}-${String(index + 1).padStart(2, '0')}`,
        fileName: `${className}-${index + 1}.png`,
        actualClean: className === 'clean',
        actualDamage: className === 'damage',
        predictedClean: true,
        predictedDamage: false
    }));
}

function visualClass(row) {
    if (row.actualClean) return 'clean';
    return row.actualDamage ? 'damage' : 'residual';
}

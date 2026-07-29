import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compositeKnownWatermark,
    measureRestorationAgainstTruth
} from '../../scripts/synthetic-residual-ground-truth.js';

let benchmarkModule = null;
try {
    benchmarkModule = await import(
        '../../scripts/synthetic-cleanliness-benchmark.js'
    );
} catch {
    // RED: benchmark helpers do not exist yet.
}

function createFlatImageData(width = 2, height = 2, value = 100) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) {
        const offset = index * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
    }
    return { width, height, data };
}

test('builds directional candidates from the observed forward delta', () => {
    assert.equal(
        typeof benchmarkModule?.createDirectionalCandidate,
        'function'
    );
    const truth = createFlatImageData();
    const watermarked = createFlatImageData();
    watermarked.data.set([120, 120, 120], 0);
    watermarked.data.set([90, 90, 90], 4);

    const candidate = benchmarkModule.createDirectionalCandidate({
        truthImageData: truth,
        watermarkedImageData: watermarked,
        position: { x: 0, y: 0, width: 2, height: 1 },
        factor: 0.5
    });

    assert.deepEqual(
        Array.from(candidate.data),
        [
            110, 110, 110, 255,
            95, 95, 95, 255,
            100, 100, 100, 255,
            100, 100, 100, 255
        ]
    );
});

test('orthogonalizes an independent damage vector against watermark delta', () => {
    assert.equal(
        typeof benchmarkModule?.orthogonalizeVector,
        'function'
    );
    const result = benchmarkModule.orthogonalizeVector(
        new Float64Array([1, 3, 4]),
        new Float64Array([2, 0, 0])
    );

    assert.ok(Math.abs(result[0]) < 1e-12);
    assert.equal(result[1], 3);
    assert.equal(result[2], 4);
    const dot = result[0] * 2;
    assert.ok(Math.abs(dot) < 1e-12);
});

test('scores pairwise ordering without inventing an order for truth ties', () => {
    assert.equal(
        typeof benchmarkModule?.calculatePairwiseOrdering,
        'function'
    );
    const truth = [1, 0.35, 0, 0];

    assert.deepEqual(
        benchmarkModule.calculatePairwiseOrdering(
            truth,
            [10, 3, 1, 1]
        ),
        { accuracy: 1, correct: 5, compared: 5, ties: 0 }
    );
    assert.deepEqual(
        benchmarkModule.calculatePairwiseOrdering(
            truth,
            [1, 1, 1, 1]
        ),
        { accuracy: 0.5, correct: 2.5, compared: 5, ties: 5 }
    );
    assert.equal(
        benchmarkModule.calculatePairwiseOrdering(
            truth,
            [0, 1, 2, 2]
        ).accuracy,
        0
    );
    assert.deepEqual(
        benchmarkModule.calculatePairwiseOrdering(
            [0.35, 0.351, 0],
            [1, 0, 0],
            { truthTolerance: 0.01 }
        ),
        { accuracy: 0.75, correct: 1.5, compared: 2, ties: 1 }
    );
});

test('creates equal-energy content damage orthogonal to the empirical watermark', () => {
    assert.equal(
        typeof benchmarkModule?.createOrthogonalDamageCandidate,
        'function'
    );
    const truth = createFlatImageData();
    const watermarked = createFlatImageData();
    for (let offset = 0; offset < watermarked.data.length; offset += 4) {
        watermarked.data[offset] = 120;
        watermarked.data[offset + 1] = 120;
        watermarked.data[offset + 2] = 120;
    }

    const result = benchmarkModule.createOrthogonalDamageCandidate({
        truthImageData: truth,
        watermarkedImageData: watermarked,
        position: { x: 0, y: 0, width: 2, height: 2 },
        targetFraction: 0.35
    });
    const measured = measureRestorationAgainstTruth({
        truthImageData: truth,
        watermarkedImageData: watermarked,
        candidateImageData: result.imageData,
        position: { x: 0, y: 0, width: 2, height: 2 }
    });

    assert.ok(Math.abs(measured.template.signedAmplitude) < 1e-12);
    assert.ok(Math.abs(measured.orthogonal.rmse - 7) < 1e-12);
    assert.ok(
        Math.abs(result.diagnostics.achievedEnergyFraction - 0.35) <
            1e-12
    );
    assert.equal(result.diagnostics.clippedChannelCount, 0);
});

test('recomposition consistency detects residual and orthogonal damage without clean truth', () => {
    assert.equal(
        typeof benchmarkModule?.measureRecompositionConsistency,
        'function'
    );
    const truth = createFlatImageData();
    const alphaMap = new Float32Array([0.5, 0.5, 0, 0]);
    const position = { x: 0, y: 0, width: 2, height: 2 };
    const watermarked = compositeKnownWatermark({
        truthImageData: truth,
        alphaMap,
        position
    });
    const damaged = createFlatImageData();
    damaged.data.set([110, 110, 110], 8);
    damaged.data.set([90, 90, 90], 12);

    const cleanCycle = benchmarkModule.measureRecompositionConsistency({
        originalImageData: watermarked,
        candidateImageData: truth,
        alphaMap,
        position
    });
    const unchangedCycle =
        benchmarkModule.measureRecompositionConsistency({
            originalImageData: watermarked,
            candidateImageData: watermarked,
            alphaMap,
            position
        });
    const damagedCycle =
        benchmarkModule.measureRecompositionConsistency({
            originalImageData: watermarked,
            candidateImageData: damaged,
            alphaMap,
            position
        });

    assert.equal(cleanCycle.rmse, 0);
    assert.ok(unchangedCycle.rmse > 0);
    assert.ok(damagedCycle.rmse > 0);
});

test('normalizes recomposition error to the unchanged-input cycle baseline', () => {
    assert.equal(
        typeof benchmarkModule?.evaluateRecompositionProfileBank,
        'function'
    );
    const truth = createFlatImageData();
    const alphaMap = new Float32Array([0.5, 0.5, 0, 0]);
    const position = { x: 0, y: 0, width: 2, height: 2 };
    const watermarked = compositeKnownWatermark({
        truthImageData: truth,
        alphaMap,
        position
    });
    const profiles = [{ name: 'known', alphaMap }];

    const clean = benchmarkModule.evaluateRecompositionProfileBank({
        originalImageData: watermarked,
        candidateImageData: truth,
        position,
        profiles
    });
    const unchanged =
        benchmarkModule.evaluateRecompositionProfileBank({
            originalImageData: watermarked,
            candidateImageData: watermarked,
            position,
            profiles
        });

    assert.equal(clean.status, 'complete');
    assert.equal(clean.best.profile, 'known');
    assert.equal(clean.best.normalizedRmse, 0);
    assert.equal(clean.best.signedTemplateAmplitude, 0);
    assert.equal(clean.best.normalizedOrthogonalError, 0);
    assert.equal(
        unchanged.best.normalizedRmse,
        1
    );
    assert.equal(unchanged.best.signedTemplateAmplitude, 1);
    assert.equal(unchanged.best.normalizedOrthogonalError, 0);
    assert.equal(
        unchanged.trials[0].baselineRmse,
        unchanged.trials[0].candidateRmse
    );
});

test('weights template-gradient shape evidence by actual recomposition amplitude', () => {
    assert.equal(
        typeof benchmarkModule?.createAmplitudeWeightedDirectionalEvidence,
        'function'
    );
    assert.deepEqual(
        benchmarkModule.createAmplitudeWeightedDirectionalEvidence({
            spatialScore: 0.5,
            gradientScore: 0.5,
            weightedRecomposeError: 0.125
        }),
        {
            templateArtifact: 0.0625,
            underRemoval: 0.0625,
            overRemoval: 0,
            spatialPolarity: 'positive'
        }
    );
    assert.deepEqual(
        benchmarkModule.createAmplitudeWeightedDirectionalEvidence({
            spatialScore: -0.5,
            gradientScore: 0.5,
            weightedRecomposeError: 0.125
        }),
        {
            templateArtifact: 0.0625,
            underRemoval: 0,
            overRemoval: 0.0625,
            spatialPolarity: 'negative'
        }
    );
    assert.deepEqual(
        benchmarkModule.createAmplitudeWeightedDirectionalEvidence({
            spatialScore: 0.5,
            gradientScore: -0.5,
            weightedRecomposeError: 0.125
        }),
        {
            templateArtifact: 0,
            underRemoval: 0,
            overRemoval: 0,
            spatialPolarity: 'positive'
        }
    );
});

test('decomposes the self-recomposition cycle into signed template error and orthogonal damage', () => {
    assert.equal(
        typeof benchmarkModule?.decomposeRecompositionError,
        'function'
    );
    const truth = createFlatImageData();
    const alphaMap = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const position = { x: 0, y: 0, width: 2, height: 2 };
    const watermarked = compositeKnownWatermark({
        truthImageData: truth,
        alphaMap,
        position
    });
    const under = benchmarkModule.createDirectionalCandidate({
        truthImageData: truth,
        watermarkedImageData: watermarked,
        position,
        factor: 0.5
    });
    const over = benchmarkModule.createDirectionalCandidate({
        truthImageData: truth,
        watermarkedImageData: watermarked,
        position,
        factor: -0.5
    });
    const orthogonal =
        benchmarkModule.createOrthogonalDamageCandidate({
            truthImageData: truth,
            watermarkedImageData: watermarked,
            position,
            targetFraction: 0.35
        }).imageData;
    const measure = (candidateImageData) =>
        benchmarkModule.decomposeRecompositionError({
            originalImageData: watermarked,
            candidateImageData,
            alphaMap,
            position
        });

    const cleanEvidence = measure(truth);
    const unchangedEvidence = measure(watermarked);
    const underEvidence = measure(under);
    const overEvidence = measure(over);
    const orthogonalEvidence = measure(orthogonal);

    assert.equal(cleanEvidence.status, 'complete');
    assert.equal(cleanEvidence.normalizedTotalError, 0);
    assert.equal(cleanEvidence.signedTemplateAmplitude, 0);
    assert.equal(cleanEvidence.normalizedOrthogonalError, 0);

    assert.equal(unchangedEvidence.normalizedTotalError, 1);
    assert.equal(unchangedEvidence.signedTemplateAmplitude, 1);
    assert.equal(unchangedEvidence.underRemoval, 1);
    assert.equal(unchangedEvidence.normalizedOrthogonalError, 0);

    assert.ok(
        Math.abs(underEvidence.signedTemplateAmplitude - 0.5) < 0.03
    );
    assert.equal(underEvidence.overRemoval, 0);
    assert.ok(
        Math.abs(overEvidence.signedTemplateAmplitude + 0.5) < 0.03
    );
    assert.equal(overEvidence.underRemoval, 0);

    assert.ok(
        Math.abs(orthogonalEvidence.signedTemplateAmplitude) < 0.03
    );
    assert.ok(orthogonalEvidence.normalizedOrthogonalError > 0.2);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import * as pipelineCandidateQuality from '../../src/core/pipelineCandidateQuality.js';

import {
    classifyCandidateQuality,
    createCandidateImperfectionSignals,
    createCandidateQualitySignals,
    createCandidateSummaries,
    rankCompletedCandidates
} from '../../src/core/pipelineCandidateQuality.js';

function createImageData(width, height, value = 128) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
    }
    return { width, height, data };
}

function createCompleted(id, qualitySignals, rankingKey = [0, 0, 0, 0, 0, 0]) {
    return {
        hypothesis: {
            id,
            family: 'standard',
            rankingKey,
            trial: { source: id }
        },
        result: {
            imageData: createImageData(1, 1),
            meta: { source: id }
        },
        qualitySignals
    };
}

function createCompletedAt(id, qualitySignals, {
    position = { x: 10, y: 20, width: 48, height: 48 },
    discoveryRole = 'fixed-selected'
} = {}) {
    const completed = createCompleted(id, qualitySignals);
    return {
        ...completed,
        hypothesis: {
            ...completed.hypothesis,
            discoveryRole,
            trial: {
                ...completed.hypothesis.trial,
                position
            }
        }
    };
}

function createPreferenceSignals({
    evidenceLoss = 0.1,
    residualLoss = 0.2,
    damageLoss = 0.1,
    imperfectionScore = 2,
    imperfectionSeverity = 'high',
    catastrophic = false
} = {}) {
    return {
        evidenceLoss,
        residualLoss,
        damageLoss,
        residualVisible: true,
        damageWarning: false,
        qualityStatus: 'visible-residual',
        imperfections: {
            detected: true,
            severity: imperfectionSeverity,
            score: imperfectionScore,
            types: ['gradient-residual']
        },
        texture: catastrophic ? { hardReject: true } : { hardReject: false },
        damageComponents: catastrophic
            ? { clipped: 1, nearBlack: 1, nearWhite: 0 }
            : { clipped: 0, nearBlack: 0, nearWhite: 0 }
    };
}

function createPreferenceCandidate(id, signals, {
    position = { x: 100, y: 120, width: 96, height: 96 },
    discoveryRole = 'fixed-selected',
    finalScore = 0
} = {}) {
    return {
        ...createCompletedAt(id, signals, { position, discoveryRole }),
        finalScore
    };
}

test('applySameAnchor96ImperfectionPreference should promote an eligible candidate and preserve the remaining base order', () => {
    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals());
    const unrelated = createPreferenceCandidate('unrelated', createPreferenceSignals({
        imperfectionScore: 3
    }), {
        position: { x: 101, y: 120, width: 96, height: 96 }
    });
    const alternative = createPreferenceCandidate('alternative', createPreferenceSignals({
        evidenceLoss: 0.15,
        residualLoss: 0.7,
        damageLoss: 0.15,
        imperfectionScore: 1.8
    }));

    const preferred = pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
        incumbent,
        unrelated,
        alternative
    ]);

    assert.deepEqual(preferred.map((candidate) => candidate.hypothesis.id), [
        'alternative',
        'incumbent',
        'unrelated'
    ]);
});

test('applySameAnchor96ImperfectionPreference should require a material imperfection improvement', () => {
    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals({
        imperfectionScore: 2
    }));
    const belowBoundary = createPreferenceCandidate('below-boundary', createPreferenceSignals({
        imperfectionScore: 1.850001
    }));
    assert.equal(
        pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
            incumbent,
            belowBoundary
        ])[0],
        incumbent
    );

    const boundary = createPreferenceCandidate('boundary', createPreferenceSignals({
        imperfectionScore: 1.85
    }));
    assert.equal(
        pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
            incumbent,
            boundary
        ])[0],
        boundary
    );
});

test('applySameAnchor96ImperfectionPreference should keep non-exact-96 and different-anchor base rankings unchanged', () => {
    for (const position of [
        { x: 10, y: 20, width: 48, height: 48 },
        { x: 10, y: 20, width: 94, height: 94 },
        { x: 10, y: 20, width: 96, height: 95 }
    ]) {
        const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals(), { position });
        const alternative = createPreferenceCandidate('alternative', createPreferenceSignals({
            imperfectionScore: 0.1
        }), { position });
        assert.deepEqual(
            pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
                incumbent,
                alternative
            ]),
            [incumbent, alternative]
        );
    }

    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals());
    const shifted = createPreferenceCandidate('shifted', createPreferenceSignals({
        imperfectionScore: 0.1
    }), {
        position: { x: 101, y: 120, width: 96, height: 96 }
    });
    assert.deepEqual(
        pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
            incumbent,
            shifted
        ]),
        [incumbent, shifted]
    );
});

test('applySameAnchor96ImperfectionPreference should require complete high-severity incumbent signals', () => {
    for (const signals of [
        createPreferenceSignals({ imperfectionSeverity: 'moderate' }),
        createPreferenceSignals({ imperfectionScore: Number.NaN }),
        createPreferenceSignals({ evidenceLoss: Number.NaN }),
        createPreferenceSignals({ damageLoss: Number.NaN })
    ]) {
        const incumbent = createPreferenceCandidate('incumbent', signals);
        const alternative = createPreferenceCandidate('alternative', createPreferenceSignals({
            imperfectionScore: 0.1
        }));
        assert.equal(
            pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
                incumbent,
                alternative
            ])[0],
            incumbent
        );
    }
});

test('applySameAnchor96ImperfectionPreference should include tolerance boundaries and reject unsafe or invalid alternatives', () => {
    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals());
    const boundary = createPreferenceCandidate('boundary', createPreferenceSignals({
        evidenceLoss: 0.15,
        damageLoss: 0.15,
        imperfectionScore: 1
    }));
    assert.equal(
        pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
            incumbent,
            boundary
        ])[0],
        boundary
    );

    for (const candidate of [
        createPreferenceCandidate('evidence-over', createPreferenceSignals({
            evidenceLoss: 0.150001,
            imperfectionScore: 0.1
        })),
        createPreferenceCandidate('damage-over', createPreferenceSignals({
            damageLoss: 0.150001,
            imperfectionScore: 0.1
        })),
        createPreferenceCandidate('invalid', createPreferenceSignals({
            imperfectionScore: Number.NaN
        })),
        createPreferenceCandidate('catastrophic', createPreferenceSignals({
            imperfectionScore: 0.1,
            catastrophic: true
        }))
    ]) {
        assert.equal(
            pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
                incumbent,
                candidate
            ])[0],
            incumbent,
            candidate.hypothesis.id
        );
    }
});

test('applySameAnchor96ImperfectionPreference should choose by imperfection residual and base order', () => {
    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals());
    const earlier = createPreferenceCandidate('earlier', createPreferenceSignals({
        residualLoss: 0.3,
        imperfectionScore: 0.5
    }));
    const lowerResidual = createPreferenceCandidate('lower-residual', createPreferenceSignals({
        residualLoss: 0.1,
        imperfectionScore: 0.5
    }));
    assert.equal(
        pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
            incumbent,
            earlier,
            lowerResidual
        ])[0],
        lowerResidual
    );

    const sameA = createPreferenceCandidate('same-a', createPreferenceSignals({
        residualLoss: 0.1,
        imperfectionScore: 0.5
    }));
    const sameB = createPreferenceCandidate('same-b', createPreferenceSignals({
        residualLoss: 0.1,
        imperfectionScore: 0.5
    }));
    assert.equal(
        pipelineCandidateQuality.applySameAnchor96ImperfectionPreference([
            incumbent,
            sameB,
            sameA
        ])[0],
        sameB
    );
});

test('rankCompletedCandidates should apply exact-96 imperfection preference after base scoring', () => {
    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals({
        evidenceLoss: 0.1,
        residualLoss: 0.1,
        damageLoss: 0.1,
        imperfectionScore: 2
    }));
    const alternative = createPreferenceCandidate('alternative', createPreferenceSignals({
        evidenceLoss: 0.15,
        residualLoss: 0.2,
        damageLoss: 0.15,
        imperfectionScore: 1
    }));

    const ranked = rankCompletedCandidates([incumbent, alternative]);

    assert.deepEqual(ranked.map((candidate) => candidate.hypothesis.id), [
        'alternative',
        'incumbent'
    ]);
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[1].rank, 2);
    assert.equal(ranked[0].selectionConfidence, 0);
});

test('classifyCandidateQuality should expose residual and damage independently', () => {
    assert.equal(classifyCandidateQuality({
        residualVisible: false,
        damageWarning: false
    }), 'clean');
    assert.equal(classifyCandidateQuality({
        residualVisible: true,
        damageWarning: false
    }), 'visible-residual');
    assert.equal(classifyCandidateQuality({
        residualVisible: false,
        damageWarning: true
    }), 'possible-content-damage');
    assert.equal(classifyCandidateQuality({
        residualVisible: true,
        damageWarning: true
    }), 'mixed');
});

test('createCandidateImperfectionSignals should expose moderate residuals below hard visibility thresholds', () => {
    const imperfections = createCandidateImperfectionSignals({
        positiveHaloLum: 2.04,
        spatialResidual: 0.019,
        gradientResidual: 0.177
    });

    assert.equal(imperfections.detected, true);
    assert.equal(imperfections.severity, 'moderate');
    assert.deepEqual(imperfections.types, ['gradient-residual']);
    assert.ok(imperfections.score > 0.8 && imperfections.score < 1);
});

test('createCandidateImperfectionSignals should preserve low continuous signals without raising a warning', () => {
    const imperfections = createCandidateImperfectionSignals({
        positiveHaloLum: 0.3,
        spatialResidual: 0.03,
        gradientResidual: 0.04
    });

    assert.equal(imperfections.detected, false);
    assert.equal(imperfections.severity, 'low');
    assert.deepEqual(imperfections.types, []);
    assert.ok(imperfections.score > 0);
});

test('createCandidateImperfectionSignals should report high residuals at existing visibility thresholds', () => {
    const imperfections = createCandidateImperfectionSignals({
        positiveHaloLum: 0,
        spatialResidual: 0.18,
        gradientResidual: 0
    });

    assert.equal(imperfections.detected, true);
    assert.equal(imperfections.severity, 'high');
    assert.deepEqual(imperfections.types, ['spatial-residual']);
    assert.equal(imperfections.score, 1);
});

test('createCandidateImperfectionSignals should report polarity-aware dark halos at their active threshold', () => {
    const imperfections = createCandidateImperfectionSignals({
        positiveHaloLum: 0,
        darkPolarityHaloLum: 2.1,
        darkPolarityHaloThreshold: 1.75,
        spatialResidual: 0.01,
        gradientResidual: 0.01
    });

    assert.equal(imperfections.detected, true);
    assert.equal(imperfections.severity, 'high');
    assert.deepEqual(imperfections.types, ['dark-polarity-halo']);
    assert.ok(imperfections.score > 1.1 && imperfections.score < 1.3);
});

test('createCandidateQualitySignals should produce finite losses from real pixels', () => {
    const originalImageData = createImageData(16, 16, 120);
    const candidateImageData = createImageData(16, 16, 118);
    const alphaMap = new Float32Array([
        0, 0.2, 0.2, 0,
        0.2, 0.6, 0.6, 0.2,
        0.2, 0.6, 0.6, 0.2,
        0, 0.2, 0.2, 0
    ]);
    const position = { x: 8, y: 8, width: 4, height: 4 };
    const hypothesis = {
        id: 'candidate-real',
        family: 'standard',
        trial: {
            source: 'standard',
            position,
            alphaMap,
            alphaGain: 1,
            originalSpatialScore: 0.8,
            originalGradientScore: 0.7
        }
    };

    const signals = createCandidateQualitySignals({
        originalImageData,
        candidateImageData,
        hypothesis
    });

    assert.ok(Number.isFinite(signals.evidenceLoss));
    assert.ok(Number.isFinite(signals.residualLoss));
    assert.ok(Number.isFinite(signals.damageLoss));
    assert.ok(Number.isFinite(signals.nearBlackIncrease));
    assert.ok(Number.isFinite(signals.nearWhiteIncrease));
    assert.ok(signals.imperfections);
    assert.ok(Number.isFinite(signals.imperfections.score));
    assert.ok(['clean', 'visible-residual', 'possible-content-damage', 'mixed']
        .includes(signals.qualityStatus));
});

test('createCandidateQualitySignals should warn when a dark region becomes both much darker and much flatter', () => {
    const originalImageData = createImageData(16, 16, 50);
    const candidateImageData = createImageData(16, 16, 50);
    const position = { x: 8, y: 8, width: 4, height: 4 };
    const alphaMap = new Float32Array(16).fill(0.2);

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const referenceValue = (row + col) % 2 === 0 ? 20 : 80;
            const candidateValue = (row + col) % 2 === 0 ? 20 : 36;
            const referenceOffset = (
                (position.y - position.height + row) * originalImageData.width +
                position.x +
                col
            ) * 4;
            const candidateOffset = (
                (position.y + row) * candidateImageData.width +
                position.x +
                col
            ) * 4;

            for (let channel = 0; channel < 3; channel++) {
                originalImageData.data[referenceOffset + channel] = referenceValue;
                candidateImageData.data[referenceOffset + channel] = referenceValue;
                originalImageData.data[candidateOffset + channel] = referenceValue;
                candidateImageData.data[candidateOffset + channel] = candidateValue;
            }
        }
    }

    const signals = createCandidateQualitySignals({
        originalImageData,
        candidateImageData,
        hypothesis: {
            id: 'severe-dark-flat-collapse',
            family: 'standard',
            trial: {
                source: 'standard+outline-dark',
                position,
                alphaMap,
                alphaGain: 1
            }
        }
    });

    assert.equal(signals.texture.tooDark, true);
    assert.equal(signals.texture.tooFlat, true);
    assert.equal(signals.texture.hardReject, false);
    assert.ok(signals.texture.texturePenalty > 1.5);
    assert.equal(signals.rawDamageWarning, true);
    assert.equal(signals.damageWarning, true);
    assert.equal(signals.qualityStatus, 'possible-content-damage');
});

test('createCandidateQualitySignals should include a dark-polarity halo in residual loss', () => {
    const originalImageData = createImageData(16, 16, 80);
    const candidateImageData = createImageData(16, 16, 80);
    const alphaMap = Float32Array.from([
        0, 0.2, 0.2, 0,
        0.2, 0.3, 0.3, 0.2,
        0.2, 0.3, 0.3, 0.2,
        0, 0.2, 0.2, 0
    ], (value) => -value);
    const position = { x: 8, y: 8, width: 4, height: 4 };
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            if (Math.abs(alphaMap[row * position.width + col]) < 0.18) continue;
            const offset = ((position.y + row) * 16 + position.x + col) * 4;
            candidateImageData.data[offset] = 77;
            candidateImageData.data[offset + 1] = 77;
            candidateImageData.data[offset + 2] = 77;
        }
    }

    const signals = createCandidateQualitySignals({
        originalImageData,
        candidateImageData,
        hypothesis: {
            id: 'dark-polarity-halo',
            family: 'standard',
            trial: {
                source: 'standard+dark-polarity',
                position,
                alphaMap,
                alphaGain: 0.1
            }
        }
    });

    assert.equal(signals.qualityStatus, 'visible-residual');
    assert.ok(
        signals.residualComponents.halo > 0.2,
        `halo=${signals.residualComponents.halo}`
    );
    assert.ok(signals.imperfections.types.includes('dark-polarity-halo'));
});

test('createCandidateQualitySignals should resolve support-confined dark clipping only with a verified convergence marker', () => {
    const originalImageData = createImageData(16, 16, 0);
    const candidateImageData = createImageData(16, 16, 0);
    const alphaMap = new Float32Array([
        0, 0, 0, 0,
        0, 0.6, 0.6, 0,
        0, 0.6, 0.6, 0,
        0, 0, 0, 0
    ]);
    const position = { x: 8, y: 8, width: 4, height: 4 };
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            if (alphaMap[row * position.width + col] <= 0) continue;
            const offset = (
                (position.y + row) * originalImageData.width +
                position.x +
                col
            ) * 4;
            originalImageData.data[offset] = 120;
            originalImageData.data[offset + 1] = 120;
            originalImageData.data[offset + 2] = 120;
        }
    }
    const hypothesis = {
        id: 'support-confined-dark',
        family: 'standard',
        trial: {
            source: 'standard',
            position,
            alphaMap,
            alphaGain: 1
        }
    };

    const rawSignals = createCandidateQualitySignals({
        originalImageData,
        candidateImageData,
        hypothesis
    });
    assert.equal(rawSignals.rawDamageWarning, true);
    assert.equal(rawSignals.damageWarning, true);
    assert.equal(rawSignals.qualityStatus, 'possible-content-damage');

    const resolvedSignals = createCandidateQualitySignals({
        originalImageData,
        candidateImageData,
        hypothesis,
        finalCandidate: {
            position,
            alphaMap,
            alphaGain: 1,
            darkBackgroundSupportConvergence: { accepted: true }
        }
    });
    assert.equal(resolvedSignals.rawDamageWarning, true);
    assert.equal(resolvedSignals.damageWarning, false);
    assert.equal(
        resolvedSignals.damageRiskResolution,
        'dark-background-support-converged'
    );
    assert.equal(resolvedSignals.qualityStatus, 'clean');
});

test('createCandidateQualitySignals should not reward spatial evidence with the wrong polarity', () => {
    const originalImageData = createImageData(16, 16, 180);
    const candidateImageData = createImageData(16, 16, 180);
    const alphaMap = new Float32Array([
        0, 0.2, 0.2, 0,
        0.2, 0.6, 0.6, 0.2,
        0.2, 0.6, 0.6, 0.2,
        0, 0.2, 0.2, 0
    ]);
    const position = { x: 8, y: 8, width: 4, height: 4 };

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            const pixelIndex = ((position.y + row) * originalImageData.width + position.x + col) * 4;
            const wrongPolarityValue = 180 - Math.round(alpha * 100);
            originalImageData.data[pixelIndex] = wrongPolarityValue;
            originalImageData.data[pixelIndex + 1] = wrongPolarityValue;
            originalImageData.data[pixelIndex + 2] = wrongPolarityValue;
        }
    }

    const signals = createCandidateQualitySignals({
        originalImageData,
        candidateImageData,
        hypothesis: {
            id: 'wrong-polarity',
            family: 'standard',
            trial: {
                source: 'standard',
                position,
                alphaMap,
                alphaGain: 1
            }
        }
    });

    assert.ok(
        signals.original.spatialScore < -0.95,
        `spatialScore=${signals.original.spatialScore}`
    );
    assert.ok(signals.evidenceLoss >= 0.45, `evidenceLoss=${signals.evidenceLoss}`);
});

test('rankCompletedCandidates should prefer content-safe recovery over polarity damage', () => {
    const ranked = rankCompletedCandidates([
        createCompleted('damaged', {
            evidenceLoss: 0.02,
            residualLoss: 0.01,
            damageLoss: 1,
            residualVisible: false,
            damageWarning: true,
            qualityStatus: 'possible-content-damage'
        }),
        createCompleted('safe', {
            evidenceLoss: 0.05,
            residualLoss: 0.18,
            damageLoss: 0.02,
            residualVisible: true,
            damageWarning: false,
            qualityStatus: 'visible-residual'
        })
    ]);

    assert.equal(ranked[0].hypothesis.id, 'safe');
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked.length, 2);
    assert.ok(ranked[0].selectionConfidence > 0);
});

test('rankCompletedCandidates should keep damage warnings observable without turning them into a hard safety gate', () => {
    const ranked = rankCompletedCandidates([
        createCompleted('unsafe-low-score', {
            evidenceLoss: 0,
            residualLoss: 0,
            damageLoss: 0.2,
            residualVisible: false,
            damageWarning: true,
            qualityStatus: 'possible-content-damage'
        }),
        createCompleted('safe-best-effort', {
            evidenceLoss: 0.8,
            residualLoss: 0.8,
            damageLoss: 0,
            residualVisible: true,
            damageWarning: false,
            qualityStatus: 'visible-residual'
        })
    ]);

    assert.equal(ranked[0].hypothesis.id, 'unsafe-low-score');
    assert.equal(ranked[0].qualitySignals.damageWarning, true);
});

test('rankCompletedCandidates should prefer a same-anchor clean candidate that strictly dominates visible residual', () => {
    const ranked = rankCompletedCandidates([
        createCompletedAt('fixed-visible', {
            evidenceLoss: 0.1,
            residualLoss: 0.3,
            damageLoss: 0.2,
            qualityStatus: 'visible-residual'
        }),
        createCompletedAt('derived-clean', {
            evidenceLoss: 0.1,
            residualLoss: 0.2,
            damageLoss: 0.2,
            qualityStatus: 'clean'
        }, { discoveryRole: 'conservative-derived' })
    ]);

    assert.equal(ranked[0].hypothesis.id, 'derived-clean');
});

test('rankCompletedCandidates should prefer a same-anchor clean candidate that strictly dominates damage', () => {
    const ranked = rankCompletedCandidates([
        createCompletedAt('fixed-damage', {
            evidenceLoss: 0.1,
            residualLoss: 0.2,
            damageLoss: 0.4,
            qualityStatus: 'possible-content-damage'
        }),
        createCompletedAt('derived-clean', {
            evidenceLoss: 0.1,
            residualLoss: 0.15,
            damageLoss: 0.3,
            qualityStatus: 'clean'
        }, { discoveryRole: 'conservative-derived' })
    ]);

    assert.equal(ranked[0].hypothesis.id, 'derived-clean');
});

test('rankCompletedCandidates should keep discovery priority outside narrow same-anchor clean dominance', () => {
    const fixedClean = createCompletedAt('fixed-clean', {
        evidenceLoss: 0.2,
        residualLoss: 0.2,
        damageLoss: 0.2,
        qualityStatus: 'clean'
    });
    const derivedClean = createCompletedAt('derived-clean', {
        evidenceLoss: 0.2,
        residualLoss: 0.1,
        damageLoss: 0.2,
        qualityStatus: 'clean'
    }, { discoveryRole: 'conservative-derived' });
    const differentAnchor = createCompletedAt('different-anchor-clean', {
        evidenceLoss: 0.1,
        residualLoss: 0.1,
        damageLoss: 0.1,
        qualityStatus: 'clean'
    }, {
        discoveryRole: 'conservative-derived',
        position: { x: 11, y: 20, width: 48, height: 48 }
    });

    assert.equal(rankCompletedCandidates([fixedClean, derivedClean])[0].hypothesis.id, 'fixed-clean');
    assert.equal(rankCompletedCandidates([
        createCompletedAt('fixed-visible', {
            evidenceLoss: 0.1,
            residualLoss: 0.3,
            damageLoss: 0.2,
            qualityStatus: 'visible-residual'
        }),
        differentAnchor
    ])[0].hypothesis.id, 'fixed-visible');
});

test('rankCompletedCandidates should not apply clean dominance when one quality loss is worse', () => {
    const fixed = createCompletedAt('fixed-visible', {
        evidenceLoss: 0.1,
        residualLoss: 0.3,
        damageLoss: 0.2,
        qualityStatus: 'visible-residual'
    });
    const derived = createCompletedAt('derived-clean', {
        evidenceLoss: 0.1,
        residualLoss: 0.2,
        damageLoss: 0.21,
        qualityStatus: 'clean'
    }, { discoveryRole: 'conservative-derived' });

    assert.equal(rankCompletedCandidates([fixed, derived])[0].hypothesis.id, 'fixed-visible');
});

test('rankCompletedCandidates should never select a catastrophic clipped black or white block', () => {
    const ranked = rankCompletedCandidates([
        createCompleted('catastrophic-low-score', {
            evidenceLoss: 0,
            residualLoss: 0,
            damageLoss: 0.75,
            residualVisible: false,
            damageWarning: true,
            qualityStatus: 'possible-content-damage',
            damageComponents: { nearBlack: 1, nearWhite: 0, clipped: 1 },
            texture: { hardReject: true }
        }),
        createCompleted('ordinary-residual', {
            evidenceLoss: 0.8,
            residualLoss: 0.8,
            damageLoss: 0,
            residualVisible: true,
            damageWarning: false,
            qualityStatus: 'visible-residual',
            damageComponents: { nearBlack: 0, nearWhite: 0, clipped: 0 },
            texture: { hardReject: false }
        })
    ]);

    assert.equal(ranked[0].hypothesis.id, 'ordinary-residual');
});

test('rankCompletedCandidates should not prefer an empty wrong anchor just because it has zero residual', () => {
    const ranked = rankCompletedCandidates([
        createCompleted('empty-wrong-anchor', {
            evidenceLoss: 1,
            residualLoss: 0,
            damageLoss: 0.25,
            residualVisible: false,
            damageWarning: false,
            qualityStatus: 'clean'
        }),
        createCompleted('supported-correct-anchor', {
            evidenceLoss: 0,
            residualLoss: 0.42,
            damageLoss: 0.5,
            residualVisible: true,
            damageWarning: true,
            qualityStatus: 'mixed'
        })
    ]);

    assert.equal(ranked[0].hypothesis.id, 'supported-correct-anchor');
});

test('rankCompletedCandidates should preserve a fixed candidate over a conservative alpha derivation', () => {
    const signals = {
        evidenceLoss: 0.2,
        residualLoss: 0.2,
        damageLoss: 0.2,
        residualVisible: false,
        damageWarning: false,
        qualityStatus: 'clean'
    };
    const ranked = rankCompletedCandidates([
        {
            ...createCompleted('fixed-selected', signals),
            hypothesis: {
                ...createCompleted('fixed-selected', signals).hypothesis,
                discoveryRole: 'fixed-selected'
            }
        },
        {
            ...createCompleted('derived', {
                ...signals,
                residualLoss: 0
            }),
            hypothesis: {
                ...createCompleted('derived', signals).hypothesis,
                discoveryRole: 'conservative-derived'
            }
        }
    ]);

    assert.equal(ranked[0].hypothesis.id, 'fixed-selected');
});

test('rankCompletedCandidates should let the severe-11 correct anchor beat the automatic wrong anchor', () => {
    const automaticWrong = {
        ...createCompleted('automatic-wrong-anchor', {
            evidenceLoss: 0.746264505302135,
            residualLoss: 0.8,
            damageLoss: 0.14084854660424104,
            residualVisible: true,
            damageWarning: false,
            qualityStatus: 'visible-residual'
        }),
        hypothesis: {
            ...createCompleted('automatic-wrong-anchor', {}).hypothesis,
            discoveryRole: 'automatic-selected'
        }
    };
    const discoveredCorrect = {
        ...createCompleted('discovered-correct-anchor', {
            evidenceLoss: 0.9195748666943697,
            residualLoss: 0.31990985706443653,
            damageLoss: 0.1736111111111111,
            residualVisible: true,
            damageWarning: false,
            qualityStatus: 'visible-residual'
        }),
        hypothesis: {
            ...createCompleted('discovered-correct-anchor', {}).hypothesis,
            discoveryRole: 'aggressive-fallback-alternative'
        }
    };

    const ranked = rankCompletedCandidates([
        automaticWrong,
        discoveredCorrect
    ]);

    assert.equal(ranked[0].hypothesis.id, 'discovered-correct-anchor');
});

test('rankCompletedCandidates should not let a standard alternative override a fixed V2 profile', () => {
    const fixedV2 = {
        ...createCompleted('fixed-v2', {
            evidenceLoss: 0.847383118723015,
            residualLoss: 0.26529380960026516,
            damageLoss: 0,
            residualVisible: false,
            damageWarning: false,
            qualityStatus: 'clean'
        }),
        hypothesis: {
            ...createCompleted('fixed-v2', {}).hypothesis,
            family: 'alpha',
            discoveryRole: 'fixed-selected'
        }
    };
    const standardAlternative = {
        ...createCompleted('standard-alternative', {
            evidenceLoss: 0.5996672545546734,
            residualLoss: 0.1300487132848263,
            damageLoss: 0.20157948894224154,
            residualVisible: false,
            damageWarning: false,
            qualityStatus: 'clean'
        }),
        hypothesis: {
            ...createCompleted('standard-alternative', {}).hypothesis,
            discoveryRole: 'discovered-alternative'
        }
    };

    const ranked = rankCompletedCandidates([
        fixedV2,
        standardAlternative
    ]);

    assert.equal(ranked[0].hypothesis.id, 'fixed-v2');
});

test('rankCompletedCandidates should use ranking key and id for deterministic ties', () => {
    const signals = {
        evidenceLoss: 0.1,
        residualLoss: 0.1,
        damageLoss: 0.1,
        residualVisible: false,
        damageWarning: false,
        qualityStatus: 'clean'
    };
    const ranked = rankCompletedCandidates([
        createCompleted('candidate-b', signals, [1, 0, 0, 0, 0, 0]),
        createCompleted('candidate-c', signals, [0, 0, 0, 0, 0, 0]),
        createCompleted('candidate-a', signals, [0, 0, 0, 0, 0, 0])
    ]);

    assert.deepEqual(ranked.map((item) => item.hypothesis.id), [
        'candidate-a',
        'candidate-c',
        'candidate-b'
    ]);
});

test('createCandidateSummaries should append failures without leaking image buffers', () => {
    const ranked = rankCompletedCandidates([
        createCompleted('safe', {
            evidenceLoss: 0.05,
            residualLoss: 0.05,
            damageLoss: 0.01,
            residualVisible: false,
            damageWarning: false,
            qualityStatus: 'clean'
        })
    ]);
    const summaries = createCandidateSummaries(ranked, [{
        hypothesis: { id: 'failed', family: 'aggressive' },
        error: new Error('candidate failed')
    }]);

    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].valid, true);
    assert.equal(summaries[0].rank, 1);
    assert.equal('imageData' in summaries[0], false);
    assert.equal('result' in summaries[0], false);
    assert.deepEqual(summaries[1], {
        id: 'failed',
        family: 'aggressive',
        rank: null,
        valid: false,
        finalScore: null,
        qualityStatus: null,
        qualitySignals: null,
        error: 'candidate failed'
    });
});

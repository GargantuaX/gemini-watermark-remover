import assert from 'node:assert/strict';
import test from 'node:test';

let shadowModule = null;
try {
    shadowModule = await import(
        '../../scripts/shadow-residual-profile-ensemble.js'
    );
} catch {
    // RED: the offline shadow evaluator does not exist yet.
}

function createAlphaFixture(size = 9) {
    const alphaMap = new Float32Array(size * size);
    const center = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const distance = Math.abs(x - center) + Math.abs(y - center);
            alphaMap[y * size + x] = Math.max(0, 1 - distance / center);
        }
    }
    return alphaMap;
}

function createShiftedResidualFixture({
    imageSize = 24,
    regionX = 6,
    regionY = 6,
    size = 9,
    dx = 1,
    dy = -1
} = {}) {
    const alphaMap = createAlphaFixture(size);
    const data = new Uint8ClampedArray(imageSize * imageSize * 4);
    for (let index = 0; index < imageSize * imageSize; index++) {
        const offset = index * 4;
        data[offset] = 72;
        data[offset + 1] = 72;
        data[offset + 2] = 72;
        data[offset + 3] = 255;
    }
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const alpha = alphaMap[y * size + x];
            const pixelX = regionX + dx + x;
            const pixelY = regionY + dy + y;
            const offset = (pixelY * imageSize + pixelX) * 4;
            const value = Math.round(72 + alpha * 150);
            data[offset] = value;
            data[offset + 1] = value;
            data[offset + 2] = value;
        }
    }
    return {
        alphaMap,
        imageData: { width: imageSize, height: imageSize, data },
        position: {
            x: regionX,
            y: regionY,
            width: size,
            height: size
        }
    };
}

test('searches small offsets and returns continuous evidence without a quality decision', () => {
    assert.equal(
        typeof shadowModule?.evaluateResidualProfileEvidence,
        'function'
    );
    const fixture = createShiftedResidualFixture();
    const evidence = shadowModule.evaluateResidualProfileEvidence({
        imageData: fixture.imageData,
        position: fixture.position,
        profiles: [{
            name: 'fixture',
            alphaMap: fixture.alphaMap
        }],
        powerExponents: [1],
        shiftRadius: 2
    });

    assert.ok(evidence.residualProfile.maxAbsSpatial > 0.95);
    assert.ok(evidence.residualProfile.maxPositiveGradient > 0.95);
    assert.ok(evidence.residualProfile.marginalJointEvidence > 0.95);
    assert.ok(evidence.residualProfile.bestJointEvidence > 0.95);
    assert.equal(evidence.residualProfile.bestSpatial.dx, 1);
    assert.equal(evidence.residualProfile.bestSpatial.dy, -1);
    assert.equal(evidence.evidenceQuality.status, 'complete');
    assert.equal(evidence.evidenceQuality.evaluatedTrialCount, 25);
    assert.equal('hit' in evidence, false);
    assert.equal('visible' in evidence, false);
    assert.equal('clean' in evidence, false);
});

test('marks clipped shift coverage as partial evidence', () => {
    const fixture = createShiftedResidualFixture({
        regionX: 0,
        regionY: 0,
        dx: 0,
        dy: 0
    });
    const evidence = shadowModule.evaluateResidualProfileEvidence({
        imageData: fixture.imageData,
        position: fixture.position,
        profiles: [{
            name: 'fixture',
            alphaMap: fixture.alphaMap
        }],
        powerExponents: [1],
        shiftRadius: 2
    });

    assert.equal(evidence.evidenceQuality.status, 'partial');
    assert.equal(evidence.evidenceQuality.expectedTrialCount, 25);
    assert.equal(evidence.evidenceQuality.evaluatedTrialCount, 9);
});

test('keeps marginal maxima separate from the best same-trial joint evidence', () => {
    assert.equal(
        typeof shadowModule?.summarizeResidualProfileTrials,
        'function'
    );
    const summary = shadowModule.summarizeResidualProfileTrials([
        {
            profile: 'spatial-only',
            exponent: 1,
            dx: 0,
            dy: 0,
            spatial: 0.9,
            gradient: 0.1
        },
        {
            profile: 'gradient-only',
            exponent: 1,
            dx: 1,
            dy: 0,
            spatial: 0.1,
            gradient: 0.9
        },
        {
            profile: 'balanced',
            exponent: 0.8,
            dx: 0,
            dy: -1,
            spatial: 0.5,
            gradient: 0.5
        }
    ]);

    assert.equal(summary.marginalJointEvidence, 0.9);
    assert.equal(summary.bestJointEvidence, 0.5);
    assert.equal(summary.bestJoint.profile, 'balanced');
    assert.equal(summary.bestJoint.dx, 0);
    assert.equal(summary.bestJoint.dy, -1);
});

test('records calibrated disagreement without changing the production decision', () => {
    assert.equal(
        typeof shadowModule?.createResidualProfileShadowObservation,
        'function'
    );
    const observation =
        shadowModule.createResidualProfileShadowObservation({
            currentResidualVisibility: {
                rawVisible: true,
                calibratedVisible: false,
                visible: false,
                qualityStatus: 'clean',
                metricRisk: 'weak-halo-background-collision',
                spatialResidual: 0.04,
                gradientResidual: 0.01
            },
            evidence: {
                residualProfile: {
                    maxAbsSpatial: 0.09,
                    maxPositiveGradient: 0.095,
                    marginalJointEvidence: 0.09246,
                    bestJointEvidence: 0.091,
                    bestSpatial: {
                        score: -0.09,
                        profile: 'default',
                        exponent: 0.4,
                        dx: 2,
                        dy: 2
                    },
                    bestGradient: {
                        score: 0.095,
                        profile: '20260520',
                        exponent: 0.4,
                        dx: 1,
                        dy: 0
                    }
                },
                evidenceQuality: {
                    status: 'complete',
                    expectedTrialCount: 350,
                    evaluatedTrialCount: 350
                }
            }
        });

    assert.equal(observation.shadowReviewEligible, true);
    assert.deepEqual(observation.currentDecision, {
        rawVisible: true,
        calibratedVisible: false,
        metricRisk: 'weak-halo-background-collision'
    });
    assert.ok(observation.rProfile);
    assert.deepEqual(observation.rProfile.spatial, {
        signedAtMaxAbs: -0.09,
        maxAbs: 0.09,
        winner: {
            profile: 'default',
            exponent: 0.4,
            dx: 2,
            dy: 2
        }
    });
    assert.deepEqual(observation.rProfile.gradient, {
        maxSigned: 0.095,
        maxPositive: 0.095,
        winner: {
            profile: '20260520',
            exponent: 0.4,
            dx: 1,
            dy: 0
        }
    });
    assert.deepEqual(
        observation.currentCalibratedDisagreement,
        {
            evidenceLevel: 'full',
            current: {
                qualityStatus: 'clean',
                rawVisible: true,
                calibratedVisible: false,
                metricRisk: 'weak-halo-background-collision',
                absSpatial: 0.04,
                positiveGradient: 0.01
            },
            existingRawVsCalibrated: {
                known: true,
                disagrees: true,
                direction: 'raw-visible-calibrated-suppressed'
            },
            rProfileDelta: {
                absSpatial: 0.05,
                positiveGradient: 0.085
            },
            profileVerdict: null
        }
    );
    assert.equal(observation.q.sameHeadWinner, false);
    assert.equal(observation.q.evidenceAvailability, 'complete');
    assert.equal(observation.productionDecisionChanged, false);
    assert.equal(observation.productionCalibratedVisible, false);
    assert.equal('recommendedVisible' in observation, false);
    assert.equal('clean' in observation, false);
    assert.equal('hit' in observation, false);
});

test('selects raw-visible calibrated-suppressed records even without a metric-risk label', () => {
    const observation =
        shadowModule.createResidualProfileShadowObservation({
            currentResidualVisibility: {
                rawVisible: true,
                calibratedVisible: false,
                metricRisk: null
            },
            evidence: {
                residualProfile: {
                    maxAbsSpatial: 0,
                    maxPositiveGradient: 0,
                    marginalJointEvidence: 0,
                    bestJointEvidence: 0
                },
                evidenceQuality: {
                    status: 'complete',
                    expectedTrialCount: 1,
                    evaluatedTrialCount: 1
                }
            }
        });

    assert.equal(observation.shadowReviewEligible, true);
    assert.equal(observation.currentDecision.metricRisk, null);
});

test('returns unavailable evidence for unsupported geometry instead of aborting the batch', () => {
    const fixture = createShiftedResidualFixture();
    let evidence = null;
    assert.doesNotThrow(() => {
        evidence = shadowModule.evaluateResidualProfileEvidence({
            imageData: fixture.imageData,
            position: {
                ...fixture.position,
                height: fixture.position.height - 1
            },
            profiles: [{
                name: 'fixture',
                alphaMap: fixture.alphaMap
            }],
            powerExponents: [1],
            shiftRadius: 2
        });
    });

    assert.equal(evidence.residualProfile, null);
    assert.deepEqual(evidence.evidenceQuality, {
        status: 'unavailable',
        reason: 'unsupported-geometry',
        expectedTrialCount: 0,
        evaluatedTrialCount: 0
    });
});

test('marks incomplete current calibration as partial instead of inferring from quality status', () => {
    const observation =
        shadowModule.createResidualProfileShadowObservation({
            currentResidualVisibility: {
                qualityStatus: 'clean',
                rawVisible: true,
                metricRisk: 'legacy-risk-without-calibrated-field'
            },
            evidence: {
                residualProfile: null,
                evidenceQuality: {
                    status: 'unavailable',
                    expectedTrialCount: 0,
                    evaluatedTrialCount: 0
                }
            }
        });

    assert.equal(
        observation.currentCalibratedDisagreement.evidenceLevel,
        'partial'
    );
    assert.deepEqual(
        observation.currentCalibratedDisagreement.existingRawVsCalibrated,
        {
            known: false,
            disagrees: null,
            direction: 'unknown'
        }
    );
    assert.equal(observation.productionCalibratedVisible, null);
    assert.equal(observation.shadowReviewEligible, false);
});

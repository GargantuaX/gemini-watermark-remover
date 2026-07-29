import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createResidualProfileShadowObservation,
    evaluateResidualProfileEvidence,
    summarizeResidualProfileTrials
} from '../../scripts/shadow-residual-profile-ensemble.js';

test('separates positive under-removal from negative over-removal using same-trial joint evidence', () => {
    const summary = summarizeResidualProfileTrials([
        {
            profile: 'under-balanced',
            exponent: 1,
            dx: 0,
            dy: 0,
            spatial: 0.64,
            gradient: 0.25
        },
        {
            profile: 'over-balanced',
            exponent: 1,
            dx: 1,
            dy: 0,
            spatial: -0.81,
            gradient: 0.36
        },
        {
            profile: 'under-spatial-only',
            exponent: 2.2,
            dx: 2,
            dy: 2,
            spatial: 0.9,
            gradient: -0.5
        },
        {
            profile: 'over-spatial-only',
            exponent: 0.4,
            dx: -2,
            dy: -2,
            spatial: -0.95,
            gradient: -0.4
        }
    ]);

    assert.deepEqual(summary.directionalEvidence.underRemoval, {
        maxPositiveSpatial: 0.9,
        bestSpatial: {
            score: 0.9,
            profile: 'under-spatial-only',
            exponent: 2.2,
            dx: 2,
            dy: 2
        },
        bestJointEvidence: 0.4,
        bestJoint: {
            profile: 'under-balanced',
            exponent: 1,
            dx: 0,
            dy: 0,
            spatial: 0.64,
            gradient: 0.25,
            jointEvidence: 0.4
        }
    });
    assert.deepEqual(summary.directionalEvidence.overRemoval, {
        maxNegativeSpatialMagnitude: 0.95,
        bestSpatial: {
            score: -0.95,
            profile: 'over-spatial-only',
            exponent: 0.4,
            dx: -2,
            dy: -2
        },
        bestJointEvidence: 0.54,
        bestJoint: {
            profile: 'over-balanced',
            exponent: 1,
            dx: 1,
            dy: 0,
            spatial: -0.81,
            gradient: 0.36,
            jointEvidence: 0.54
        }
    });
});

test('records the exact search space used by directional winner quality checks', () => {
    const imageData = {
        width: 5,
        height: 5,
        data: new Uint8ClampedArray(5 * 5 * 4).fill(128)
    };
    const evidence = evaluateResidualProfileEvidence({
        imageData,
        position: { x: 1, y: 1, width: 3, height: 3 },
        profiles: [{
            name: 'fixture',
            alphaMap: new Float32Array(9).fill(0.5)
        }],
        powerExponents: [0.4, 1, 2.2],
        shiftRadius: 1
    });

    assert.deepEqual(evidence.searchSpace, {
        profileCount: 1,
        powerExponents: [0.4, 1, 2.2],
        shiftRadius: 1
    });
});

test('exposes R-under and D-over as continuous shadow evidence with winner-risk flags', () => {
    const observation = createResidualProfileShadowObservation({
        currentResidualVisibility: {
            rawVisible: true,
            calibratedVisible: false,
            metricRisk: 'positive-spatial-background-collision'
        },
        evidence: {
            residualProfile: {
                maxAbsSpatial: 0.95,
                maxPositiveGradient: 0.36,
                marginalJointEvidence: 0.5848076211353316,
                bestJointEvidence: 0.54,
                bestSpatial: {
                    score: -0.95,
                    profile: 'over-spatial-only',
                    exponent: 0.4,
                    dx: -2,
                    dy: -2
                },
                bestGradient: {
                    score: 0.36,
                    profile: 'over-balanced',
                    exponent: 1,
                    dx: 1,
                    dy: 0
                },
                directionalEvidence: {
                    underRemoval: {
                        maxPositiveSpatial: 0.9,
                        bestSpatial: {
                            score: 0.9,
                            profile: 'under-spatial-only',
                            exponent: 2.2,
                            dx: 2,
                            dy: 2
                        },
                        bestJointEvidence: 0.4,
                        bestJoint: {
                            profile: 'under-balanced',
                            exponent: 0.4,
                            dx: 2,
                            dy: 0,
                            spatial: 0.64,
                            gradient: 0.25,
                            jointEvidence: 0.4
                        }
                    },
                    overRemoval: {
                        maxNegativeSpatialMagnitude: 0.95,
                        bestSpatial: {
                            score: -0.95,
                            profile: 'over-spatial-only',
                            exponent: 0.4,
                            dx: -2,
                            dy: -2
                        },
                        bestJointEvidence: 0.54,
                        bestJoint: {
                            profile: 'over-balanced',
                            exponent: 1,
                            dx: 1,
                            dy: 0,
                            spatial: -0.81,
                            gradient: 0.36,
                            jointEvidence: 0.54
                        }
                    }
                }
            },
            evidenceQuality: {
                status: 'complete',
                expectedTrialCount: 175,
                evaluatedTrialCount: 175
            },
            searchSpace: {
                profileCount: 1,
                powerExponents: [0.4, 1, 2.2],
                shiftRadius: 2
            }
        }
    });

    assert.deepEqual(observation.rUnder, {
        maxPositiveSpatial: 0.9,
        bestJointEvidence: 0.4,
        spatialWinner: {
            profile: 'under-spatial-only',
            exponent: 2.2,
            dx: 2,
            dy: 2
        },
        jointWinner: {
            profile: 'under-balanced',
            exponent: 0.4,
            dx: 2,
            dy: 0
        }
    });
    assert.deepEqual(observation.dOver, {
        maxNegativeSpatialMagnitude: 0.95,
        bestJointEvidence: 0.54,
        spatialWinner: {
            profile: 'over-spatial-only',
            exponent: 0.4,
            dx: -2,
            dy: -2
        },
        jointWinner: {
            profile: 'over-balanced',
            exponent: 1,
            dx: 1,
            dy: 0
        }
    });
    assert.deepEqual(observation.q.directionalWinnerRisk, {
        under: {
            shiftBoundary: true,
            exponentEndpoint: true
        },
        over: {
            shiftBoundary: false,
            exponentEndpoint: false
        }
    });
    assert.equal(observation.productionDecisionChanged, false);
    assert.equal('verdict' in observation, false);
    assert.equal('clean' in observation, false);
});

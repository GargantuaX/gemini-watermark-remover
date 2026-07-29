import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAlphaRepairPipelineRuntime,
    runCurrentAlphaStage,
    runCurrentAlphaStageSpecPhase,
    runCurrentAlphaStageSequence,
    runCurrentRepairStage,
    runCurrentRepairStageSpecPhase,
    runCurrentRepairStageSequence,
    runCurrentAlphaTrialStage,
    runCurrentAlphaTrialSpecPhase,
    runCurrentAlphaTrialSequence,
    runPreviewBackgroundCleanupStage,
    runRecalibrationStage,
    runLocatedAggressiveStage,
    runRepeatedCurrentRepairStage
} from '../../src/core/pipelineRuntime.js';

test('createAlphaRepairPipelineRuntime should commit scored results through state helpers', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        alphaGain: 1,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.7,
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.3,
        suppressionGain: 0.4,
        source: 'standard'
    };
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages: [],
            alphaTrialEvents: [],
            recordAlphaAdjustmentStage() {},
            recordAlphaTrialEvent() {}
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    const committed = runtime.commitPipelineResult({
        result: {
            imageData: { id: 'after' },
            spatialScore: 0.1,
            gradientScore: 0.2,
            alphaGain: 0.85
        },
        source: 'standard+fine-alpha'
    });

    assert.equal(committed, currentState);
    assert.deepEqual(currentState.finalImageData, { id: 'after' });
    assert.equal(currentState.finalProcessedSpatialScore, 0.1);
    assert.equal(currentState.finalProcessedGradientScore, 0.2);
    assert.equal(currentState.alphaGain, 0.85);
    assert.ok(Math.abs(currentState.suppressionGain - 0.7) < 1e-12);
    assert.equal(currentState.source, 'standard+fine-alpha');
});

test('runCurrentAlphaTrialStage should run and accept a current alpha trial with timing', () => {
    const debugTimings = {};
    const accepted = [];
    const nowValues = [100, 117];
    const result = {
        imageData: { id: 'after' },
        alphaGain: 0.85,
        spatialScore: 0.1,
        gradientScore: 0.04,
        suppressionGain: 0.7
    };

    const returned = runCurrentAlphaTrialStage({
        stage: 'dark-catalog-fine-alpha',
        strategy: 'dark-catalog-fine-alpha',
        createTrial: () => result,
        acceptCurrentAlphaTrialResult: (acceptedTrial) => {
            accepted.push(acceptedTrial);
        },
        source: () => 'standard+fine-alpha',
        debugTimings,
        timingKey: 'darkCatalogFineTuneMs',
        nowMs: () => nowValues.shift()
    });

    assert.equal(returned, result);
    assert.deepEqual(accepted, [{
        stage: 'dark-catalog-fine-alpha',
        strategy: 'dark-catalog-fine-alpha',
        result,
        source: 'standard+fine-alpha'
    }]);
    assert.equal(debugTimings.darkCatalogFineTuneMs, 17);
});

test('runCurrentAlphaTrialStage should only record timing when no trial is produced', () => {
    const debugTimings = {};
    const accepted = [];
    const returned = runCurrentAlphaTrialStage({
        stage: 'weak-positive-residual-fine-alpha',
        strategy: 'over-subtraction-fine-alpha',
        createTrial: () => null,
        acceptCurrentAlphaTrialResult: (acceptedTrial) => {
            accepted.push(acceptedTrial);
        },
        source: 'standard+fine-alpha',
        debugTimings,
        timingKey: 'weakAlphaFineTuneMs',
        nowMs: (() => {
            const values = [200, 205];
            return () => values.shift();
        })()
    });

    assert.equal(returned, null);
    assert.deepEqual(accepted, []);
    assert.equal(debugTimings.weakAlphaFineTuneMs, 5);
});

test('runCurrentAlphaTrialSequence should preserve ordered alpha trial execution', () => {
    const calls = [];
    const accepted = [];
    const first = { imageData: { id: 'first' }, alphaGain: 0.9 };
    const third = { imageData: { id: 'third' }, alphaGain: 0.7 };

    const results = runCurrentAlphaTrialSequence({
        stages: [
            {
                stage: 'over-subtraction-recalibration',
                strategy: 'over-subtraction-fine-alpha',
                createTrial: () => {
                    calls.push('first');
                    return first;
                },
                acceptCurrentAlphaTrialResult: (trial) => accepted.push(trial),
                source: 'standard+gain'
            },
            {
                stage: 'dark-catalog-fine-alpha',
                strategy: 'dark-catalog-fine-alpha',
                createTrial: () => {
                    calls.push('second');
                    return null;
                },
                acceptCurrentAlphaTrialResult: (trial) => accepted.push(trial),
                source: 'standard+fine-alpha'
            },
            {
                stage: 'weak-positive-residual-fine-alpha',
                strategy: 'over-subtraction-fine-alpha',
                createTrial: () => {
                    calls.push('third');
                    return third;
                },
                acceptCurrentAlphaTrialResult: (trial) => accepted.push(trial),
                source: 'standard+fine-alpha'
            }
        ]
    });

    assert.deepEqual(calls, ['first', 'second', 'third']);
    assert.deepEqual(results, [first, null, third]);
    assert.deepEqual(accepted.map((trial) => trial.stage), [
        'over-subtraction-recalibration',
        'weak-positive-residual-fine-alpha'
    ]);
});

test('runCurrentAlphaTrialSpecPhase should create specs and run alpha trial sequence', () => {
    const accepted = [];
    const result = { imageData: { id: 'alpha-trial' }, alphaGain: 1.1 };

    const results = runCurrentAlphaTrialSpecPhase({
        createSpecs: () => [
            {
                stage: 'dark-catalog-fine-alpha',
                strategy: 'dark-catalog-fine-alpha',
                createTrial: () => result,
                acceptCurrentAlphaTrialResult: (trial) => accepted.push(trial),
                source: 'standard+fine-alpha'
            }
        ]
    });

    assert.deepEqual(results, [result]);
    assert.deepEqual(accepted.map((trial) => trial.stage), [
        'dark-catalog-fine-alpha'
    ]);
});

test('runCurrentAlphaStage should accept a current alpha stage with resolved extras', () => {
    const accepted = [];
    const result = {
        imageData: { id: 'after' },
        alphaGain: 1.05,
        spatialScore: 0.08,
        gradientScore: 0.04,
        suppressionGain: 0.82,
        profileExponent: 1.06
    };

    const returned = runCurrentAlphaStage({
        stage: 'new-margin-96-variant-rescue',
        strategy: 'new-margin-96-variant',
        createStage: () => result,
        acceptCurrentAlphaStageResult: (acceptedStage) => {
            accepted.push(acceptedStage);
        },
        source: () => 'standard+new-margin-variant',
        stageExtras: (stageResult) => ({
            profileExponent: stageResult.profileExponent
        })
    });

    assert.equal(returned, result);
    assert.deepEqual(accepted, [{
        stage: 'new-margin-96-variant-rescue',
        strategy: 'new-margin-96-variant',
        result,
        source: 'standard+new-margin-variant',
        suppressionGain: undefined,
        stageExtras: {
            profileExponent: 1.06
        }
    }]);
});

test('runCurrentAlphaStage should preserve explicit null suppression gain', () => {
    const accepted = [];
    const result = {
        imageData: { id: 'after' },
        alphaGain: 1,
        spatialScore: 0.05,
        gradientScore: 0.03,
        suppressionGain: 0.4
    };

    runCurrentAlphaStage({
        stage: 'subpixel-outline-refinement',
        createStage: () => result,
        acceptCurrentAlphaStageResult: (acceptedStage) => {
            accepted.push(acceptedStage);
        },
        source: 'standard+subpixel',
        suppressionGain: null
    });

    assert.deepEqual(accepted, [{
        stage: 'subpixel-outline-refinement',
        strategy: null,
        result,
        source: 'standard+subpixel',
        suppressionGain: null,
        stageExtras: undefined
    }]);
});

test('runCurrentAlphaStageSequence should preserve ordered alpha stage execution', () => {
    const calls = [];
    const accepted = [];
    const first = { imageData: { id: 'first' }, alphaGain: 1.05 };
    const third = { imageData: { id: 'third' }, alphaGain: 1.1, profileExponent: 1.2 };

    const results = runCurrentAlphaStageSequence({
        stages: [
            {
                stage: 'new-margin-96-variant-rescue',
                strategy: 'new-margin-96-variant',
                createStage: () => {
                    calls.push('first');
                    return first;
                },
                acceptCurrentAlphaStageResult: (stage) => accepted.push(stage),
                source: 'standard+new-margin-variant'
            },
            {
                stage: 'known-48-anti-template-rescue',
                createStage: () => {
                    calls.push('second');
                    return null;
                },
                acceptCurrentAlphaStageResult: (stage) => accepted.push(stage),
                source: 'standard+anti-template-rescue'
            },
            {
                stage: 'known-48-power-profile-rescue',
                strategy: 'known-48-power-profile',
                createStage: () => {
                    calls.push('third');
                    return third;
                },
                acceptCurrentAlphaStageResult: (stage) => accepted.push(stage),
                source: 'standard+power-profile-rescue',
                stageExtras: (result) => ({
                    profileExponent: result.profileExponent
                })
            }
        ]
    });

    assert.deepEqual(calls, ['first', 'second', 'third']);
    assert.deepEqual(results, [first, null, third]);
    assert.deepEqual(accepted.map((stage) => stage.stage), [
        'new-margin-96-variant-rescue',
        'known-48-power-profile-rescue'
    ]);
    assert.deepEqual(accepted[1].stageExtras, {
        profileExponent: 1.2
    });
});

test('runCurrentAlphaStageSpecPhase should create specs and run alpha stage sequence', () => {
    const accepted = [];
    const result = {
        imageData: { id: 'alpha-stage' },
        alphaGain: 1.2,
        profileExponent: 1.4
    };

    const results = runCurrentAlphaStageSpecPhase({
        createSpecs: () => [
            {
                stage: 'known-48-power-profile-rescue',
                strategy: 'known-48-power-profile',
                createStage: () => result,
                acceptCurrentAlphaStageResult: (stage) => accepted.push(stage),
                source: 'standard+power-profile-rescue',
                stageExtras: (stageResult) => ({
                    profileExponent: stageResult.profileExponent
                })
            }
        ]
    });

    assert.deepEqual(results, [result]);
    assert.deepEqual(accepted[0].stageExtras, {
        profileExponent: 1.4
    });
});

test('runCurrentRepairStage should accept a current repair stage with suppression gain', () => {
    const accepted = [];
    const result = {
        imageData: { id: 'after' },
        spatialScore: 0.09,
        gradientScore: 0.05,
        suppressionGain: 0.73
    };

    const returned = runCurrentRepairStage({
        stage: 'known-48-small-margin-prior-repair',
        strategy: 'small-margin-prior',
        createStage: () => result,
        acceptCurrentRepairTrialResult: (acceptedStage) => {
            accepted.push(acceptedStage);
        },
        source: () => 'standard+small-margin-prior',
        suppressionGain: (stageResult) => stageResult.suppressionGain
    });

    assert.equal(returned, result);
    assert.deepEqual(accepted, [{
        stage: 'known-48-small-margin-prior-repair',
        strategy: 'small-margin-prior',
        result,
        source: 'standard+small-margin-prior',
        suppressionGain: 0.73,
        deriveSuppressionGainFromOriginalSpatial: false,
        stageExtras: undefined
    }]);
});

test('runCurrentRepairStageSequence should preserve ordered repair stage execution', () => {
    const calls = [];
    const accepted = [];
    const first = { imageData: { id: 'first' }, suppressionGain: 0.73 };
    const third = { imageData: { id: 'third' }, suppressionGain: 0.51 };

    const results = runCurrentRepairStageSequence({
        stages: [
            {
                stage: 'known-48-small-margin-prior-repair',
                strategy: 'small-margin-prior',
                createStage: () => {
                    calls.push('first');
                    return first;
                },
                acceptCurrentRepairTrialResult: (stage) => accepted.push(stage),
                source: () => 'standard+small-margin-prior',
                suppressionGain: (result) => result.suppressionGain
            },
            {
                stage: 'small-located-prior-repair',
                strategy: 'small-located-prior',
                createStage: () => {
                    calls.push('second');
                    return null;
                },
                acceptCurrentRepairTrialResult: (stage) => accepted.push(stage),
                source: 'standard+small-located-prior'
            },
            {
                stage: 'known-48-mid-core-bias-correction',
                strategy: 'mid-core-bias-correction',
                createStage: () => {
                    calls.push('third');
                    return third;
                },
                acceptCurrentRepairTrialResult: (stage) => accepted.push(stage),
                source: () => 'standard+mid-core-bias',
                deriveSuppressionGainFromOriginalSpatial: true
            }
        ]
    });

    assert.deepEqual(calls, ['first', 'second', 'third']);
    assert.deepEqual(results, [first, null, third]);
    assert.deepEqual(accepted.map((stage) => stage.stage), [
        'known-48-small-margin-prior-repair',
        'known-48-mid-core-bias-correction'
    ]);
    assert.equal(accepted[0].suppressionGain, 0.73);
    assert.equal(accepted[1].deriveSuppressionGainFromOriginalSpatial, true);
});

test('runCurrentRepairStageSequence should run beforeStage before each repair stage', () => {
    const calls = [];
    const results = runCurrentRepairStageSequence({
        stages: [
            {
                stage: 'known-48-small-margin-prior-repair',
                beforeStage: () => calls.push('before-first'),
                createStage: () => {
                    calls.push('first');
                    return { imageData: { id: 'first' } };
                }
            },
            {
                stage: 'small-located-prior-repair',
                beforeStage: () => calls.push('before-second'),
                createStage: () => {
                    calls.push('second');
                    return null;
                }
            }
        ]
    });

    assert.deepEqual(calls, [
        'before-first',
        'first',
        'before-second',
        'second'
    ]);
    assert.deepEqual(results, [
        { imageData: { id: 'first' } },
        null
    ]);
});

test('runCurrentRepairStageSpecPhase should create specs and run repair stage sequence', () => {
    const calls = [];
    const accepted = [];
    const result = {
        imageData: { id: 'repair-stage' },
        suppressionGain: 0.5
    };

    const results = runCurrentRepairStageSpecPhase({
        createSpecs: () => [
            {
                stage: 'known-48-boundary-repair-rescue',
                strategy: 'boundary-repair',
                beforeStage: () => calls.push('before'),
                createStage: () => {
                    calls.push('create');
                    return result;
                },
                acceptCurrentRepairTrialResult: (stage) => accepted.push(stage),
                source: 'standard+boundary-repair-rescue',
                suppressionGain: (stageResult) => stageResult.suppressionGain
            }
        ]
    });

    assert.deepEqual(results, [result]);
    assert.deepEqual(calls, ['before', 'create']);
    assert.equal(accepted[0].suppressionGain, 0.5);
});

test('current stage runners should skip acceptance when no result is produced', () => {
    const accepted = [];
    assert.equal(runCurrentAlphaStage({
        stage: 'known-48-power-profile-rescue',
        createStage: () => null,
        acceptCurrentAlphaStageResult: (acceptedStage) => {
            accepted.push(acceptedStage);
        },
        source: 'standard+power-profile-rescue'
    }), null);
    assert.equal(runCurrentRepairStage({
        stage: 'known-48-boundary-repair-rescue',
        createStage: () => null,
        acceptCurrentRepairTrialResult: (acceptedStage) => {
            accepted.push(acceptedStage);
        },
        source: 'standard+boundary-repair-rescue'
    }), null);
    assert.deepEqual(accepted, []);
});

test('runRepeatedCurrentRepairStage should accept successful passes and include failed attempt timing', () => {
    const accepted = [];
    const results = [
        { imageData: { id: 'after-1' }, spatialScore: 0.2, gradientScore: 0.1 },
        { imageData: { id: 'after-2' }, spatialScore: 0.1, gradientScore: 0.05 },
        null
    ];
    const nowValues = [100, 103, 110, 114, 120, 121];

    const outcome = runRepeatedCurrentRepairStage({
        maxPasses: 4,
        createStage: (passIndex) => results[passIndex],
        acceptCurrentRepairTrialResult: (acceptedStage) => {
            accepted.push(acceptedStage);
        },
        stage: (result) => result.spatialScore === 0.2 ? 'preview-edge-cleanup' : 'known-48-edge-cleanup',
        strategy: 'edge-cleanup',
        source: (result) => `standard+edge-${result.spatialScore}`,
        deriveSuppressionGainFromOriginalSpatial: true,
        nowMs: () => nowValues.shift()
    });

    assert.deepEqual(outcome, {
        passCount: 2,
        elapsedMs: 8
    });
    assert.deepEqual(accepted, [
        {
            stage: 'preview-edge-cleanup',
            strategy: 'edge-cleanup',
            result: results[0],
            source: 'standard+edge-0.2',
            suppressionGain: undefined,
            deriveSuppressionGainFromOriginalSpatial: true,
            stageExtras: undefined
        },
        {
            stage: 'known-48-edge-cleanup',
            strategy: 'edge-cleanup',
            result: results[1],
            source: 'standard+edge-0.1',
            suppressionGain: undefined,
            deriveSuppressionGainFromOriginalSpatial: true,
            stageExtras: undefined
        }
    ]);
});

test('runPreviewBackgroundCleanupStage should accept cleanup payload and record timing', () => {
    const accepted = [];
    const debugTimings = {};
    const payload = {
        cleanedImageData: { id: 'cleaned' },
        source: 'standard+background-cleanup',
        cleanedSpatialScore: 0.1,
        cleanedGradientScore: 0.02,
        cleanedNearBlackRatio: 0.01,
        currentNearBlackRatio: 0.01,
        baselineSpatialScore: 0.2,
        maxNearBlackRatioIncrease: 0.05
    };
    const nowValues = [300, 312];

    const returned = runPreviewBackgroundCleanupStage({
        createCleanup: () => payload,
        acceptPreviewBackgroundCleanupResult: (acceptedPayload) => {
            accepted.push(acceptedPayload);
        },
        debugTimings,
        timingKey: 'previewBackgroundCleanupMs',
        nowMs: () => nowValues.shift()
    });

    assert.equal(returned, payload);
    assert.deepEqual(accepted, [payload]);
    assert.equal(debugTimings.previewBackgroundCleanupMs, 12);
});

test('runPreviewBackgroundCleanupStage should only record timing when cleanup is skipped', () => {
    const accepted = [];
    const debugTimings = {};
    const returned = runPreviewBackgroundCleanupStage({
        createCleanup: () => null,
        acceptPreviewBackgroundCleanupResult: (acceptedPayload) => {
            accepted.push(acceptedPayload);
        },
        debugTimings,
        timingKey: 'previewBackgroundCleanupMs',
        nowMs: (() => {
            const values = [400, 407];
            return () => values.shift();
        })()
    });

    assert.equal(returned, null);
    assert.deepEqual(accepted, []);
    assert.equal(debugTimings.previewBackgroundCleanupMs, 7);
});

test('runRecalibrationStage should accept recalibration with computed gradient and timing', () => {
    const accepted = [];
    const debugTimings = {};
    const result = {
        imageData: { id: 'after' },
        processedSpatialScore: 0.12,
        alphaGain: 0.85,
        suppressionGain: 0.7
    };
    const nowValues = [500, 519];

    const returned = runRecalibrationStage({
        shouldRun: true,
        createRecalibration: () => result,
        computeGradientScore: (recalibrated) => recalibrated.processedSpatialScore / 2,
        acceptRecalibrationStageResult: (acceptedStage) => {
            accepted.push(acceptedStage);
        },
        debugTimings,
        timingKey: 'recalibrationMs',
        nowMs: () => nowValues.shift()
    });

    assert.equal(returned, result);
    assert.deepEqual(accepted, [{
        result,
        gradientScore: 0.06
    }]);
    assert.equal(debugTimings.recalibrationMs, 19);
});

test('runRecalibrationStage should skip creation when gate is false', () => {
    const accepted = [];
    const debugTimings = {};
    let createCalled = false;
    const returned = runRecalibrationStage({
        shouldRun: false,
        createRecalibration: () => {
            createCalled = true;
            return { imageData: { id: 'after' } };
        },
        computeGradientScore: () => 0.1,
        acceptRecalibrationStageResult: (acceptedStage) => {
            accepted.push(acceptedStage);
        },
        debugTimings,
        timingKey: 'recalibrationMs',
        nowMs: (() => {
            const values = [700, 704];
            return () => values.shift();
        })()
    });

    assert.equal(returned, null);
    assert.equal(createCalled, false);
    assert.deepEqual(accepted, []);
    assert.equal(debugTimings.recalibrationMs, 4);
});

test('runLocatedAggressiveStage should wrap reject events and apply accepted pass outcome', () => {
    const rejectedEvents = [];
    const passes = [];
    const result = {
        imageData: { id: 'after' },
        spatialScore: 0.08,
        gradientScore: 0.03,
        alphaGain: 1.4,
        repeatCount: 2,
        edgeCleanup: true
    };

    const run = runLocatedAggressiveStage({
        shouldRun: true,
        createStage: ({ onRejected }) => {
            onRejected({
                strategy: 'located-aggressive-alpha',
                blockedGate: 'artifact-risk'
            });
            return result;
        },
        recordAlphaTrialEvent: (event) => {
            rejectedEvents.push(event);
        },
        acceptLocatedAggressiveResult: ({ result: acceptedResult, passes: acceptedPasses }) => {
            assert.equal(acceptedResult, result);
            assert.equal(acceptedPasses, passes);
            acceptedPasses.push({ index: 1, afterSpatialScore: acceptedResult.spatialScore });
            return {
                committedState: { id: 'committed' },
                passIncrement: 2,
                passStopReason: 'located-aggressive-edge-cleanup'
            };
        },
        currentPassState: {
            passCount: 1,
            attemptedPassCount: 1,
            passStopReason: 'single-pass',
            passes
        },
        source: () => 'standard+located-aggressive',
        fromAlphaGain: 1,
        beforeSpatialScore: 0.3,
        beforeGradientScore: 0.2,
        originalSpatialScore: 0.7
    });

    assert.equal(run.result, result);
    assert.deepEqual(rejectedEvents, [{
        strategy: 'located-aggressive-alpha',
        blockedGate: 'artifact-risk',
        decision: 'reject'
    }]);
    assert.equal(run.outcome.committedState.id, 'committed');
    assert.deepEqual(run.passState, {
        passCount: 3,
        attemptedPassCount: 3,
        passStopReason: 'located-aggressive-edge-cleanup',
        passes
    });
    assert.deepEqual(passes, [{ index: 1, afterSpatialScore: 0.08 }]);
});

test('runLocatedAggressiveStage should skip creation when gate is false', () => {
    let createCalled = false;
    const passState = {
        passCount: 1,
        attemptedPassCount: 1,
        passStopReason: 'single-pass',
        passes: []
    };
    const run = runLocatedAggressiveStage({
        shouldRun: false,
        createStage: () => {
            createCalled = true;
            return { imageData: { id: 'after' } };
        },
        currentPassState: passState
    });

    assert.equal(createCalled, false);
    assert.equal(run.result, null);
    assert.equal(run.passState, passState);
});

test('createAlphaRepairPipelineRuntime should assign tail debug timings', () => {
    const debugTimings = {};
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {},
        readState: () => ({}),
        applyState: () => {},
        debugTimings
    });

    const nowValues = [1000, 1005, 1010, 1020, 1030];
    const assigned = runtime.assignTailDebugTimings({
        nowMs: () => nowValues.shift(),
        totalStartedAt: 10,
        previewEdgeCleanupElapsedMs: 12,
        smallPreviewRefinementStartedAt: 900,
        locatedAggressiveStartedAt: 800,
        smoothPriorStartedAt: 700,
        newMargin96VariantRescueStartedAt: 100,
        known48AntiTemplateRescueStartedAt: 130,
        powerProfileRescueStartedAt: 170,
        positiveResidualRebalanceStartedAt: 220,
        smallMarginPriorRepairStartedAt: 280,
        smallLocatedPriorRepairStartedAt: 350,
        boundaryRepairRescueStartedAt: 430,
        darkHaloRescueStartedAt: 520,
        quantizedBodyCorrectionStartedAt: 620,
        midCoreBiasStartedAt: 730
    });

    assert.equal(assigned, debugTimings);
    assert.equal(debugTimings.previewEdgeCleanupMs, 12);
    assert.equal(debugTimings.smallPreviewRefinementMs, 100);
    assert.equal(debugTimings.locatedAggressiveRemovalMs, 205);
    assert.equal(debugTimings.totalMs, 1020);
});

test('createAlphaRepairPipelineRuntime should accept alpha trial results with existing trace shape', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        alphaGain: 1,
        originalSpatialScore: 0.9,
        originalGradientScore: 0.6,
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.3,
        suppressionGain: 0.5,
        source: 'standard'
    };
    const alphaAdjustmentStages = [];
    const alphaTrialEvents = [];
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            alphaTrialEvents,
            recordAlphaAdjustmentStage(stage) {
                alphaAdjustmentStages.push(stage);
            },
            recordAlphaTrialEvent(event) {
                alphaTrialEvents.push(event);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    const committed = runtime.acceptAlphaTrialResult({
        stage: 'weak-positive-residual-fine-alpha',
        strategy: 'over-subtraction-fine-alpha',
        result: {
            imageData: { id: 'after' },
            spatialScore: 0.12,
            gradientScore: 0.08,
            suppressionGain: 0.78,
            alphaGain: 0.7,
            cost: 0.2
        },
        source: 'standard+fine-alpha',
        fromAlphaGain: 1,
        beforeSpatialScore: 0.4,
        beforeGradientScore: 0.3
    });

    assert.equal(committed, currentState);
    assert.equal(currentState.alphaGain, 0.7);
    assert.equal(currentState.source, 'standard+fine-alpha');
    assert.deepEqual(alphaAdjustmentStages, [{
        stage: 'weak-positive-residual-fine-alpha',
        fromAlphaGain: 1,
        toAlphaGain: 0.7,
        beforeSpatialScore: 0.4,
        beforeGradientScore: 0.3,
        afterSpatialScore: 0.12,
        afterGradientScore: 0.08,
        suppressionGain: 0.78,
        cost: 0.2,
        alphaStrategy: 'over-subtraction-fine-alpha'
    }]);
    assert.deepEqual(alphaTrialEvents, [{
        stage: 'weak-positive-residual-fine-alpha',
        strategy: 'over-subtraction-fine-alpha',
        decision: 'accept',
        fromAlphaGain: 1,
        toAlphaGain: 0.7,
        alphaGain: 0.7,
        beforeSpatialScore: 0.4,
        beforeGradientScore: 0.3,
        afterSpatialScore: 0.12,
        afterGradientScore: 0.08,
        suppressionGain: 0.78,
        cost: 0.2
    }]);
});

test('createAlphaRepairPipelineRuntime should accept current-state alpha trial results', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        alphaGain: 1.15,
        originalSpatialScore: 0.9,
        originalGradientScore: 0.6,
        finalProcessedSpatialScore: 0.33,
        finalProcessedGradientScore: 0.28,
        suppressionGain: 0.57,
        source: 'standard'
    };
    const alphaAdjustmentStages = [];
    const alphaTrialEvents = [];
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            alphaTrialEvents,
            recordAlphaAdjustmentStage(stage) {
                alphaAdjustmentStages.push(stage);
            },
            recordAlphaTrialEvent(event) {
                alphaTrialEvents.push(event);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    const committed = runtime.acceptCurrentAlphaTrialResult({
        stage: 'dark-catalog-fine-alpha',
        strategy: 'dark-catalog-fine-alpha',
        result: {
            imageData: { id: 'after' },
            spatialScore: 0.08,
            gradientScore: 0.04,
            suppressionGain: 0.82,
            alphaGain: 0.85,
            cost: 0.16
        },
        source: 'standard+fine-alpha'
    });

    assert.equal(committed, currentState);
    assert.equal(currentState.alphaGain, 0.85);
    assert.equal(currentState.source, 'standard+fine-alpha');
    assert.deepEqual(alphaAdjustmentStages, [{
        stage: 'dark-catalog-fine-alpha',
        fromAlphaGain: 1.15,
        toAlphaGain: 0.85,
        beforeSpatialScore: 0.33,
        beforeGradientScore: 0.28,
        afterSpatialScore: 0.08,
        afterGradientScore: 0.04,
        suppressionGain: 0.82,
        cost: 0.16,
        alphaStrategy: 'dark-catalog-fine-alpha'
    }]);
    assert.deepEqual(alphaTrialEvents, [{
        stage: 'dark-catalog-fine-alpha',
        strategy: 'dark-catalog-fine-alpha',
        decision: 'accept',
        fromAlphaGain: 1.15,
        toAlphaGain: 0.85,
        alphaGain: 0.85,
        beforeSpatialScore: 0.33,
        beforeGradientScore: 0.28,
        afterSpatialScore: 0.08,
        afterGradientScore: 0.04,
        suppressionGain: 0.82,
        cost: 0.16
    }]);
});

test('createAlphaRepairPipelineRuntime should accept repair trial results with existing stage shape', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        alphaGain: 1,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.5,
        finalProcessedSpatialScore: 0.3,
        finalProcessedGradientScore: 0.25,
        suppressionGain: 0.5,
        source: 'standard+edge-cleanup'
    };
    const alphaAdjustmentStages = [];
    const alphaTrialEvents = [];
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            alphaTrialEvents,
            recordAlphaAdjustmentStage(stage) {
                alphaAdjustmentStages.push(stage);
            },
            recordAlphaTrialEvent(event) {
                alphaTrialEvents.push(event);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    const committed = runtime.acceptRepairTrialResult({
        stage: 'known-48-flat-background-fill',
        strategy: 'known-48-flat-fill',
        result: {
            imageData: { id: 'after' },
            spatialScore: 0.08,
            gradientScore: 0.06,
            cost: 0.18
        },
        source: 'standard+flat-fill',
        fromAlphaGain: 1,
        beforeSpatialScore: 0.3,
        beforeGradientScore: 0.25,
        suppressionGain: 0.72
    });

    assert.equal(committed, currentState);
    assert.deepEqual(currentState.finalImageData, { id: 'after' });
    assert.equal(currentState.finalProcessedSpatialScore, 0.08);
    assert.equal(currentState.finalProcessedGradientScore, 0.06);
    assert.equal(currentState.alphaGain, 1);
    assert.equal(currentState.source, 'standard+flat-fill');
    assert.deepEqual(alphaAdjustmentStages, [{
        stage: 'known-48-flat-background-fill',
        fromAlphaGain: 1,
        toAlphaGain: 1,
        beforeSpatialScore: 0.3,
        beforeGradientScore: 0.25,
        afterSpatialScore: 0.08,
        afterGradientScore: 0.06,
        suppressionGain: 0.72,
        cost: 0.18,
        repairStrategy: 'known-48-flat-fill',
        allowSameAlphaGain: true
    }]);
    assert.deepEqual(alphaTrialEvents, []);
});

test('createAlphaRepairPipelineRuntime should accept alpha stage results without adding trial events', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 96, height: 96 },
        config: { logoSize: 96, marginRight: 192, marginBottom: 192 },
        alphaGain: 1,
        originalSpatialScore: 0.9,
        originalGradientScore: 0.7,
        finalProcessedSpatialScore: 0.3,
        finalProcessedGradientScore: 0.2,
        suppressionGain: 0.6,
        source: 'standard'
    };
    const alphaAdjustmentStages = [];
    const alphaTrialEvents = [];
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            alphaTrialEvents,
            recordAlphaAdjustmentStage(stage) {
                alphaAdjustmentStages.push(stage);
            },
            recordAlphaTrialEvent(event) {
                alphaTrialEvents.push(event);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    runtime.acceptAlphaStageResult({
        stage: 'new-margin-96-variant-rescue',
        strategy: 'new-margin-96-variant',
        result: {
            imageData: { id: 'after' },
            spatialScore: 0.05,
            gradientScore: 0.04,
            suppressionGain: 0.85,
            alphaGain: 1.05,
            cost: 0.11
        },
        source: 'standard+new-margin-variant',
        fromAlphaGain: 1,
        beforeSpatialScore: 0.3,
        beforeGradientScore: 0.2,
        stageExtras: { profileExponent: 1.06 }
    });

    assert.equal(currentState.alphaGain, 1.05);
    assert.equal(currentState.source, 'standard+new-margin-variant');
    assert.deepEqual(alphaAdjustmentStages, [{
        stage: 'new-margin-96-variant-rescue',
        fromAlphaGain: 1,
        toAlphaGain: 1.05,
        beforeSpatialScore: 0.3,
        beforeGradientScore: 0.2,
        afterSpatialScore: 0.05,
        afterGradientScore: 0.04,
        suppressionGain: 0.85,
        cost: 0.11,
        alphaStrategy: 'new-margin-96-variant',
        profileExponent: 1.06
    }]);
    assert.deepEqual(alphaTrialEvents, []);
});

test('createAlphaRepairPipelineRuntime should accept current-state alpha stage results', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        alphaGain: 1.1,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.4,
        finalProcessedSpatialScore: 0.22,
        finalProcessedGradientScore: 0.18,
        suppressionGain: 0.58,
        source: 'standard'
    };
    const alphaAdjustmentStages = [];
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            recordAlphaAdjustmentStage(stage) {
                alphaAdjustmentStages.push(stage);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    runtime.acceptCurrentAlphaStageResult({
        stage: 'known-48-power-profile-rescue',
        strategy: 'known-48-power-profile',
        result: {
            imageData: { id: 'after' },
            spatialScore: 0.07,
            gradientScore: 0.05,
            alphaGain: 1.1,
            suppressionGain: 0.73,
            profileExponent: 1.2,
            cost: 0.15
        },
        source: 'standard+power-profile-rescue',
        stageExtras: {
            profileExponent: 1.2,
            allowSameAlphaGain: true
        }
    });

    assert.equal(currentState.source, 'standard+power-profile-rescue');
    assert.deepEqual(alphaAdjustmentStages, [{
        stage: 'known-48-power-profile-rescue',
        fromAlphaGain: 1.1,
        toAlphaGain: 1.1,
        beforeSpatialScore: 0.22,
        beforeGradientScore: 0.18,
        afterSpatialScore: 0.07,
        afterGradientScore: 0.05,
        suppressionGain: 0.73,
        cost: 0.15,
        alphaStrategy: 'known-48-power-profile',
        profileExponent: 1.2,
        allowSameAlphaGain: true
    }]);
});

test('createAlphaRepairPipelineRuntime should preserve explicit null suppression gain on current alpha stages', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        alphaGain: 1,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.4,
        finalProcessedSpatialScore: 0.22,
        finalProcessedGradientScore: 0.18,
        suppressionGain: 0.58,
        source: 'standard'
    };
    const alphaAdjustmentStages = [];
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            recordAlphaAdjustmentStage(stage) {
                alphaAdjustmentStages.push(stage);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    runtime.acceptCurrentAlphaStageResult({
        stage: 'subpixel-outline-refinement',
        result: {
            imageData: { id: 'after' },
            spatialScore: 0.08,
            gradientScore: 0.04,
            alphaGain: 1
        },
        source: 'standard+subpixel',
        suppressionGain: null
    });

    assert.equal(alphaAdjustmentStages[0].suppressionGain, null);
});

test('createAlphaRepairPipelineRuntime should accept current-state repair trial results', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        alphaGain: 1,
        originalSpatialScore: 0.81,
        originalGradientScore: 0.4,
        finalProcessedSpatialScore: 0.24,
        finalProcessedGradientScore: 0.2,
        suppressionGain: 0.57,
        source: 'standard'
    };
    const alphaAdjustmentStages = [];
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            recordAlphaAdjustmentStage(stage) {
                alphaAdjustmentStages.push(stage);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    runtime.acceptCurrentRepairTrialResult({
        stage: 'smooth-located-estimated-prior',
        strategy: 'smooth-located-prior',
        result: {
            imageData: { id: 'after' },
            spatialScore: 0.06,
            gradientScore: 0.04,
            cost: 0.12
        },
        source: 'standard+smooth-prior',
        deriveSuppressionGainFromOriginalSpatial: true
    });

    assert.equal(currentState.source, 'standard+smooth-prior');
    assert.deepEqual(alphaAdjustmentStages, [{
        stage: 'smooth-located-estimated-prior',
        fromAlphaGain: 1,
        toAlphaGain: 1,
        beforeSpatialScore: 0.24,
        beforeGradientScore: 0.2,
        afterSpatialScore: 0.06,
        afterGradientScore: 0.04,
        suppressionGain: 0.75,
        cost: 0.12,
        repairStrategy: 'smooth-located-prior',
        allowSameAlphaGain: true
    }]);
});

test('createAlphaRepairPipelineRuntime should accept recalibration stage results', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 96, height: 96 },
        config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        alphaGain: 1,
        originalSpatialScore: 0.9,
        originalGradientScore: 0.6,
        finalProcessedSpatialScore: 0.48,
        finalProcessedGradientScore: 0.31,
        suppressionGain: 0.42,
        source: 'adaptive'
    };
    const alphaAdjustmentStages = [];
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            recordAlphaAdjustmentStage(stage) {
                alphaAdjustmentStages.push(stage);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    const committed = runtime.acceptRecalibrationStageResult({
        result: {
            imageData: { id: 'after' },
            processedSpatialScore: 0.11,
            alphaGain: 0.85,
            suppressionGain: 0.79,
            cost: 0.2
        },
        gradientScore: 0.06
    });

    assert.equal(committed, currentState);
    assert.equal(currentState.source, 'adaptive+gain');
    assert.equal(currentState.finalProcessedSpatialScore, 0.11);
    assert.equal(currentState.finalProcessedGradientScore, 0.06);
    assert.equal(currentState.alphaGain, 0.85);
    assert.deepEqual(alphaAdjustmentStages, [{
        stage: 'recalibration',
        fromAlphaGain: 1,
        toAlphaGain: 0.85,
        beforeSpatialScore: 0.48,
        beforeGradientScore: 0.31,
        afterSpatialScore: 0.11,
        afterGradientScore: 0.06,
        suppressionGain: 0.79,
        cost: 0.2,
        alphaStrategy: null
    }]);
});

test('createAlphaRepairPipelineRuntime should accept located aggressive results with pass metadata', () => {
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        alphaGain: 1,
        originalSpatialScore: 0.7,
        originalGradientScore: 0.5,
        finalProcessedSpatialScore: 0.3,
        finalProcessedGradientScore: 0.2,
        suppressionGain: 0.4,
        source: 'standard'
    };
    const alphaAdjustmentStages = [];
    const alphaTrialEvents = [];
    const passes = [];
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            alphaTrialEvents,
            recordAlphaAdjustmentStage(stage) {
                alphaAdjustmentStages.push(stage);
            },
            recordAlphaTrialEvent(event) {
                alphaTrialEvents.push(event);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    const outcome = runtime.acceptLocatedAggressiveResult({
        result: {
            imageData: { id: 'after' },
            spatialScore: 0.09,
            gradientScore: 0.04,
            alphaGain: 1.4,
            repeatCount: 2,
            edgeCleanup: true,
            nearBlackRatio: 0.01,
            cost: 0.12
        },
        source: 'standard+located-aggressive',
        fromAlphaGain: 1,
        beforeSpatialScore: 0.3,
        beforeGradientScore: 0.2,
        originalSpatialScore: 0.7,
        passes
    });

    assert.equal(outcome.committedState, currentState);
    assert.equal(outcome.passIncrement, 2);
    assert.equal(outcome.passStopReason, 'located-aggressive-edge-cleanup');
    assert.equal(currentState.alphaGain, 1.4);
    assert.equal(currentState.source, 'standard+located-aggressive');
    assert.deepEqual(alphaAdjustmentStages, [{
        stage: 'located-aggressive-removal',
        fromAlphaGain: 1,
        toAlphaGain: 1.4,
        beforeSpatialScore: 0.3,
        beforeGradientScore: 0.2,
        afterSpatialScore: 0.09,
        afterGradientScore: 0.04,
        suppressionGain: 0.61,
        cost: 0.12,
        alphaStrategy: 'located-aggressive-alpha',
        allowSameAlphaGain: true
    }]);
    assert.deepEqual(alphaTrialEvents, [{
        strategy: 'located-aggressive-alpha',
        decision: 'accept',
        blockedGate: null,
        beforeSpatialScore: 0.3,
        beforeGradientScore: 0.2,
        afterSpatialScore: 0.09,
        afterGradientScore: 0.04,
        suppressionGain: 0.61,
        alphaGain: 1.4,
        repeatCount: 2,
        edgeCleanup: true,
        cost: 0.12
    }]);
    assert.deepEqual(passes, [{
        index: 1,
        beforeSpatialScore: 0.3,
        beforeGradientScore: 0.2,
        afterSpatialScore: 0.09,
        afterGradientScore: 0.04,
        improvement: 0.21,
        gradientDelta: -0.16,
        nearBlackRatio: 0.01
    }]);
});

test('createAlphaRepairPipelineRuntime should accept safe preview background cleanup results', () => {
    const alphaAdjustmentStages = [];
    let currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 96, height: 96 },
        config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        alphaGain: 1,
        originalSpatialScore: 0.7,
        originalGradientScore: 0.5,
        finalProcessedSpatialScore: 0.2,
        finalProcessedGradientScore: 0.15,
        suppressionGain: 0.5,
        source: 'preview'
    };
    const runtime = createAlphaRepairPipelineRuntime({
        traceRecorder: {
            alphaAdjustmentStages,
            recordAlphaAdjustmentStage: (stage) => {
                alphaAdjustmentStages.push(stage);
            }
        },
        readState: () => currentState,
        applyState: (state) => {
            currentState = state;
        }
    });

    const committed = runtime.acceptPreviewBackgroundCleanupResult({
        cleanedImageData: { id: 'cleaned' },
        source: 'preview+background-cleanup',
        cleanedSpatialScore: 0.12,
        cleanedGradientScore: 0.08,
        cleanedNearBlackRatio: 0.03,
        currentNearBlackRatio: 0.02,
        baselineSpatialScore: 0.2,
        maxNearBlackRatioIncrease: 0.02
    });

    assert.equal(committed, currentState);
    assert.equal(currentState.finalImageData.id, 'cleaned');
    assert.equal(currentState.finalProcessedSpatialScore, 0.12);
    assert.equal(currentState.finalProcessedGradientScore, 0.08);
    assert.equal(currentState.source, 'preview+background-cleanup');
    assert.deepEqual(
        alphaAdjustmentStages.map((stage) => ({
            stage: stage.stage,
            fromAlphaGain: stage.fromAlphaGain,
            toAlphaGain: stage.toAlphaGain,
            beforeSpatialScore: stage.beforeSpatialScore,
            beforeGradientScore: stage.beforeGradientScore,
            afterSpatialScore: stage.afterSpatialScore,
            afterGradientScore: stage.afterGradientScore
        })),
        [{
            stage: 'preview-background-cleanup',
            fromAlphaGain: 1,
            toAlphaGain: 1,
            beforeSpatialScore: 0.2,
            beforeGradientScore: 0.15,
            afterSpatialScore: 0.12,
            afterGradientScore: 0.08
        }]
    );
});

test('createAlphaRepairPipelineRuntime should reject unsafe preview background cleanup results', () => {
    let applyCount = 0;
    const currentState = {
        finalImageData: { id: 'before' },
        alphaMap: 'alpha-before',
        position: { x: 0, y: 0, width: 96, height: 96 },
        config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        alphaGain: 1,
        originalSpatialScore: 0.7,
        originalGradientScore: 0.5,
        finalProcessedSpatialScore: 0.2,
        finalProcessedGradientScore: 0.15,
        suppressionGain: 0.5,
        source: 'preview'
    };
    const runtime = createAlphaRepairPipelineRuntime({
        readState: () => currentState,
        applyState: () => {
            applyCount++;
        }
    });

    const committed = runtime.acceptPreviewBackgroundCleanupResult({
        cleanedImageData: { id: 'cleaned' },
        source: 'preview+background-cleanup',
        cleanedSpatialScore: 0.25,
        cleanedGradientScore: 0.08,
        cleanedNearBlackRatio: 0.06,
        currentNearBlackRatio: 0.02,
        baselineSpatialScore: 0.2,
        maxNearBlackRatioIncrease: 0.02
    });

    assert.equal(committed, null);
    assert.equal(applyCount, 0);
});

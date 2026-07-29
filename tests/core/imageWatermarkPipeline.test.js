import test from 'node:test';
import assert from 'node:assert/strict';

import { runImageWatermarkPipeline } from '../../src/core/imageWatermarkPipeline.js';

function createImageData(width = 128, height = 128, value = 0) {
    const data = new Uint8ClampedArray(width * height * 4);
    data.fill(value);
    return { width, height, data };
}

function createHypothesis(id, signals) {
    return {
        id,
        family: id,
        rankingKey: [id],
        config: { watermarkSize: 48 },
        position: { x: 48, y: 48 },
        alphaProfile: 'standard',
        polarity: 'light',
        signals
    };
}

function createPipelineInput({ hypotheses, failures = new Set(), options = {} }) {
    const imageData = createImageData();
    const alpha48 = new Float32Array(48 * 48).fill(0.5);
    const alpha96 = new Float32Array(96 * 96).fill(0.5);
    let clock = 0;
    const executed = [];

    return {
        executed,
        request: {
            imageData,
            options: { alpha48, alpha96, debugTimings: true, ...options },
            nowMs: () => ++clock,
            cloneImageData: (source) => ({
                width: source.width,
                height: source.height,
                data: new Uint8ClampedArray(source.data)
            }),
            alphaGainCandidates: [1],
            alphaPriorityGains: [1],
            cleanupConfig: {},
            createAcceptedPipelineDependencies: () => ({}),
            selectCandidate: () => ({ selectedTrial: null }),
            collectCandidates: () => ({ hypotheses, presenceConfirmed: true }),
            runCandidate: ({ hypothesis }) => {
                executed.push(hypothesis.id);
                if (failures.has(hypothesis.id)) {
                    throw new Error(`failed:${hypothesis.id}`);
                }
                return {
                    hypothesis,
                    result: {
                        imageData: createImageData(128, 128, hypothesis.id.length),
                        meta: {
                            applied: true,
                            source: `source:${hypothesis.id}`,
                            config: hypothesis.config,
                            position: hypothesis.position
                        },
                        debugTimings: { candidateMs: 1 }
                    },
                    elapsedMs: 1
                };
            },
            measureCandidate: ({ hypothesis }) => hypothesis.signals
        }
    };
}

test('runImageWatermarkPipeline should not reuse convergence from a superseded accepted stage', () => {
    const convergence = {
        accepted: true,
        textureHardRejectResolved: true
    };
    const hypotheses = [
        createHypothesis('stale-convergence', {
            qualityStatus: 'clean',
            evidenceLoss: 0.05,
            residualLoss: 0.05,
            damageLoss: 0.05
        })
    ];
    const capturedFinalCandidates = [];
    const { request } = createPipelineInput({ hypotheses });
    request.runCandidate = ({ hypothesis }) => ({
        hypothesis,
        result: {
            imageData: createImageData(),
            meta: {
                applied: true,
                source: 'source:stale-convergence',
                config: hypothesis.config,
                position: hypothesis.position,
                alphaAdjustmentStages: [
                    {
                        stage: 'evidence-gated-local-alpha-search',
                        darkBackgroundSupportConvergence: convergence
                    },
                    {
                        stage: 'later-pixel-repair'
                    }
                ]
            }
        },
        pipelineState: {
            position: hypothesis.position,
            alphaMap: new Float32Array(48 * 48).fill(0.5),
            alphaGain: 1
        }
    });
    request.measureCandidate = ({ hypothesis, finalCandidate }) => {
        capturedFinalCandidates.push(finalCandidate);
        return hypothesis.signals;
    };

    runImageWatermarkPipeline(request);

    assert.equal(
        capturedFinalCandidates[0].darkBackgroundSupportConvergence,
        null
    );
});

test('runImageWatermarkPipeline should scope accepted-pipeline dependencies to each hypothesis', () => {
    const hypotheses = [
        createHypothesis('first', {
            qualityStatus: 'clean',
            evidenceLoss: 0.05,
            residualLoss: 0.05,
            damageLoss: 0.05
        }),
        createHypothesis('second', {
            qualityStatus: 'visible-residual',
            evidenceLoss: 0.1,
            residualLoss: 0.4,
            damageLoss: 0.1
        })
    ];
    const scopedHypothesisIds = [];
    const { request } = createPipelineInput({ hypotheses });
    request.createAcceptedPipelineDependencies = (hypothesis) => {
        scopedHypothesisIds.push(hypothesis?.id ?? null);
        return {};
    };
    request.runCandidate = ({
        hypothesis,
        createAcceptedPipelineDependencies
    }) => {
        createAcceptedPipelineDependencies();
        return {
            hypothesis,
            result: {
                imageData: createImageData(),
                meta: {
                    applied: true,
                    source: `source:${hypothesis.id}`,
                    config: hypothesis.config,
                    position: hypothesis.position
                }
            }
        };
    };

    runImageWatermarkPipeline(request);

    assert.deepEqual(scopedHypothesisIds, ['first', 'second']);
});

test('runImageWatermarkPipeline should notify diagnostics once for each completed candidate', () => {
    const hypotheses = [
        createHypothesis('standard', {
            qualityStatus: 'clean',
            evidenceLoss: 0.05,
            residualLoss: 0.05,
            damageLoss: 0.03
        }),
        createHypothesis('geometry', {
            qualityStatus: 'visible-residual',
            evidenceLoss: 0.1,
            residualLoss: 0.4,
            damageLoss: 0.08
        }),
        createHypothesis('failed', {})
    ];
    const captured = [];
    const { request } = createPipelineInput({
        hypotheses,
        failures: new Set(['failed']),
        options: {
            onCandidateCompleted: (candidate) => captured.push(candidate)
        }
    });

    const result = runImageWatermarkPipeline(request);

    assert.deepEqual(captured.map(({ hypothesis }) => hypothesis.id), [
        'standard',
        'geometry'
    ]);
    assert.equal(captured[0].result.imageData.width, 128);
    assert.equal(captured[0].qualitySignals.qualityStatus, 'clean');
    assert.equal(captured.some(({ hypothesis }) => hypothesis.id === 'failed'), false);
    assert.equal(
        result.meta.candidateSummaries.some((summary) => 'imageData' in summary),
        false
    );
});

test('runImageWatermarkPipeline should isolate diagnostic callback errors', () => {
    const hypotheses = [
        createHypothesis('standard', {
            qualityStatus: 'clean',
            evidenceLoss: 0.05,
            residualLoss: 0.05,
            damageLoss: 0.03
        })
    ];
    const { request } = createPipelineInput({
        hypotheses,
        options: {
            onCandidateCompleted: () => {
                throw new Error('diagnostic failed');
            }
        }
    });

    const result = runImageWatermarkPipeline(request);

    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.selectedCandidate.id, 'standard');
    assert.equal(result.debugTimings.candidateDiagnosticErrorCount, 1);
});

test('runImageWatermarkPipeline should execute all diverse hypotheses and return the best final result', () => {
    const hypotheses = [
        createHypothesis('standard', {
            qualityStatus: 'clean',
            evidenceLoss: 0.05,
            residualLoss: 0.05,
            damageLoss: 0.03,
            damageWarning: false
        }),
        createHypothesis('geometry', {
            qualityStatus: 'visible-residual',
            evidenceLoss: 0.04,
            residualLoss: 0.4,
            damageLoss: 0.1,
            damageWarning: false
        }),
        createHypothesis('alpha', {
            qualityStatus: 'possible-content-damage',
            evidenceLoss: 0.03,
            residualLoss: 0.02,
            damageLoss: 0.9,
            damageWarning: true
        }),
        createHypothesis('polarity', {
            qualityStatus: 'visible-residual',
            evidenceLoss: 0.1,
            residualLoss: 0.2,
            damageLoss: 0.08,
            damageWarning: false
        }),
        createHypothesis('aggressive', {
            qualityStatus: 'possible-content-damage',
            evidenceLoss: 0,
            residualLoss: 0,
            damageLoss: 1,
            damageWarning: true
        })
    ];
    const { request, executed } = createPipelineInput({ hypotheses });

    const result = runImageWatermarkPipeline(request);

    assert.deepEqual(executed, hypotheses.map(({ id }) => id));
    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.bestEffort, true);
    assert.equal(result.meta.retryRecommended, false);
    assert.equal(result.meta.qualityStatus, 'clean');
    assert.equal(result.meta.selectedCandidate.id, 'standard');
    assert.equal(result.meta.candidateSummaries.length, 5);
    assert.equal(result.meta.candidateSummaries[0].id, 'standard');
    assert.equal('imageData' in result.meta.candidateSummaries[0], false);
    assert.equal(result.debugTimings.generatedCandidateCount, 5);
    assert.equal(result.debugTimings.executedCandidateCount, 5);
});

test('runImageWatermarkPipeline should expose a failed candidate and still return the best completed result', () => {
    const hypotheses = [
        createHypothesis('standard', {
            qualityStatus: 'clean',
            evidenceLoss: 0.05,
            residualLoss: 0.05,
            damageLoss: 0.03,
            damageWarning: false
        }),
        createHypothesis('aggressive', {
            qualityStatus: 'possible-content-damage',
            evidenceLoss: 0,
            residualLoss: 0,
            damageLoss: 1,
            damageWarning: true
        })
    ];
    const { request } = createPipelineInput({
        hypotheses,
        failures: new Set(['aggressive'])
    });

    const result = runImageWatermarkPipeline(request);

    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.selectedCandidate.id, 'standard');
    assert.equal(result.meta.candidateSummaries.length, 2);
    assert.equal(result.meta.candidateSummaries[1].id, 'aggressive');
    assert.equal(result.meta.candidateSummaries[1].valid, false);
    assert.equal(result.meta.candidateSummaries[1].error, 'failed:aggressive');
    assert.equal(result.debugTimings.failedCandidateCount, 1);
});

test('runImageWatermarkPipeline should return an imperfect best effort without recommending retry', () => {
    const hypotheses = [
        createHypothesis('standard', {
            qualityStatus: 'visible-residual',
            evidenceLoss: 0.3,
            residualLoss: 0.7,
            damageLoss: 0.1,
            damageWarning: false
        })
    ];
    const { request } = createPipelineInput({ hypotheses });

    const result = runImageWatermarkPipeline(request);

    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.bestEffort, true);
    assert.equal(result.meta.retryRecommended, false);
    assert.equal(result.meta.qualityStatus, 'visible-residual');
    assert.equal(result.meta.selectionConfidence, 1);
});

test('runImageWatermarkPipeline should reject only when every candidate execution fails', () => {
    const hypotheses = [
        createHypothesis('standard', {}),
        createHypothesis('aggressive', {})
    ];
    const { request } = createPipelineInput({
        hypotheses,
        failures: new Set(['standard', 'aggressive'])
    });

    const result = runImageWatermarkPipeline(request);

    assert.equal(result.meta.applied, false);
    assert.equal(result.meta.skipReason, 'candidate-execution-failed');
    assert.equal(result.meta.source, 'top-n-runtime-failure');
    assert.equal(result.meta.decisionTier, 'runtime-failure');
    assert.equal(result.debugTimings.generatedCandidateCount, 2);
    assert.equal(result.debugTimings.failedCandidateCount, 2);
});

test('runImageWatermarkPipeline should reject unconfirmed hypotheses before changing pixels', () => {
    const hypotheses = [
        createHypothesis('diagnostic-only', {
            qualityStatus: 'visible-residual',
            evidenceLoss: 1,
            residualLoss: 1,
            damageLoss: 1
        })
    ];
    const { request, executed } = createPipelineInput({ hypotheses });
    const original = new Uint8ClampedArray(request.imageData.data);
    request.collectCandidates = () => ({
        hypotheses,
        presenceConfirmed: false,
        fixedSelection: {
            selectedTrial: null,
            adaptiveConfidence: null,
            standardSpatialScore: 0,
            standardGradientScore: 0,
            decisionTier: 'insufficient'
        },
        automaticSelection: {
            selectedTrial: null,
            adaptiveConfidence: null,
            standardSpatialScore: 0,
            standardGradientScore: 0,
            decisionTier: 'insufficient'
        }
    });

    const result = runImageWatermarkPipeline(request);

    assert.deepEqual(executed, []);
    assert.equal(result.meta.applied, false);
    assert.equal(result.meta.skipReason, 'no-watermark-detected');
    assert.equal(result.meta.decisionPath?.decision, 'reject');
    assert.deepEqual(result.imageData.data, original);
});

test('runImageWatermarkPipeline should execute an explicit unconfirmed best-effort fallback', () => {
    const hypotheses = [
        createHypothesis('validated-best-effort', {
            qualityStatus: 'visible-residual',
            evidenceLoss: 0.3,
            residualLoss: 0.5,
            damageLoss: 0.1,
            damageWarning: false
        })
    ];
    const { request, executed } = createPipelineInput({ hypotheses });
    request.collectCandidates = () => ({
        hypotheses,
        presenceConfirmed: false,
        bestEffortFallback: true,
        bestEffortReason: 'presence-witness-unconfirmed'
    });

    const result = runImageWatermarkPipeline(request);

    assert.deepEqual(executed, ['validated-best-effort']);
    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.bestEffort, true);
    assert.equal(result.meta.retryRecommended, false);
    assert.equal(result.meta.presenceConfirmed, false);
    assert.equal(result.meta.bestEffortReason, 'presence-witness-unconfirmed');
});

test('runImageWatermarkPipeline should preserve collectors that predate explicit presence metadata', () => {
    const hypotheses = [
        createHypothesis('legacy-collector', {
            qualityStatus: 'clean',
            evidenceLoss: 0.1,
            residualLoss: 0.1,
            damageLoss: 0.1
        })
    ];
    const { request, executed } = createPipelineInput({ hypotheses });
    request.collectCandidates = () => ({ hypotheses });

    const result = runImageWatermarkPipeline(request);

    assert.deepEqual(executed, ['legacy-collector']);
    assert.equal(result.meta.applied, true);
});

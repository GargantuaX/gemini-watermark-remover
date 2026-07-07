import test from 'node:test';
import assert from 'node:assert/strict';

import {
    arbitrateCandidateByEvaluation,
    createAcceptedDecisionPath,
    createCandidateEvaluation,
    createRejectedDecisionPath,
    hasHighRiskNewMarginPositiveEvidence,
    shouldFailClosedForVisibleResidualUnsafeDamage
} from '../../src/core/candidateEvaluation.js';

const NEW_MARGIN_ALPHA_VARIANT = Object.freeze({
    logoSize: 96,
    marginRight: 192,
    marginBottom: 192,
    alphaVariant: '20260520'
});

const NEW_MARGIN_DEFAULT_ALPHA = Object.freeze({
    logoSize: 96,
    marginRight: 192,
    marginBottom: 192
});

function createAlwaysPassingEvaluation(overrides = {}) {
    return createCandidateEvaluation({
        source: 'standard',
        config: NEW_MARGIN_ALPHA_VARIANT,
        provenance: {},
        originalScores: { spatialScore: 0.5, gradientScore: 0.2 },
        processedScores: { spatialScore: 0.05, gradientScore: 0.02 },
        improvement: 0.45,
        residual: { cleared: true },
        damage: { safe: true, penalty: 0.02 },
        gates: {
            originalEvidenceAllowed: true,
            catalogEvidenceAllowed: true,
            darkPolarityCatalogEvidenceAllowed: true,
            baseValidationAccepted: true
        },
        ...overrides
    });
}

test('createCandidateEvaluation should reject weak positive-alpha 96px new-margin evidence', () => {
    const evaluation = createAlwaysPassingEvaluation({
        originalScores: {
            spatialScore: 0.281,
            gradientScore: -0.044
        }
    });

    assert.equal(evaluation.eligible, false);
    assert.equal(evaluation.blockedGate, 'highRiskNewMarginEvidenceAllowed');
    assert.deepEqual(evaluation.riskFlags, ['weak-new-margin-positive-alpha-evidence']);
});

test('createCandidateEvaluation should allow strong 96px new-margin evidence', () => {
    const evaluation = createAlwaysPassingEvaluation({
        originalScores: {
            spatialScore: 0.468,
            gradientScore: 0.804
        }
    });

    assert.equal(evaluation.eligible, true);
    assert.equal(evaluation.blockedGate, null);
    assert.equal(hasHighRiskNewMarginPositiveEvidence({
        config: NEW_MARGIN_ALPHA_VARIANT,
        originalSpatialScore: 0.468,
        originalGradientScore: 0.804
    }), true);
});

test('shouldFailClosedForVisibleResidualUnsafeDamage should reject issue 103 unsafe visible residual', () => {
    assert.equal(shouldFailClosedForVisibleResidualUnsafeDamage({
        selectedTrial: {
            config: NEW_MARGIN_ALPHA_VARIANT,
            damage: { safe: false, reason: 'texture' }
        },
        residualVisibility: { visible: true }
    }), true);
});

test('shouldFailClosedForVisibleResidualUnsafeDamage should allow safe or non-visible results', () => {
    assert.equal(shouldFailClosedForVisibleResidualUnsafeDamage({
        selectedTrial: {
            config: NEW_MARGIN_ALPHA_VARIANT,
            damage: { safe: true, reason: null }
        },
        residualVisibility: { visible: true }
    }), false);

    assert.equal(shouldFailClosedForVisibleResidualUnsafeDamage({
        selectedTrial: {
            config: NEW_MARGIN_ALPHA_VARIANT,
            damage: { safe: false, reason: 'texture' }
        },
        residualVisibility: { visible: false }
    }), false);

    assert.equal(shouldFailClosedForVisibleResidualUnsafeDamage({
        selectedTrial: {
            config: NEW_MARGIN_DEFAULT_ALPHA,
            damage: { safe: false, reason: 'texture' }
        },
        residualVisibility: { visible: true }
    }), false);
});

test('arbitrateCandidateByEvaluation should prefer safe default-alpha new-margin rescue over uncleared alpha variant', () => {
    const currentBest = {
        config: NEW_MARGIN_ALPHA_VARIANT,
        residual: { cleared: false },
        processedSpatialScore: 0.24,
        processedGradientScore: 0.16,
        improvement: 0.2,
        damage: { penalty: 0.04 }
    };
    const candidate = {
        config: NEW_MARGIN_DEFAULT_ALPHA,
        residual: { cleared: true },
        processedSpatialScore: 0.05,
        processedGradientScore: 0.02,
        improvement: 0.2,
        damage: { penalty: 0.05 }
    };

    assert.equal(arbitrateCandidateByEvaluation(currentBest, candidate), candidate);
});

test('arbitrateCandidateByEvaluation should prefer lower-damage default-alpha candidates when both are safe', () => {
    const currentBest = {
        config: NEW_MARGIN_DEFAULT_ALPHA,
        residual: { cleared: true },
        processedSpatialScore: 0.08,
        processedGradientScore: 0.03,
        improvement: 0.2,
        damage: { penalty: 0.2 }
    };
    const candidate = {
        config: NEW_MARGIN_DEFAULT_ALPHA,
        residual: { cleared: true },
        processedSpatialScore: 0.07,
        processedGradientScore: 0.03,
        improvement: 0.2,
        damage: { penalty: 0.16 }
    };

    assert.equal(arbitrateCandidateByEvaluation(currentBest, candidate), candidate);
});

test('createAcceptedDecisionPath should adapt selectedTrial into layered lightweight path objects', () => {
    const selectedTrial = {
        source: 'standard+catalog',
        config: NEW_MARGIN_ALPHA_VARIANT,
        position: { x: 736, y: 736, width: 96, height: 96 },
        alphaGain: 1,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.72,
        processedSpatialScore: 0.12,
        processedGradientScore: 0.08,
        improvement: 0.68,
        provenance: { catalogVariant: true, alphaVariant: '20260520' },
        originalEvidence: { tier: 3 },
        residual: { cleared: true, score: 0.12 },
        damage: { safe: true, penalty: 0.01 },
        evaluation: createAlwaysPassingEvaluation()
    };

    const decisionPath = createAcceptedDecisionPath({
        selectedTrial,
        selectionSource: 'standard+catalog',
        source: 'standard+catalog+gain+luma-edge',
        decisionTier: 'direct-match',
        config: NEW_MARGIN_ALPHA_VARIANT,
        position: selectedTrial.position,
        alphaGain: 0.85,
        alphaAdjustmentStages: [
            {
                stage: 'weak-positive-residual-fine-alpha',
                fromAlphaGain: 1,
                toAlphaGain: 0.85,
                alphaStrategy: 'over-subtraction-fine-alpha'
            },
            { stage: 'known-48-luma-edge-cleanup', fromAlphaGain: 0.85, toAlphaGain: 0.85, cost: 0.1 }
        ],
        alphaTrialEvents: [
            {
                stage: 'weak-positive-residual-fine-alpha',
                strategy: 'over-subtraction-fine-alpha',
                decision: 'accept',
                fromAlphaGain: 1,
                toAlphaGain: 0.85,
                alphaGain: 0.85
            }
        ],
        processedSpatialScore: 0.04,
        processedGradientScore: 0.03,
        suppressionGain: 0.76
    });

    assert.equal(decisionPath.decision, 'accept');
    assert.equal(decisionPath.detectionCandidate.config.alphaVariant, '20260520');
    assert.equal(decisionPath.detectionCandidate.evidence.productionEvidence, true);
    assert.equal(decisionPath.alphaTrial.alphaGain, 0.85);
    assert.equal(decisionPath.alphaTrial.strategy, 'over-subtraction-fine-alpha');
    assert.equal(decisionPath.alphaTrial.migrationStage, 'phase2-alpha-trial');
    assert.equal(decisionPath.alphaTrial.alphaShape.profileStages[0].alphaStrategy, 'over-subtraction-fine-alpha');
    assert.equal(decisionPath.alphaTrial.acceptedStrategies[0].stage, 'weak-positive-residual-fine-alpha');
    assert.equal(decisionPath.alphaTrial.acceptedStrategies[0].fromAlphaGain, 1);
    assert.equal(decisionPath.alphaTrial.acceptedStrategies[0].toAlphaGain, 0.85);
    assert.equal(decisionPath.alphaTrial.scores.processedSpatial, 0.04);
    assert.equal(decisionPath.repairTrial.applied, true);
    assert.equal(decisionPath.repairTrial.repairType, 'luma-edge');
    assert.equal(decisionPath.repairTrial.params[0].repairStrategy, 'luma-edge');
    assert.equal(decisionPath.repairTrial.gates.stages[0], 'known-48-luma-edge-cleanup');
    assert.equal(decisionPath.repairSource, 'standard+catalog+gain+luma-edge');
    assert.equal(decisionPath.evaluation.decision, 'accept');
});

test('createAcceptedDecisionPath should mark new-margin variant rescue as a phase2 alpha trial', () => {
    const selectedTrial = {
        source: 'standard+catalog',
        config: NEW_MARGIN_DEFAULT_ALPHA,
        position: { x: 736, y: 736, width: 96, height: 96 },
        alphaGain: 1,
        originalSpatialScore: 0.95,
        originalGradientScore: 0.91,
        processedSpatialScore: 0.28,
        processedGradientScore: 0.08,
        improvement: 0.67,
        provenance: { catalogVariant: true },
        originalEvidence: { tier: 3 },
        residual: { cleared: false, score: 0.28 },
        damage: { safe: true, penalty: 0.02 },
        evaluation: createAlwaysPassingEvaluation()
    };

    const decisionPath = createAcceptedDecisionPath({
        selectedTrial,
        selectionSource: 'standard+catalog',
        source: 'standard+catalog+new-margin-variant',
        decisionTier: 'direct-match',
        config: NEW_MARGIN_ALPHA_VARIANT,
        position: selectedTrial.position,
        alphaGain: 1.05,
        alphaAdjustmentStages: [
            {
                stage: 'new-margin-96-variant-rescue',
                fromAlphaGain: 1,
                toAlphaGain: 1.05,
                beforeSpatialScore: 0.28,
                beforeGradientScore: 0.08,
                afterSpatialScore: 0.04,
                afterGradientScore: 0.02,
                suppressionGain: 0.91,
                profileExponent: 1.06,
                alphaStrategy: 'new-margin-96-variant',
                cost: 0.03
            }
        ],
        processedSpatialScore: 0.04,
        processedGradientScore: 0.02,
        suppressionGain: 0.91
    });

    assert.equal(decisionPath.alphaTrial.strategy, 'new-margin-96-variant');
    assert.equal(decisionPath.alphaTrial.migrationStage, 'phase2-alpha-trial');
    assert.equal(decisionPath.alphaTrial.alphaShape.variant, '20260520');
    assert.deepEqual(decisionPath.alphaTrial.alphaShape.stages, ['new-margin-96-variant-rescue']);
    assert.equal(decisionPath.alphaTrial.alphaShape.profileStages[0].toAlphaGain, 1.05);
    assert.equal(decisionPath.alphaTrial.alphaShape.profileStages[0].profileExponent, 1.06);
    assert.equal(decisionPath.alphaTrial.alphaShape.profileStages[0].afterSpatialScore, 0.04);
    assert.equal(decisionPath.alphaTrial.alphaShape.profileStages[0].alphaStrategy, 'new-margin-96-variant');
});

test('createAcceptedDecisionPath should promote power and rebalance alpha strategies to phase2 alpha trials', () => {
    const selectedTrial = {
        source: 'standard+gain',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 880, y: 880, width: 48, height: 48 },
        alphaGain: 0.55,
        originalSpatialScore: 0.99,
        originalGradientScore: 0.99,
        processedSpatialScore: 0.31,
        processedGradientScore: 0.1,
        improvement: 0.68,
        provenance: { catalogVariant: true },
        originalEvidence: { tier: 3 },
        residual: { cleared: false, score: 0.31 },
        damage: { safe: true, penalty: 0.02 },
        evaluation: createAlwaysPassingEvaluation({
            config: { logoSize: 48, marginRight: 96, marginBottom: 96 }
        })
    };
    const common = {
        selectedTrial,
        selectionSource: 'standard+gain',
        decisionTier: 'direct-match',
        config: selectedTrial.config,
        position: selectedTrial.position,
        alphaGain: 0.55,
        processedSpatialScore: 0.04,
        processedGradientScore: 0.03,
        suppressionGain: 0.95
    };

    const powerPath = createAcceptedDecisionPath({
        ...common,
        source: 'standard+gain+power-profile-rescue',
        alphaAdjustmentStages: [{
            stage: 'known-48-power-profile-rescue',
            fromAlphaGain: 0.6,
            toAlphaGain: 0.55,
            afterSpatialScore: 0.04,
            afterGradientScore: 0.03,
            suppressionGain: 0.95,
            profileExponent: 0.88,
            alphaStrategy: 'known-48-power-profile'
        }]
    });
    const rebalancePath = createAcceptedDecisionPath({
        ...common,
        source: 'standard+gain+residual-rebalance',
        alphaAdjustmentStages: [{
            stage: 'known-48-positive-residual-rebalance',
            fromAlphaGain: 0.55,
            toAlphaGain: 0.65,
            afterSpatialScore: 0.05,
            afterGradientScore: 0.04,
            suppressionGain: 0.94,
            profileExponent: 1.08,
            alphaStrategy: 'known-48-positive-residual-rebalance'
        }]
    });

    assert.equal(powerPath.alphaTrial.strategy, 'known-48-power-profile');
    assert.equal(powerPath.alphaTrial.migrationStage, 'phase2-alpha-trial');
    assert.equal(powerPath.alphaTrial.alphaShape.profileStages[0].profileExponent, 0.88);
    assert.equal(rebalancePath.alphaTrial.strategy, 'known-48-positive-residual-rebalance');
    assert.equal(rebalancePath.alphaTrial.migrationStage, 'phase2-alpha-trial');
    assert.equal(rebalancePath.alphaTrial.alphaShape.profileStages[0].profileExponent, 1.08);
});

test('createAcceptedDecisionPath should mark dark catalog fine alpha as a phase2 alpha trial', () => {
    const selectedTrial = {
        source: 'standard+catalog',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 576, y: 1313, width: 48, height: 48 },
        alphaGain: 1,
        originalSpatialScore: 0.72,
        originalGradientScore: 0.48,
        processedSpatialScore: 0.18,
        processedGradientScore: 0.08,
        improvement: 0.54,
        provenance: { catalogVariant: true },
        originalEvidence: { tier: 3 },
        residual: { cleared: true },
        damage: { safe: true, penalty: 0.02 },
        evaluation: createAlwaysPassingEvaluation({
            config: { logoSize: 48, marginRight: 96, marginBottom: 96 }
        })
    };

    const decisionPath = createAcceptedDecisionPath({
        selectedTrial,
        selectionSource: 'standard+catalog',
        source: 'standard+catalog+fine-alpha',
        decisionTier: 'direct-match',
        config: selectedTrial.config,
        position: selectedTrial.position,
        alphaGain: 0.95,
        alphaAdjustmentStages: [
            {
                stage: 'dark-catalog-fine-alpha',
                fromAlphaGain: 1,
                toAlphaGain: 0.95,
                alphaStrategy: 'dark-catalog-fine-alpha'
            }
        ],
        alphaTrialEvents: [
            {
                stage: 'dark-catalog-fine-alpha',
                strategy: 'dark-catalog-fine-alpha',
                decision: 'accept',
                fromAlphaGain: 1,
                toAlphaGain: 0.95,
                alphaGain: 0.95
            }
        ],
        processedSpatialScore: 0.05,
        processedGradientScore: 0.04,
        suppressionGain: 0.67
    });

    assert.equal(decisionPath.alphaTrial.strategy, 'dark-catalog-fine-alpha');
    assert.equal(decisionPath.alphaTrial.migrationStage, 'phase2-alpha-trial');
    assert.equal(decisionPath.alphaTrial.alphaShape.profileStages[0].alphaStrategy, 'dark-catalog-fine-alpha');
    assert.equal(decisionPath.alphaTrial.acceptedStrategies[0].stage, 'dark-catalog-fine-alpha');
});

test('createAcceptedDecisionPath should record accepted and rejected alpha trial events separately', () => {
    const selectedTrial = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 880, y: 880, width: 48, height: 48 },
        alphaGain: 1,
        originalSpatialScore: 0.6,
        originalGradientScore: 0.3,
        processedSpatialScore: 0.18,
        processedGradientScore: 0.08,
        improvement: 0.42,
        provenance: {},
        originalEvidence: { tier: 2 },
        residual: { cleared: true, score: 0.18 },
        damage: { safe: true, penalty: 0.02 },
        evaluation: createAlwaysPassingEvaluation({
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 }
        })
    };
    const decisionPath = createAcceptedDecisionPath({
        selectedTrial,
        selectionSource: 'standard',
        source: 'standard',
        decisionTier: 'direct-match',
        config: selectedTrial.config,
        position: selectedTrial.position,
        alphaGain: 1,
        processedSpatialScore: 0.18,
        processedGradientScore: 0.08,
        suppressionGain: 0.42,
        alphaTrialEvents: [
            {
                strategy: 'located-aggressive-alpha',
                decision: 'reject',
                blockedGate: 'passable-spatial-drift',
                currentSpatialScore: 0.18,
                candidateSpatialScore: 0.24,
                spatialDrift: 0.06
            },
            {
                strategy: 'located-aggressive-alpha',
                decision: 'accept',
                afterSpatialScore: 0.08,
                afterGradientScore: 0.04,
                alphaGain: 1.3,
                repeatCount: 1,
                edgeCleanup: false
            }
        ]
    });

    assert.equal(decisionPath.alphaTrial.rejectedStrategies[0].strategy, 'located-aggressive-alpha');
    assert.equal(decisionPath.alphaTrial.rejectedStrategies[0].blockedGate, 'passable-spatial-drift');
    assert.equal(decisionPath.alphaTrial.rejectedStrategies[0].spatialDrift, 0.06);
    assert.equal(decisionPath.alphaTrial.acceptedStrategies[0].strategy, 'located-aggressive-alpha');
    assert.equal(decisionPath.alphaTrial.acceptedStrategies[0].alphaGain, 1.3);
});

test('createRejectedDecisionPath should describe skipped decisions without alpha or repair trials', () => {
    const decisionPath = createRejectedDecisionPath({
        reason: 'no-watermark-detected',
        source: 'skipped',
        decisionTier: 'insufficient',
        originalSpatialScore: 0.08,
        originalGradientScore: 0.04
    });

    assert.equal(decisionPath.decision, 'reject');
    assert.equal(decisionPath.alphaTrial, null);
    assert.equal(decisionPath.repairTrial, null);
    assert.equal(decisionPath.blockedGate, 'no-watermark-detected');
    assert.equal(decisionPath.detectionCandidate.evidence.productionEvidence, false);
});

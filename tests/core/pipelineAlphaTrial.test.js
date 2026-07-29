import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAlphaTrialContractSummary,
    createAlphaTrialFromSelectedTrial
} from '../../src/core/pipelineAlphaTrial.js';

test('createAlphaTrialFromSelectedTrial should map phase2 alpha trial evidence', () => {
    const detectionCandidate = {
        id: 'det:96/192/192/20260520:736,736,96,96:standard+catalog'
    };
    const selectedTrial = {
        source: 'standard+catalog',
        config: {
            logoSize: 96,
            marginRight: 192,
            marginBottom: 192,
            alphaVariant: '20260520'
        },
        position: { x: 736, y: 736, width: 96, height: 96 },
        alphaGain: 1.05,
        originalSpatialScore: 0.72,
        originalGradientScore: 0.34,
        processedSpatialScore: 0.04,
        processedGradientScore: 0.02,
        improvement: 0.68,
        evaluation: { gates: { highRiskNewMarginEvidenceAllowed: true } },
        damage: { safe: true, penalty: 0.01 },
        residual: { cleared: true },
        provenance: { alphaMapSource: 'catalog', catalogVariant: true }
    };

    const alphaTrial = createAlphaTrialFromSelectedTrial({
        selectedTrial,
        detectionCandidate,
        source: 'new-margin-variant-rescue',
        alphaAdjustmentStages: [{
            stage: 'new-margin-96-variant-rescue',
            alphaStrategy: 'new-margin-96-variant',
            fromAlphaGain: 1,
            toAlphaGain: 1.05,
            beforeSpatialScore: 0.22,
            afterSpatialScore: 0.04,
            suppressionGain: 0.18,
            profileExponent: 1.06
        }],
        alphaTrialEvents: [{
            stage: 'new-margin-96-variant-rescue',
            strategy: 'new-margin-96-variant',
            decision: 'accept',
            alphaGain: 1.05
        }]
    });

    assert.equal(alphaTrial.id, 'alpha:96/192/192/20260520:736,736,96,96:new-margin-variant-rescue:1.05');
    assert.equal(alphaTrial.detectionId, detectionCandidate.id);
    assert.equal(alphaTrial.strategy, 'new-margin-96-variant');
    assert.equal(alphaTrial.migrationStage, 'phase2-alpha-trial');
    assert.equal(alphaTrial.alphaMapSource, 'catalog');
    assert.equal(alphaTrial.alphaShape.variant, '20260520');
    assert.deepEqual(alphaTrial.alphaShape.stages, ['new-margin-96-variant-rescue']);
    assert.deepEqual(alphaTrial.alphaShape.profileStages, [{
        stage: 'new-margin-96-variant-rescue',
        alphaStrategy: 'new-margin-96-variant',
        fromAlphaGain: 1,
        toAlphaGain: 1.05,
        beforeSpatialScore: 0.22,
        afterSpatialScore: 0.04,
        suppressionGain: 0.18,
        profileExponent: 1.06
    }]);
    assert.deepEqual(alphaTrial.acceptedStrategies, [{
        stage: 'new-margin-96-variant-rescue',
        strategy: 'new-margin-96-variant',
        decision: 'accept',
        alphaGain: 1.05
    }]);
    assert.deepEqual(alphaTrial.rejectedStrategies, []);
    assert.deepEqual(alphaTrial.scores, {
        originalSpatial: 0.72,
        originalGradient: 0.34,
        processedSpatial: 0.04,
        processedGradient: 0.02,
        suppressionGain: 0.68
    });
    assert.equal(alphaTrial.gates, selectedTrial.evaluation.gates);
    assert.equal(alphaTrial.damage, selectedTrial.damage);
    assert.equal(alphaTrial.residual, selectedTrial.residual);
    assert.equal(alphaTrial.provenance, selectedTrial.provenance);
});

test('createAlphaTrialFromSelectedTrial should split accepted and rejected events', () => {
    const alphaTrial = createAlphaTrialFromSelectedTrial({
        selectedTrial: {
            source: 'located-aggressive',
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            position: { x: 80, y: 80, width: 48, height: 48 }
        },
        alphaTrialEvents: [
            {
                stage: 'located-aggressive-removal',
                strategy: 'located-aggressive-alpha',
                decision: 'reject',
                blockedGate: 'passable-spatial-drift',
                spatialDrift: 0.06
            },
            {
                stage: 'located-aggressive-removal',
                strategy: 'located-aggressive-alpha',
                decision: 'accept',
                alphaGain: 1.3
            }
        ]
    });

    assert.equal(alphaTrial.strategy, 'located-aggressive-alpha');
    assert.equal(alphaTrial.migrationStage, 'phase1-adapter');
    assert.equal(alphaTrial.rejectedStrategies[0].blockedGate, 'passable-spatial-drift');
    assert.equal(alphaTrial.rejectedStrategies[0].spatialDrift, 0.06);
    assert.equal(alphaTrial.acceptedStrategies[0].alphaGain, 1.3);
});

test('createAlphaTrialFromSelectedTrial should replace stale selection quality with final pipeline quality', () => {
    const selectedDamage = {
        safe: true,
        penalty: 0.1,
        newlyClippedRatio: 0
    };
    const selectedResidual = {
        cleared: false,
        spatial: -0.06,
        gradient: 0.05,
        score: 0.09
    };
    const finalArtifacts = {
        newlyClippedRatio: 0.019965277777777776,
        visualArtifactCost: 0.117
    };
    const finalQualitySignals = {
        final: {
            spatialScore: 0.08269753279573036,
            gradientScore: 0.0663245530919801
        },
        artifacts: finalArtifacts,
        texture: {
            hardReject: false,
            texturePenalty: 0.04
        },
        visibility: {
            halo: { positiveDeltaLum: 2.7 }
        },
        nearBlackIncrease: 0.02
    };

    const alphaTrial = createAlphaTrialFromSelectedTrial({
        selectedTrial: {
            source: 'standard+catalog',
            config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
            position: { x: 576, y: 1313, width: 48, height: 48 },
            alphaGain: 1,
            damage: selectedDamage,
            residual: selectedResidual
        },
        source: 'standard+catalog+profile-alpha-rescue',
        alphaGain: 0.85,
        alphaAdjustmentStages: [{
            stage: 'large-margin-48-profile-alpha-rescue',
            fromAlphaGain: 1,
            toAlphaGain: 0.85,
            alphaStrategy: 'large-margin-48-profile-alpha',
            profileExponent: 0.9
        }],
        processedSpatialScore: finalQualitySignals.final.spatialScore,
        processedGradientScore: finalQualitySignals.final.gradientScore,
        suppressionGain: 0.628960825889181,
        finalQualitySignals
    });

    assert.notEqual(alphaTrial.damage, selectedDamage);
    assert.equal(alphaTrial.damage.newlyClippedRatio, finalArtifacts.newlyClippedRatio);
    assert.equal(alphaTrial.damage.nearBlackIncrease, 0.02);
    assert.equal(alphaTrial.damage.texturePenalty, 0.04);
    assert.equal(alphaTrial.artifacts, finalArtifacts);
    assert.notEqual(alphaTrial.residual, selectedResidual);
    assert.equal(alphaTrial.residual.spatial, finalQualitySignals.final.spatialScore);
    assert.equal(alphaTrial.residual.gradient, finalQualitySignals.final.gradientScore);
    assert.equal(alphaTrial.residual.suppressionGain, 0.628960825889181);
    assert.equal(alphaTrial.residual.artifactCost, finalArtifacts.visualArtifactCost);
});

test('createAlphaTrialFromSelectedTrial should classify profile and local alpha stages as phase2 and preserve stage extras', () => {
    const profileTrial = createAlphaTrialFromSelectedTrial({
        selectedTrial: {
            source: 'standard+catalog',
            config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
            position: { x: 576, y: 1313, width: 48, height: 48 }
        },
        source: 'standard+catalog+profile-alpha-rescue',
        alphaAdjustmentStages: [{
            stage: 'large-margin-48-profile-alpha-rescue',
            fromAlphaGain: 1,
            toAlphaGain: 0.85,
            alphaStrategy: 'large-margin-48-profile-alpha',
            profileExponent: 0.9
        }]
    });
    const localSearchTrigger = {
        reason: 'damage-warning',
        newlyClippedRatio: 0.021
    };
    const localTrial = createAlphaTrialFromSelectedTrial({
        selectedTrial: {
            source: 'standard+catalog',
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            position: { x: 576, y: 1313, width: 48, height: 48 }
        },
        source: 'standard+catalog+local-alpha',
        alphaAdjustmentStages: [{
            stage: 'evidence-gated-local-alpha-search',
            fromAlphaGain: 1,
            toAlphaGain: 0.95,
            alphaStrategy: 'evidence-gated-local-alpha',
            localSearchTrigger,
            evaluatedCandidateCount: 7
        }]
    });

    assert.equal(profileTrial.strategy, 'large-margin-48-profile-alpha');
    assert.equal(profileTrial.migrationStage, 'phase2-alpha-trial');
    assert.equal(localTrial.strategy, 'evidence-gated-local-alpha');
    assert.equal(localTrial.migrationStage, 'phase2-alpha-trial');
    assert.equal(
        localTrial.alphaShape.profileStages[0].localSearchTrigger,
        localSearchTrigger
    );
    assert.equal(localTrial.alphaShape.profileStages[0].evaluatedCandidateCount, 7);
});

test('createAlphaTrialContractSummary should expose stable alpha contract counts', () => {
    const alphaTrial = createAlphaTrialFromSelectedTrial({
        selectedTrial: {
            source: 'weak-positive-residual-fine-alpha',
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            position: { x: 80, y: 80, width: 48, height: 48 }
        },
        detectionCandidate: { id: 'det:48/32/32:80,80,48,48:standard' },
        alphaAdjustmentStages: ['weak-positive-residual-fine-alpha'],
        alphaTrialEvents: [
            { stage: 'weak-positive-residual-fine-alpha', decision: 'accept' },
            { stage: 'weak-positive-residual-fine-alpha', decision: 'reject' }
        ]
    });

    assert.deepEqual(createAlphaTrialContractSummary(alphaTrial), {
        id: 'alpha:48/32/32:80,80,48,48:weak-positive-residual-fine-alpha:1',
        detectionId: 'det:48/32/32:80,80,48,48:standard',
        source: 'weak-positive-residual-fine-alpha',
        strategy: 'over-subtraction-fine-alpha',
        migrationStage: 'phase2-alpha-trial',
        acceptedStrategyCount: 1,
        rejectedStrategyCount: 1,
        profileStageCount: 1
    });
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    attachTopNSelectionMeta,
    createAcceptedWatermarkMeta,
    createRejectedWatermarkMeta,
    createWatermarkMeta
} from '../../src/core/pipelineMeta.js';
import { createCandidateEvaluation } from '../../src/core/candidateEvaluation.js';

function createAlwaysPassingEvaluation() {
    return createCandidateEvaluation({
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
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
        }
    });
}

test('createWatermarkMeta should normalize skipped metadata', () => {
    const meta = createWatermarkMeta({
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32, ignored: true },
        processedSpatialScore: 0.1,
        processedGradientScore: 0.2,
        source: 'skipped',
        applied: false,
        skipReason: 'no-watermark-detected',
        passes: 'not-an-array'
    });

    assert.equal(meta.applied, false);
    assert.equal(meta.skipReason, 'no-watermark-detected');
    assert.equal(meta.size, 48);
    assert.deepEqual(meta.config, { logoSize: 48, marginRight: 32, marginBottom: 32 });
    assert.equal(meta.detection.processedSpatialScore, 0.1);
    assert.equal(meta.passes, null);
});

test('createAcceptedWatermarkMeta should attach accepted decision path', () => {
    const selectedTrial = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 80, y: 80, width: 48, height: 48 },
        alphaGain: 1,
        originalSpatialScore: 0.6,
        originalGradientScore: 0.3,
        processedSpatialScore: 0.12,
        processedGradientScore: 0.05,
        improvement: 0.48,
        provenance: {},
        originalEvidence: { tier: 2 },
        residual: { cleared: true },
        damage: { safe: true, penalty: 0.02 },
        evaluation: createAlwaysPassingEvaluation()
    };

    const meta = createAcceptedWatermarkMeta({
        selectedTrial,
        selectionSource: 'standard',
        source: 'standard+edge-cleanup',
        decisionTier: 'direct-match',
        config: selectedTrial.config,
        position: selectedTrial.position,
        alphaGain: 1,
        passCount: 1,
        attemptedPassCount: 1,
        passStopReason: 'residual-low',
        passes: [{ index: 1 }],
        alphaAdjustmentStages: [{
            stage: 'known-48-edge-cleanup',
            fromAlphaGain: 1,
            toAlphaGain: 1,
            repairStrategy: 'edge-cleanup'
        }],
        processedSpatialScore: 0.08,
        processedGradientScore: 0.04,
        suppressionGain: 0.52
    });

    assert.equal(meta.applied, true);
    assert.equal(meta.decisionPath.decision, 'accept');
    assert.equal(meta.decisionPath.alphaTrial.alphaGain, 1);
    assert.equal(meta.decisionPath.repairTrial.applied, true);
    assert.equal(meta.decisionPath.repairTrial.params[0].repairStrategy, 'edge-cleanup');
    assert.equal(meta.passCount, 1);
    assert.deepEqual(meta.passes, [{ index: 1 }]);
});

test('createRejectedWatermarkMeta should attach rejected decision path', () => {
    const meta = createRejectedWatermarkMeta({
        reason: 'no-watermark-detected',
        adaptiveConfidence: 0.12,
        originalSpatialScore: 0.03,
        originalGradientScore: 0.04,
        decisionTier: 'insufficient'
    });

    assert.equal(meta.applied, false);
    assert.equal(meta.skipReason, 'no-watermark-detected');
    assert.equal(meta.detection.processedSpatialScore, 0.03);
    assert.equal(meta.detection.processedGradientScore, 0.04);
    assert.equal(meta.decisionPath.decision, 'reject');
    assert.equal(meta.decisionPath.blockedGate, 'no-watermark-detected');
    assert.equal(meta.decisionPath.evaluation.decision, 'reject');
});

test('createAcceptedWatermarkMeta should normalize best-effort selection fields', () => {
    const imageData = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    const alphaMap = new Float32Array([0.5]);
    const meta = createAcceptedWatermarkMeta({
        selectedTrial: {
            source: 'standard',
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            position: { x: 80, y: 80, width: 48, height: 48 }
        },
        source: 'standard+fine-alpha',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 80, y: 80, width: 48, height: 48 },
        bestEffort: true,
        retryRecommended: false,
        qualityStatus: 'visible-residual',
        selectionConfidence: 1.5,
        selectedCandidate: {
            id: 'candidate-2',
            family: 'geometry',
            rank: 1,
            imageData,
            alphaMap
        },
        qualitySignals: { residualVisible: true, damageWarning: false },
        candidateSummaries: [{
            id: 'candidate-2',
            family: 'geometry',
            rank: 1,
            valid: true,
            finalScore: 0.2,
            imageData,
            alphaMap
        }]
    });

    assert.equal(meta.bestEffort, true);
    assert.equal(meta.retryRecommended, false);
    assert.equal(meta.qualityStatus, 'visible-residual');
    assert.equal(meta.selectionConfidence, 1);
    assert.equal(meta.selectedCandidate.id, 'candidate-2');
    assert.equal('imageData' in meta.selectedCandidate, false);
    assert.equal('alphaMap' in meta.selectedCandidate, false);
    assert.equal(meta.candidateSummaries.length, 1);
    assert.equal('imageData' in meta.candidateSummaries[0], false);
    assert.equal('alphaMap' in meta.candidateSummaries[0], false);
});

test('attachTopNSelectionMeta should preserve existing accepted metadata', () => {
    const existing = createWatermarkMeta({
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        processedSpatialScore: 0.1,
        processedGradientScore: 0.2,
        source: 'standard+gain',
        decisionPath: { decision: 'accept' }
    });

    const attached = attachTopNSelectionMeta(existing, {
        qualityStatus: 'clean',
        selectionConfidence: 0.8,
        selectedCandidate: { id: 'candidate-1', family: 'standard', rank: 1 },
        qualitySignals: { residualVisible: false, damageWarning: false },
        candidateSummaries: [{ id: 'candidate-1', rank: 1, valid: true }]
    });

    assert.notEqual(attached, existing);
    assert.deepEqual(attached.detection, existing.detection);
    assert.deepEqual(attached.decisionPath, existing.decisionPath);
    assert.equal(attached.bestEffort, true);
    assert.equal(attached.retryRecommended, false);
    assert.equal(attached.qualityStatus, 'clean');
});

test('attachTopNSelectionMeta should reconcile phase2 decisionPath quality with final candidate state', () => {
    const staleDamage = {
        safe: true,
        penalty: 0.1,
        newlyClippedRatio: 0
    };
    const staleResidual = {
        cleared: false,
        spatial: -0.06,
        gradient: 0.05
    };
    const existing = createWatermarkMeta({
        position: { x: 576, y: 1313, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        processedSpatialScore: 0.08269753279573036,
        processedGradientScore: 0.0663245530919801,
        suppressionGain: 0.628960825889181,
        alphaGain: 0.85,
        source: 'standard+catalog+profile-alpha-rescue',
        decisionPath: {
            decision: 'accept',
            alphaTrial: {
                migrationStage: 'phase2-alpha-trial',
                scores: { suppressionGain: 0.628960825889181 },
                damage: staleDamage,
                residual: staleResidual
            }
        }
    });
    const artifacts = {
        newlyClippedRatio: 0.019965277777777776,
        visualArtifactCost: 0.117
    };
    const qualitySignals = {
        final: {
            spatialScore: 0.08269753279573036,
            gradientScore: 0.0663245530919801
        },
        artifacts,
        texture: {
            hardReject: false,
            texturePenalty: 0.04
        },
        visibility: {
            halo: { positiveDeltaLum: 2.7 }
        },
        nearBlackIncrease: 0.02
    };

    const attached = attachTopNSelectionMeta(existing, { qualitySignals });

    assert.equal(existing.decisionPath.alphaTrial.damage, staleDamage);
    assert.equal(attached.decisionPath.alphaTrial.artifacts, artifacts);
    assert.equal(
        attached.decisionPath.alphaTrial.damage.newlyClippedRatio,
        artifacts.newlyClippedRatio
    );
    assert.equal(
        attached.decisionPath.alphaTrial.residual.spatial,
        qualitySignals.final.spatialScore
    );
    assert.equal(
        attached.decisionPath.alphaTrial.residual.gradient,
        qualitySignals.final.gradientScore
    );
});

test('attachTopNSelectionMeta should reconcile ordinary phase1 alpha trial with final quality', () => {
    const legacyDamage = { safe: true, penalty: 0.02, newlyClippedRatio: 0 };
    const legacyResidual = { cleared: true, spatial: 0.01, gradient: 0.02 };
    const existing = createWatermarkMeta({
        decisionPath: {
            decision: 'accept',
            alphaTrial: {
                migrationStage: 'phase1-adapter',
                damage: legacyDamage,
                residual: legacyResidual
            }
        }
    });

    const attached = attachTopNSelectionMeta(existing, {
        qualitySignals: {
            final: { spatialScore: 0.03, gradientScore: 0.04 },
            artifacts: {
                newlyClippedRatio: 0.017361111111111112,
                visualArtifactCost: 0.1
            },
            nearBlackIncrease: 0.01,
            texture: { hardReject: false, texturePenalty: 0 }
        }
    });

    assert.notEqual(attached.decisionPath.alphaTrial.damage, legacyDamage);
    assert.notEqual(attached.decisionPath.alphaTrial.residual, legacyResidual);
    assert.equal(
        attached.decisionPath.alphaTrial.artifacts.newlyClippedRatio,
        0.017361111111111112
    );
    assert.equal(
        attached.decisionPath.alphaTrial.damage.newlyClippedRatio,
        0.017361111111111112
    );
    assert.equal(attached.decisionPath.alphaTrial.residual.spatial, 0.03);
    assert.equal(attached.decisionPath.alphaTrial.residual.gradient, 0.04);
});

test('attachTopNSelectionMeta should reconcile a phase1 alpha trial when repair changed the final pixels', () => {
    const legacyDamage = { safe: true, penalty: 0, newlyClippedRatio: 0 };
    const legacyResidual = {
        cleared: false,
        spatial: 0.15,
        gradient: 0.1
    };
    const existing = createWatermarkMeta({
        decisionPath: {
            decision: 'accept',
            alphaTrial: {
                migrationStage: 'phase1-adapter',
                scores: {
                    processedSpatial: 0.08,
                    processedGradient: 0.03,
                    suppressionGain: 0.6
                },
                damage: legacyDamage,
                residual: legacyResidual
            },
            repairTrial: {
                applied: true,
                repairType: 'edge-cleanup'
            }
        }
    });
    const artifacts = {
        newlyClippedRatio: 0.008,
        visualArtifactCost: 0.04
    };

    const attached = attachTopNSelectionMeta(existing, {
        qualitySignals: {
            final: {
                spatialScore: 0.08,
                gradientScore: 0.03
            },
            artifacts,
            texture: {
                hardReject: false,
                texturePenalty: 0.01
            },
            nearBlackIncrease: 0.005
        }
    });

    assert.equal(attached.decisionPath.alphaTrial.artifacts, artifacts);
    assert.equal(
        attached.decisionPath.alphaTrial.damage.newlyClippedRatio,
        artifacts.newlyClippedRatio
    );
    assert.equal(attached.decisionPath.alphaTrial.residual.spatial, 0.08);
    assert.equal(attached.decisionPath.alphaTrial.residual.gradient, 0.03);
});

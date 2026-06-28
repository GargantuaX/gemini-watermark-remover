import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyOutputResidualGate,
    createOutputResidualGateReport,
    findScoreByCandidateId,
    resolveVideoOutputResidualExitCode
} from '../../scripts/score-video-output-residual.js';

test('findScoreByCandidateId should return the fixed anchor score from a report', () => {
    const score = findScoreByCandidateId({
        catalogScores: [
            { candidateId: 'veo-720p-2-compact', meanConfidence: 0.12 },
            { candidateId: 'veo-720p-3-inset', meanConfidence: 0.0182 }
        ]
    }, 'veo-720p-3-inset');

    assert.equal(score.candidateId, 'veo-720p-3-inset');
    assert.equal(score.meanConfidence, 0.0182);
});

test('classifyOutputResidualGate should pass strongly reduced fixed-anchor residuals', () => {
    const result = classifyOutputResidualGate({
        originalScore: { candidateId: 'veo-720p-3-inset', meanConfidence: 0.7283 },
        currentScore: { candidateId: 'veo-720p-3-inset', meanConfidence: 0.0182 }
    });

    assert.deepEqual(result, {
        action: 'pass',
        reason: 'fixed-anchor-residual-low',
        candidateId: 'veo-720p-3-inset',
        originalMeanConfidence: 0.7283,
        currentMeanConfidence: 0.0182,
        reductionRatio: 0.975010298,
        maxAllowedConfidence: 0.08,
        minReductionRatio: 0.75
    });
});

test('classifyOutputResidualGate should require review for visible fixed-anchor residuals', () => {
    const result = classifyOutputResidualGate({
        originalScore: { candidateId: 'veo-720p-3-inset', meanConfidence: 0.75 },
        currentScore: { candidateId: 'veo-720p-3-inset', meanConfidence: 0.1877 }
    });

    assert.equal(result.action, 'needs-review');
    assert.equal(result.reason, 'fixed-anchor-residual-above-pass-threshold');
    assert.equal(result.candidateId, 'veo-720p-3-inset');
});

test('createOutputResidualGateReport should ignore off-anchor output grid hits', () => {
    const report = createOutputResidualGateReport({
        originalReport: {
            inputPath: 'original.mp4',
            outputPath: 'original-score.json',
            catalogScores: [
                { candidateId: 'veo-720p-3-inset', meanConfidence: 0.7283, size: 48, marginRight: 96, marginBottom: 96 }
            ],
            gridSearch: {
                topCandidates: [
                    { size: 48, marginRight: 96, marginBottom: 96, meanConfidence: 0.727 }
                ]
            },
            recommendation: { action: 'catalog-ok' }
        },
        currentReport: {
            inputPath: 'current.mp4',
            outputPath: 'current-score.json',
            catalogScores: [
                { candidateId: 'veo-720p-2-compact', meanConfidence: 0.1132 },
                { candidateId: 'veo-720p-3-inset', meanConfidence: 0.0182, size: 48, marginRight: 96, marginBottom: 96 }
            ],
            gridSearch: {
                topCandidates: [
                    { size: 36, marginRight: 32, marginBottom: 128, meanConfidence: 0.2144 }
                ]
            },
            recommendation: { action: 'catalog-gap' }
        }
    });

    assert.equal(report.fixedAnchor.candidateId, 'veo-720p-3-inset');
    assert.equal(report.verdict.action, 'pass');
    assert.equal(report.currentBestGridIgnoredForVerdict.marginRight, 32);
});

test('createOutputResidualGateReport should use confident Veo text detections as the fixed anchor', () => {
    const report = createOutputResidualGateReport({
        originalReport: {
            inputPath: 'original.mp4',
            outputPath: 'original-score.json',
            selectedWatermarkKind: 'veo-text',
            selectedDetection: {
                watermarkKind: 'veo-text',
                isConfident: true,
                templateId: 'veo-text-23x10',
                best: {
                    candidateId: 'veo-text-23x10:682:1254',
                    meanNcc: 0.7556
                }
            },
            catalogScores: [
                { candidateId: 'veo-1080p-standard', meanConfidence: 0.0883 }
            ]
        },
        currentReport: {
            inputPath: 'current.mp4',
            outputPath: 'current-score.json',
            selectedWatermarkKind: 'diamond',
            selectedDetection: {
                watermarkKind: 'diamond',
                isConfident: false,
                alternatives: {
                    veoTextCandidates: [
                        {
                            candidateId: 'veo-text-23x10:657:1245',
                            meanNcc: 0.105
                        },
                        {
                            candidateId: 'veo-text-23x10:682:1254',
                            templateId: 'veo-text-23x10',
                            meanNcc: 0.041
                        }
                    ]
                }
            },
            catalogScores: [
                { candidateId: 'veo-1080p-standard', meanConfidence: 0.0719 }
            ]
        },
        thresholds: {
            maxAllowedConfidence: 0.08,
            minReductionRatio: 0.75,
            minOriginalConfidence: 0.18
        }
    });

    assert.equal(report.fixedAnchor.watermarkKind, 'veo-text');
    assert.equal(report.fixedAnchor.candidateId, 'veo-text-23x10:682:1254');
    assert.equal(report.verdict.action, 'pass');
    assert.equal(report.verdict.originalMeanConfidence, 0.7556);
    assert.equal(report.verdict.currentMeanConfidence, 0.041);
});

test('createOutputResidualGateReport should ignore weak incidental Veo text detections', () => {
    const report = createOutputResidualGateReport({
        originalReport: {
            selectedDetection: {
                watermarkKind: 'diamond',
                alternatives: {
                    veoTextCandidates: [
                        {
                            candidateId: 'veo-text-68x30:1174:649',
                            templateId: 'veo-text-68x30',
                            meanNcc: 0.078,
                            isConfident: false
                        }
                    ]
                }
            },
            catalogScores: [
                { candidateId: 'veo-720p-3-inset', meanConfidence: 0.813 }
            ]
        },
        currentReport: {
            selectedDetection: {
                watermarkKind: 'diamond',
                alternatives: {
                    veoTextCandidates: [
                        {
                            candidateId: 'veo-text-68x30:1174:649',
                            templateId: 'veo-text-68x30',
                            meanNcc: 0.052,
                            isConfident: false
                        }
                    ]
                }
            },
            catalogScores: [
                { candidateId: 'veo-720p-3-inset', meanConfidence: 0.014 }
            ]
        }
    });

    assert.equal(report.fixedAnchor.watermarkKind, 'diamond');
    assert.equal(report.fixedAnchor.candidateId, 'veo-720p-3-inset');
    assert.equal(report.verdict.action, 'pass');
});

test('createOutputResidualGateReport should honor explicit Veo text candidate ids', () => {
    const report = createOutputResidualGateReport({
        candidateId: 'veo-text-23x10:682:1254',
        originalReport: {
            selectedWatermarkKind: 'veo-text',
            selectedDetection: {
                watermarkKind: 'veo-text',
                isConfident: true,
                templateId: 'veo-text-23x10',
                best: {
                    candidateId: 'veo-text-23x10:682:1254',
                    meanNcc: 0.7556
                }
            }
        },
        currentReport: {
            selectedWatermarkKind: 'diamond',
            selectedDetection: {
                watermarkKind: 'diamond',
                alternatives: {
                    veoTextCandidates: [
                        {
                            candidateId: 'veo-text-23x10:682:1254',
                            templateId: 'veo-text-23x10',
                            meanNcc: 0.041
                        }
                    ]
                }
            }
        }
    });

    assert.equal(report.fixedAnchor.watermarkKind, 'veo-text');
    assert.equal(report.verdict.action, 'pass');
});

test('resolveVideoOutputResidualExitCode should fail only when requested and verdict is not pass', () => {
    assert.equal(resolveVideoOutputResidualExitCode({ verdict: { action: 'pass' } }, { failOnResidual: true }), 0);
    assert.equal(resolveVideoOutputResidualExitCode({ verdict: { action: 'needs-review' } }, { failOnResidual: true }), 1);
    assert.equal(resolveVideoOutputResidualExitCode({ verdict: { action: 'needs-review' } }, { failOnResidual: false }), 0);
});

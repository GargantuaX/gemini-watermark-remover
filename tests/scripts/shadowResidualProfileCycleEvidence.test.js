import assert from 'node:assert/strict';
import test from 'node:test';

import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import {
    processShadowResidualProfileRecord,
    resolveProfileBank
} from '../../scripts/run-shadow-residual-profile-ensemble-cli.js';
import { compositeKnownWatermark } from '../../scripts/synthetic-residual-ground-truth.js';

function createFlatImageData(width, height, value = 100) {
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

test('records normalized recomposition evidence without changing a production decision', async () => {
    const truth = createFlatImageData(64, 64);
    const alphaMap = getEmbeddedAlphaMap(48);
    const position = { x: 8, y: 8, width: 48, height: 48 };
    const watermarked = compositeKnownWatermark({
        truthImageData: truth,
        alphaMap,
        position
    });
    const record = {
        sourceReport: 'synthetic-report.json',
        resultIndex: 0,
        fileName: 'synthetic.png',
        filePath: 'synthetic.png',
        width: 64,
        height: 64,
        position,
        residualVisibility: {
            rawVisible: true,
            calibratedVisible: false
        },
        historicalResidualVisibility: {
            rawVisible: true,
            calibratedVisible: false
        },
        historicalVisibilitySource: 'residualVisibility'
    };

    const result = await processShadowResidualProfileRecord(record, {
        decodeImageData: async () => watermarked,
        processImageData: () => ({
            imageData: truth,
            meta: {
                applied: true,
                position,
                alphaGain: 1,
                decisionPath: {
                    detectionCandidate: {
                        polarityHint: 'white'
                    },
                    alphaTrial: {
                        artifacts: {
                            spatialScore: 0.5,
                            gradientScore: 0.5,
                            weightedRecomposeError: 0.125
                        }
                    }
                },
                detection: {
                    residualVisibility: {
                        rawVisible: false,
                        calibratedVisible: false
                    }
                }
            }
        })
    });

    assert.equal(result.recomposition.status, 'complete');
    assert.equal(result.recomposition.best.profile, '48-default');
    assert.equal(result.recomposition.best.normalizedRmse, 0);
    assert.equal(result.recomposition.best.signedTemplateAmplitude, 0);
    assert.equal(result.recomposition.best.normalizedOrthogonalError, 0);
    assert.equal(result.recomposition.best.decompositionStatus, 'complete');
    assert.equal(result.alphaEdgeEvidence.status, 'complete');
    assert.equal(result.alphaEdgeEvidence.profile, '48-default');
    assert.equal(
        result.alphaEdgeEvidence.role,
        'research-diagnostic-only'
    );
    assert.equal(
        result.alphaEdgeEvidence.validationStatus,
        'rejected-heldout'
    );
    assert.equal(result.alphaEdgeEvidence.edgeWeightedMean, 0);
    assert.equal(result.alphaEdgeEvidence.edgeDecoyRatio, null);
    assert.equal(result.alphaEdgeEvidence.gridPercentile, null);
    assert.equal(result.alphaEdgeEvidence.productionDecisionChanged, false);
    assert.deepEqual(result.selectedCandidateEvidence, {
        templateArtifact: 0.0625,
        underRemoval: 0.0625,
        overRemoval: 0,
        spatialPolarity: 'positive',
        source: 'selected-alpha-trial-artifacts'
    });
    assert.equal(result.productionDecisionChanged, false);
});

test('reports null selected candidate evidence when replay errors', async () => {
    const truth = createFlatImageData(64, 64);
    const result = await processShadowResidualProfileRecord(
        {
            sourceReport: 'synthetic-report.json',
            resultIndex: 1,
            fileName: 'synthetic-error.png',
            filePath: 'synthetic-error.png'
        },
        {
            decodeImageData: async () => truth,
            processImageData: () => {
                throw new Error('synthetic replay failure');
            }
        }
    );

    assert.equal(result.replay.status, 'error');
    assert.equal(result.selectedCandidateEvidence, null);
    assert.equal(result.alphaEdgeEvidence, null);
});

test('supports only the evidenced 36px projection while leaving 38/60 unsupported', () => {
    const projected = resolveProfileBank({
        position: { x: 0, y: 0, width: 36, height: 36 },
        polarity: 'white'
    });
    assert.equal(projected.geometrySupport, 'supported');
    assert.equal(projected.reason, null);
    assert.deepEqual(
        projected.profiles.map((profile) => profile.name),
        ['36-projected-48']
    );
    assert.equal(projected.profiles[0].alphaMap.length, 36 * 36);

    for (const size of [38, 60]) {
        const unsupported = resolveProfileBank({
            position: { x: 0, y: 0, width: size, height: size },
            polarity: 'white'
        });
        assert.equal(unsupported.geometrySupport, 'unsupported');
        assert.equal(unsupported.reason, 'unsupported-geometry');
        assert.deepEqual(unsupported.profiles, []);
    }
});

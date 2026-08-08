import test from 'node:test';
import assert from 'node:assert/strict';

import { runCandidateHypothesis } from '../../src/core/pipelineCandidateRunner.js';

function createImageData(width, height, value = 120) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
    }
    return { width, height, data };
}

test('runCandidateHypothesis should materialize and finalize one isolated candidate', () => {
    const originalImageData = createImageData(8, 8);
    const originalPixels = new Uint8ClampedArray(originalImageData.data);
    const alphaMap = new Float32Array([0.2, 0.4, 0.4, 0.2]);
    const position = { x: 4, y: 4, width: 2, height: 2 };
    const config = { logoSize: 2, marginRight: 2, marginBottom: 2 };
    const hypothesis = {
        id: 'candidate-one',
        family: 'standard',
        rankingKey: [0, 0, 0, 0, 0, 0],
        trial: {
            source: 'standard',
            config,
            position,
            alphaMap,
            alphaGain: 1,
            originalSpatialScore: 0.8,
            originalGradientScore: 0.7,
            imageData: createImageData(8, 8, 1)
        }
    };
    const calls = [];
    let clock = 10;

    const output = runCandidateHypothesis({
        hypothesis,
        originalImageData,
        resolvedConfig: config,
        options: {},
        nowMs: () => clock++,
        alpha96: null,
        cleanupConfig: {},
        createAcceptedPipelineDependencies: () => ({
            metrics: {},
            gates: {},
            config: {},
            refiners: {}
        }),
        materializeCandidate: (trial, original) => {
            calls.push({ type: 'materialize', trial, original });
            return {
                ...trial,
                imageData: {
                    width: original.width,
                    height: original.height,
                    data: new Uint8ClampedArray(original.data)
                }
            };
        },
        runAcceptedPipeline: (request) => {
            calls.push({ type: 'execute', request });
            return {
                passState: request.passState,
                subpixelShift: null,
                readPipelineState: request.runtimeBootstrap.readPipelineState
            };
        },
        createAcceptedFinalResult: (request) => {
            calls.push({ type: 'finalize', request });
            return {
                imageData: request.pipelineState.finalImageData,
                meta: { applied: true, source: request.pipelineState.source }
            };
        }
    });

    assert.deepEqual(calls.map((item) => item.type), [
        'materialize',
        'execute',
        'finalize'
    ]);
    assert.equal(calls[0].original, originalImageData);
    assert.equal(calls[1].request.freezeSelectedTrial, false);
    assert.equal(calls[2].request.allowFailClosed, false);
    assert.notEqual(output.result.imageData, originalImageData);
    assert.deepEqual(originalImageData.data, originalPixels);
    assert.equal(output.hypothesis, hypothesis);
    assert.ok(output.elapsedMs >= 0);
});

test('runCandidateHypothesis should freeze a source-witness rescue before repair searches', () => {
    const originalImageData = createImageData(8, 8);
    let capturedRequest = null;
    const trial = {
        source: 'standard+catalog+source-witness-rescue',
        config: { logoSize: 2, marginRight: 2, marginBottom: 2 },
        position: { x: 4, y: 4, width: 2, height: 2 },
        alphaMap: new Float32Array([0.2, 0.4, 0.4, 0.2]),
        alphaGain: 0.6,
        provenance: { sourceWitnessRescue: true },
        imageData: createImageData(8, 8, 110)
    };

    runCandidateHypothesis({
        hypothesis: {
            id: 'source-witness',
            family: 'alpha',
            rankingKey: [0],
            trial
        },
        originalImageData,
        resolvedConfig: trial.config,
        createAcceptedPipelineDependencies: () => ({
            metrics: {}, gates: {}, config: {}, refiners: {}
        }),
        materializeCandidate: () => trial,
        runAcceptedPipeline: (request) => {
            capturedRequest = request;
            return {
                passState: request.passState,
                subpixelShift: null,
                readPipelineState:
                    request.runtimeBootstrap.readPipelineState
            };
        },
        createAcceptedFinalResult: (request) => ({
            imageData: request.pipelineState.finalImageData,
            meta: { applied: true }
        })
    });

    assert.equal(capturedRequest.freezeSelectedTrial, true);
});

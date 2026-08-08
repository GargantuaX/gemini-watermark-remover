import test from 'node:test';
import assert from 'node:assert/strict';

import { createAcceptedPipelineExecutorRequest } from '../../src/core/pipelineAcceptedExecutorRequest.js';

test('createAcceptedPipelineExecutorRequest should map runtime context and injected dependencies', () => {
    const nowMs = () => 123;
    const passState = { passCount: 1 };
    const runtimeBootstrap = { passState };
    const pipelineTraceRecorder = { alphaAdjustmentStages: [] };
    const debugTimings = {};
    const getAlphaMap = () => 'alpha-map';
    const alpha96Variants = [{ source: 'variant' }];
    const metrics = { createRegionCorrelationMetrics: () => ({}) };
    const gates = { shouldRecalibrateAlphaStrength: () => false };
    const config = { maxNearBlackRatioIncrease: 0.05 };
    const refiners = { refineSubpixelOutline: () => null };

    const request = createAcceptedPipelineExecutorRequest({
        nowMs,
        options: {
            getAlphaMap,
            alpha96Variants,
            locatedAggressiveRemoval: true
        },
        totalStartedAt: 100,
        runtimeBootstrap,
        pipelineTraceRecorder,
        originalImageData: { width: 10, height: 10 },
        alpha96: 'alpha-96',
        debugTimings,
        debugTimingsEnabled: true,
        visualPostProcessingEnabled: false,
        templateWarp: { dx: 1 },
        subpixelShift: { dx: 0.25 },
        freezeSelectedTrial: true,
        acceptedPipelineDependencies: {
            metrics,
            gates,
            config,
            refiners
        }
    });

    assert.equal(request.nowMs, nowMs);
    assert.equal(request.totalStartedAt, 100);
    assert.equal(request.runtimeBootstrap, runtimeBootstrap);
    assert.equal(request.pipelineTraceRecorder, pipelineTraceRecorder);
    assert.deepEqual(request.originalImageData, { width: 10, height: 10 });
    assert.equal(request.alpha96, 'alpha-96');
    assert.equal(request.getAlphaMap, getAlphaMap);
    assert.equal(request.alpha96Variants, alpha96Variants);
    assert.equal(request.locatedAggressiveRemoval, true);
    assert.equal(request.debugTimings, debugTimings);
    assert.equal(request.debugTimingsEnabled, true);
    assert.equal(request.visualPostProcessingEnabled, false);
    assert.deepEqual(request.templateWarp, { dx: 1 });
    assert.deepEqual(request.subpixelShift, { dx: 0.25 });
    assert.equal(request.freezeSelectedTrial, true);
    assert.equal(request.passState, passState);
    assert.equal(request.metrics, metrics);
    assert.equal(request.gates, gates);
    assert.equal(request.config, config);
    assert.equal(request.refiners, refiners);
});

test('createAcceptedPipelineExecutorRequest should normalize missing alpha variants to null', () => {
    const request = createAcceptedPipelineExecutorRequest({
        runtimeBootstrap: { passState: {} },
        acceptedPipelineDependencies: {
            metrics: {},
            gates: {},
            config: {},
            refiners: {}
        }
    });

    assert.equal(request.alpha96Variants, null);
    assert.equal(request.freezeSelectedTrial, false);
});

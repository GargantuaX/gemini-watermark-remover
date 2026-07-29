import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAlphaTraceContractSummary,
    normalizeAlphaAdjustmentStageForTrace,
    normalizeAlphaTrialEventForTrace
} from '../../src/core/pipelineAlphaTraceContract.js';

test('normalizeAlphaTrialEventForTrace should preserve object events verbatim', () => {
    const event = {
        stage: 'located-aggressive-removal',
        strategy: 'located-aggressive-alpha',
        decision: 'reject',
        blockedGate: 'passable-spatial-drift'
    };

    assert.equal(normalizeAlphaTrialEventForTrace(null), null);
    assert.equal(normalizeAlphaTrialEventForTrace('bad'), null);
    assert.equal(normalizeAlphaTrialEventForTrace(event), event);
});

test('normalizeAlphaAdjustmentStageForTrace should normalize stage fields and gates', () => {
    assert.equal(normalizeAlphaAdjustmentStageForTrace(null), null);
    assert.equal(normalizeAlphaAdjustmentStageForTrace({
        stage: 'same-alpha-without-allow',
        fromAlphaGain: 1,
        toAlphaGain: 1
    }), null);

    assert.deepEqual(normalizeAlphaAdjustmentStageForTrace({
        stage: 'known-48-luma-edge-correction',
        fromAlphaGain: 1,
        toAlphaGain: 1,
        beforeSpatialScore: 0.2,
        beforeGradientScore: Number.NaN,
        afterSpatialScore: 0.1,
        afterGradientScore: 0.05,
        suppressionGain: 0.1,
        cost: 0.03,
        profileExponent: Infinity,
        alphaStrategy: '',
        repairStrategy: 'luma-edge',
        allowSameAlphaGain: true
    }), {
        stage: 'known-48-luma-edge-correction',
        fromAlphaGain: 1,
        toAlphaGain: 1,
        beforeSpatialScore: 0.2,
        beforeGradientScore: null,
        afterSpatialScore: 0.1,
        afterGradientScore: 0.05,
        suppressionGain: 0.1,
        cost: 0.03,
        profileExponent: null,
        alphaStrategy: null,
        repairStrategy: 'luma-edge'
    });
});

test('normalizeAlphaAdjustmentStageForTrace should preserve stage extras without leaking internal gates', () => {
    const localSearchTrigger = {
        reason: 'damage-warning',
        newlyClippedRatio: 0.019965277777777776
    };
    const normalized = normalizeAlphaAdjustmentStageForTrace({
        stage: 'evidence-gated-local-alpha-search',
        fromAlphaGain: 1,
        toAlphaGain: 0.85,
        alphaStrategy: 'evidence-gated-local-alpha',
        localSearchTrigger,
        evaluatedCandidateCount: 7,
        allowSameAlphaGain: true
    });

    assert.equal(normalized.localSearchTrigger, localSearchTrigger);
    assert.equal(normalized.evaluatedCandidateCount, 7);
    assert.equal('allowSameAlphaGain' in normalized, false);
});

test('createAlphaTraceContractSummary should expose trace counts', () => {
    assert.deepEqual(createAlphaTraceContractSummary({
        alphaAdjustmentStages: [{ stage: 'fine-alpha' }],
        alphaTrialEvents: [{ decision: 'accept' }, { decision: 'reject' }]
    }), {
        alphaAdjustmentStageCount: 1,
        alphaTrialEventCount: 2,
        hasAlphaAdjustments: true,
        hasAlphaTrialEvents: true
    });
});

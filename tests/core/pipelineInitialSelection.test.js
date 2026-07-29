import test from 'node:test';
import assert from 'node:assert/strict';

import {
    collectInitialWatermarkCandidates,
    selectInitialWatermarkCandidate
} from '../../src/core/pipelineInitialSelection.js';

function createBaseInput(selectCandidate) {
    return {
        originalImageData: { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4) },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alpha48: new Float32Array(48 * 48),
        alpha96: new Float32Array(96 * 96),
        alphaGainCandidates: [1],
        alphaPriorityGains: [1],
        selectCandidate
    };
}

test('selectInitialWatermarkCandidate should keep the first selected standard candidate', () => {
    const calls = [];
    const selectedTrial = { id: 'standard-trial' };
    const result = selectInitialWatermarkCandidate(createBaseInput((args) => {
        calls.push(args);
        return {
            selectedTrial,
            source: 'standard',
            decisionTier: 'direct-match'
        };
    }));

    assert.equal(result.selectedTrial, selectedTrial);
    assert.equal(result.source, 'standard');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].allowAutomaticSearch, false);
});

test('selectInitialWatermarkCandidate should use aggressive located fallback when standard selection skips', () => {
    const calls = [];
    const selectedTrial = {
        id: 'aggressive-trial',
        processedSpatialScore: 0.08,
        nearBlackIncrease: 0.01,
        nearWhiteIncrease: 0.01,
        damage: { safe: true }
    };
    const result = selectInitialWatermarkCandidate(createBaseInput((args) => {
        calls.push(args);
        return calls.length === 1
            ? { selectedTrial: null, source: 'skipped', decisionTier: 'insufficient' }
            : { selectedTrial, source: 'located', decisionTier: null };
    }));

    assert.equal(result.selectedTrial, selectedTrial);
    assert.equal(result.source, 'located+aggressive-located');
    assert.equal(result.decisionTier, 'direct-match');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].allowAutomaticSearch, true);
    assert.equal(calls[1].allowAggressiveStrongLocated, true);
});

test('selectInitialWatermarkCandidate should reject aggressive fallback polarity overshoot', () => {
    const calls = [];
    const skipped = { selectedTrial: null, source: 'skipped', decisionTier: 'insufficient' };
    const result = selectInitialWatermarkCandidate(createBaseInput(() => {
        calls.push(true);
        return calls.length === 1 ? skipped : {
            selectedTrial: {
                processedSpatialScore: -0.9,
                nearBlackIncrease: 0,
                nearWhiteIncrease: 0.2,
                damage: { safe: true }
            },
            source: 'located',
            decisionTier: 'validated-match'
        };
    }));

    assert.equal(result.selectedTrial, null);
    assert.equal(result.source, 'skipped');
    assert.equal(calls.length, 2);
});

test('selectInitialWatermarkCandidate should respect disabled aggressive fallback', () => {
    const calls = [];
    const result = selectInitialWatermarkCandidate({
        ...createBaseInput((args) => {
            calls.push(args);
            return { selectedTrial: null, source: 'skipped', decisionTier: 'insufficient' };
        }),
        aggressiveLocatedFallback: false
    });

    assert.equal(result.selectedTrial, null);
    assert.equal(result.source, 'skipped');
    assert.equal(calls.length, 1);
});

test('collectInitialWatermarkCandidates should retain fixed and unsafe aggressive hypotheses', () => {
    const calls = [];
    const createTrial = (source, x, overrides = {}) => ({
        source,
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 1,
        rankingKey: [x, 0, 0, 0, 0, 0],
        provenance: {},
        ...overrides
    });
    const standard = createTrial('standard', 20);
    const outline = createTrial('standard+outline-dark', 30, {
        provenance: { outlineDark: true }
    });
    const adaptive = createTrial('adaptive', 40, {
        provenance: { adaptive: true }
    });
    const aggressive = createTrial('adaptive+aggressive-located', 50, {
        processedSpatialScore: -0.9,
        nearWhiteIncrease: 0.2,
        damage: { safe: false }
    });

    const result = collectInitialWatermarkCandidates(createBaseInput((args) => {
        calls.push(args);
        return args.allowAutomaticSearch
            ? {
                selectedTrial: aggressive,
                candidatePool: [adaptive, aggressive],
                source: aggressive.source
            }
            : {
                selectedTrial: standard,
                candidatePool: [standard, outline],
                source: standard.source
            };
    }));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].allowAutomaticSearch, false);
    assert.equal(calls[1].allowAutomaticSearch, true);
    assert.equal(calls[1].allowAggressiveStrongLocated, true);
    assert.deepEqual(result.hypotheses.map((item) => item.family).sort(), [
        'aggressive',
        'alpha',
        'geometry',
        'polarity',
        'standard'
    ]);
    assert.ok(result.hypotheses.some((item) => item.trial === aggressive));
    assert.ok(result.hypotheses.some((item) => item.trial === standard));
    assert.ok(result.hypotheses.some((item) => (
        item.family === 'alpha' &&
        item.alphaGain <= 0.5 &&
        item.trial.provenance?.topNConservative === true
    )));
});

test('collectInitialWatermarkCandidates should retain conservative alpha trials for fixed and automatic anchors', () => {
    const alphaMap = new Float32Array(48 * 48).fill(0.2);
    const createTrial = (source, x, provenance = {}) => ({
        source,
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x, y: 20, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        rankingKey: [x, 0, 0, 0, 0, 0],
        provenance
    });
    const fixed = createTrial('standard', 20);
    const automatic = createTrial('adaptive', 40, { adaptive: true });

    const result = collectInitialWatermarkCandidates(createBaseInput((args) => (
        args.allowAutomaticSearch
            ? { selectedTrial: automatic, candidatePool: [automatic] }
            : { selectedTrial: fixed, candidatePool: [fixed] }
    )));

    const conservative = result.hypotheses.filter((item) => (
        item.family === 'alpha' &&
        item.alphaGain <= 0.5 &&
        item.trial.provenance?.topNConservative === true
    ));
    assert.deepEqual(conservative
        .map((item) => ({ x: item.position.x, alphaGain: item.alphaGain }))
        .sort((left, right) => left.x - right.x), [
        { x: 20, alphaGain: 0.5 },
        { x: 40, alphaGain: 0.25 }
    ]);
});

test('collectInitialWatermarkCandidates should relax all alternatives when automatic selection falls back to aggressive', () => {
    const alphaMap = new Float32Array(48 * 48).fill(0.2);
    const standardAlternative = {
        source: 'standard+catalog',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 4, y: 20, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: {}
    };
    const aggressive = {
        source: 'adaptive+aggressive-located',
        config: { logoSize: 48, marginRight: 16, marginBottom: 48 },
        position: { x: 36, y: 20, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        rankingKey: [1, 0, 0, 0, 0, 0],
        provenance: { adaptive: true }
    };
    const polarityAlternative = {
        source: 'standard+outline-dark',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 12, y: 20, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        rankingKey: [0, 1, 0, 0, 0, 0],
        provenance: { outlineDark: true }
    };

    const result = collectInitialWatermarkCandidates(createBaseInput((args) => (
        args.allowAutomaticSearch
            ? {
                selectedTrial: aggressive,
                candidatePool: [standardAlternative, polarityAlternative, aggressive]
            }
            : {
                selectedTrial: null,
                candidatePool: [standardAlternative, polarityAlternative]
            }
    )));

    const retainedStandard = result.hypotheses.find((item) => item.trial === standardAlternative);
    const retainedPolarity = result.hypotheses.find((item) => item.trial === polarityAlternative);
    assert.equal(retainedStandard?.family, 'standard');
    assert.equal(retainedPolarity?.family, 'polarity');
    assert.equal(retainedStandard?.discoveryRole, 'aggressive-fallback-alternative');
    assert.equal(retainedPolarity?.discoveryRole, 'aggressive-fallback-alternative');
});

test('collectInitialWatermarkCandidates should not introduce automatic geometry when adaptive search is disabled', () => {
    const calls = [];
    const fixed = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 1,
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: {}
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput((args) => {
            calls.push(args);
            return { selectedTrial: fixed, candidatePool: [fixed] };
        }),
        allowAdaptiveSearch: false
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].allowAutomaticSearch, false);
    assert.equal(result.hypotheses.some((item) => item.family === 'geometry'), false);
    assert.equal(result.hypotheses.some((item) => item.family === 'aggressive'), false);
});

test('collectInitialWatermarkCandidates should not promote diagnostic trials when no selector confirms a target', () => {
    const rejected = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 1,
        accepted: false,
        evaluation: { eligible: false },
        originalEvidence: { tier: 'none' },
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: {}
    };

    const result = collectInitialWatermarkCandidates(createBaseInput(() => ({
        selectedTrial: null,
        candidatePool: [rejected],
        source: 'skipped',
        decisionTier: 'insufficient'
    })));

    assert.equal(result.presenceConfirmed, false);
    assert.deepEqual(result.hypotheses, []);
});

test('collectInitialWatermarkCandidates should keep selector-confirmed best effort even when restoration is unsafe', () => {
    const selected = {
        source: 'standard+preview-anchor+aggressive-located',
        config: { logoSize: 24, marginRight: 15, marginBottom: 15 },
        position: { x: 61, y: 61, width: 24, height: 24 },
        alphaMap: new Float32Array(24 * 24).fill(0.2),
        alphaGain: 1,
        accepted: false,
        evaluation: { eligible: false },
        originalSpatialScore: 0.34,
        originalGradientScore: 0.22,
        originalEvidence: { tier: 'strong' },
        damage: { safe: false },
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: { previewAnchor: true }
    };

    const result = collectInitialWatermarkCandidates(createBaseInput(() => ({
        selectedTrial: selected,
        candidatePool: [selected],
        source: selected.source,
        decisionTier: 'direct-match'
    })));

    assert.equal(result.presenceConfirmed, true);
    assert.ok(result.hypotheses.some((hypothesis) => hypothesis.trial === selected));
});

test('collectInitialWatermarkCandidates should not trust a weak aggressive label after restoration rejection', () => {
    const weakAggressive = {
        source: 'standard+aggressive-located',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 1,
        accepted: false,
        evaluation: { eligible: false },
        originalSpatialScore: 0.25,
        originalGradientScore: 0.03,
        originalEvidence: { tier: 'medium' },
        damage: { safe: false },
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: {}
    };

    const result = collectInitialWatermarkCandidates(createBaseInput(() => ({
        selectedTrial: weakAggressive,
        candidatePool: [weakAggressive],
        source: weakAggressive.source,
        decisionTier: 'direct-match'
    })));

    assert.equal(result.presenceConfirmed, false);
    assert.deepEqual(result.hypotheses, []);
});

test('collectInitialWatermarkCandidates should retain a safe validated match as unconfirmed best effort', () => {
    const weakValidated = {
        source: 'standard+catalog+gain+validated',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 0.25,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.35,
        originalGradientScore: 0.08,
        processedSpatialScore: 0.19,
        processedGradientScore: 0.1,
        residual: { cleared: false },
        originalEvidence: { tier: 'medium' },
        damage: { safe: true },
        rankingKey: [1, 0, 0, 0, 0, 0],
        provenance: { catalogVariant: true }
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: weakValidated,
            candidatePool: [weakValidated],
            source: weakValidated.source,
            decisionTier: 'validated-match'
        })),
        allowAdaptiveSearch: false
    });

    assert.equal(result.presenceConfirmed, false);
    assert.equal(result.bestEffortFallback, true);
    assert.equal(result.bestEffortReason, 'presence-witness-unconfirmed');

    const fallback = result.hypotheses.find((hypothesis) => (
        hypothesis.position.x === weakValidated.position.x &&
        hypothesis.position.y === weakValidated.position.y &&
        hypothesis.position.width === weakValidated.position.width
    ));
    assert.ok(fallback);
    assert.ok(fallback.alphaGain <= weakValidated.alphaGain);
});

test('collectInitialWatermarkCandidates should drop a no-effect conservative best-effort trial', () => {
    const originalImageData = {
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(100 * 100 * 4)
    };
    for (let offset = 0; offset < originalImageData.data.length; offset += 4) {
        originalImageData.data[offset] = 250;
        originalImageData.data[offset + 1] = 250;
        originalImageData.data[offset + 2] = 250;
        originalImageData.data[offset + 3] = 255;
    }
    const selectedTrial = {
        source: 'standard+preview-anchor+validated',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 1,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.16,
        originalGradientScore: 0.05,
        processedSpatialScore: 0.01,
        processedGradientScore: 0.08,
        residual: { cleared: false },
        damage: { safe: true },
        rankingKey: [1, 0, 0, 0, 0, 0],
        provenance: { previewAnchor: true }
    };
    const input = createBaseInput(() => ({
        selectedTrial,
        candidatePool: [selectedTrial],
        source: selectedTrial.source,
        decisionTier: 'validated-match'
    }));

    const result = collectInitialWatermarkCandidates({
        ...input,
        originalImageData,
        allowAdaptiveSearch: false
    });

    assert.equal(result.bestEffortFallback, true);
    assert.ok(result.hypotheses.some((hypothesis) => hypothesis.trial === selectedTrial));
    assert.equal(result.hypotheses.some((hypothesis) => (
        hypothesis.trial?.provenance?.topNConservative === true
    )), false);
});

test('collectInitialWatermarkCandidates should keep a cleared medium-evidence validated match', () => {
    const clearedValidated = {
        source: 'standard+catalog+gain+validated',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 0.55,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.18,
        originalGradientScore: 0.27,
        processedSpatialScore: 0.03,
        processedGradientScore: 0.07,
        residual: { cleared: true },
        originalEvidence: { tier: 'medium' },
        damage: { safe: true },
        rankingKey: [1, 0, 0, 0, 0, 0],
        provenance: { catalogVariant: true }
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: clearedValidated,
            candidatePool: [clearedValidated],
            source: clearedValidated.source,
            decisionTier: 'validated-match'
        })),
        allowAdaptiveSearch: false
    });

    assert.equal(result.presenceConfirmed, true);
    assert.ok(result.hypotheses.some((hypothesis) => hypothesis.trial === clearedValidated));
});

test('collectInitialWatermarkCandidates should accept cleared restoration when repeated texture weakens localization', () => {
    const width = 160;
    const height = 160;
    const data = new Uint8ClampedArray(width * height * 4);
    const alphaMap = new Float32Array(48 * 48);
    for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 48; x++) {
            alphaMap[y * 48 + x] = ((x * 17 + y * 31) % 97) / 160;
        }
    }
    for (const patchX of [48, 96]) {
        for (let y = 0; y < 48; y++) {
            for (let x = 0; x < 48; x++) {
                const value = Math.round(alphaMap[y * 48 + x] * 220);
                const offset = ((96 + y) * width + patchX + x) * 4;
                data[offset] = value;
                data[offset + 1] = value;
                data[offset + 2] = value;
                data[offset + 3] = 255;
            }
        }
    }
    const clearedDirect = {
        source: 'standard+validated',
        config: { logoSize: 48, marginRight: 16, marginBottom: 16 },
        position: { x: 96, y: 96, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.4,
        originalGradientScore: 0.2,
        processedSpatialScore: 0.05,
        processedGradientScore: 0.04,
        residual: { cleared: true },
        originalEvidence: { tier: 'strong' },
        damage: { safe: true },
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: {}
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: clearedDirect,
            candidatePool: [clearedDirect],
            source: clearedDirect.source,
            decisionTier: 'direct-match'
        })),
        originalImageData: { width, height, data },
        allowAdaptiveSearch: false
    });

    assert.equal(result.presenceConfirmed, true);
    assert.ok(result.hypotheses.some((hypothesis) => hypothesis.trial === clearedDirect));
});

test('collectInitialWatermarkCandidates should not let best effort bypass a repeated-template collision', () => {
    const width = 256;
    const height = 256;
    const data = new Uint8ClampedArray(width * height * 4);
    const alphaMap = new Float32Array(48 * 48);
    for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 48; x++) {
            alphaMap[y * 48 + x] = ((x * 17 + y * 31) % 97) / 160;
        }
    }
    for (const [patchX, patchY] of [
        [128, 176],
        [176, 128],
        [128, 128]
    ]) {
        for (let y = 0; y < 48; y++) {
            for (let x = 0; x < 48; x++) {
                const value = Math.round(alphaMap[y * 48 + x] * 220);
                const offset = ((patchY + y) * width + patchX + x) * 4;
                data[offset] = value;
                data[offset + 1] = value;
                data[offset + 2] = value;
                data[offset + 3] = 255;
            }
        }
    }
    const weakTarget = {
        source: 'standard+catalog+gain+validated',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 176, y: 176, width: 48, height: 48 },
        alphaMap,
        alphaGain: 0.25,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.29,
        originalGradientScore: 0.5,
        processedSpatialScore: 0.05,
        processedGradientScore: 0.1,
        residual: { cleared: true },
        originalEvidence: { tier: 'medium' },
        damage: { safe: true },
        rankingKey: [1, 0, 0, 0, 0, 0],
        provenance: { catalogVariant: true }
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: weakTarget,
            candidatePool: [weakTarget],
            source: weakTarget.source,
            decisionTier: 'validated-match'
        })),
        originalImageData: { width, height, data },
        allowAdaptiveSearch: false
    });

    assert.equal(result.presenceConfirmed, false);
    assert.equal(result.bestEffortFallback, false);
    assert.deepEqual(result.hypotheses, []);

    const localizedWitness = {
        ...weakTarget,
        source: 'standard',
        config: { logoSize: 48, marginRight: 188, marginBottom: 188 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaGain: 1,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.5,
        processedSpatialScore: 0.02,
        processedGradientScore: 0.03,
        provenance: {}
    };
    const confirmedResult = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: localizedWitness,
            candidatePool: [weakTarget, localizedWitness],
            source: localizedWitness.source,
            decisionTier: 'direct-match'
        })),
        originalImageData: { width, height, data },
        allowAdaptiveSearch: false
    });

    assert.equal(confirmedResult.presenceConfirmed, true);
    assert.ok(confirmedResult.hypotheses.some((hypothesis) => (
        hypothesis.trial === localizedWitness
    )));
    assert.equal(confirmedResult.hypotheses.some((hypothesis) => (
        hypothesis.trial === weakTarget
    )), false);
});

test('collectInitialWatermarkCandidates should keep the small-v2 exception catalog-scoped and damage-safe', () => {
    const createTrial = (overrides = {}) => ({
        source: 'standard+catalog+validated',
        config: { logoSize: 36, marginRight: 71, marginBottom: 71, alphaVariant: 'v2' },
        position: { x: 52, y: 52, width: 36, height: 36 },
        alphaMap: new Float32Array(36 * 36).fill(0.2),
        alphaGain: 1,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.2,
        originalGradientScore: 0.1,
        processedSpatialScore: 0.02,
        processedGradientScore: 0.3,
        residual: { cleared: false },
        originalEvidence: { tier: 'medium' },
        damage: { safe: true },
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: {
            alphaVariant: 'v2',
            catalogFamily: 'gemini-v2-small'
        },
        ...overrides
    });

    for (const trial of [
        createTrial({ damage: { safe: false } }),
        createTrial({
            provenance: {
                alphaVariant: 'v2',
                catalogFamily: 'unrelated-family'
            }
        })
    ]) {
        const result = collectInitialWatermarkCandidates({
            ...createBaseInput(() => ({
                selectedTrial: trial,
                candidatePool: [trial],
                source: trial.source,
                decisionTier: 'validated-match'
            })),
            allowAdaptiveSearch: false
        });

        assert.equal(result.presenceConfirmed, false);
        assert.deepEqual(result.hypotheses, []);
    }
});

test('collectInitialWatermarkCandidates should preserve partial legacy selector metadata', () => {
    const legacySelected = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 1,
        accepted: true,
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: {}
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: legacySelected,
            candidatePool: [legacySelected],
            source: legacySelected.source,
            decisionTier: 'validated-match'
        })),
        allowAdaptiveSearch: false
    });

    assert.equal(result.presenceConfirmed, true);
    assert.ok(result.hypotheses.some((hypothesis) => hypothesis.trial === legacySelected));
});

test('collectInitialWatermarkCandidates should use an eligible direct-match pool trial as presence evidence', () => {
    const directMatch = {
        source: 'standard+preview-anchor',
        config: { logoSize: 35, marginRight: 23, marginBottom: 23 },
        position: { x: 42, y: 42, width: 35, height: 35 },
        alphaMap: new Float32Array(35 * 35).fill(0.2),
        alphaGain: 1,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.88,
        originalGradientScore: 0.45,
        originalEvidence: { tier: 'strong' },
        damage: { safe: true },
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: { previewAnchor: true }
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: null,
            candidatePool: [directMatch],
            source: 'skipped',
            decisionTier: 'insufficient'
        })),
        allowAdaptiveSearch: false
    });

    assert.equal(result.presenceConfirmed, true);
    assert.ok(result.hypotheses.some((hypothesis) => hypothesis.trial === directMatch));
});

test('collectInitialWatermarkCandidates should retain the pool trial that confirmed presence', () => {
    const alphaMap = new Float32Array(48 * 48).fill(0.2);
    const shared = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        provenance: {}
    };
    const diagnostic = {
        ...shared,
        accepted: false,
        evaluation: { eligible: false },
        originalSpatialScore: 0,
        originalGradientScore: 0,
        rankingKey: [0, 0, 0, 0, 0, 0]
    };
    const witness = {
        ...shared,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.8,
        originalGradientScore: 0.4,
        rankingKey: [9, 0, 0, 0, 0, 0]
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: null,
            candidatePool: [diagnostic, witness],
            source: 'skipped',
            decisionTier: 'insufficient'
        })),
        allowAdaptiveSearch: false
    });

    assert.equal(result.presenceConfirmed, true);
    assert.ok(result.hypotheses.some((hypothesis) => hypothesis.trial === witness));
});

test('collectInitialWatermarkCandidates should lock a strong localized geometry ahead of a disjoint weak safe fallback', () => {
    const alphaMap = new Float32Array(48 * 48);
    for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 48; x++) {
            alphaMap[y * 48 + x] = ((x * 17 + y * 31) % 97) / 160;
        }
    }
    const strongGeometry = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 4, marginBottom: 4 },
        position: { x: 48, y: 48, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        accepted: false,
        evaluation: { eligible: false, blockedGate: 'baseValidationAccepted' },
        originalSpatialScore: 0.999,
        originalGradientScore: 0.999,
        processedSpatialScore: -0.61,
        processedGradientScore: 0.49,
        originalEvidence: { tier: 'strong' },
        damage: { safe: false },
        rankingKey: [9, 0, 0, 0, 0, 0],
        provenance: {}
    };
    const weakSafeFallback = {
        source: 'standard+catalog+gain+validated',
        config: { logoSize: 48, marginRight: 52, marginBottom: 52 },
        position: { x: 0, y: 0, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1.15,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.067,
        originalGradientScore: 0.04,
        processedSpatialScore: -0.389,
        processedGradientScore: 0.063,
        residual: { cleared: false },
        originalEvidence: { tier: 'medium' },
        damage: { safe: true },
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: { catalogVariant: true }
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: weakSafeFallback,
            candidatePool: [weakSafeFallback, strongGeometry],
            source: weakSafeFallback.source,
            decisionTier: 'validated-match'
        })),
        allowAdaptiveSearch: false
    });

    assert.equal(result.presenceConfirmed, true);
    assert.ok(result.hypotheses.some((hypothesis) => hypothesis.trial === strongGeometry));
    assert.equal(result.hypotheses.some((hypothesis) => (
        hypothesis.trial === weakSafeFallback
    )), false);
});

test('collectInitialWatermarkCandidates should not geometry-lock a localized content star with only moderate direct evidence', () => {
    const alphaMap = new Float32Array(48 * 48);
    for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 48; x++) {
            alphaMap[y * 48 + x] = ((x * 17 + y * 31) % 97) / 160;
        }
    }
    const contentStar = {
        source: 'standard+preview-anchor',
        config: { logoSize: 48, marginRight: 4, marginBottom: 4 },
        position: { x: 48, y: 48, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        accepted: false,
        evaluation: { eligible: false },
        originalSpatialScore: 0.83,
        originalGradientScore: 0.455,
        processedSpatialScore: -0.94,
        processedGradientScore: 0.92,
        originalEvidence: { tier: 'strong' },
        damage: { safe: false },
        rankingKey: [9, 0, 0, 0, 0, 0],
        provenance: { previewAnchor: true }
    };
    const weakSafeFallback = {
        source: 'standard+preview-anchor+validated',
        config: { logoSize: 48, marginRight: 52, marginBottom: 52 },
        position: { x: 0, y: 0, width: 48, height: 48 },
        alphaMap,
        alphaGain: 0.5,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.28,
        originalGradientScore: 0.04,
        processedSpatialScore: 0.13,
        processedGradientScore: 0.06,
        residual: { cleared: false },
        originalEvidence: { tier: 'medium' },
        damage: { safe: true },
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: { previewAnchor: true }
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput(() => ({
            selectedTrial: weakSafeFallback,
            candidatePool: [weakSafeFallback, contentStar],
            source: weakSafeFallback.source,
            decisionTier: 'validated-match'
        })),
        allowAdaptiveSearch: false
    });

    assert.equal(result.presenceConfirmed, false);
    assert.equal(result.bestEffortFallback, true);
    assert.ok(result.hypotheses.some((hypothesis) => (
        hypothesis.trial === weakSafeFallback
    )));
    assert.equal(result.hypotheses.some((hypothesis) => (
        hypothesis.trial === contentStar
    )), false);
});

test('collectInitialWatermarkCandidates should retain a localized direct-match pool witness when an unsafe small candidate is selected', () => {
    const width = 224;
    const height = 224;
    const data = new Uint8ClampedArray(width * height * 4);
    const alpha48 = new Float32Array(48 * 48);
    for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 48; x++) {
            const alpha = ((x * 17 + y * 31) % 97) / 160;
            alpha48[y * 48 + x] = alpha;
            const value = Math.round(30 + alpha * 180);
            const offset = ((160 + y) * width + 160 + x) * 4;
            data[offset] = value;
            data[offset + 1] = value;
            data[offset + 2] = value;
            data[offset + 3] = 255;
        }
    }
    const directPoolWitness = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 16, marginBottom: 16 },
        position: { x: 160, y: 160, width: 48, height: 48 },
        alphaMap: alpha48,
        alphaGain: 1,
        accepted: false,
        evaluation: { eligible: false, blockedGate: 'baseValidationAccepted' },
        originalSpatialScore: 0.536,
        originalGradientScore: 0.284,
        processedSpatialScore: -0.36,
        processedGradientScore: 0.114,
        damage: { safe: false },
        rankingKey: [0, -3, 1, 0.43, 1, 2.08],
        provenance: { catalogFamily: 'default-standard' }
    };
    const unsafeSmallSelection = {
        source: 'standard+catalog+local+validated+warp',
        config: {
            logoSize: 36,
            marginRight: 28,
            marginBottom: 28,
            alphaVariant: 'v2'
        },
        position: { x: 160, y: 160, width: 36, height: 36 },
        alphaMap: new Float32Array(36 * 36).fill(0.2),
        alphaGain: 1,
        accepted: true,
        evaluation: { eligible: true },
        originalSpatialScore: 0.496,
        originalGradientScore: 0.04,
        processedSpatialScore: 0.015,
        processedGradientScore: 0.184,
        damage: { safe: false },
        rankingKey: [2, -2, 1, 0.125, 1, 1],
        provenance: {
            alphaVariant: 'v2',
            catalogFamily: 'gemini-v2-small',
            localShift: true
        }
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput((args) => args.allowAutomaticSearch
            ? {
                selectedTrial: unsafeSmallSelection,
                candidatePool: [directPoolWitness, unsafeSmallSelection],
                source: unsafeSmallSelection.source,
                decisionTier: 'validated-match'
            }
            : {
                selectedTrial: null,
                candidatePool: [directPoolWitness],
                source: 'skipped',
                decisionTier: 'insufficient'
            }),
        originalImageData: { width, height, data }
    });

    assert.equal(result.presenceConfirmed, true);
    assert.ok(result.hypotheses.some((hypothesis) => (
        hypothesis.trial === directPoolWitness
    )));
    assert.ok(result.hypotheses.some((hypothesis) => (
        hypothesis.trial?.provenance?.topNConservative === true &&
        hypothesis.trial?.position?.width === 48 &&
        hypothesis.trial?.alphaGain <= 0.25
    )));
});

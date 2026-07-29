import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
    assessReferenceTextureAlignment,
    calculateNearBlackRatio,
    evaluateRestorationCandidate,
    pickBetterCandidate,
    selectInitialCandidate
} from '../../src/core/candidateSelector.js';
import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import { interpolateAlphaMap, warpAlphaMap } from '../../src/core/adaptiveDetector.js';
import { decodeImageDataInNode } from '../../scripts/sample-benchmark.js';
import {
    applySyntheticWatermark,
    createPatternImageData,
    createSyntheticAlphaMap
} from './syntheticWatermarkTestUtils.js';

function createPaleFlatImageData(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const value = 204 + ((x + y) % 3);
            data[index] = value;
            data[index + 1] = value + 1;
            data[index + 2] = value + 3;
            data[index + 3] = 255;
        }
    }
    return { width, height, data };
}

test('size-jitter alpha resolution should interpolate the seed variant instead of the default profile', async () => {
    const candidateSelector = await import('../../src/core/candidateSelector.js');
    assert.equal(typeof candidateSelector.resolveSizeJitterAlphaMap, 'function');

    const defaultAlpha = createSyntheticAlphaMap(96);
    const variantAlpha = new Float32Array(defaultAlpha.length);
    for (let index = 0; index < defaultAlpha.length; index++) {
        variantAlpha[index] = defaultAlpha[index] * 0.37;
    }
    const seed = {
        alphaMap: variantAlpha,
        position: { x: 0, y: 0, width: 96, height: 96 },
        config: {
            logoSize: 96,
            marginRight: 192,
            marginBottom: 192,
            alphaVariant: '20260520'
        }
    };

    const actual = candidateSelector.resolveSizeJitterAlphaMap(seed, 88, {
        alpha48: interpolateAlphaMap(defaultAlpha, 96, 48),
        alpha96: defaultAlpha,
        getAlphaMap: (size) => interpolateAlphaMap(defaultAlpha, 96, size),
        resolveAlphaMap: (size) => interpolateAlphaMap(defaultAlpha, 96, size)
    });
    const expected = interpolateAlphaMap(variantAlpha, 96, 88);

    assert.deepEqual(actual, expected);
});

test('evaluateRestorationCandidate should reject weak nearby dark-polarity trials that create a near-white block', async () => {
    const imageData = await decodeImageDataInNode(path.resolve(
        'tests/fixtures/issue101-weak-dark-polarity-damage.png'
    ));
    const alphaMap = calculateAlphaMap(await decodeImageDataInNode(path.resolve(
        'src/assets/bg_96_20260520.png'
    )));
    const darkAlphaMap = new Float32Array(alphaMap.length);
    for (let index = 0; index < alphaMap.length; index++) {
        darkAlphaMap[index] = -alphaMap[index];
    }
    for (const position of [
        { x: 48, y: 48, width: 96, height: 96 },
        { x: 48, y: 52, width: 96, height: 96 }
    ]) {
        const result = evaluateRestorationCandidate({
            originalImageData: imageData,
            alphaMap: darkAlphaMap,
            position,
            source: 'standard+catalog+dark-polarity',
            config: {
                logoSize: 96,
                marginRight: 192,
                marginBottom: 192,
                alphaVariant: '20260520'
            },
            baselineNearBlackRatio: calculateNearBlackRatio(imageData, position),
            alphaGain: 1,
            provenance: {
                catalogVariant: true,
                darkPolarity: true,
                alphaVariant: '20260520'
            },
            includeImageData: false
        });

        assert.equal(result.accepted, false, `position=${JSON.stringify(position)}`);
        assert.equal(result.evaluation.blockedGate, 'darkPolarityNearWhiteIncreaseAllowed');
        assert.ok(result.nearWhiteIncrease > 0.2, `nearWhiteIncrease=${result.nearWhiteIncrease}`);
    }
});

test('evaluateRestorationCandidate should reject a weak 48px dark-polarity content collision', async () => {
    const imageData = await decodeImageDataInNode(path.resolve(
        'tests/fixtures/release-d119-dark-polarity-false-positive-roi.png'
    ));
    const alphaMap = getEmbeddedAlphaMap(48);
    const darkAlphaMap = Float32Array.from(alphaMap, (value) => -Math.abs(value));
    const position = { x: 0, y: 0, width: 48, height: 48 };
    const result = evaluateRestorationCandidate({
        originalImageData: imageData,
        alphaMap: darkAlphaMap,
        position,
        source: 'standard+catalog+dark-polarity+gain',
        config: {
            logoSize: 48,
            marginRight: 96,
            marginBottom: 96
        },
        baselineNearBlackRatio: calculateNearBlackRatio(imageData, position),
        alphaGain: 0.06,
        provenance: {
            catalogVariant: true,
            catalogFamily: 'known-current-variant',
            catalogEvidenceGate: 'required',
            darkPolarity: true
        },
        includeImageData: false
    });

    assert.equal(result.accepted, false);
    assert.equal(
        result.evaluation.blockedGate,
        'darkPolarityCatalogEvidenceAllowed'
    );
    assert.ok(result.originalSpatialScore < 0.6);
    assert.ok(result.originalGradientScore < 0.3);
});

test('evaluateRestorationCandidate should keep the 48px dark-polarity rescue inside its validated weak-gain range', () => {
    const imageData = createPaleFlatImageData(48, 48);
    const alphaMap = getEmbeddedAlphaMap(48);
    const darkAlphaMap = Float32Array.from(alphaMap, (value) => -Math.abs(value));
    const position = { x: 0, y: 0, width: 48, height: 48 };
    for (let index = 0; index < alphaMap.length; index++) {
        const alpha = alphaMap[index];
        const offset = index * 4;
        for (let channel = 0; channel < 3; channel++) {
            imageData.data[offset + channel] = Math.round(
                imageData.data[offset + channel] * (1 - alpha)
            );
        }
    }

    const result = evaluateRestorationCandidate({
        originalImageData: imageData,
        alphaMap: darkAlphaMap,
        position,
        source: 'standard+catalog+dark-polarity',
        config: {
            logoSize: 48,
            marginRight: 96,
            marginBottom: 96
        },
        baselineNearBlackRatio: calculateNearBlackRatio(imageData, position),
        alphaGain: 1,
        provenance: {
            catalogVariant: true,
            catalogFamily: 'known-current-variant',
            catalogEvidenceGate: 'required',
            darkPolarity: true,
            weakDarkPolarity48: true
        },
        includeImageData: false
    });

    assert.equal(result.accepted, false);
    assert.equal(
        result.evaluation.blockedGate,
        'darkPolarityCatalogEvidenceAllowed'
    );
});

test('evaluateRestorationCandidate should admit the issue101 light-outline template only with strong structural evidence', async () => {
    const alphaMap = getEmbeddedAlphaMap('96-outline-light');
    assert.ok(alphaMap, 'expected the embedded light-outline alpha map');
    assert.ok(alphaMap.some((value) => value > 0.1), 'expected a white core');
    assert.ok(alphaMap.some((value) => value < -0.01), 'expected a dark outline');

    const targetImageData = await decodeImageDataInNode(path.resolve(
        'tests/fixtures/issue101-outline-light-portrait.png'
    ));
    const targetPosition = { x: 48, y: 48, width: 96, height: 96 };
    const sharedCandidate = {
        alphaMap,
        source: 'standard+catalog+outline-light',
        config: {
            logoSize: 96,
            marginRight: 192,
            marginBottom: 192,
            alphaVariant: 'outline-light'
        },
        alphaGain: 1,
        provenance: {
            catalogVariant: true,
            alphaVariant: 'outline-light',
            outlineLight: true
        },
        includeImageData: false
    };
    const target = evaluateRestorationCandidate({
        ...sharedCandidate,
        originalImageData: targetImageData,
        position: targetPosition,
        baselineNearBlackRatio: calculateNearBlackRatio(targetImageData, targetPosition)
    });

    assert.equal(target.accepted, true);
    assert.equal(target.evaluation.gates.outlineLightEvidenceAllowed, true);
    assert.ok(target.originalGradientScore >= 0.45, `originalGradient=${target.originalGradientScore}`);
    assert.ok(target.improvement >= 0.35, `improvement=${target.improvement}`);
    assert.ok(target.processedGradientScore <= 0.25, `processedGradient=${target.processedGradientScore}`);

    const falsePositiveImageData = await decodeImageDataInNode(path.resolve(
        'tests/fixtures/issue92-new-margin-default-alpha.png'
    ));
    const falsePositivePosition = {
        x: falsePositiveImageData.width - 192 - 96,
        y: falsePositiveImageData.height - 192 - 96,
        width: 96,
        height: 96
    };
    const falsePositive = evaluateRestorationCandidate({
        ...sharedCandidate,
        originalImageData: falsePositiveImageData,
        position: falsePositivePosition,
        baselineNearBlackRatio: calculateNearBlackRatio(falsePositiveImageData, falsePositivePosition)
    });

    assert.equal(falsePositive.accepted, false);
    assert.equal(falsePositive.evaluation.blockedGate, 'outlineLightEvidenceAllowed');
    assert.equal(falsePositive.evaluation.gates.outlineLightEvidenceAllowed, false);
});

test('evaluateRestorationCandidate should repair the issue101 dark-outline contour without broad inpaint', async () => {
    const alphaMap = getEmbeddedAlphaMap('96-outline-dark');
    assert.ok(alphaMap, 'expected the embedded dark-outline alpha map');
    assert.ok(alphaMap.some((value) => value > 0.02), 'expected a light body component');
    assert.ok(alphaMap.some((value) => value < -0.05), 'expected a dark contour component');

    const targetImageData = await decodeImageDataInNode(path.resolve(
        'tests/fixtures/issue101-outline-dark-landscape.png'
    ));
    const position = { x: 48, y: 96, width: 96, height: 96 };
    const result = evaluateRestorationCandidate({
        originalImageData: targetImageData,
        alphaMap,
        position,
        source: 'standard+catalog+outline-dark',
        config: {
            logoSize: 96,
            marginRight: 192,
            marginBottom: 192,
            alphaVariant: 'outline-dark'
        },
        baselineNearBlackRatio: calculateNearBlackRatio(targetImageData, position),
        alphaGain: 1,
        provenance: {
            catalogVariant: true,
            alphaVariant: 'outline-dark',
            outlineDark: true
        }
    });

    assert.equal(result.accepted, true);
    assert.equal(result.evaluation.gates.outlineDarkEvidenceAllowed, true);
    assert.equal(result.outlineDarkRepair?.accepted, true);
    assert.ok(result.outlineDarkRepair.maskPixels >= 32, `mask=${result.outlineDarkRepair.maskPixels}`);
    assert.ok(result.outlineDarkRepair.maskPixels <= 96 * 96 * 0.1, `mask=${result.outlineDarkRepair.maskPixels}`);
    assert.ok(result.originalGradientScore >= 0.38, `originalGradient=${result.originalGradientScore}`);
    assert.ok(result.processedGradientScore <= 0.18, `processedGradient=${result.processedGradientScore}`);
    assert.ok(Math.abs(result.processedSpatialScore) <= 0.15, `processedSpatial=${result.processedSpatialScore}`);

    for (const fixture of [
        'tests/fixtures/issue101-outline-light-portrait.png',
        'tests/fixtures/issue101-weak-dark-polarity-damage.png',
        'tests/fixtures/issue92-new-margin-default-alpha.png'
    ]) {
        const control = await decodeImageDataInNode(path.resolve(fixture));
        const controlPosition = control.width === 192
            ? { x: 48, y: 48, width: 96, height: 96 }
            : {
                x: control.width - 192 - 96,
                y: control.height - 192 - 96,
                width: 96,
                height: 96
            };
        const controlResult = evaluateRestorationCandidate({
            originalImageData: control,
            alphaMap,
            position: controlPosition,
            source: 'standard+catalog+outline-dark',
            config: {
                logoSize: 96,
                marginRight: 192,
                marginBottom: 192,
                alphaVariant: 'outline-dark'
            },
            baselineNearBlackRatio: calculateNearBlackRatio(control, controlPosition),
            alphaGain: 1,
            provenance: {
                catalogVariant: true,
                alphaVariant: 'outline-dark',
                outlineDark: true
            },
            includeImageData: false
        });
        assert.equal(controlResult.accepted, false, fixture);
        assert.equal(controlResult.evaluation.gates.outlineDarkEvidenceAllowed, false, fixture);
    }
});

async function selectIssue101DarkOutlineFixture(fixtureName) {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96Current = calculateAlphaMap(await decodeImageDataInNode(path.resolve(
        'src/assets/bg_96_20260520.png'
    )));
    const outlineDarkAlpha = getEmbeddedAlphaMap('96-outline-dark');
    const originalImageData = createPatternImageData(480, 480);
    const issue101Crop = await decodeImageDataInNode(path.resolve(fixtureName));
    const config = {
        logoSize: 96,
        marginRight: 192,
        marginBottom: 192,
        alphaVariant: '20260520'
    };
    const position = { x: 192, y: 192, width: 96, height: 96 };

    for (let y = 0; y < issue101Crop.height; y++) {
        for (let x = 0; x < issue101Crop.width; x++) {
            const sourceIndex = (y * issue101Crop.width + x) * 4;
            const targetIndex = ((96 + y) * originalImageData.width + 144 + x) * 4;
            originalImageData.data.set(
                issue101Crop.data.subarray(sourceIndex, sourceIndex + 4),
                targetIndex
            );
        }
    }

    return selectInitialCandidate({
        originalImageData,
        config,
        position,
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96Current,
            'outline-dark': outlineDarkAlpha
        },
        getAlphaMap: (size) => size === '96-outline-dark'
            ? outlineDarkAlpha
            : interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: false,
        allowAutomaticSearch: false,
        alphaGainCandidates: [1],
        alphaPriorityGains: [1]
    });
}

test('selectInitialCandidate should preserve full dark-outline body gain for strong body evidence', async () => {
    const result = await selectIssue101DarkOutlineFixture(
        'tests/fixtures/issue101-outline-dark-landscape.png'
    );

    assert.equal(result.selectedTrial?.provenance?.outlineDark, true);
    assert.equal(result.selectedTrial?.provenance?.outlineDarkBodyGain, 1);
});

test('selectInitialCandidate should reduce dark-outline body gain when the full body over-corrects', async () => {
    const result = await selectIssue101DarkOutlineFixture(
        'tests/fixtures/issue101-outline-dark-low-body-landscape.png'
    );

    assert.equal(result.selectedTrial?.provenance?.outlineDark, true);
    assert.equal(result.selectedTrial?.provenance?.outlineDarkBodyGain, 0.5);
    assert.ok(
        Math.abs(result.selectedTrial.processedSpatialScore) <= 0.02,
        `processedSpatial=${result.selectedTrial.processedSpatialScore}`
    );
});

test('selectInitialCandidate should select the light-outline variant without replacing the canonical alpha map', async () => {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96Current = calculateAlphaMap(await decodeImageDataInNode(path.resolve(
        'src/assets/bg_96_20260520.png'
    )));
    const outlineAlpha = getEmbeddedAlphaMap('96-outline-light');
    const originalImageData = createPatternImageData(480, 480);
    const issue101Crop = await decodeImageDataInNode(path.resolve(
        'tests/fixtures/issue101-outline-light-portrait.png'
    ));
    const config = {
        logoSize: 96,
        marginRight: 192,
        marginBottom: 192,
        alphaVariant: '20260520'
    };
    const position = { x: 192, y: 192, width: 96, height: 96 };
    for (let y = 0; y < issue101Crop.height; y++) {
        for (let x = 0; x < issue101Crop.width; x++) {
            const sourceIndex = (y * issue101Crop.width + x) * 4;
            const targetIndex = ((144 + y) * originalImageData.width + 144 + x) * 4;
            originalImageData.data.set(
                issue101Crop.data.subarray(sourceIndex, sourceIndex + 4),
                targetIndex
            );
        }
    }

    const result = selectInitialCandidate({
        originalImageData,
        config,
        position,
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96Current,
            'outline-light': outlineAlpha
        },
        getAlphaMap: (size) => size === '96-outline-light'
            ? outlineAlpha
            : interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: false,
        allowAutomaticSearch: false,
        alphaGainCandidates: [1],
        alphaPriorityGains: [1]
    });

    assert.ok(result.selectedTrial, 'expected a selected outline candidate');
    assert.equal(result.selectedTrial.provenance?.outlineLight, true);
    assert.equal(result.selectedTrial.provenance?.alphaVariant, 'outline-light');
    assert.equal(result.selectedTrial.alphaMap, outlineAlpha);
    assert.deepEqual(result.position, position);
});

test('selectInitialCandidate should return a skipped result when no standard trials can be built', () => {
    const imageData = createPatternImageData(456, 142);
    const config = {
        logoSize: 125,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48: null,
        alpha96: null,
        getAlphaMap: () => null,
        allowAdaptiveSearch: false,
        alphaGainCandidates: [1]
    });

    assert.equal(result.selectedTrial, null);
    assert.equal(result.source, 'skipped');
    assert.equal(result.decisionTier, 'insufficient');
    assert.equal(result.standardSpatialScore, null);
    assert.equal(result.standardGradientScore, null);
});

test('selectInitialCandidate should not require eager adaptive search when the standard candidate is already strong', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPatternImageData(320, 320);
    const config = {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96: null,
        getAlphaMap: () => null,
        allowAdaptiveSearch: true,
        alphaGainCandidates: [1]
    });

    assert.ok(result.selectedTrial, 'expected standard candidate to be selected');
    assert.ok(result.source.startsWith('standard'), `source=${result.source}`);
    assert.equal(result.position.x, position.x);
    assert.equal(result.position.y, position.y);
    assert.ok(Array.isArray(result.candidatePool));
    assert.ok(result.candidatePool.includes(result.selectedTrial));
    assert.equal(new Set(result.candidatePool).size, result.candidatePool.length);
});

test('selectInitialCandidate should preserve strong undersized adaptive provenance', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPaleFlatImageData(400, 500);
    const target = { x: 260, y: 400, width: 40, height: 40 };
    applySyntheticWatermark(
        imageData,
        interpolateAlphaMap(alpha96, 96, 40),
        target,
        1
    );
    const config = { logoSize: 96, marginRight: 64, marginBottom: 64 };
    const position = { x: 240, y: 340, width: 96, height: 96 };

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: true,
        allowAutomaticSearch: true,
        alphaGainCandidates: [0.6, 1],
        alphaPriorityGains: [0.6, 1]
    });

    assert.ok(result.selectedTrial, 'expected an adaptive candidate');
    assert.equal(result.position.width, 40);
    assert.equal(result.selectedTrial.provenance?.adaptive, true);
    assert.equal(result.selectedTrial.provenance?.strongUndersizedMatch, true);
});

test('selectInitialCandidate should validate strong-alpha standard anchors before skipping', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const strongAlpha48 = new Float32Array(alpha48.length);
    for (let index = 0; index < alpha48.length; index++) {
        strongAlpha48[index] = Math.min(0.95, alpha48[index] * 1.25);
    }
    const imageData = createPatternImageData(320, 320);
    const config = {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };

    applySyntheticWatermark(imageData, strongAlpha48, position, 1);

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: false,
        allowAutomaticSearch: false,
        alphaGainCandidates: [0.6, 1, 1.15, 1.3],
        alphaPriorityGains: [0.6, 1, 1.15, 1.3]
    });

    assert.ok(result.selectedTrial, 'expected strong-alpha standard candidate to be selected');
    assert.equal(result.alphaGain, 1.15);
    assert.equal(result.source, 'standard+gain');
    assert.deepEqual(result.position, position);
});

test('selectInitialCandidate should recover fixed-core local geometry drift for strong standard evidence', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const alpha46 = interpolateAlphaMap(alpha96, 96, 46);
    const strongAlpha46 = new Float32Array(alpha46.length);
    for (let index = 0; index < alpha46.length; index++) {
        strongAlpha46[index] = Math.min(0.95, alpha46[index] * 1.2);
    }
    const imageData = createPatternImageData(720, 1456);
    const config = {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };
    const truePosition = {
        x: imageData.width - 35 - 46,
        y: imageData.height - 35 - 46,
        width: 46,
        height: 46
    };

    applySyntheticWatermark(imageData, strongAlpha46, truePosition, 1);

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: false,
        allowAutomaticSearch: false,
        alphaGainCandidates: [0.6, 1, 1.15, 1.3],
        alphaPriorityGains: [0.6, 1, 1.15, 1.3]
    });

    assert.ok(result.selectedTrial, 'expected local fixed-core candidate to be selected');
    assert.ok(Math.abs(result.position.x - truePosition.x) <= 1, `x=${result.position.x}`);
    assert.ok(Math.abs(result.position.y - truePosition.y) <= 1, `y=${result.position.y}`);
    assert.ok(Math.abs(result.position.width - truePosition.width) <= 1, `width=${result.position.width}`);
    assert.ok(String(result.source).includes('fixed-local'), `source=${result.source}`);
});

test('selectInitialCandidate should not use automatic preview-anchor search outside fixed combinations', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const alpha36 = interpolateAlphaMap(alpha96, 96, 36);
    const imageData = createPatternImageData(400, 400);
    const config = {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };
    const unsupportedPreviewPosition = {
        x: imageData.width - 32 - 36,
        y: imageData.height - 32 - 36,
        width: 36,
        height: 36
    };

    applySyntheticWatermark(imageData, alpha36, unsupportedPreviewPosition, 1);

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => size === 36 ? alpha36 : null,
        allowAdaptiveSearch: false,
        allowAutomaticSearch: false,
        alphaGainCandidates: [0.6, 1, 0.7, 0.85, 0.55],
        alphaPriorityGains: [0.6, 1]
    });

    assert.equal(result.selectedTrial, null);
    assert.equal(result.source, 'skipped');
    assert.equal(result.decisionTier, 'insufficient');
});

test('evaluateRestorationCandidate should add texture penalty when restoration becomes darker than the local reference region', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPatternImageData(320, 320);
    const position = {
        x: 240,
        y: 240,
        width: 48,
        height: 48
    };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    const candidate = evaluateRestorationCandidate({
        originalImageData: imageData,
        alphaMap: alpha48,
        position,
        source: 'standard',
        config: {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        },
        baselineNearBlackRatio: 0,
        alphaGain: 1.05
    });

    const baseValidationCost =
        Math.abs(candidate.processedSpatialScore) +
        Math.max(0, candidate.processedGradientScore) * 0.6 +
        Math.max(0, candidate.nearBlackIncrease) * 3;

    assert.equal(candidate.accepted, true);
    assert.ok(candidate.validationCost > baseValidationCost, 'expected local texture penalty to increase validation cost');
    assert.ok(candidate.texturePenalty > 0, `texturePenalty=${candidate.texturePenalty}`);
});

test('evaluateRestorationCandidate should reject standard candidates with no original watermark evidence', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const data = new Uint8ClampedArray(320 * 320 * 4);
    for (let index = 0; index < 320 * 320; index++) {
        const offset = index * 4;
        data[offset] = 220;
        data[offset + 1] = 220;
        data[offset + 2] = 220;
        data[offset + 3] = 255;
    }
    const imageData = { width: 320, height: 320, data };
    const position = {
        x: 240,
        y: 240,
        width: 48,
        height: 48
    };

    const candidate = evaluateRestorationCandidate({
        originalImageData: imageData,
        alphaMap: alpha48,
        position,
        source: 'standard',
        config: {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        },
        baselineNearBlackRatio: 0,
        alphaGain: 1
    });

    assert.equal(candidate.accepted, false);
    assert.ok(candidate.originalSpatialScore < 0.05, `spatial=${candidate.originalSpatialScore}`);
    assert.ok(candidate.originalGradientScore < 0.12, `gradient=${candidate.originalGradientScore}`);
});

test('evaluateRestorationCandidate should support scoring without materializing a full candidate image', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPatternImageData(320, 320);
    const position = {
        x: 240,
        y: 240,
        width: 48,
        height: 48
    };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    const fullCandidate = evaluateRestorationCandidate({
        originalImageData: imageData,
        alphaMap: alpha48,
        position,
        source: 'standard',
        config: {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        },
        baselineNearBlackRatio: 0,
        alphaGain: 1,
        includeImageData: true
    });

    const scoreOnlyCandidate = evaluateRestorationCandidate({
        originalImageData: imageData,
        alphaMap: alpha48,
        position,
        source: 'standard',
        config: {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        },
        baselineNearBlackRatio: 0,
        alphaGain: 1,
        includeImageData: false
    });

    assert.ok(fullCandidate.imageData, 'expected full candidate image data to exist');
    assert.equal(scoreOnlyCandidate.imageData, null);
    assert.equal(scoreOnlyCandidate.accepted, fullCandidate.accepted);
    assert.equal(scoreOnlyCandidate.processedSpatialScore, fullCandidate.processedSpatialScore);
    assert.equal(scoreOnlyCandidate.processedGradientScore, fullCandidate.processedGradientScore);
    assert.equal(scoreOnlyCandidate.validationCost, fullCandidate.validationCost);
    assert.equal(scoreOnlyCandidate.originalEvidence.tier, 'strong');
    assert.equal(scoreOnlyCandidate.residual.cleared, true);
    assert.equal(scoreOnlyCandidate.damage.safe, true);
    assert.equal(scoreOnlyCandidate.sourcePriority, 0);
    assert.ok(Array.isArray(scoreOnlyCandidate.rankingKey));
    assert.equal(scoreOnlyCandidate.earlyAccept, true);
});

test('pickBetterCandidate should keep the default anchor when a local shift loses strong original watermark evidence', () => {
    const defaultAnchorCandidate = {
        accepted: true,
        source: 'standard+validated',
        provenance: null,
        validationCost: 0.3265185265738402,
        improvement: 0.5431154601023849,
        originalSpatialScore: 0.29710616867610046,
        originalGradientScore: 0.4998777626082937
    };
    const driftedLocalShiftCandidate = {
        accepted: true,
        source: 'standard+local+validated',
        provenance: { localShift: true },
        validationCost: 0.06597234178943942,
        improvement: 0.19065682410462825,
        originalSpatialScore: 0.17313940579433085,
        originalGradientScore: -0.0250843744728948
    };

    const selected = pickBetterCandidate(defaultAnchorCandidate, driftedLocalShiftCandidate, 0.002);

    assert.equal(selected, defaultAnchorCandidate);
});

test('pickBetterCandidate should preserve a strong 48px large-margin anchor over a weak official anchor', () => {
    const largeMarginCandidate = {
        accepted: true,
        source: 'standard',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 880, y: 880, width: 48, height: 48 },
        provenance: null,
        validationCost: 1.507943672019685,
        improvement: 1.37237124311371,
        originalSpatialScore: 0.9998442377606915,
        originalGradientScore: 0.9997840403609796
    };
    const weakOfficialCandidate = {
        accepted: true,
        source: 'standard+catalog+validated',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 944, y: 944, width: 48, height: 48 },
        provenance: {
            catalogVariant: true,
            catalogFamily: 'exact-official-current',
            catalogSourcePriority: 0
        },
        validationCost: 0.4051653941725306,
        improvement: 0.386727537075713,
        originalSpatialScore: 0.02671828846379963,
        originalGradientScore: 0.12516799191854763
    };

    assert.equal(
        pickBetterCandidate(largeMarginCandidate, weakOfficialCandidate, 0.002),
        largeMarginCandidate
    );
    assert.equal(
        pickBetterCandidate(weakOfficialCandidate, largeMarginCandidate, 0.002),
        largeMarginCandidate
    );
});

test('pickBetterCandidate should preserve a strong full 96px anchor over weak 48px large-margin evidence', () => {
    const canonical96Candidate = {
        accepted: true,
        source: 'standard',
        config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        position: { x: 1536, y: 2358, width: 96, height: 96 },
        provenance: null,
        validationCost: 1.012,
        improvement: 0.54,
        originalSpatialScore: 0.4815,
        originalGradientScore: 0.2747,
        processedSpatialScore: 0.0188,
        processedGradientScore: 0.023,
        residual: { cleared: true }
    };
    const weakLargeMargin48Candidate = {
        accepted: true,
        source: 'standard+catalog+gain+validated+luma-edge',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 1552, y: 2374, width: 48, height: 48 },
        provenance: {
            catalogVariant: true,
            catalogFamily: 'exact-official-current',
            catalogSourcePriority: 0
        },
        validationCost: 0.314,
        improvement: 0.22,
        originalSpatialScore: 0.186,
        originalGradientScore: 0.089,
        processedSpatialScore: -0.081,
        processedGradientScore: 0.186,
        residual: { cleared: false }
    };

    const selected = pickBetterCandidate(canonical96Candidate, weakLargeMargin48Candidate, 0.002);

    assert.equal(selected, canonical96Candidate);
});

test('pickBetterCandidate should preserve a strong low-residual 96px anchor even before residual clears', () => {
    const canonical96Candidate = {
        accepted: true,
        source: 'standard',
        config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        position: { x: 1632, y: 2230, width: 96, height: 96 },
        provenance: null,
        validationCost: 0.44,
        improvement: 0.62,
        originalSpatialScore: 0.6578,
        originalGradientScore: 0.7131,
        processedSpatialScore: 0.037,
        processedGradientScore: 0.2026,
        residual: { cleared: false }
    };
    const weakLargeMargin48Candidate = {
        accepted: true,
        source: 'standard+catalog+gain',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 1648, y: 2246, width: 48, height: 48 },
        provenance: {
            catalogVariant: true,
            catalogFamily: 'exact-official-current',
            catalogSourcePriority: 0
        },
        validationCost: 0.31,
        improvement: 0.33,
        originalSpatialScore: 0.3252,
        originalGradientScore: 0.1252,
        processedSpatialScore: 0.0079,
        processedGradientScore: 0.3364,
        residual: { cleared: false }
    };

    const selected = pickBetterCandidate(canonical96Candidate, weakLargeMargin48Candidate, 0.002);

    assert.equal(selected, canonical96Candidate);
});

test('pickBetterCandidate should still allow a local shift when the default anchor lacks strong evidence', () => {
    const defaultAnchorCandidate = {
        accepted: true,
        source: 'standard+validated',
        provenance: null,
        validationCost: 0.4040296852241377,
        improvement: 0.9692938044339201,
        originalSpatialScore: 0.751216569797702,
        originalGradientScore: -0.12768919590607608
    };
    const recoveredLocalShiftCandidate = {
        accepted: true,
        source: 'standard+local+validated',
        provenance: { localShift: true },
        validationCost: 0.03650774301387135,
        improvement: 0.8620228530471932,
        originalSpatialScore: 0.8669310438820185,
        originalGradientScore: -0.10895911933638856
    };

    const selected = pickBetterCandidate(defaultAnchorCandidate, recoveredLocalShiftCandidate, 0.002);

    assert.equal(selected, recoveredLocalShiftCandidate);
});

test('pickBetterCandidate should preserve a clean default anchor when a local shift leaves higher residual gradient', () => {
    const defaultAnchorCandidate = {
        accepted: true,
        source: 'standard+validated',
        provenance: null,
        validationCost: 0.2696465723466803,
        improvement: 0.5531471532886425,
        originalSpatialScore: 0.2873281605142487,
        originalGradientScore: 0.5278399164629114,
        processedSpatialScore: -0.26581899277439386,
        processedGradientScore: 0.00637929928714411
    };
    const driftedLocalShiftCandidate = {
        accepted: true,
        source: 'standard+local+validated',
        provenance: { localShift: true },
        validationCost: 0.13556486383737498,
        improvement: 0.1927215257713466,
        originalSpatialScore: 0.16967136619110074,
        originalGradientScore: -0.02446231186883343,
        processedSpatialScore: -0.023050159580245855,
        processedGradientScore: 0.06599672931743743
    };

    const selected = pickBetterCandidate(defaultAnchorCandidate, driftedLocalShiftCandidate, 0.002);

    assert.equal(selected, defaultAnchorCandidate);
});

test('pickBetterCandidate should preserve a strong default anchor against weak size-jitter evidence', () => {
    const defaultAnchorCandidate = {
        accepted: true,
        source: 'standard+validated',
        provenance: null,
        validationCost: 0.312,
        improvement: 0.61,
        originalSpatialScore: 0.41,
        originalGradientScore: 0.58,
        processedSpatialScore: -0.21,
        processedGradientScore: 0.018
    };
    const weakSizeJitterCandidate = {
        accepted: true,
        source: 'standard+size+validated',
        provenance: { sizeJitter: true },
        validationCost: 0.09,
        improvement: 0.19,
        originalSpatialScore: 0.16,
        originalGradientScore: 0.06,
        processedSpatialScore: -0.02,
        processedGradientScore: 0.071
    };

    const selected = pickBetterCandidate(defaultAnchorCandidate, weakSizeJitterCandidate, 0.002);

    assert.equal(selected, defaultAnchorCandidate);
});

test('pickBetterCandidate should preserve a safe exact new-margin variant over a size-jitter descendant', () => {
    const exactCandidate = {
        accepted: true,
        source: 'standard+catalog+validated',
        config: {
            logoSize: 96,
            marginRight: 192,
            marginBottom: 192,
            alphaVariant: '20260520'
        },
        provenance: { alphaVariant: '20260520' },
        validationCost: 0.231,
        improvement: 0.115,
        originalSpatialScore: 0.1831,
        originalGradientScore: 0.0658,
        processedSpatialScore: 0.0681,
        processedGradientScore: 0.0314,
        damage: { safe: true, penalty: 0.02 }
    };
    const jitterCandidate = {
        accepted: true,
        source: 'standard+catalog+size+validated',
        config: {
            logoSize: 108,
            marginRight: 192,
            marginBottom: 192,
            alphaVariant: '20260520'
        },
        provenance: {
            alphaVariant: '20260520',
            sizeJitter: true
        },
        validationCost: 0.058,
        improvement: 0.167,
        originalSpatialScore: 0.2012,
        originalGradientScore: -0.0064,
        processedSpatialScore: 0.0342,
        processedGradientScore: 0.044,
        damage: { safe: true, penalty: 0.01 }
    };

    assert.equal(pickBetterCandidate(exactCandidate, jitterCandidate, 0.002), exactCandidate);
    assert.equal(pickBetterCandidate(jitterCandidate, exactCandidate, 0.002), exactCandidate);
});

test('pickBetterCandidate should preserve a clean default anchor against weaker warp evidence', () => {
    const defaultAnchorCandidate = {
        accepted: true,
        source: 'standard',
        provenance: null,
        validationCost: 0.27,
        improvement: 0.55,
        originalSpatialScore: 0.29,
        originalGradientScore: 0.53,
        processedSpatialScore: -0.26,
        processedGradientScore: 0.006
    };
    const weakWarpCandidate = {
        accepted: true,
        source: 'standard+warp',
        provenance: null,
        validationCost: 0.19,
        improvement: 0.18,
        originalSpatialScore: 0.17,
        originalGradientScore: 0.04,
        processedSpatialScore: -0.03,
        processedGradientScore: 0.041
    };

    const selected = pickBetterCandidate(defaultAnchorCandidate, weakWarpCandidate, 0.002);

    assert.equal(selected, defaultAnchorCandidate);
});

test('pickBetterCandidate should use rankingKey for same-anchor local alpha choices', () => {
    const position = { x: 240, y: 240, width: 48, height: 48 };
    const config = { logoSize: 48, marginRight: 32, marginBottom: 32 };
    const riskyLowResidualCandidate = {
        accepted: true,
        source: 'standard',
        provenance: null,
        config,
        position,
        validationCost: 0.01,
        improvement: 0.6,
        originalSpatialScore: 0.7,
        originalGradientScore: 0.4,
        rankingKey: [0, -3, 1, 0.01, 0, 0.8]
    };
    const safeCandidate = {
        accepted: true,
        source: 'standard+gain',
        provenance: null,
        config,
        position,
        validationCost: 0.08,
        improvement: 0.5,
        originalSpatialScore: 0.7,
        originalGradientScore: 0.4,
        rankingKey: [0, -3, 0, 0.08, 1, 0.02]
    };

    const selected = pickBetterCandidate(riskyLowResidualCandidate, safeCandidate, 0.002);

    assert.equal(selected, safeCandidate);
});

test('pickBetterCandidate should preserve standard alpha when stronger same-anchor gain risks dark over-removal', () => {
    const standardAlphaCandidate = {
        accepted: true,
        source: 'standard',
        config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        position: { x: 2592, y: 1376, width: 96, height: 96 },
        alphaGain: 1,
        originalSpatialScore: 0.77,
        originalGradientScore: 0.47,
        processedSpatialScore: 0.31,
        processedGradientScore: 0.04,
        improvement: 0.46,
        validationCost: 0.34,
        rankingKey: [0, -3, 1, 0.34, 1, 0.9]
    };
    const strongDarkCandidate = {
        ...standardAlphaCandidate,
        alphaGain: 1.15,
        processedSpatialScore: 0.14,
        processedGradientScore: 0.13,
        improvement: 0.63,
        tooDark: true,
        validationCost: 0.22,
        rankingKey: [0, -3, 1, 0.22, 3, 0.97]
    };

    assert.equal(
        pickBetterCandidate(standardAlphaCandidate, strongDarkCandidate, 0.002),
        standardAlphaCandidate
    );
    assert.equal(
        pickBetterCandidate(strongDarkCandidate, standardAlphaCandidate, 0.002),
        standardAlphaCandidate
    );
});

test('pickBetterCandidate should not apply same-anchor rankingKey migration to preview-anchor fallbacks', () => {
    const position = { x: 720, y: 480, width: 34, height: 34 };
    const config = { logoSize: 34, marginRight: 24, marginBottom: 24 };
    const cleanPreviewCandidate = {
        accepted: true,
        source: 'standard+preview-anchor',
        provenance: { previewAnchor: true },
        config,
        position,
        validationCost: 0.02,
        improvement: 0.4,
        originalSpatialScore: 0.5,
        originalGradientScore: 0.3,
        rankingKey: [8, -2, 1, 0.02, 0, 0.4]
    };
    const rankingPreferredPreviewCandidate = {
        accepted: true,
        source: 'standard+preview-anchor+gain',
        provenance: { previewAnchor: true },
        config,
        position,
        validationCost: 0.08,
        improvement: 0.35,
        originalSpatialScore: 0.5,
        originalGradientScore: 0.3,
        rankingKey: [8, -2, 0, 0.08, 1, 0.02]
    };

    const selected = pickBetterCandidate(cleanPreviewCandidate, rankingPreferredPreviewCandidate, 0.002);

    assert.equal(selected, cleanPreviewCandidate);
});

test('assessReferenceTextureAlignment should mark a candidate unsafe when it is both darker and flatter than the local reference', () => {
    const width = 96;
    const height = 96;
    const data = new Uint8ClampedArray(width * height * 4);
    const candidateData = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i + 3] = 255;
        candidateData[i + 3] = 255;
    }

    const referenceRegion = { x: 24, y: 0, width: 48, height: 48 };
    const position = { x: 24, y: 48, width: 48, height: 48 };

    for (let row = 0; row < 48; row++) {
        for (let col = 0; col < 48; col++) {
            const refIdx = ((referenceRegion.y + row) * width + (referenceRegion.x + col)) * 4;
            const posIdx = ((position.y + row) * width + (position.x + col)) * 4;
            const value = (row + col) % 2 === 0 ? 40 : 180;
            data[refIdx] = value;
            data[refIdx + 1] = value;
            data[refIdx + 2] = value;
            candidateData[posIdx] = 18;
            candidateData[posIdx + 1] = 18;
            candidateData[posIdx + 2] = 18;
        }
    }

    const originalImageData = { width, height, data };
    const candidateImageData = { width, height, data: candidateData };
    const assessment = assessReferenceTextureAlignment({
        originalImageData,
        candidateImageData,
        position
    });

    assert.equal(assessment.tooDark, true);
    assert.equal(assessment.tooFlat, true);
    assert.ok(assessment.texturePenalty > 0, `texturePenalty=${assessment.texturePenalty}`);
    assert.equal(assessment.hardReject, true);
});

test('selectInitialCandidate should expose structured provenance for size-jitter recovery', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const alpha54 = interpolateAlphaMap(alpha96, 96, 54);
    const imageData = createPatternImageData(320, 320);
    const config = {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };
    const truePosition = {
        x: 320 - 32 - 54,
        y: 320 - 32 - 54,
        width: 54,
        height: 54
    };

    applySyntheticWatermark(imageData, alpha54, truePosition, 1);

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: false,
        alphaGainCandidates: [1]
    });

    assert.ok(result.selectedTrial, 'expected size-jitter candidate to be selected');
    assert.equal(result.selectedTrial.provenance?.sizeJitter, true);
});

test('selectInitialCandidate should skip expensive size-jitter search when the standard candidate already leaves low residual', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPatternImageData(320, 320);
    const config = {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };

    applySyntheticWatermark(imageData, alpha48, position, 1);

    let interpolatedAlphaRequests = 0;
    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => {
            if (size !== 48 && size !== 96) {
                interpolatedAlphaRequests += 1;
            }
            return interpolateAlphaMap(alpha96, 96, size);
        },
        allowAdaptiveSearch: false,
        alphaGainCandidates: [1]
    });

    assert.ok(result.selectedTrial, 'expected standard candidate to be selected');
    assert.equal(interpolatedAlphaRequests, 0);
    assert.ok(result.source.startsWith('standard'), `source=${result.source}`);
});

test('selectInitialCandidate should reuse interpolated alpha maps across preview-anchor refinement', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPatternImageData(1024, 559);
    const config = {
        logoSize: 48,
        marginRight: 24,
        marginBottom: 24
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };
    const truePosition = {
        x: 1024 - 24 - 34,
        y: 559 - 24 - 34,
        width: 34,
        height: 34
    };
    const alpha34 = warpAlphaMap(interpolateAlphaMap(alpha96, 96, 34), 34, {
        dx: -1,
        dy: 1,
        scale: 0.985
    });
    applySyntheticWatermark(imageData, alpha34, truePosition, 1.1);

    const requestedSizes = [];
    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => {
            requestedSizes.push(size);
            return interpolateAlphaMap(alpha96, 96, size);
        },
        allowAdaptiveSearch: false,
        alphaGainCandidates: [1.04, 1.12, 1.22, 1.34]
    });

    assert.ok(result.selectedTrial, 'expected preview-anchor candidate to be selected');
    assert.ok(result.source.startsWith('standard+preview-anchor'), `source=${result.source}`);
    assert.equal(
        requestedSizes.length,
        new Set(requestedSizes).size,
        `expected preview-anchor alpha map requests to be cached by size, got ${JSON.stringify(requestedSizes)}`
    );
});

test('selectInitialCandidate should skip preview-anchor gain search when the candidate is already clean enough', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPatternImageData(1024, 559);
    const config = {
        logoSize: 48,
        marginRight: 24,
        marginBottom: 24
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };
    const truePosition = {
        x: 1024 - 24 - 34,
        y: 559 - 24 - 34,
        width: 34,
        height: 34
    };
    const alpha34 = warpAlphaMap(interpolateAlphaMap(alpha96, 96, 34), 34, {
        dx: -1,
        dy: 1,
        scale: 0.985
    });
    applySyntheticWatermark(imageData, alpha34, truePosition, 1.1);

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: false,
        alphaGainCandidates: [1.04, 1.12, 1.22, 1.34]
    });

    assert.ok(result.selectedTrial, 'expected preview-anchor candidate to be selected');
    assert.equal(result.alphaGain, 1, `expected no extra gain search, alphaGain=${result.alphaGain}`);
    assert.ok(
        !String(result.source).includes('+gain'),
        `expected preview-anchor path to skip gain sweep for an already-clean candidate, source=${result.source}`
    );
});

test('selectInitialCandidate should keep searching nearby on tall portrait images when the initial direct match is still misaligned', () => {
    const alpha96 = createSyntheticAlphaMap(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createPatternImageData(768, 1376);
    const config = {
        logoSize: 96,
        marginRight: 64,
        marginBottom: 64
    };
    const position = {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };
    const truePosition = {
        x: 768 - 59 - 96,
        y: 1376 - 59 - 96,
        width: 96,
        height: 96
    };

    applySyntheticWatermark(imageData, alpha96, truePosition, 1);

    const result = selectInitialCandidate({
        originalImageData: imageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: false,
        alphaGainCandidates: [1]
    });

    assert.ok(result.selectedTrial, 'expected a nearby standard candidate to be selected');
    assert.equal(result.selectedTrial.provenance?.localShift, true);
    assert.ok(
        Math.abs(result.position.x - truePosition.x) <= 1,
        `expected x to recover toward ${truePosition.x}, got ${result.position.x}`
    );
    assert.ok(
        Math.abs(result.position.y - truePosition.y) <= 1,
        `expected y to recover toward ${truePosition.y}, got ${result.position.y}`
    );
});

test('selectInitialCandidate should keep the canonical anchor for debug2-source when drifted candidates have weaker original evidence', async () => {
    const samplePath = path.resolve('src/assets/samples/debug2-source.png');
    try {
        await decodeImageDataInNode(samplePath);
    } catch {
        return;
    }

    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const originalImageData = await decodeImageDataInNode(samplePath);
    const config = {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
    const position = {
        x: 688,
        y: 1296,
        width: 48,
        height: 48
    };

    const result = selectInitialCandidate({
        originalImageData,
        config,
        position,
        alpha48,
        alpha96,
        getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size),
        allowAdaptiveSearch: true,
        alphaGainCandidates: [1.05, 1.12, 1.2, 1.28, 1.36, 1.45, 1.52, 1.6]
    });

    assert.ok(result.selectedTrial, 'expected a selected standard trial');
    assert.equal(result.source, 'standard');
    assert.deepEqual(result.position, position);
    assert.equal(result.selectedTrial.provenance?.localShift, undefined);
});

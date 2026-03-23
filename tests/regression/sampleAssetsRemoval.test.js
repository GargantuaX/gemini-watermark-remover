import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

import { chromium } from 'playwright';

import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { removeWatermark } from '../../src/core/blendModes.js';
import { removeRepeatedWatermarkLayers } from '../../src/core/multiPassRemoval.js';
import { processWatermarkImageData } from '../../src/core/watermarkProcessor.js';
import {
    computeRegionSpatialCorrelation,
    computeRegionGradientCorrelation,
    detectAdaptiveWatermarkRegion,
    interpolateAlphaMap,
    warpAlphaMap,
    shouldAttemptAdaptiveFallback
} from '../../src/core/adaptiveDetector.js';
import {
    hasReliableAdaptiveWatermarkSignal,
    hasReliableStandardWatermarkSignal
} from '../../src/core/watermarkPresence.js';
import {
    calculateWatermarkPosition,
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from '../../src/core/watermarkConfig.js';
import {
    decodeImageDataInPage,
    inferMimeType,
    isMissingPlaywrightExecutableError
} from './sampleAssetTestUtils.js';

const ROOT_DIR = process.cwd();
const SAMPLE_DIR = path.resolve(ROOT_DIR, 'src/assets/samples');
const BG48_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_48.png');
const BG96_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_96.png');
const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg']);
const KNOWN_GEMINI_SAMPLE_ASSETS = Object.freeze([
    '4.png',
    '5.png',
    '5.webp',
    '6.png',
    '7.png',
    'large.png',
    'large2.png',
    'large3.png'
]);
const KNOWN_GEMINI_RESIDUAL_EDGE_SAMPLE_ASSETS = Object.freeze([
    '5.png'
]);
const KNOWN_NON_GEMINI_SAMPLE_ASSETS = Object.freeze([
    'no-gemini.jpg'
]);
const RESIDUAL_RECALIBRATION_THRESHOLD = 0.5;
const MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION = 0.18;
const MIN_RECALIBRATION_SCORE_DELTA = 0.18;
const OUTLINE_REFINEMENT_THRESHOLD = 0.42;
const OUTLINE_REFINEMENT_MIN_GAIN = 1.2;
const ALPHA_GAIN_CANDIDATES = (() => {
    const candidates = [];

    for (let gain = 1.15; gain <= 1.65; gain += 0.01) {
        candidates.push(Number(gain.toFixed(2)));
    }

    for (let gain = 1.7; gain <= 2.6; gain += 0.1) {
        candidates.push(Number(gain.toFixed(2)));
    }

    return candidates;
})();
const NEAR_BLACK_THRESHOLD = 5;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const SUBPIXEL_SHIFTS = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75];
const SUBPIXEL_SCALES = [0.98, 0.99, 1, 1.01, 1.02];

test('sample asset manifest should classify every image sample exactly once', async () => {
    const files = (await readdir(SAMPLE_DIR))
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .filter((name) => !name.includes('-fix.'))
        .sort((a, b) => a.localeCompare(b));

    const classified = [
        ...KNOWN_GEMINI_SAMPLE_ASSETS,
        ...KNOWN_NON_GEMINI_SAMPLE_ASSETS
    ].sort((a, b) => a.localeCompare(b));

    assert.deepEqual(classified, files);
});

test('isMissingPlaywrightExecutableError should detect missing-browser launch error', () => {
    const error = new Error(
        'browserType.launch: Executable doesn\'t exist at /tmp/playwright/chrome-headless-shell'
    );
    assert.equal(isMissingPlaywrightExecutableError(error), true);
});

test('isMissingPlaywrightExecutableError should ignore unrelated errors', () => {
    const error = new Error('network timeout');
    assert.equal(isMissingPlaywrightExecutableError(error), false);
});

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function shouldRecalibrateAlphaStrength({ originalScore, processedScore, suppressionGain }) {
    return originalScore >= 0.6 &&
        processedScore >= RESIDUAL_RECALIBRATION_THRESHOLD &&
        suppressionGain <= MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION;
}

function recalibrateAlphaStrength({
    originalImageData,
    alphaMap,
    position,
    originalSpatialScore,
    processedSpatialScore,
    originalNearBlackRatio
}) {
    let bestScore = processedSpatialScore;
    let bestGain = 1;
    let bestImageData = null;
    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);

    for (const alphaGain of ALPHA_GAIN_CANDIDATES) {
        const candidate = cloneImageData(originalImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const candidateNearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (candidateNearBlackRatio > maxAllowedNearBlackRatio) {
            continue;
        }

        const score = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        });

        if (score < bestScore) {
            bestScore = score;
            bestGain = alphaGain;
            bestImageData = candidate;
        }
    }

    const scoreDelta = processedSpatialScore - bestScore;
    if (!bestImageData || scoreDelta < MIN_RECALIBRATION_SCORE_DELTA) {
        return null;
    }

    return {
        imageData: bestImageData,
        alphaGain: bestGain,
        processedSpatialScore: bestScore,
        suppressionGain: originalSpatialScore - bestScore
    };
}

function calculateNearBlackRatio(imageData, position) {
    let nearBlack = 0;
    let total = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
            const r = imageData.data[idx];
            const g = imageData.data[idx + 1];
            const b = imageData.data[idx + 2];
            if (r <= NEAR_BLACK_THRESHOLD && g <= NEAR_BLACK_THRESHOLD && b <= NEAR_BLACK_THRESHOLD) {
                nearBlack++;
            }
            total++;
        }
    }

    return total > 0 ? nearBlack / total : 0;
}

function measureRegionDelta(originalImageData, processedImageData, position) {
    let changedPixels = 0;
    let totalPixels = 0;
    let totalAbsoluteDelta = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * originalImageData.width + (position.x + col)) * 4;
            let pixelChanged = false;

            for (let channel = 0; channel < 3; channel++) {
                const delta = Math.abs(processedImageData.data[idx + channel] - originalImageData.data[idx + channel]);
                totalAbsoluteDelta += delta;
                if (delta > 0) pixelChanged = true;
            }

            if (pixelChanged) changedPixels++;
            totalPixels++;
        }
    }

    return {
        changedPixels,
        totalPixels,
        changedRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
        avgAbsoluteDeltaPerChannel: totalPixels > 0 ? totalAbsoluteDelta / (totalPixels * 3) : 0
    };
}

function getRegionStats(imageData, region) {
    let sum = 0;
    let sq = 0;
    let total = 0;

    for (let row = 0; row < region.height; row++) {
        for (let col = 0; col < region.width; col++) {
            const idx = ((region.y + row) * imageData.width + (region.x + col)) * 4;
            const lum =
                0.2126 * imageData.data[idx] +
                0.7152 * imageData.data[idx + 1] +
                0.0722 * imageData.data[idx + 2];
            sum += lum;
            sq += lum * lum;
            total++;
        }
    }

    const meanLum = total > 0 ? sum / total : 0;
    const variance = total > 0 ? Math.max(0, sq / total - meanLum * meanLum) : 0;

    return {
        meanLum,
        stdLum: Math.sqrt(variance)
    };
}

function refineSubpixelOutline({
    originalImageData,
    alphaMap,
    position,
    alphaGain,
    originalNearBlackRatio,
    baselineSpatialScore,
    baselineGradientScore
}) {
    const size = position.width;
    if (!size || size <= 8) return null;
    if (alphaGain < OUTLINE_REFINEMENT_MIN_GAIN) return null;

    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    const gainCandidates = [alphaGain];
    const lower = Math.max(1, Number((alphaGain - 0.02).toFixed(2)));
    const upper = Number((alphaGain + 0.02).toFixed(2));
    if (lower !== alphaGain) gainCandidates.push(lower);
    if (upper !== alphaGain) gainCandidates.push(upper);

    let best = null;
    for (const scale of SUBPIXEL_SCALES) {
        for (const dy of SUBPIXEL_SHIFTS) {
            for (const dx of SUBPIXEL_SHIFTS) {
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                for (const gain of gainCandidates) {
                    const candidate = cloneImageData(originalImageData);
                    removeWatermark(candidate, warped, position, { alphaGain: gain });
                    const nearBlackRatio = calculateNearBlackRatio(candidate, position);
                    if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

                    const spatialScore = computeRegionSpatialCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });
                    const gradientScore = computeRegionGradientCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });

                    const cost = Math.abs(spatialScore) * 0.6 + Math.max(0, gradientScore);
                    if (!best || cost < best.cost) {
                        best = {
                            imageData: candidate,
                            alphaMap: warped,
                            alphaGain: gain,
                            spatialScore,
                            gradientScore,
                            cost
                        };
                    }
                }
            }
        }
    }

    if (!best) return null;

    const improvedGradient = best.gradientScore <= baselineGradientScore - 0.04;
    const keptSpatial = Math.abs(best.spatialScore) <= Math.abs(baselineSpatialScore) + 0.08;
    if (!improvedGradient || !keptSpatial) return null;

    return best;
}

function removeWatermarkLikeEngine(imageData, alpha48, alpha96) {
    const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
    const resolvedConfig = resolveInitialStandardConfig({
        imageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    const defaultPosition = calculateWatermarkPosition(imageData.width, imageData.height, resolvedConfig);
    const defaultAlphaMap = resolvedConfig.logoSize === 96 ? alpha96 : alpha48;
    const standardScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap: defaultAlphaMap,
        region: {
            x: defaultPosition.x,
            y: defaultPosition.y,
            size: defaultPosition.width
        }
    });
    const standardGradient = computeRegionGradientCorrelation({
        imageData,
        alphaMap: defaultAlphaMap,
        region: {
            x: defaultPosition.x,
            y: defaultPosition.y,
            size: defaultPosition.width
        }
    });

    const processed = processWatermarkImageData(imageData, {
        alpha48,
        alpha96,
        getAlphaMap: (size) => {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return interpolateAlphaMap(alpha96, 96, size);
        }
    });

    const position = processed.meta.position ?? defaultPosition;
    const alphaMap = processed.meta.size === 96
        ? alpha96
        : (processed.meta.size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, position.width));
    const finalImageData = processed.imageData;

    if (processed.meta.applied === false) {
        const regionDelta = measureRegionDelta(imageData, imageData, position);
        return {
            beforeScore: standardScore,
            beforeGradient: standardGradient,
            afterScore: standardScore,
            afterGradient: standardGradient,
            improvement: 0,
            alphaGain: 1,
            beforeBlackRatio: calculateNearBlackRatio(imageData, position),
            afterBlackRatio: calculateNearBlackRatio(imageData, position),
            position,
            regionDelta,
            skipped: true
        };
    }

    const beforeScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    const beforeGradient = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });

    let afterScore = computeRegionSpatialCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    let afterGradient = computeRegionGradientCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    let improvement = beforeScore - afterScore;
    let alphaGain = 1;

    if (shouldRecalibrateAlphaStrength({
        originalScore: beforeScore,
        processedScore: afterScore,
        suppressionGain: improvement
    })) {
        const originalNearBlackRatio = calculateNearBlackRatio(imageData, position);
        const recalibrated = recalibrateAlphaStrength({
            originalImageData: imageData,
            alphaMap,
            position,
            originalSpatialScore: beforeScore,
            processedSpatialScore: afterScore,
            originalNearBlackRatio
        });

        if (recalibrated) {
            finalImageData = recalibrated.imageData;
            afterScore = recalibrated.processedSpatialScore;
            improvement = recalibrated.suppressionGain;
            alphaGain = recalibrated.alphaGain;
            afterGradient = computeRegionGradientCorrelation({
                imageData: finalImageData,
                alphaMap,
                region: {
                    x: position.x,
                    y: position.y,
                    size: position.width
                }
            });
        }
    }

    if (afterScore <= 0.3 && afterGradient >= OUTLINE_REFINEMENT_THRESHOLD) {
        const originalNearBlackRatio = calculateNearBlackRatio(imageData, position);
        const refined = refineSubpixelOutline({
            originalImageData: imageData,
            alphaMap,
            position,
            alphaGain,
            originalNearBlackRatio,
            baselineSpatialScore: afterScore,
            baselineGradientScore: afterGradient
        });

        if (refined) {
            finalImageData = refined.imageData;
            alphaMap = refined.alphaMap;
            alphaGain = refined.alphaGain;
            afterScore = refined.spatialScore;
            afterGradient = refined.gradientScore;
            improvement = beforeScore - afterScore;
        }
    }

    const beforeBlackRatio = calculateNearBlackRatio(imageData, position);
    const afterBlackRatio = calculateNearBlackRatio(finalImageData, position);
    const regionDelta = measureRegionDelta(imageData, finalImageData, position);

    return {
        beforeScore,
        beforeGradient,
        afterScore,
        afterGradient,
        improvement,
        alphaGain: processed.meta.alphaGain ?? 1,
        beforeBlackRatio,
        afterBlackRatio,
        position,
        regionDelta,
        skipped: false
    };
}

test('known Gemini sample assets should show strong watermark suppression after processing', async (t) => {
    const files = KNOWN_GEMINI_SAMPLE_ASSETS
        .filter((name) => !KNOWN_GEMINI_RESIDUAL_EDGE_SAMPLE_ASSETS.includes(name))
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()));

    assert.ok(files.length > 0, 'known Gemini sample asset list should not be empty');

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        if (isMissingPlaywrightExecutableError(error)) {
            t.skip('Playwright browser binaries are missing in this environment');
            return;
        }
        throw error;
    }

    const page = await browser.newPage();

    try {
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));

        for (const fileName of files) {
            const filePath = path.join(SAMPLE_DIR, fileName);
            const imageData = await decodeImageDataInPage(page, filePath);
            const result = removeWatermarkLikeEngine(imageData, alpha48, alpha96);

            assert.ok(
                !result.skipped,
                `${fileName}: expected processing pipeline to accept sample, spatial=${result.beforeScore}, gradient=${result.beforeGradient}`
            );
            assert.ok(
                result.afterScore < 0.22,
                `${fileName}: expected residual signal after processing < 0.22, got ${result.afterScore}`
            );
            assert.ok(
                result.improvement >= 0.3,
                `${fileName}: expected signal improvement >= 0.3, got ${result.improvement}`
            );
            if (result.alphaGain > 1) {
                assert.ok(
                    result.afterBlackRatio <= result.beforeBlackRatio + 0.05,
                    `${fileName}: alphaGain=${result.alphaGain} darkening too strong, beforeBlack=${result.beforeBlackRatio}, afterBlack=${result.afterBlackRatio}`
                );
            }
            if (result.afterScore < 0.22 && result.beforeGradient >= 0) {
                assert.ok(
                    result.afterGradient <= result.beforeGradient,
                    `${fileName}: expected outline gradient to not increase, before=${result.beforeGradient}, after=${result.afterGradient}`
                );
            }
        }
    } finally {
        await browser.close();
    }
});

test('6.png should not be skipped when the standard template has strong gradient evidence', async (t) => {
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        if (isMissingPlaywrightExecutableError(error)) {
            t.skip('Playwright browser binaries are missing in this environment');
            return;
        }
        throw error;
    }

    const page = await browser.newPage();

    try {
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));
        const filePath = path.join(SAMPLE_DIR, '6.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const result = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size)
        });
        const position = result.meta.position;
        const alphaMap = result.meta.size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, result.meta.size);
        const residual = computeRegionSpatialCorrelation({
            imageData: result.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });

        assert.equal(result.meta.applied, true, 'expected 6.png to enter removal pipeline');
        assert.ok(
            result.meta.source.startsWith('standard'),
            `expected 6.png to stay on a standard-template path, got ${result.meta.source}`
        );
        assert.equal(
            result.meta.decisionTier,
            'validated-match',
            `expected 6.png to be accepted through restoration validation, got decisionTier=${result.meta.decisionTier}, source=${result.meta.source}`
        );
        assert.equal(result.meta.size, 96, 'expected 6.png to use the 96px watermark template');
        assert.equal(result.meta.passCount, 1, `expected 6.png to stop after the first safe pass, got ${result.meta.passCount}`);
        assert.ok(residual < 0.22, `expected residual watermark signal < 0.22, got ${residual}`);
    } finally {
        await browser.close();
    }
});

test('7.png should remove a shifted bottom-right watermark instead of skipping the image', async (t) => {
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        if (isMissingPlaywrightExecutableError(error)) {
            t.skip('Playwright browser binaries are missing in this environment');
            return;
        }
        throw error;
    }

    const page = await browser.newPage();

    try {
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));
        const filePath = path.join(SAMPLE_DIR, '7.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const result = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size)
        });
        const position = result.meta.position;
        const alphaMap = result.meta.size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, result.meta.size);
        const residual = computeRegionSpatialCorrelation({
            imageData: result.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });

        assert.equal(result.meta.applied, true, 'expected 7.png to enter removal pipeline');
        assert.ok(
            result.meta.source.startsWith('standard'),
            `expected 7.png to stay on a standard-template path, got ${result.meta.source}`
        );
        assert.equal(
            result.meta.decisionTier,
            'validated-match',
            `expected 7.png to be accepted through restoration validation, got decisionTier=${result.meta.decisionTier}, source=${result.meta.source}`
        );
        assert.equal(result.meta.size, 48, `expected 7.png to use a 48px watermark template, got ${result.meta.size}`);
        assert.ok(
            position.x >= 928 && position.x <= 932,
            `expected 7.png x position to stay near the default anchor, got ${position.x}`
        );
        assert.ok(
            position.y >= 987 && position.y <= 995,
            `expected 7.png y position to stay near the default anchor, got ${position.y}`
        );
        assert.ok(residual < 0.22, `expected residual watermark signal < 0.22, got ${residual}`);
    } finally {
        await browser.close();
    }
});

test('known non-Gemini sample assets should keep the candidate region unchanged', async (t) => {
    const files = KNOWN_NON_GEMINI_SAMPLE_ASSETS.filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()));

    assert.ok(files.length > 0, 'known non-Gemini sample asset list should not be empty');

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        if (isMissingPlaywrightExecutableError(error)) {
            t.skip('Playwright browser binaries are missing in this environment');
            return;
        }
        throw error;
    }

    const page = await browser.newPage();

    try {
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));

        for (const fileName of files) {
            const filePath = path.join(SAMPLE_DIR, fileName);
            const imageData = await decodeImageDataInPage(page, filePath);
            const result = removeWatermarkLikeEngine(imageData, alpha48, alpha96);

            assert.ok(
                result.regionDelta.changedRatio <= 0.01,
                `${fileName}: expected weak-match region to remain unchanged, changedRatio=${result.regionDelta.changedRatio}, candidateSize=${result.position.width}`
            );
            assert.ok(
                result.regionDelta.avgAbsoluteDeltaPerChannel <= 0.5,
                `${fileName}: expected weak-match region delta <= 0.5, got ${result.regionDelta.avgAbsoluteDeltaPerChannel}`
            );
        }
    } finally {
        await browser.close();
    }
});

test('5.png should attempt repeated removal without overcommitting to a sinkhole pass', async (t) => {
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        if (isMissingPlaywrightExecutableError(error)) {
            t.skip('Playwright browser binaries are missing in this environment');
            return;
        }
        throw error;
    }

    const page = await browser.newPage();

    try {
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));
        const filePath = path.join(SAMPLE_DIR, '5.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
        const config = resolveInitialStandardConfig({
            imageData,
            defaultConfig,
            alpha48,
            alpha96
        });
        const position = calculateWatermarkPosition(imageData.width, imageData.height, config);
        const alphaMap = config.logoSize === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, config.logoSize);

        const beforeScore = computeRegionSpatialCorrelation({
            imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const result = removeRepeatedWatermarkLayers({
            imageData,
            alphaMap,
            position,
            maxPasses: 4
        });
        const afterScore = computeRegionSpatialCorrelation({
            imageData: result.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });

        assert.ok(
            (result.attemptedPassCount ?? result.passCount) >= 2,
            `expected repeated-pass attempt, got passCount=${result.passCount}, attempted=${result.attemptedPassCount}`
        );
        assert.ok(
            ['residual-low', 'safety-texture-collapse'].includes(result.stopReason),
            `unexpected stopReason=${result.stopReason}`
        );
        assert.ok(afterScore < beforeScore, `expected some suppression, before=${beforeScore}, after=${afterScore}`);
        assert.ok(
            beforeScore - afterScore >= 0.04,
            `expected strong suppression on 5.png, before=${beforeScore}, after=${afterScore}`
        );
    } finally {
        await browser.close();
    }
});

test('5.png multi-pass removal should avoid sinkhole-like texture collapse', async (t) => {
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        if (isMissingPlaywrightExecutableError(error)) {
            t.skip('Playwright browser binaries are missing in this environment');
            return;
        }
        throw error;
    }

    const page = await browser.newPage();

    try {
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));
        const filePath = path.join(SAMPLE_DIR, '5.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
        const config = resolveInitialStandardConfig({
            imageData,
            defaultConfig,
            alpha48,
            alpha96
        });
        const position = calculateWatermarkPosition(imageData.width, imageData.height, config);
        const alphaMap = config.logoSize === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, config.logoSize);
        const result = removeRepeatedWatermarkLayers({
            imageData,
            alphaMap,
            position,
            maxPasses: 4
        });

        const refRegion = {
            x: position.x,
            y: position.y - position.height,
            width: position.width,
            height: position.height
        };
        const processedStats = getRegionStats(result.imageData, position);
        const referenceStats = getRegionStats(imageData, refRegion);

        assert.ok(
            processedStats.meanLum >= referenceStats.meanLum - 1,
            `expected processed ROI to stay near local reference brightness, processed=${processedStats.meanLum}, reference=${referenceStats.meanLum}`
        );
        assert.ok(
            processedStats.stdLum >= referenceStats.stdLum * 0.8,
            `expected processed ROI to keep local texture variance, processed=${processedStats.stdLum}, reference=${referenceStats.stdLum}`
        );
    } finally {
        await browser.close();
    }
});

test('5.png metadata should report only the passes that were actually applied', async (t) => {
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        if (isMissingPlaywrightExecutableError(error)) {
            t.skip('Playwright browser binaries are missing in this environment');
            return;
        }
        throw error;
    }

    const page = await browser.newPage();

    try {
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));
        const filePath = path.join(SAMPLE_DIR, '5.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const processed = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            maxPasses: 4,
            getAlphaMap: (size) => size === 48 ? alpha48 : size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size)
        });

        const appliedPasses = processed.meta.passes ?? [];
        const lastAppliedIndex = appliedPasses.length > 0
            ? appliedPasses[appliedPasses.length - 1].index
            : 0;

        assert.equal(
            processed.meta.passCount,
            lastAppliedIndex,
            `passCount=${processed.meta.passCount}, lastAppliedIndex=${lastAppliedIndex}, stop=${processed.meta.passStopReason}`
        );
    } finally {
        await browser.close();
    }
});

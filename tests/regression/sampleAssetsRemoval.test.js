import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, readFile, readdir } from 'node:fs/promises';

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
const BG96_20260520_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_96_20260520.png');
const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg']);
const EXACT_OFFICIAL_48_SAMPLE_ASSETS = Object.freeze([
    '1-1.png',
    '21-9.png',
    '3-2.png',
    '3-4.png',
    '4-3.png',
    '4-5.png',
    '5-4.png'
]);
const RESIDUAL_RECALIBRATION_THRESHOLD = 0.5;
const MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION = 0.18;
const MIN_RECALIBRATION_SCORE_DELTA = 0.18;
const OUTLINE_REFINEMENT_THRESHOLD = 0.42;
const OUTLINE_REFINEMENT_MIN_GAIN = 1.2;
const ALPHA_GAIN_CANDIDATES = Object.freeze([0.6, 1, 0.55, 0.7, 0.85]);
const NEAR_BLACK_THRESHOLD = 5;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const SUBPIXEL_SHIFTS = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75];
const SUBPIXEL_SCALES = [0.98, 0.99, 1, 1.01, 1.02];
const FIXED_CORE_UNSUPPORTED_SAMPLE_ASSETS = new Set();

async function loadSampleGoldManifest() {
    try {
        const manifest = JSON.parse(await readFile(path.join(SAMPLE_DIR, 'gold-manifest.json'), 'utf8'));
        return manifest.samples && typeof manifest.samples === 'object'
            ? manifest.samples
            : {};
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return {};
    }
}

async function ensureSampleAssetAvailable(t, fileName) {
    try {
        await access(path.join(SAMPLE_DIR, fileName));
        return true;
    } catch {
        t.skip(`${fileName} is not present in the current fixture set`);
        return false;
    }
}

async function listSampleAssetFiles() {
    return (await readdir(SAMPLE_DIR))
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .filter((name) => !name.includes('-fix.'))
        .filter((name) => !name.includes('-after.'))
        .filter((name) => !name.startsWith('Gemini_Generated_Image_'))
        .sort((a, b) => a.localeCompare(b));
}

test('sample asset manifest should expose at least one supported fixture image for every sample base name', async () => {
    const files = await listSampleAssetFiles();
    const variantsByBaseName = new Map();

    for (const fileName of files) {
        const ext = path.extname(fileName).toLowerCase();
        const baseName = path.basename(fileName, ext);
        const variants = variantsByBaseName.get(baseName) ?? new Set();
        variants.add(ext);
        variantsByBaseName.set(baseName, variants);
    }

    assert.ok(files.length > 0, 'expected sample asset directory to contain regression images');
    assert.ok(variantsByBaseName.size > 0, 'expected at least one sample base name');

    for (const [baseName, variants] of variantsByBaseName) {
        assert.ok(
            variants.has('.webp') || variants.has('.png') || variants.has('.jpg') || variants.has('.jpeg'),
            `expected ${baseName} to provide at least one supported sample variant`
        );
    }
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

function createSolidImageData(width, height, value = 32) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        data[idx] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
        data[idx + 3] = 255;
    }

    return { width, height, data };
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

function measureAlphaBandHalo(imageData, position, alphaMap, {
    minAlpha = 0.12,
    maxAlpha = 0.35,
    outsideAlphaMax = 0.01,
    outerMargin = 3
} = {}) {
    let bandSum = 0;
    let bandSq = 0;
    let bandCount = 0;
    let outerSum = 0;
    let outerSq = 0;
    let outerCount = 0;

    for (let row = -outerMargin; row < position.height + outerMargin; row++) {
        for (let col = -outerMargin; col < position.width + outerMargin; col++) {
            const pixelX = position.x + col;
            const pixelY = position.y + row;
            if (pixelX < 0 || pixelY < 0 || pixelX >= imageData.width || pixelY >= imageData.height) {
                continue;
            }

            const pixelIndex = (pixelY * imageData.width + pixelX) * 4;
            const luminance =
                0.2126 * imageData.data[pixelIndex] +
                0.7152 * imageData.data[pixelIndex + 1] +
                0.0722 * imageData.data[pixelIndex + 2];
            const insideRegion = row >= 0 && col >= 0 && row < position.height && col < position.width;
            const alpha = insideRegion
                ? alphaMap[row * position.width + col]
                : 0;

            if (insideRegion && alpha >= minAlpha && alpha <= maxAlpha) {
                bandSum += luminance;
                bandSq += luminance * luminance;
                bandCount++;
                continue;
            }

            if (!insideRegion || alpha <= outsideAlphaMax) {
                outerSum += luminance;
                outerSq += luminance * luminance;
                outerCount++;
            }
        }
    }

    const bandMeanLum = bandCount > 0 ? bandSum / bandCount : 0;
    const outerMeanLum = outerCount > 0 ? outerSum / outerCount : 0;
    const bandStdLum = bandCount > 0 ? Math.sqrt(Math.max(0, bandSq / bandCount - bandMeanLum * bandMeanLum)) : 0;
    const outerStdLum = outerCount > 0 ? Math.sqrt(Math.max(0, outerSq / outerCount - outerMeanLum * outerMeanLum)) : 0;

    return {
        bandCount,
        outerCount,
        bandMeanLum,
        outerMeanLum,
        deltaLum: bandMeanLum - outerMeanLum,
        bandStdLum,
        outerStdLum,
        visibility: (bandMeanLum - outerMeanLum) / Math.max(1, outerStdLum)
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

function removeWatermarkLikeEngine(imageData, alpha48, alpha96, alpha96NewMargin = null) {
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
        alpha96Variants: alpha96NewMargin ? {
            '20260520': alpha96NewMargin
        } : null,
        getAlphaMap: (size) => {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return interpolateAlphaMap(alpha96, 96, size);
        }
    });

    const position = processed.meta.position ?? defaultPosition;
    const usesNewMarginAlpha = processed.meta.size === 96 &&
        processed.meta.config?.marginRight === 192 &&
        processed.meta.config?.marginBottom === 192 &&
        alpha96NewMargin;
    let alphaMap = usesNewMarginAlpha
        ? alpha96NewMargin
        : (
            processed.meta.size === 96
                ? alpha96
                : (processed.meta.size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, position.width))
        );
    if (processed.meta.templateWarp) {
        alphaMap = warpAlphaMap(alphaMap, position.width, processed.meta.templateWarp);
    }
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
            skipped: true,
            meta: processed.meta
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
        skipped: false,
        meta: processed.meta
    };
}

test('known Gemini sample assets should show strong watermark suppression after processing', async (t) => {
    const files = await listSampleAssetFiles();
    const goldManifest = await loadSampleGoldManifest();

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
        const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInPage(page, BG96_20260520_PATH));

        for (const fileName of files) {
            const filePath = path.join(SAMPLE_DIR, fileName);
            const imageData = await decodeImageDataInPage(page, filePath);
            const result = removeWatermarkLikeEngine(imageData, alpha48, alpha96, alpha96NewMargin);

            if (FIXED_CORE_UNSUPPORTED_SAMPLE_ASSETS.has(fileName)) {
                assert.equal(
                    result.skipped,
                    true,
                    `${fileName}: expected fixed core to skip unsupported pure inverse sample`
                );
                continue;
            }

            assert.ok(
                !result.skipped,
                `${fileName}: expected processing pipeline to accept sample, spatial=${result.beforeScore}, gradient=${result.beforeGradient}`
            );
            const gold = goldManifest[fileName] ?? {};
            const allowsWeakResidual = gold.allowWeakResidual === true;
            const tags = Array.isArray(gold.tags) ? gold.tags : [];
            const allowsModerateSignalStandardAlpha =
                tags.includes('moderate-signal-standard-alpha') &&
                result.alphaGain <= 1 &&
                result.afterScore < 0.22 &&
                result.afterGradient <= 0.02;
            if (allowsWeakResidual) {
                assert.ok(
                    result.afterScore < 0.35,
                    `${fileName}: expected bounded allowed residual signal after processing < 0.35, got ${result.afterScore}`
                );
            } else {
                assert.ok(
                    result.afterScore < 0.22,
                    `${fileName}: expected residual signal after processing < 0.22, got ${result.afterScore}`
                );
            }
            assert.ok(
                result.improvement >= 0.3 || result.afterScore < 0.05 || allowsModerateSignalStandardAlpha,
                `${fileName}: expected strong suppression gain or near-zero residual, gain=${result.improvement}, residual=${result.afterScore}`
            );
            if (result.alphaGain > 1) {
                assert.ok(
                    result.afterBlackRatio <= result.beforeBlackRatio + 0.05,
                    `${fileName}: alphaGain=${result.alphaGain} darkening too strong, beforeBlack=${result.beforeBlackRatio}, afterBlack=${result.afterBlackRatio}`
                );
            }
            const isLossyJpegSample = ['.jpg', '.jpeg'].includes(path.extname(fileName).toLowerCase());
            if (!isLossyJpegSample && result.afterScore < 0.22 && result.beforeGradient >= 0) {
                assert.ok(
                    result.afterGradient <= result.beforeGradient + 0.05,
                    `${fileName}: expected outline gradient to not increase, before=${result.beforeGradient}, after=${result.afterGradient}`
                );
            }
        }
    } finally {
        await browser.close();
    }
});

test('low-contrast catalog watermarks should use conservative removal instead of skipping', async (t) => {
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
        const cases = [
            {
                fileName: '2-3.png',
                minOriginalSpatialScore: 0.12,
                minOriginalGradientScore: 0.08,
                maxProcessedSpatialScore: 0.04,
                maxProcessedGradientScore: 0.12
            },
            {
                fileName: '8-1.png',
                minOriginalSpatialScore: 0.45,
                minOriginalGradientScore: 0.45,
                maxProcessedSpatialScore: 0.12,
                maxProcessedGradientScore: 0.12
            }
        ];

        for (const item of cases) {
            const sampleAvailable = await ensureSampleAssetAvailable(t, item.fileName);
            if (!sampleAvailable) continue;

            const filePath = path.join(SAMPLE_DIR, item.fileName);
            const imageData = await decodeImageDataInPage(page, filePath);
            const result = processWatermarkImageData(imageData, {
                alpha48,
                alpha96,
                getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size)
            });

            assert.equal(result.meta.applied, true, `${item.fileName} skipReason=${result.meta.skipReason}`);
            assert.equal(result.meta.size, 48, `${item.fileName} expected 48px watermark`);
            assert.deepEqual(
                result.meta.config,
                { logoSize: 48, marginRight: 96, marginBottom: 96 },
                `${item.fileName} expected current large-margin catalog anchor`
            );
            assert.equal(result.meta.alphaGain, 0.55, `${item.fileName} expected conservative alpha gain`);
            assert.ok(
                String(result.meta.source).includes('catalog'),
                `${item.fileName} expected catalog source, got ${result.meta.source}`
            );
            assert.ok(
                result.meta.detection.originalSpatialScore >= item.minOriginalSpatialScore &&
                    result.meta.detection.originalGradientScore >= item.minOriginalGradientScore,
                `${item.fileName} expected original signal, detection=${JSON.stringify(result.meta.detection)}`
            );
            assert.ok(
                Math.abs(result.meta.detection.processedSpatialScore) <= item.maxProcessedSpatialScore &&
                    result.meta.detection.processedGradientScore <= item.maxProcessedGradientScore,
                `${item.fileName} expected conservative residual, detection=${JSON.stringify(result.meta.detection)}`
            );
        }
    } finally {
        await browser.close();
    }
});

test('20260617.png should keep the full canonical 96px star watermark anchor', async (t) => {
    if (!await ensureSampleAssetAvailable(t, '20260617.png')) return;

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
        const filePath = path.join(SAMPLE_DIR, '20260617.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const result = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            getAlphaMap: (size) => size === 48 ? alpha48 : size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size)
        });

        assert.equal(result.meta.applied, true, 'expected 20260617.png to enter removal pipeline');
        assert.deepEqual(
            result.meta.config,
            { logoSize: 96, marginRight: 64, marginBottom: 64 },
            `expected canonical 96px anchor, got ${JSON.stringify(result.meta.config)}`
        );
        assert.equal(result.meta.alphaGain, 1, `expected standard alpha, got ${result.meta.alphaGain}`);
        assert.ok(
            !String(result.meta.source).includes('localized-small'),
            `expected full canonical 96px removal, source=${result.meta.source}`
        );
        assert.ok(
            result.meta.detection.processedGradientScore <= 0.02,
            `expected standard alpha to keep edge residual low, detection=${JSON.stringify(result.meta.detection)}`
        );
        assert.ok(
            result.meta.detection.processedSpatialScore <= 0.26,
            `expected bounded standard-alpha residual, detection=${JSON.stringify(result.meta.detection)}`
        );
    } finally {
        await browser.close();
    }
});

test('exact-official 1K sample assets with visible 48px watermark should fall back to the 48px template', async (t) => {
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
        for (const fileName of EXACT_OFFICIAL_48_SAMPLE_ASSETS) {
            const filePath = path.join(SAMPLE_DIR, fileName);
            const imageData = await decodeImageDataInPage(page, filePath);
            const result = processWatermarkImageData(imageData, {
                alpha48,
                alpha96,
                getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size)
            });

            if (FIXED_CORE_UNSUPPORTED_SAMPLE_ASSETS.has(fileName)) {
                assert.equal(result.meta.applied, false, `expected ${fileName} to stay unsupported in fixed core`);
                continue;
            }

            const position = result.meta.position;
            const residual = computeRegionSpatialCorrelation({
                imageData: result.imageData,
                alphaMap: alpha48,
                region: { x: position.x, y: position.y, size: position.width }
            });

            assert.equal(result.meta.applied, true, `expected ${fileName} to enter removal pipeline`);
            assert.ok(
                result.meta.decisionTier === 'direct-match' || result.meta.decisionTier === 'validated-match',
                `expected ${fileName} to be a fixed-core 48px match, got ${result.meta.decisionTier}`
            );
            assert.equal(result.meta.size, 48, `expected ${fileName} to use a 48px watermark template, got ${result.meta.size}`);
            assert.ok(result.meta.source.startsWith('standard'), `expected ${fileName} to stay on a standard-template path, got ${result.meta.source}`);
            assert.ok(residual < 0.22, `expected ${fileName} residual watermark signal < 0.22, got ${residual}`);
        }
    } finally {
        await browser.close();
    }
});

test('9-16.png should stop after the first pass when extra passes only reintroduce watermark edges', async (t) => {
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
        const filePath = path.join(SAMPLE_DIR, '9-16.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const firstPassOnly = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size),
            locatedAggressiveRemoval: false
        });
        const fullResult = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            getAlphaMap: (size) => size === 48 ? alpha48 : interpolateAlphaMap(alpha96, 96, size),
            locatedAggressiveRemoval: false
        });
        const position = fullResult.meta.position;
        const alphaMap = fullResult.meta.size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, fullResult.meta.size);
        const firstPassGradient = computeRegionGradientCorrelation({
            imageData: firstPassOnly.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const finalGradient = computeRegionGradientCorrelation({
            imageData: fullResult.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });

        assert.equal(fullResult.meta.applied, true, 'expected 9-16.png to enter removal pipeline');
        assert.equal(
            fullResult.meta.passCount,
            1,
            `expected 9-16.png to stop after the first pass, got passCount=${fullResult.meta.passCount}, stop=${fullResult.meta.passStopReason}`
        );
        assert.ok(
            finalGradient <= firstPassGradient + 0.05,
            `expected extra passes to not reintroduce edge signal, firstPassGradient=${firstPassGradient}, finalGradient=${finalGradient}`
        );
    } finally {
        await browser.close();
    }
});

test('9-16.png should fall back to the 48px anchor when the exact-official 96px evidence is weak', async (t) => {
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
        const filePath = path.join(SAMPLE_DIR, '9-16.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const result = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            getAlphaMap: (size) => size === 48 ? alpha48 : size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size)
        });

        assert.equal(result.meta.applied, true, 'expected 9-16.png to enter removal pipeline');
        assert.equal(result.meta.size, 48, `expected 9-16.png to fall back to the 48px template, got ${result.meta.size}`);
        assert.deepEqual(
            result.meta.selectionDebug?.initialConfig,
            { logoSize: 48, marginRight: 96, marginBottom: 96 },
            `expected initial standard config to be re-resolved to 48px, got ${JSON.stringify(result.meta.selectionDebug?.initialConfig)}`
        );
        assert.equal(
            result.meta.selectionDebug?.usedCatalogVariant,
            false,
            `expected fallback to come from the standard 48px comparison, source=${result.meta.source}`
        );
        assert.ok(
            result.meta.source.startsWith('standard'),
            `expected standard fallback path, got ${result.meta.source}`
        );
        assert.ok(
            result.meta.position.x >= 620 && result.meta.position.x <= 628,
            `expected fallback x anchor near the 48px bottom-right position, got ${result.meta.position.x}`
        );
        assert.ok(
            result.meta.position.y >= 1228 && result.meta.position.y <= 1236,
            `expected fallback y anchor near the 48px bottom-right position, got ${result.meta.position.y}`
        );
    } finally {
        await browser.close();
    }
});

test('9-16-preview.png should keep the preview anchor away from the extreme bottom-right corner', async (t) => {
    if (!await ensureSampleAssetAvailable(t, '9-16-preview.png')) return;

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
        const filePath = path.join(SAMPLE_DIR, '9-16-preview.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const result = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            getAlphaMap: (size) => size === 48 ? alpha48 : size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size)
        });

        assert.equal(result.meta.applied, true, 'expected 9-16-preview.png to enter removal pipeline');
        assert.ok(
            result.meta.source.includes('preview-anchor'),
            `expected 9-16-preview.png to use preview-anchor search, source=${result.meta.source}`
        );
        assert.ok(
            result.meta.position.width >= 34 && result.meta.position.width <= 36,
            `expected preview watermark size near 35px, got ${result.meta.position.width}`
        );
        assert.ok(
            result.meta.position.x >= 512 && result.meta.position.x <= 516,
            `expected preview watermark x anchor near the projected preview position, got ${result.meta.position.x}`
        );
        assert.ok(
            result.meta.position.y >= 964 && result.meta.position.y <= 968,
            `expected preview watermark y anchor near the projected preview position, got ${result.meta.position.y}`
        );
        assert.equal(
            result.meta.passCount,
            1,
            `expected 9-16-preview.png preview-anchor removal to stop after the first pass, got ${result.meta.passCount}`
        );
        assert.ok(
            !result.meta.source.includes('+multipass'),
            `expected 9-16-preview.png preview-anchor path to skip multipass, source=${result.meta.source}`
        );
    } finally {
        await browser.close();
    }
});

test('21-9-preview.png should use fixed preview-anchor without edge cleanup by default', async (t) => {
    if (!await ensureSampleAssetAvailable(t, '21-9-preview.png')) return;

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
        const filePath = path.join(SAMPLE_DIR, '21-9-preview.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const result = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            getAlphaMap: (size) => size === 48 ? alpha48 : size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size)
        });

        assert.equal(result.meta.applied, true, 'expected 21-9-preview.png to enter removal pipeline');
        assert.ok(
            result.meta.source.includes('preview-anchor'),
            `expected 21-9-preview.png to use fixed preview-anchor config, source=${result.meta.source}`
        );
        assert.ok(
            !result.meta.source.includes('+edge-cleanup'),
            `expected preview edge cleanup to stay disabled, source=${result.meta.source}`
        );
        assert.ok(
            result.meta.position.width >= 29 && result.meta.position.width <= 31,
            `expected preview watermark size near 30px, got ${result.meta.position.width}`
        );
        assert.ok(
            Math.abs(result.meta.detection.processedSpatialScore) < 0.22,
            `expected residual preview spatial < 0.22, got ${result.meta.detection.processedSpatialScore}`
        );
    } finally {
        await browser.close();
    }
});

test('Gemini-like dimensions should not force processing when watermark evidence is absent', async (t) => {
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
        const imageData = createSolidImageData(1408, 768, 48);
        const result = removeWatermarkLikeEngine(imageData, alpha48, alpha96);

        assert.equal(result.meta.applied, false);
        assert.equal(result.skipped, true);
        assert.equal(result.meta.skipReason, 'no-watermark-detected');
        assert.notEqual(result.meta.retryRecommended, true);
        assert.equal(result.regionDelta.changedRatio, 0);
    } finally {
        await browser.close();
    }
});

test('16-9.png repeated removal helper should stop after the first pass when residual is already low', async (t) => {
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
        const filePath = path.join(SAMPLE_DIR, '16-9.png');
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
            alphaGain: 0.6
        });
        const afterScore = computeRegionSpatialCorrelation({
            imageData: result.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });

        assert.equal(result.passCount, 1, `expected a single applied pass, got ${result.passCount}`);
        assert.equal(result.attemptedPassCount, 1, `expected no extra pass attempt, got ${result.attemptedPassCount}`);
        assert.equal(result.stopReason, 'residual-low', `unexpected stopReason=${result.stopReason}`);
        assert.ok(afterScore < beforeScore, `expected some suppression, before=${beforeScore}, after=${afterScore}`);
        assert.ok(
            beforeScore - afterScore >= 0.04,
            `expected strong suppression on 16-9.png, before=${beforeScore}, after=${afterScore}`
        );
    } finally {
        await browser.close();
    }
});

test('16-9.png repeated removal helper should keep the ROI out of sinkhole-like collapse', async (t) => {
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
        const filePath = path.join(SAMPLE_DIR, '16-9.png');
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
            processedStats.meanLum >= referenceStats.meanLum - 6,
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

test('16-9.png metadata should report only the passes that were actually applied', async (t) => {
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
        const filePath = path.join(SAMPLE_DIR, '16-9.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const processed = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
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

test('16-9.png should not ship a hard-rejected standard candidate when a safer nearby size exists', async (t) => {
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
        const filePath = path.join(SAMPLE_DIR, '16-9.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const processed = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            getAlphaMap: (size) => size === 48 ? alpha48 : size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size)
        });

        assert.equal(processed.meta.applied, true, 'expected 16-9.png to enter removal pipeline');
        assert.equal(
            processed.meta.selectionDebug?.hardReject,
            false,
            `expected 16-9.png final candidate to avoid hard-reject fallback, selectionDebug=${JSON.stringify(processed.meta.selectionDebug)}`
        );
    } finally {
        await browser.close();
    }
});

test('16-9.png should keep canonical outline gradient from rising after standard refinement', async (t) => {
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
        const filePath = path.join(SAMPLE_DIR, '16-9.png');
        const imageData = await decodeImageDataInPage(page, filePath);
        const result = removeWatermarkLikeEngine(imageData, alpha48, alpha96);

        assert.ok(!result.skipped, 'expected 16-9.png to be processed');
        assert.ok(
            result.afterGradient <= result.beforeGradient,
            `expected canonical outline gradient to not increase, before=${result.beforeGradient}, after=${result.afterGradient}`
        );
    } finally {
        await browser.close();
    }
});

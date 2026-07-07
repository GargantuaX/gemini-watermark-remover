import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { chromium } from 'playwright';

import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { interpolateAlphaMap, computeRegionSpatialCorrelation } from '../../src/core/adaptiveDetector.js';
import { processWatermarkImageData } from '../../src/core/watermarkProcessor.js';
import {
    decodeImageDataInPage,
    isMissingPlaywrightExecutableError
} from './sampleAssetTestUtils.js';

const ROOT_DIR = process.cwd();
const FIXTURE_PATH = path.resolve(ROOT_DIR, 'tests/fixtures/real-page-preview-1024x559.png');
const STRONG_FIXTURE_PATH = path.resolve(ROOT_DIR, 'tests/fixtures/real-page-preview-strong-1024x559.png');
const BG48_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_48.png');
const BG96_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_96.png');

test('real Gemini preview-sized page image should remove the bottom-right watermark instead of skipping', async (t) => {
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
        const imageData = await decodeImageDataInPage(page, FIXTURE_PATH);
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));

        const result = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            adaptiveMode: 'never',
            getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size)
        });

        assert.equal(result.meta.applied, true, `skipReason=${result.meta.skipReason}`);
        assert.ok(
            result.meta.position.width >= 30 && result.meta.position.width <= 40,
            `expected preview watermark size near 34px, got ${result.meta.position.width}`
        );
        assert.ok(
            result.meta.position.x >= 960 && result.meta.position.x <= 970,
            `x=${result.meta.position.x}`
        );
        assert.ok(
            result.meta.position.y >= 497 && result.meta.position.y <= 505,
            `y=${result.meta.position.y}`
        );

        const alphaMap = interpolateAlphaMap(alpha96, 96, result.meta.position.width);
        const residual = computeRegionSpatialCorrelation({
            imageData: result.imageData,
            alphaMap,
            region: {
                x: result.meta.position.x,
                y: result.meta.position.y,
                size: result.meta.position.width
            }
        });
        assert.ok(residual < 0.22, `expected residual watermark signal < 0.22, got ${residual}`);
        assert.ok(
            result.meta.detection.processedGradientScore < result.meta.detection.originalGradientScore,
            `expected preview outline gradient to decrease, before=${result.meta.detection.originalGradientScore}, after=${result.meta.detection.processedGradientScore}`
        );
        assert.ok(
            result.meta.detection.processedGradientScore < 0.32,
            `expected preview outline residual gradient < 0.32 without edge cleanup, got ${result.meta.detection.processedGradientScore}`
        );
    } finally {
        await browser.close();
    }
});

test('real Gemini preview path should use gated edge cleanup without subpixel refinement', async (t) => {
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
        const imageData = await decodeImageDataInPage(page, FIXTURE_PATH);
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));

        const result = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            adaptiveMode: 'never',
            debugTimings: true,
            getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size)
        });

        assert.ok(result.meta.applied, `skipReason=${result.meta.skipReason}`);
        assert.ok(
            result.meta.source.includes('preview-anchor'),
            `expected preview real page fixture to stay on preview-anchor localization, source=${result.meta.source}`
        );
        assert.ok(
            result.meta.source.includes('+edge-cleanup'),
            `expected preview real page fixture to use gated edge cleanup, source=${result.meta.source}`
        );
        assert.equal(result.meta.subpixelShift, null, `expected no accepted subpixel shift, source=${result.meta.source}`);
        assert.ok(
            result.meta.passes?.[0]?.afterSpatialScore < 0.05,
            `expected first pass to already suppress spatial residual, got ${result.meta.passes?.[0]?.afterSpatialScore}`
        );
        assert.ok(
            result.debugTimings.subpixelRefinementMs < 5,
            `expected preview path to skip expensive subpixel sweep, got ${result.debugTimings.subpixelRefinementMs}ms`
        );
    } finally {
        await browser.close();
    }
});

test('real Gemini strong preview fixture should use gated cleanup without subpixel refinement', async (t) => {
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
        const imageData = await decodeImageDataInPage(page, STRONG_FIXTURE_PATH);
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));

        const result = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            adaptiveMode: 'never',
            debugTimings: true,
            getAlphaMap: (size) => interpolateAlphaMap(alpha96, 96, size)
        });

        assert.ok(result.meta.applied, `skipReason=${result.meta.skipReason}`);
        assert.ok(
            result.meta.position.width >= 30 && result.meta.position.width <= 40,
            `expected preview watermark size near 35px, got ${result.meta.position.width}`
        );
        assert.equal(result.meta.subpixelShift, null, `expected no accepted subpixel shift, source=${result.meta.source}`);
        assert.ok(
            Math.abs(result.meta.detection.processedSpatialScore) < 0.18,
            `expected fixed-core inverse to keep spatial residual within a safe range, got ${result.meta.detection.processedSpatialScore}`
        );
        assert.ok(
            result.meta.detection.processedGradientScore < result.meta.detection.originalGradientScore,
            `expected fixed-core inverse to reduce residual gradient, before=${result.meta.detection.originalGradientScore}, after=${result.meta.detection.processedGradientScore}`
        );
        assert.ok(
            result.meta.source.includes('preview-anchor'),
            `expected strong preview fixture to stay on preview-anchor localization, source=${result.meta.source}`
        );
        assert.ok(
            result.meta.source.includes('+edge-cleanup'),
            `expected strong preview fixture to use gated edge cleanup, source=${result.meta.source}`
        );
        assert.ok(
            result.debugTimings.subpixelRefinementMs < 5,
            `expected preview path to skip expensive no-op subpixel sweep, got ${result.debugTimings.subpixelRefinementMs}ms`
        );
    } finally {
        await browser.close();
    }
});

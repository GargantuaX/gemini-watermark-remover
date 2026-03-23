import test from 'node:test';
import assert from 'node:assert/strict';

import {
    matchOfficialGeminiImageSize,
    resolveGeminiWatermarkSearchConfigs,
    resolveOfficialGeminiSearchConfigs,
    resolveOfficialGeminiWatermarkConfig
} from '../../src/core/geminiSizeCatalog.js';

test('matchOfficialGeminiImageSize should match documented Gemini 3.x 1K size', () => {
    const match = matchOfficialGeminiImageSize(848, 1264);

    assert.equal(match.aspectRatio, '2:3');
    assert.equal(match.width, 848);
    assert.equal(match.height, 1264);
    assert.equal(match.resolutionTier, '1k');
    assert.equal(match.modelFamily, 'gemini-3.x-image');
});

test('matchOfficialGeminiImageSize should match documented Gemini 2.5 Flash Image size', () => {
    const match = matchOfficialGeminiImageSize(832, 1248);

    assert.equal(match.aspectRatio, '2:3');
    assert.equal(match.width, 832);
    assert.equal(match.height, 1248);
    assert.equal(match.modelFamily, 'gemini-2.5-flash-image');
});

test('resolveOfficialGeminiWatermarkConfig should use 96px watermark for documented 1K portrait output', () => {
    assert.deepEqual(
        resolveOfficialGeminiWatermarkConfig(768, 1376),
        { logoSize: 96, marginRight: 64, marginBottom: 64 }
    );
});

test('resolveOfficialGeminiWatermarkConfig should return null for unknown non-official dimensions', () => {
    assert.equal(resolveOfficialGeminiWatermarkConfig(1000, 1000), null);
});

test('resolveOfficialGeminiSearchConfigs should map near-official portrait dimensions to scaled anchor configs', () => {
    const configs = resolveOfficialGeminiSearchConfigs(1000, 1792);

    assert.ok(configs.length > 0);
    assert.deepEqual(configs[0], {
        logoSize: 125,
        marginRight: 83,
        marginBottom: 83
    });
});

test('resolveGeminiWatermarkSearchConfigs should keep default config first and dedupe identical catalog matches', () => {
    const configs = resolveGeminiWatermarkSearchConfigs(768, 1376, {
        logoSize: 96,
        marginRight: 64,
        marginBottom: 64
    });

    assert.deepEqual(configs[0], {
        logoSize: 96,
        marginRight: 64,
        marginBottom: 64
    });
    assert.equal(
        configs.filter((config) => (
            config.logoSize === 96 &&
            config.marginRight === 64 &&
            config.marginBottom === 64
        )).length,
        1
    );
});

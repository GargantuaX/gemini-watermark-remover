import test from 'node:test';
import assert from 'node:assert/strict';

import {
    OFFICIAL_GEMINI_IMAGE_SIZES,
    matchOfficialGeminiImageSize,
    resolveGeminiWatermarkSearchCatalogEntries,
    resolveGeminiWatermarkSearchConfigs,
    resolveOfficialGeminiSearchConfigEntries,
    resolveOfficialGeminiSearchConfigs,
    resolveOfficialGeminiWatermarkConfig
} from '../../src/core/geminiSizeCatalog.js';

function createDocumentedRows(modelFamily, resolutionTier, rows) {
    return rows.map(([aspectRatio, width, height]) => ({
        modelFamily,
        resolutionTier,
        aspectRatio,
        width,
        height
    }));
}

const DOCUMENTED_GEMINI_IMAGE_SIZES = Object.freeze([
    ...createDocumentedRows('gemini-3.x-image', '0.5k', [
        ['1:1', 512, 512],
        ['1:4', 256, 1024],
        ['1:8', 192, 1536],
        ['2:3', 424, 632],
        ['3:2', 632, 424],
        ['3:4', 448, 600],
        ['4:1', 1024, 256],
        ['4:3', 600, 448],
        ['4:5', 464, 576],
        ['5:4', 576, 464],
        ['8:1', 1536, 192],
        ['9:16', 384, 688],
        ['16:9', 688, 384],
        ['21:9', 792, 168]
    ]),
    ...createDocumentedRows('gemini-3.x-image', '1k', [
        ['1:1', 1024, 1024],
        ['1:4', 512, 2048],
        ['1:8', 384, 3072],
        ['2:3', 848, 1264],
        ['3:2', 1264, 848],
        ['3:4', 896, 1200],
        ['4:1', 2048, 512],
        ['4:3', 1200, 896],
        ['4:5', 928, 1152],
        ['5:4', 1152, 928],
        ['8:1', 3072, 384],
        ['9:16', 768, 1376],
        ['16:9', 1376, 768],
        ['21:9', 1584, 672]
    ]),
    ...createDocumentedRows('gemini-3.x-image', '2k', [
        ['1:1', 2048, 2048],
        ['1:4', 1024, 4096],
        ['1:8', 768, 6144],
        ['2:3', 1696, 2528],
        ['3:2', 2528, 1696],
        ['3:4', 1792, 2400],
        ['4:1', 4096, 1024],
        ['4:3', 2400, 1792],
        ['4:5', 1856, 2304],
        ['5:4', 2304, 1856],
        ['8:1', 6144, 768],
        ['9:16', 1536, 2752],
        ['16:9', 2752, 1536],
        ['21:9', 3168, 1344]
    ]),
    ...createDocumentedRows('gemini-3.x-image', '4k', [
        ['1:1', 4096, 4096],
        ['1:4', 2048, 8192],
        ['1:8', 1536, 12288],
        ['2:3', 3392, 5056],
        ['3:2', 5056, 3392],
        ['3:4', 3584, 4800],
        ['4:1', 8192, 2048],
        ['4:3', 4800, 3584],
        ['4:5', 3712, 4608],
        ['5:4', 4608, 3712],
        ['8:1', 12288, 1536],
        ['9:16', 3072, 5504],
        ['16:9', 5504, 3072],
        ['21:9', 6336, 2688]
    ]),
    ...createDocumentedRows('gemini-2.5-flash-image', '1k', [
        ['1:1', 1024, 1024],
        ['2:3', 832, 1248],
        ['3:2', 1248, 832],
        ['3:4', 864, 1184],
        ['4:3', 1184, 864],
        ['4:5', 896, 1152],
        ['5:4', 1152, 896],
        ['9:16', 768, 1344],
        ['16:9', 1344, 768],
        ['21:9', 1536, 672]
    ])
]);

function buildOfficialSizeKey(entry) {
    return [
        entry.modelFamily,
        entry.resolutionTier,
        entry.aspectRatio,
        `${entry.width}x${entry.height}`
    ].join('|');
}

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

test('resolveOfficialGeminiWatermarkConfig should prefer the current 48px watermark for documented Gemini 3.x 1K portrait output', () => {
    assert.deepEqual(
        resolveOfficialGeminiWatermarkConfig(768, 1376),
        { logoSize: 48, marginRight: 32, marginBottom: 32 }
    );
});

test('resolveOfficialGeminiWatermarkConfig should return null for unknown non-official dimensions', () => {
    assert.equal(resolveOfficialGeminiWatermarkConfig(1000, 1000), null);
});

test('resolveOfficialGeminiSearchConfigs should map near-official portrait dimensions to scaled anchor configs', () => {
    const configs = resolveOfficialGeminiSearchConfigs(1000, 1792);

    assert.ok(configs.length > 0);
    assert.deepEqual(configs[0], {
        logoSize: 63,
        marginRight: 42,
        marginBottom: 42
    });
});

test('resolveOfficialGeminiSearchConfigs should project near-official current large-margin anchors', () => {
    const configs = resolveOfficialGeminiSearchConfigs(1024, 768);

    assert.ok(
        configs.some((config) => (
            config.logoSize === 42 &&
            config.marginRight === 82 &&
            config.marginBottom === 82
        )),
        `configs=${JSON.stringify(configs)}`
    );
});

test('resolveGeminiWatermarkSearchConfigs should keep default config first and dedupe identical catalog matches', () => {
    const configs = resolveGeminiWatermarkSearchConfigs(768, 1376, {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    });

    assert.deepEqual(configs[0], {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    });
    assert.equal(
        configs.filter((config) => (
            config.logoSize === 48 &&
            config.marginRight === 32 &&
            config.marginBottom === 32
        )).length,
        1
    );
});

test('resolveOfficialGeminiSearchConfigs should prefer current 48px exact official dimensions and keep legacy 96px gated fallback', () => {
    const configs = resolveOfficialGeminiSearchConfigs(768, 1376);

    assert.deepEqual(configs, [
        { logoSize: 48, marginRight: 32, marginBottom: 32 },
        { logoSize: 48, marginRight: 96, marginBottom: 96 },
        { logoSize: 36, marginRight: 96, marginBottom: 96, alphaVariant: 'v2' },
        { logoSize: 96, marginRight: 64, marginBottom: 64 },
    ]);
});

test('resolveOfficialGeminiSearchConfigEntries should add the evidence-gated 48px R96 candidate to exact Gemini 3.x 2K outputs', () => {
    for (const [width, height] of [
        [2048, 2048],
        [2400, 1792]
    ]) {
        const entries = resolveOfficialGeminiSearchConfigEntries(width, height);
        const entry = entries.find((candidate) => (
            candidate.config.logoSize === 48 &&
            candidate.config.marginRight === 96 &&
            candidate.config.marginBottom === 96 &&
            candidate.config.alphaVariant == null
        ));

        assert.deepEqual(entry, {
            config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
            metadata: {
                family: 'known-current-variant',
                sourcePriority: 1,
                evidenceGate: 'required',
                modelFamily: 'gemini-3.x-image',
                resolutionTier: '2k',
                aspectRatio: width === height ? '1:1' : '4:3',
                source: '202608-2k-large-margin'
            }
        });
    }
});

test('resolveOfficialGeminiSearchConfigEntries should not generalize the 48px R96 candidate to exact Gemini 3.x 4K outputs', () => {
    const entries = resolveOfficialGeminiSearchConfigEntries(4096, 4096);

    assert.equal(entries.some((entry) => (
        entry.config.logoSize === 48 &&
        entry.config.marginRight === 96 &&
        entry.config.marginBottom === 96
    )), false);
});

test('resolveOfficialGeminiSearchConfigEntries should not generalize the 48px R96 candidate to unconfirmed exact Gemini 3.x 2K outputs', () => {
    const entries = resolveOfficialGeminiSearchConfigEntries(2752, 1536);

    assert.equal(entries.some((entry) => (
        entry.config.logoSize === 48 &&
        entry.config.marginRight === 96 &&
        entry.config.marginBottom === 96
    )), false);
});

test('resolveOfficialGeminiSearchConfigEntries should expose explicit catalog family and priority metadata', () => {
    const entries = resolveOfficialGeminiSearchConfigEntries(768, 1376);

    assert.deepEqual(
        entries.map((entry) => ({
            config: entry.config,
            family: entry.metadata.family,
            sourcePriority: entry.metadata.sourcePriority,
            evidenceGate: entry.metadata.evidenceGate
        })),
        [
            {
                config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
                family: 'exact-official-current',
                sourcePriority: 0,
                evidenceGate: 'standard'
            },
            {
                config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
                family: 'known-current-variant',
                sourcePriority: 1,
                evidenceGate: 'required'
            },
            {
                config: { logoSize: 36, marginRight: 96, marginBottom: 96, alphaVariant: 'v2' },
                family: 'gemini-v2-small',
                sourcePriority: 2,
                evidenceGate: 'medium'
            },
            {
                config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
                family: 'exact-official-legacy',
                sourcePriority: 3,
                evidenceGate: 'required'
            }
        ]
    );
});

test('resolveOfficialGeminiSearchConfigs should expose aspect-aware V2 36px small profile candidates', () => {
    assert.deepEqual(
        resolveOfficialGeminiSearchConfigs(1024, 1024).find((config) => config.alphaVariant === 'v2'),
        { logoSize: 36, marginRight: 71, marginBottom: 71, alphaVariant: 'v2' }
    );
    assert.deepEqual(
        resolveOfficialGeminiSearchConfigs(1376, 768).find((config) => config.alphaVariant === 'v2'),
        { logoSize: 36, marginRight: 96, marginBottom: 96, alphaVariant: 'v2' }
    );
});

test('resolveGeminiWatermarkSearchCatalogEntries should preserve legacy config ordering while adding metadata', () => {
    const defaultConfig = { logoSize: 48, marginRight: 32, marginBottom: 32 };
    const entries = resolveGeminiWatermarkSearchCatalogEntries(768, 1376, defaultConfig);
    const configs = resolveGeminiWatermarkSearchConfigs(768, 1376, defaultConfig);

    assert.deepEqual(entries.map((entry) => entry.config), configs);
    assert.equal(entries[0].metadata.family, 'default-standard');
    assert.equal(entries[1].metadata.family, 'known-current-variant');
    assert.equal(entries[1].metadata.sourcePriority, 1);
});

test('resolveOfficialGeminiSearchConfigs should not add the 192px-margin variant to 0.5K outputs', () => {
    const configs = resolveOfficialGeminiSearchConfigs(512, 512);

    assert.deepEqual(configs, [
        { logoSize: 48, marginRight: 32, marginBottom: 32 }
    ]);
});

test('resolveGeminiWatermarkSearchCatalogEntries should add gated 96px 192px-margin candidate for unknown large Gemini-like outputs', () => {
    const entries = resolveGeminiWatermarkSearchCatalogEntries(2730, 1536, {
        logoSize: 96,
        marginRight: 64,
        marginBottom: 64
    });
    const newMarginEntry = entries.find((entry) => (
        entry.config.logoSize === 96 &&
        entry.config.marginRight === 192 &&
        entry.config.marginBottom === 192
    ));

    assert.ok(newMarginEntry);
    assert.equal(newMarginEntry.config.alphaVariant, '20260520');
    assert.equal(newMarginEntry.metadata.family, 'known-new-margin-variant');
    assert.equal(newMarginEntry.metadata.evidenceGate, 'required');
    assert.equal(newMarginEntry.metadata.source, 'unknown-size-new-margin');
});

test('resolveGeminiWatermarkSearchCatalogEntries should not add unknown-size 96px 192px-margin candidate to official current 1K outputs', () => {
    const entries = resolveGeminiWatermarkSearchCatalogEntries(768, 1376, {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    });

    assert.equal(
        entries.some((entry) => (
            entry.config.logoSize === 96 &&
            entry.config.marginRight === 192 &&
            entry.config.marginBottom === 192
        )),
        false
    );
});

test('OFFICIAL_GEMINI_IMAGE_SIZES should include every documented Gemini image size', () => {
    const catalogKeys = new Set(OFFICIAL_GEMINI_IMAGE_SIZES.map(buildOfficialSizeKey));
    const missingRows = DOCUMENTED_GEMINI_IMAGE_SIZES
        .filter((entry) => !catalogKeys.has(buildOfficialSizeKey(entry)));

    assert.deepEqual(missingRows, []);
});

test('resolveOfficialGeminiWatermarkConfig should cover every documented portrait Gemini size', () => {
    const portraitEntries = OFFICIAL_GEMINI_IMAGE_SIZES.filter((entry) => entry.width < entry.height);

    assert.ok(portraitEntries.length > 0);

    for (const entry of portraitEntries) {
        const config = resolveOfficialGeminiWatermarkConfig(entry.width, entry.height);
        const expected = entry.resolutionTier === '0.5k' || (
            entry.modelFamily === 'gemini-3.x-image' &&
            entry.resolutionTier === '1k'
        )
            ? { logoSize: 48, marginRight: 32, marginBottom: 32 }
            : { logoSize: 96, marginRight: 64, marginBottom: 64 };

        assert.deepEqual(
            config,
            expected,
            `${entry.modelFamily} ${entry.aspectRatio} ${entry.width}x${entry.height}`
        );
    }
});

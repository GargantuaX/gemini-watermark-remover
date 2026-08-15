const WATERMARK_CONFIG_BY_TIER = Object.freeze({
    '0.5k': Object.freeze({ logoSize: 48, marginRight: 32, marginBottom: 32 }),
    '1k': Object.freeze({ logoSize: 96, marginRight: 64, marginBottom: 64 }),
    '2k': Object.freeze({ logoSize: 96, marginRight: 64, marginBottom: 64 }),
    '4k': Object.freeze({ logoSize: 96, marginRight: 64, marginBottom: 64 }),
    '2k-new-margin': Object.freeze({
        logoSize: 96,
        marginRight: 192,
        marginBottom: 192,
        alphaVariant: '20260520'
    })
});
const GEMINI_3X_CURRENT_1K_WATERMARK_CONFIG = Object.freeze({
    logoSize: 48,
    marginRight: 32,
    marginBottom: 32
});
const GEMINI_3X_LEGACY_1K_WATERMARK_CONFIG = Object.freeze({
    logoSize: 96,
    marginRight: 64,
    marginBottom: 64
});
const GEMINI_3X_CURRENT_1K_LARGE_MARGIN_WATERMARK_CONFIG = Object.freeze({
    logoSize: 48,
    marginRight: 96,
    marginBottom: 96
});
const GEMINI_3X_CURRENT_2K_LARGE_MARGIN_SIZE_KEYS = new Set([
    '2048x2048',
    '2400x1792'
]);
const GEMINI_3X_V2_SMALL_WATERMARK_CONFIG = Object.freeze({
    logoSize: 36,
    marginRight: 96,
    marginBottom: 96,
    alphaVariant: 'v2'
});
const KNOWN_FIXED_GEMINI_WATERMARK_CONFIGS_BY_SIZE = Object.freeze({
    '1408x768': Object.freeze([
        Object.freeze({ logoSize: 46, marginRight: 32, marginBottom: 32, fixedVariant: true })
    ])
});

// Gemini image generation does not emit arbitrary dimensions.
// The models use a discrete set of official sizes, so the catalog is a better
// watermark prior than ratio-only if/else heuristics.

function createEntries(modelFamily, resolutionTier, rows) {
    return rows.map(([aspectRatio, width, height]) => ({
        modelFamily,
        resolutionTier,
        aspectRatio,
        width,
        height
    }));
}

const OFFICIAL_GEMINI_IMAGE_SIZES = Object.freeze([
    ...createEntries('gemini-3.x-image', '0.5k', [
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
    ...createEntries('gemini-3.x-image', '1k', [
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
        ['16:9', 1408, 768],
        ['21:9', 1584, 672]
    ]),
    ...createEntries('gemini-3.x-image', '2k', [
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
    ...createEntries('gemini-3.x-image', '2k-new-margin', [
        ['16:9', 2816, 1536]
    ]),
    ...createEntries('gemini-3.x-image', '4k', [
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
    ...createEntries('gemini-2.5-flash-image', '1k', [
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

const OFFICIAL_GEMINI_IMAGE_SIZE_INDEX = new Map();
for (const entry of OFFICIAL_GEMINI_IMAGE_SIZES) {
    const key = `${entry.width}x${entry.height}`;
    if (!OFFICIAL_GEMINI_IMAGE_SIZE_INDEX.has(key)) {
        OFFICIAL_GEMINI_IMAGE_SIZE_INDEX.set(key, entry);
    }
}

function normalizeDimension(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const rounded = Math.round(numeric);
    return rounded > 0 ? rounded : null;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getEntryConfig(entry) {
    if (entry?.modelFamily === 'gemini-3.x-image' && entry.resolutionTier === '1k') {
        return GEMINI_3X_CURRENT_1K_WATERMARK_CONFIG;
    }
    return WATERMARK_CONFIG_BY_TIER[entry.resolutionTier] ?? null;
}

function getEntryLegacyConfigs(entry) {
    if (entry?.modelFamily === 'gemini-3.x-image' && entry.resolutionTier === '1k') {
        return [GEMINI_3X_LEGACY_1K_WATERMARK_CONFIG];
    }

    return [];
}

function buildConfigKey(config) {
    return `${config.logoSize}:${config.marginRight}:${config.marginBottom}:${config.alphaVariant ?? 'default'}`;
}

function createCatalogEntry(config, metadata = {}) {
    return {
        config,
        metadata: {
            family: metadata.family ?? 'catalog',
            sourcePriority: metadata.sourcePriority ?? 9,
            evidenceGate: metadata.evidenceGate ?? 'required',
            modelFamily: metadata.modelFamily ?? null,
            resolutionTier: metadata.resolutionTier ?? null,
            aspectRatio: metadata.aspectRatio ?? null,
            source: metadata.source ?? null
        }
    };
}

function createNewMarginVariantConfig(baseConfig, width, height) {
    if (!baseConfig || baseConfig.logoSize !== 96) return null;
    if (baseConfig.marginRight === 192 && baseConfig.marginBottom === 192) return null;

    const config = {
        logoSize: 96,
        marginRight: 192,
        marginBottom: 192,
        alphaVariant: '20260520'
    };
    const x = width - config.marginRight - config.logoSize;
    const y = height - config.marginBottom - config.logoSize;
    return x >= 0 && y >= 0 ? config : null;
}

function createUnknownSizeNewMarginVariantConfig(baseConfig, width, height) {
    if (!baseConfig || baseConfig.logoSize !== 96) return null;
    if (Math.min(width, height) < 1024) return null;
    return createNewMarginVariantConfig(baseConfig, width, height);
}

function createCurrentLargeMarginVariantConfig(baseConfig, width, height, { allowAnyBase = false } = {}) {
    if (!allowAnyBase && (!baseConfig || baseConfig.logoSize !== 48)) return null;
    if (baseConfig?.marginRight === 96 && baseConfig?.marginBottom === 96) return null;

    const config = { ...GEMINI_3X_CURRENT_1K_LARGE_MARGIN_WATERMARK_CONFIG };
    const x = width - config.marginRight - config.logoSize;
    const y = height - config.marginBottom - config.logoSize;
    return x >= 0 && y >= 0 ? config : null;
}

function createV2SmallVariantConfig(width, height) {
    const normalizedWidth = normalizeDimension(width);
    const normalizedHeight = normalizeDimension(height);
    if (!normalizedWidth || !normalizedHeight) return null;
    if (Math.max(normalizedWidth, normalizedHeight) > 2048) return null;

    const longSide = Math.max(normalizedWidth, normalizedHeight);
    const shortSide = Math.min(normalizedWidth, normalizedHeight);
    const sourceLongDim = shortSide >= 566
        ? 2752
        : (shortSide >= 550 ? 2816 : 2848);
    const margin = Math.round(192 * (longSide / sourceLongDim));
    const config = {
        ...GEMINI_3X_V2_SMALL_WATERMARK_CONFIG,
        marginRight: margin,
        marginBottom: margin
    };
    const x = normalizedWidth - config.marginRight - config.logoSize;
    const y = normalizedHeight - config.marginBottom - config.logoSize;
    return x >= 0 && y >= 0 ? config : null;
}

function createProjectedConfig(baseConfig, scaleX, scaleY, { minLogoSize, maxLogoSize, roundLogoSize = Math.round }) {
    if (!baseConfig) return null;

    return {
        logoSize: clamp(
            roundLogoSize(baseConfig.logoSize * ((scaleX + scaleY) / 2)),
            minLogoSize,
            maxLogoSize
        ),
        marginRight: Math.max(8, Math.round(baseConfig.marginRight * scaleX)),
        marginBottom: Math.max(8, Math.round(baseConfig.marginBottom * scaleY)),
        ...(baseConfig.alphaVariant ? { alphaVariant: baseConfig.alphaVariant } : {})
    };
}

function getNearOfficialProjectionConfigs(entry, baseConfig) {
    const configs = [{ config: baseConfig, family: 'near-official-projected', source: `${entry.width}x${entry.height}` }];
    if (entry?.modelFamily === 'gemini-3.x-image' && entry.resolutionTier === '1k') {
        configs.push({
            config: GEMINI_3X_CURRENT_1K_LARGE_MARGIN_WATERMARK_CONFIG,
            family: 'near-official-current-large-margin',
            source: `${entry.width}x${entry.height}-large-margin`,
            roundLogoSize: Math.ceil
        });
    }

    return configs;
}

export function matchOfficialGeminiImageSize(width, height) {
    const normalizedWidth = normalizeDimension(width);
    const normalizedHeight = normalizeDimension(height);
    if (!normalizedWidth || !normalizedHeight) return null;

    return OFFICIAL_GEMINI_IMAGE_SIZE_INDEX.get(`${normalizedWidth}x${normalizedHeight}`) ?? null;
}

export function resolveOfficialGeminiWatermarkConfig(width, height) {
    const match = matchOfficialGeminiImageSize(width, height);
    if (!match) return null;
    return getEntryConfig(match);
}

function isOfficialOrKnownGeminiDimensions(width, height) {
    return matchOfficialGeminiImageSize(width, height) !== null;
}

function resolveKnownFixedGeminiWatermarkConfigs(width, height) {
    const normalizedWidth = normalizeDimension(width);
    const normalizedHeight = normalizeDimension(height);
    if (!normalizedWidth || !normalizedHeight) return [];

    const configs = KNOWN_FIXED_GEMINI_WATERMARK_CONFIGS_BY_SIZE[`${normalizedWidth}x${normalizedHeight}`];
    return Array.isArray(configs) ? configs.map((config) => ({ ...config })) : [];
}

function resolveKnownFixedGeminiWatermarkConfigEntries(width, height) {
    return resolveKnownFixedGeminiWatermarkConfigs(width, height)
        .map((config) => createCatalogEntry(config, {
            family: 'fixed-size-variant',
            sourcePriority: 5,
            evidenceGate: 'required',
            source: 'known-fixed-size'
        }));
}

export function resolveOfficialGeminiSearchConfigs(
    width,
    height,
    options = {}
) {
    return resolveOfficialGeminiSearchConfigEntries(width, height, options)
        .map((entry) => entry.config);
}

export function resolveOfficialGeminiSearchConfigEntries(
    width,
    height,
    {
        maxRelativeAspectRatioDelta = 0.02,
        maxScaleMismatchRatio = 0.12,
        minLogoSize = 24,
        maxLogoSize = 192,
        limit = 3
    } = {}
) {
    const normalizedWidth = normalizeDimension(width);
    const normalizedHeight = normalizeDimension(height);
    if (!normalizedWidth || !normalizedHeight) return [];

    const exactOfficialConfig = resolveOfficialGeminiWatermarkConfig(
        normalizedWidth,
        normalizedHeight
    );
    if (exactOfficialConfig) {
        const match = matchOfficialGeminiImageSize(normalizedWidth, normalizedHeight);
        const entries = [
            createCatalogEntry({ ...exactOfficialConfig }, {
                family: 'exact-official-current',
                sourcePriority: 0,
                evidenceGate: 'standard',
                modelFamily: match?.modelFamily ?? null,
                resolutionTier: match?.resolutionTier ?? null,
                aspectRatio: match?.aspectRatio ?? null,
                source: 'official-size'
            })
        ];
        if (match?.modelFamily === 'gemini-3.x-image' && match.resolutionTier === '1k') {
            const currentLargeMarginVariant = createCurrentLargeMarginVariantConfig(
                exactOfficialConfig,
                normalizedWidth,
                normalizedHeight
            );
            if (currentLargeMarginVariant) {
                entries.push(createCatalogEntry(currentLargeMarginVariant, {
                    family: 'known-current-variant',
                    sourcePriority: 1,
                    evidenceGate: 'required',
                    modelFamily: match.modelFamily,
                    resolutionTier: match.resolutionTier,
                    aspectRatio: match.aspectRatio,
                    source: '202606-large-margin'
                }));
            }
            const v2SmallVariant = createV2SmallVariantConfig(
                normalizedWidth,
                normalizedHeight
            );
            if (v2SmallVariant) {
                entries.push(createCatalogEntry(v2SmallVariant, {
                    family: 'gemini-v2-small',
                    sourcePriority: 2,
                    evidenceGate: 'medium',
                    modelFamily: match.modelFamily,
                    resolutionTier: match.resolutionTier,
                    aspectRatio: match.aspectRatio,
                    source: 'allenk-v2-small'
                }));
            }
        }
        if (
            match?.modelFamily === 'gemini-3.x-image' &&
            match.resolutionTier === '2k' &&
            GEMINI_3X_CURRENT_2K_LARGE_MARGIN_SIZE_KEYS.has(
                `${normalizedWidth}x${normalizedHeight}`
            )
        ) {
            const currentLargeMarginVariant = createCurrentLargeMarginVariantConfig(
                exactOfficialConfig,
                normalizedWidth,
                normalizedHeight,
                { allowAnyBase: true }
            );
            if (currentLargeMarginVariant) {
                entries.push(createCatalogEntry(currentLargeMarginVariant, {
                    family: 'known-current-variant',
                    sourcePriority: 1,
                    evidenceGate: 'required',
                    modelFamily: match.modelFamily,
                    resolutionTier: match.resolutionTier,
                    aspectRatio: match.aspectRatio,
                    source: '202608-2k-large-margin'
                }));
            }
        }
        for (const legacyConfig of getEntryLegacyConfigs(match)) {
            entries.push(createCatalogEntry({ ...legacyConfig }, {
                family: 'exact-official-legacy',
                sourcePriority: 3,
                evidenceGate: 'required',
                modelFamily: match?.modelFamily ?? null,
                resolutionTier: match?.resolutionTier ?? null,
                aspectRatio: match?.aspectRatio ?? null,
                source: 'legacy-96px'
            }));
        }

        if (!(match?.modelFamily === 'gemini-3.x-image' && match.resolutionTier === '1k')) {
            const newMarginVariant = createNewMarginVariantConfig(
                exactOfficialConfig,
                normalizedWidth,
                normalizedHeight
            );
            if (newMarginVariant) {
                entries.push(createCatalogEntry(newMarginVariant, {
                    family: 'confirmed-exception',
                    sourcePriority: 3,
                    evidenceGate: 'required',
                    modelFamily: match?.modelFamily ?? null,
                    resolutionTier: match?.resolutionTier ?? null,
                    aspectRatio: match?.aspectRatio ?? null,
                    source: '20260520-2816x1536'
                }));
            }
        }
        return entries;
    }

    // Near-official exports are often uniformly scaled from an official size.
    // We project the official watermark anchor into the current dimensions, but
    // this only proposes search seeds; later validation still decides safety.
    const targetAspectRatio = normalizedWidth / normalizedHeight;
    const candidates = OFFICIAL_GEMINI_IMAGE_SIZES
        .flatMap((entry) => {
            const baseConfig = getEntryConfig(entry);
            if (!baseConfig) return [];

            const scaleX = normalizedWidth / entry.width;
            const scaleY = normalizedHeight / entry.height;
            const scale = (scaleX + scaleY) / 2;
            const entryAspectRatio = entry.width / entry.height;
            const relativeAspectRatioDelta = Math.abs(targetAspectRatio - entryAspectRatio) / entryAspectRatio;
            const scaleMismatchRatio = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);

            if (relativeAspectRatioDelta > maxRelativeAspectRatioDelta) return [];
            if (scaleMismatchRatio > maxScaleMismatchRatio) return [];

            return getNearOfficialProjectionConfigs(entry, baseConfig)
                .map((projection) => {
                    const config = createProjectedConfig(projection.config, scaleX, scaleY, {
                        minLogoSize,
                        maxLogoSize,
                        roundLogoSize: projection.roundLogoSize
                    });

                    const x = normalizedWidth - config.marginRight - config.logoSize;
                    const y = normalizedHeight - config.marginBottom - config.logoSize;
                    if (x < 0 || y < 0) return null;

                    return {
                        config,
                        metadata: {
                            family: projection.family,
                            sourcePriority: 4,
                            evidenceGate: 'required',
                            modelFamily: entry.modelFamily,
                            resolutionTier: entry.resolutionTier,
                            aspectRatio: entry.aspectRatio,
                            source: projection.source
                        },
                        score:
                            relativeAspectRatioDelta * 100 +
                            scaleMismatchRatio * 20 +
                            Math.abs(Math.log2(Math.max(scale, 1e-6)))
                    };
                })
                .filter(Boolean);
        })
        .filter(Boolean)
        .sort((a, b) => a.score - b.score);
    const deduped = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const key = `${candidate.config.logoSize}:${candidate.config.marginRight}:${candidate.config.marginBottom}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(createCatalogEntry(candidate.config, candidate.metadata));
        if (deduped.length >= limit) break;
    }

    return deduped;
}

export function resolveGeminiWatermarkSearchConfigs(width, height, defaultConfig) {
    return resolveGeminiWatermarkSearchCatalogEntries(width, height, defaultConfig)
        .map((entry) => entry.config);
}

export function resolveGeminiWatermarkSearchCatalogEntries(width, height, defaultConfig) {
    const entries = [];
    if (defaultConfig) {
        entries.push(createCatalogEntry(defaultConfig, {
            family: 'default-standard',
            sourcePriority: 0,
            evidenceGate: 'standard',
            source: 'default-config'
        }));
    }
    entries.push(...resolveKnownFixedGeminiWatermarkConfigEntries(width, height));
    entries.push(...resolveOfficialGeminiSearchConfigEntries(width, height));
    const currentLargeMarginVariant = createCurrentLargeMarginVariantConfig(defaultConfig, width, height);
    if (currentLargeMarginVariant) {
        entries.push(createCatalogEntry(currentLargeMarginVariant, {
            family: 'known-current-variant',
            sourcePriority: 1,
            evidenceGate: 'required',
            source: 'default-large-margin'
        }));
    }
    if (!isOfficialOrKnownGeminiDimensions(width, height)) {
        const unknownSizeNewMarginVariant = createUnknownSizeNewMarginVariantConfig(defaultConfig, width, height);
        if (unknownSizeNewMarginVariant) {
            entries.push(createCatalogEntry(unknownSizeNewMarginVariant, {
                family: 'known-new-margin-variant',
                sourcePriority: 2,
                evidenceGate: 'required',
                source: 'unknown-size-new-margin'
            }));
        }

        const unknownSizeCurrentLargeMarginVariant = createCurrentLargeMarginVariantConfig(defaultConfig, width, height, {
            allowAnyBase: true
        });
        if (unknownSizeCurrentLargeMarginVariant) {
            entries.push(createCatalogEntry(unknownSizeCurrentLargeMarginVariant, {
                family: 'known-current-variant',
                sourcePriority: 1,
                evidenceGate: 'required',
                source: 'unknown-size-large-margin'
            }));
        }
    }

    const deduped = [];
    const seen = new Set();
    for (const entry of entries) {
        const config = entry?.config;
        if (!config) continue;
        const key = buildConfigKey(config);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(entry);
    }

    return deduped;
}

export { OFFICIAL_GEMINI_IMAGE_SIZES };

const WATERMARK_CONFIG_BY_TIER = Object.freeze({
    '0.5k': Object.freeze({ logoSize: 48, marginRight: 32, marginBottom: 32 }),
    '1k': Object.freeze({ logoSize: 96, marginRight: 64, marginBottom: 64 }),
    '2k': Object.freeze({ logoSize: 96, marginRight: 64, marginBottom: 64 }),
    '4k': Object.freeze({ logoSize: 96, marginRight: 64, marginBottom: 64 })
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
        ['2:3', 848, 1264],
        ['3:2', 1264, 848],
        ['3:4', 896, 1200],
        ['4:3', 1200, 896],
        ['4:5', 928, 1152],
        ['5:4', 1152, 928],
        ['9:16', 768, 1376],
        ['16:9', 1376, 768],
        ['21:9', 1584, 672]
    ]),
    ...createEntries('gemini-3.x-image', '2k', [
        ['1:1', 2048, 2048],
        ['1:4', 512, 2048],
        ['1:8', 384, 3072],
        ['2:3', 1696, 2528],
        ['3:2', 2528, 1696],
        ['3:4', 1792, 2400],
        ['4:1', 2048, 512],
        ['4:3', 2400, 1792],
        ['4:5', 1856, 2304],
        ['5:4', 2304, 1856],
        ['8:1', 3072, 384],
        ['9:16', 1536, 2752],
        ['16:9', 2752, 1536],
        ['21:9', 3168, 1344]
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

const OFFICIAL_GEMINI_IMAGE_SIZE_INDEX = new Map(
    OFFICIAL_GEMINI_IMAGE_SIZES.map((entry) => [`${entry.width}x${entry.height}`, entry])
);

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
    return WATERMARK_CONFIG_BY_TIER[entry.resolutionTier] ?? null;
}

function buildConfigKey(config) {
    return `${config.logoSize}:${config.marginRight}:${config.marginBottom}`;
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

export function isOfficialOrKnownGeminiDimensions(width, height) {
    return matchOfficialGeminiImageSize(width, height) !== null;
}

export function resolveOfficialGeminiSearchConfigs(
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

    // Near-official exports are often uniformly scaled from an official size.
    // We project the official watermark anchor into the current dimensions, but
    // this only proposes search seeds; later validation still decides safety.
    const targetAspectRatio = normalizedWidth / normalizedHeight;
    const candidates = OFFICIAL_GEMINI_IMAGE_SIZES
        .map((entry) => {
            const baseConfig = getEntryConfig(entry);
            if (!baseConfig) return null;

            const scaleX = normalizedWidth / entry.width;
            const scaleY = normalizedHeight / entry.height;
            const scale = (scaleX + scaleY) / 2;
            const entryAspectRatio = entry.width / entry.height;
            const relativeAspectRatioDelta = Math.abs(targetAspectRatio - entryAspectRatio) / entryAspectRatio;
            const scaleMismatchRatio = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);

            if (relativeAspectRatioDelta > maxRelativeAspectRatioDelta) return null;
            if (scaleMismatchRatio > maxScaleMismatchRatio) return null;

            const config = {
                logoSize: clamp(Math.round(baseConfig.logoSize * scale), minLogoSize, maxLogoSize),
                marginRight: Math.max(8, Math.round(baseConfig.marginRight * scaleX)),
                marginBottom: Math.max(8, Math.round(baseConfig.marginBottom * scaleY))
            };

            const x = normalizedWidth - config.marginRight - config.logoSize;
            const y = normalizedHeight - config.marginBottom - config.logoSize;
            if (x < 0 || y < 0) return null;

            return {
                config,
                score:
                    relativeAspectRatioDelta * 100 +
                    scaleMismatchRatio * 20 +
                    Math.abs(Math.log2(Math.max(scale, 1e-6)))
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.score - b.score);

    const deduped = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const key = `${candidate.config.logoSize}:${candidate.config.marginRight}:${candidate.config.marginBottom}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(candidate.config);
        if (deduped.length >= limit) break;
    }

    return deduped;
}

export function resolveGeminiWatermarkSearchConfigs(width, height, defaultConfig) {
    const configs = [];
    if (defaultConfig) {
        configs.push(defaultConfig);
    }
    configs.push(...resolveOfficialGeminiSearchConfigs(width, height));

    const deduped = [];
    const seen = new Set();
    for (const config of configs) {
        if (!config) continue;
        const key = buildConfigKey(config);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(config);
    }

    return deduped;
}

export { OFFICIAL_GEMINI_IMAGE_SIZES };

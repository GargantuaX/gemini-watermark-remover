import { removeWatermark } from './blendModes.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    detectAdaptiveWatermarkRegion,
    interpolateAlphaMap,
    shouldAttemptAdaptiveFallback,
    warpAlphaMap
} from './adaptiveDetector.js';
import {
    assessReferenceTextureAlignment,
    assessReferenceTextureAlignmentFromStats,
    calculateNearBlackRatio,
    calculateNearWhiteRatio,
    cloneImageData,
    getRegionTextureStats,
    scoreRegion
} from './restorationMetrics.js';
import {
    hasReliableAdaptiveWatermarkSignal,
    hasReliableStandardWatermarkSignal
} from './watermarkPresence.js';
import {
    buildRankingKey,
    compareRankingKey,
    scoreBalancedVisualCandidate,
    scoreDamage,
    scoreOriginalEvidence,
    scoreResidual,
    shouldEarlyAccept
} from './watermarkScoring.js';
import {
    arbitrateCandidateByEvaluation,
    createCandidateEvaluation,
    hasSafeDefaultAlphaNewMarginResidual,
    isNewMarginAlphaVariantTrial
} from './candidateEvaluation.js';
import {
    matchOfficialGeminiImageSize,
    resolveGeminiWatermarkSearchCatalogEntries
} from './geminiSizeCatalog.js';
import { repairDarkOutlineContour } from './darkOutlineContourRepair.js';

const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const VALIDATION_MIN_IMPROVEMENT = 0.08;
const VALIDATION_TARGET_RESIDUAL = 0.22;
const VALIDATION_MAX_GRADIENT_INCREASE = 0.04;
const VALIDATION_MIN_CONFIDENCE_FOR_ADAPTIVE_TRIAL = 0.25;
const STANDARD_FAST_PATH_RESIDUAL_THRESHOLD = 0.22;
const STANDARD_FAST_PATH_GRADIENT_THRESHOLD = 0.08;
const FIXED_CORE_MAX_ACCEPTED_SPATIAL_RESIDUAL = 0.45;
const FIXED_CORE_STRONG_96_MAX_NEGATIVE_SPATIAL_RESIDUAL = 0.52;
const FIXED_CORE_STRONG_96_MIN_ORIGINAL_SPATIAL_SCORE = 0.95;
const FIXED_CORE_STRONG_96_MIN_ORIGINAL_GRADIENT_SCORE = 0.9;
const FIXED_CORE_STRONG_96_MAX_PROCESSED_GRADIENT_SCORE = 0.16;
const FIXED_CORE_STRONG_96_MIN_IMPROVEMENT = 0.45;
const FIXED_CORE_STRONG_96_MAX_TEXTURE = 0.05;
const FIXED_CORE_STRONG_96_MAX_NEAR_BLACK_INCREASE = 0.02;
const FIXED_CORE_STRONG_96_LOW_RESIDUAL_MIN_ORIGINAL_SPATIAL_SCORE = 0.55;
const FIXED_CORE_STRONG_96_LOW_RESIDUAL_MIN_ORIGINAL_GRADIENT_SCORE = 0.5;
const FIXED_CORE_STRONG_96_LOW_RESIDUAL_MAX_SPATIAL_SCORE = 0.08;
const FIXED_CORE_STRONG_96_LOW_RESIDUAL_MAX_GRADIENT_SCORE = 0.24;
const FIXED_CORE_STRONG_96_LOW_RESIDUAL_MIN_IMPROVEMENT = 0.6;
const STANDARD_EXPAND_CATALOG_MIN_ORIGINAL_GRADIENT = 0.12;
const WEAK_ALPHA_PRIORITY_CLEAN_GRADIENT_THRESHOLD = 0.12;
const STRONG_ORIGINAL_SIGNAL_SPATIAL_ADVANTAGE = 0.2;
const STRONG_ORIGINAL_SIGNAL_GRADIENT_ADVANTAGE = 0.25;
const STANDARD_NEARBY_SEARCH_RESIDUAL_THRESHOLD = 0.18;
const STANDARD_NEARBY_SEARCH_GRADIENT_THRESHOLD = 0.05;
const STANDARD_LOCAL_SHIFT_STRONG_BASE_GRADIENT_SCORE = 0.35;
const STANDARD_LOCAL_SHIFT_STRONG_BASE_SPATIAL_SCORE = 0.8;
const STANDARD_LOCAL_SHIFT_CANONICAL_MIN_GRADIENT_SCORE = 0.2;
const STANDARD_LOCAL_SHIFT_CANONICAL_MIN_SPATIAL_SCORE = 0.22;
const STANDARD_LOCAL_SHIFT_WEAK_CANDIDATE_GRADIENT_SCORE = 0.12;
const STANDARD_LOCAL_SHIFT_WEAK_CANDIDATE_SPATIAL_SCORE = 0.65;
const STANDARD_LOCAL_SHIFT_MIN_VALIDATION_ADVANTAGE = 0.3;
const STANDARD_LOCAL_SHIFT_SKIP_PROCESSED_GRADIENT_THRESHOLD = 0.02;
const STANDARD_LOCAL_SHIFT_PRESERVE_CLEAN_BASE_GRADIENT_THRESHOLD = 0.02;
const STANDARD_LOCAL_SHIFT_MAX_CANDIDATE_GRADIENT_FOR_CLEAN_BASE = 0.03;
const STANDARD_PRESERVE_GRADIENT_DELTA = 0.25;
const STANDARD_PRESERVE_MAX_RESIDUAL = 0.4;
const STANDARD_PRESERVE_MIN_IMPROVEMENT = 0.3;
const STANDARD_TEXT_OVERLAP_MIN_SPATIAL_SCORE = 0.22;
const STANDARD_TEXT_OVERLAP_MIN_GRADIENT_SCORE = 0.18;
const STANDARD_TEXT_OVERLAP_MIN_IMPROVEMENT = 0.25;
const STANDARD_TEXT_OVERLAP_MAX_RESIDUAL = 0.1;
const STANDARD_TEXT_OVERLAP_MIN_GRADIENT_DROP = 0.1;
const STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MIN_ORIGINAL_SPATIAL_SCORE = 0.12;
const STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MIN_ORIGINAL_GRADIENT_SCORE = 0.06;
const STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MIN_IMPROVEMENT = 0.08;
const STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MAX_SPATIAL_RESIDUAL = 0.08;
const STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MAX_GRADIENT_RESIDUAL = 0.08;
const STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MAX_NEAR_BLACK_INCREASE = 0.005;
const STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MAX_TEXTURE = 0.05;
const STANDARD_VALIDATION_MIN_ORIGINAL_SPATIAL_SCORE = 0.05;
const STANDARD_VALIDATION_MIN_ORIGINAL_GRADIENT_SCORE = 0.12;
const STANDARD_CONSERVATIVE_CATALOG_PREFERRED_ALPHA_GAIN = 0.55;
const STANDARD_CONSERVATIVE_CATALOG_MAX_ALPHA_GAIN = 0.6;
const STANDARD_CONSERVATIVE_CATALOG_MIN_ORIGINAL_SPATIAL_SCORE = 0.12;
const STANDARD_CONSERVATIVE_CATALOG_MIN_ORIGINAL_GRADIENT_SCORE = 0.08;
const STANDARD_CONSERVATIVE_CATALOG_MAX_RESIDUAL = 0.12;
const STANDARD_CONSERVATIVE_CATALOG_MAX_GRADIENT = 0.12;
const STANDARD_CONSERVATIVE_CATALOG_MIN_IMPROVEMENT = 0.12;
const STANDARD_CONSERVATIVE_CATALOG_MAX_NEAR_BLACK_INCREASE = 0.005;
const STANDARD_VISIBLE_CATALOG_MAX_ALPHA_GAIN = 0.6;
const STANDARD_VISIBLE_CATALOG_MIN_ORIGINAL_SPATIAL_SCORE = 0.45;
const STANDARD_VISIBLE_CATALOG_MIN_ORIGINAL_GRADIENT_SCORE = 0.55;
const STANDARD_VISIBLE_CATALOG_MAX_SPATIAL_RESIDUAL = 0.35;
const STANDARD_VISIBLE_CATALOG_MAX_GRADIENT_RESIDUAL = 0.18;
const STANDARD_VISIBLE_CATALOG_MIN_IMPROVEMENT = 0.7;
const STANDARD_VISIBLE_CATALOG_MAX_NEAR_BLACK_INCREASE = 0.05;
const STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MIN_SPATIAL_SCORE = 0.9;
const STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MIN_GRADIENT_SCORE = 0.7;
const STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MAX_RESIDUAL = 0.16;
const STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MAX_GRADIENT = 0.16;
const STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MIN_IMPROVEMENT = 0.9;
const STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MIN_GRADIENT_DROP = 0.6;
const STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MAX_NEAR_BLACK_INCREASE = 0.01;
const STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MAX_TEXTURE = 0.1;
const STANDARD_HARD_REJECT_OVERRIDE_MIN_SPATIAL_SCORE = 0.9;
const STANDARD_HARD_REJECT_OVERRIDE_MIN_GRADIENT_SCORE = 0.7;
const STANDARD_HARD_REJECT_OVERRIDE_MAX_RESIDUAL = 0.08;
const STANDARD_HARD_REJECT_OVERRIDE_MAX_GRADIENT = 0.1;
const STANDARD_HARD_REJECT_OVERRIDE_MIN_IMPROVEMENT = 0.7;
const STANDARD_HARD_REJECT_OVERRIDE_MAX_NEAR_BLACK_INCREASE = 0.01;
const STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MIN_SPATIAL_SCORE = 0.9;
const STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MIN_GRADIENT_SCORE = 0.7;
const STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MAX_RESIDUAL = 0.7;
const STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MAX_GRADIENT = 0.32;
const STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MIN_IMPROVEMENT = 0.7;
const STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MIN_GRADIENT_DROP = 0.6;
const STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MAX_NEAR_BLACK_INCREASE = 0.4;
const BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_MIN_SPATIAL = 0.35;
const BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_MIN_GRADIENT = 0.16;
const BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_SPATIAL_ADVANTAGE = 0.18;
const BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_GRADIENT_ADVANTAGE = 0.12;
const BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_MAX_RESIDUAL_DELTA = 0.08;
const DARK_POLARITY_CATALOG_MIN_ORIGINAL_SPATIAL = 0.12;
const DARK_POLARITY_CATALOG_MIN_ORIGINAL_GRADIENT = 0.08;
const DARK_POLARITY_48_MIN_ORIGINAL_SPATIAL = 0.6;
const DARK_POLARITY_48_MIN_ORIGINAL_GRADIENT = 0.3;
const DARK_POLARITY_CATALOG_MAX_TEXTURE_FOR_WEAK_EVIDENCE = 0.25;
const DARK_POLARITY_MAX_NEAR_WHITE_RATIO_INCREASE_FOR_WEAK_EVIDENCE = 0.05;
const DARK_POLARITY_NEAR_WHITE_OVERRIDE_MIN_ORIGINAL_SPATIAL = 0.4;
const DARK_POLARITY_NEAR_WHITE_OVERRIDE_MIN_ORIGINAL_GRADIENT = 0.3;
const OUTLINE_LIGHT_MIN_ORIGINAL_GRADIENT = 0.45;
const OUTLINE_LIGHT_MIN_IMPROVEMENT = 0.35;
const OUTLINE_LIGHT_MAX_PROCESSED_SPATIAL = 0.2;
const OUTLINE_LIGHT_MAX_PROCESSED_GRADIENT = 0.25;
const OUTLINE_DARK_MIN_ORIGINAL_GRADIENT = 0.38;
const OUTLINE_DARK_MIN_IMPROVEMENT = 0.2;
const OUTLINE_DARK_MAX_PROCESSED_SPATIAL = 0.15;
const OUTLINE_DARK_MAX_PROCESSED_GRADIENT = 0.18;
const OUTLINE_DARK_MIN_REPAIR_PIXELS = 32;
const OUTLINE_DARK_MAX_REPAIR_PIXELS = 96 * 96 * 0.1;
const OUTLINE_DARK_BODY_GAINS = Object.freeze([1, 0.85, 0.75, 0.65, 0.5]);
const OUTLINE_DARK_MIN_BODY_GAIN = 0.5;
const OUTLINE_DARK_BODY_GAIN_GRADIENT_WEIGHT = 0.6;
const OUTLINE_DARK_BODY_GAIN_MIN_COST_IMPROVEMENT = 0.015;
const OUTLINE_DARK_BODY_GAIN_SEARCH_MAX_FULL_BODY_SPATIAL = -0.05;
const TEMPLATE_ALIGN_SHIFTS = [-0.5, -0.25, 0, 0.25, 0.5];
const TEMPLATE_ALIGN_SCALES = [0.99, 1, 1.01];
const STANDARD_NEARBY_SHIFTS = [-12, -8, -4, 0, 4, 8, 12];
const STANDARD_FINE_LOCAL_SHIFTS = [-2, -1, 0, 1, 2];
const STANDARD_SIZE_JITTERS = [-12, -10, -8, -6, -4, -2, 2, 4, 6, 8, 10, 12];
const FIXED_CORE_LOCAL_SIZE_DELTAS = [-3, -2, -1, 0, 1, 2, 3, 4];
const FIXED_CORE_LOCAL_MARGIN_DELTAS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const FIXED_CORE_LOCAL_MIN_ORIGINAL_SPATIAL_SCORE = 0.7;
const FIXED_CORE_LOCAL_MIN_ORIGINAL_GRADIENT_SCORE = 0.3;
const FIXED_CORE_LOCAL_VISIBLE_CATALOG_MIN_ORIGINAL_SPATIAL_SCORE = 0.45;
const FIXED_CORE_LOCAL_VISIBLE_CATALOG_MIN_ORIGINAL_GRADIENT_SCORE = 0.55;
const PREVIEW_ANCHOR_MIN_SIZE = 24;
const PREVIEW_ANCHOR_MAX_SIZE_RATIO = 1.05;
const PREVIEW_ANCHOR_MIN_SIZE_RATIO = 0.55;
const PREVIEW_ANCHOR_MARGIN_WINDOW = 16;
const PREVIEW_ANCHOR_MARGIN_EXTENSION = 8;
const PREVIEW_ANCHOR_SIZE_STEP = 2;
const PREVIEW_ANCHOR_MARGIN_STEP = 2;
const PREVIEW_ANCHOR_TOP_K = 8;
const PREVIEW_ANCHOR_MIN_SCORE = 0.2;
const PREVIEW_ANCHOR_LOCAL_DELTAS = [-1, 0, 1];
const PREVIEW_TEMPLATE_ALIGN_SHIFTS = [-1, -0.5, 0, 0.5, 1];
const PREVIEW_TEMPLATE_ALIGN_SCALES = [0.985, 1, 1.015];
const PREVIEW_ANCHOR_GAIN_SKIP_RESIDUAL_THRESHOLD = 0.24;
const PREVIEW_ANCHOR_GAIN_SKIP_GRADIENT_THRESHOLD = 0.24;
const CORE_ALPHA_PRIORITY_GAINS = Object.freeze([0.6, 1, 1.1, 1.15, 1.3, 0.45, 0.7, 0.85, 0.55]);
const CURRENT_LARGE_MARGIN_ULTRA_WEAK_ALPHA_GAINS = Object.freeze([0.25, 0.3, 0.35, 0.4]);
const DARK_POLARITY_48_ULTRA_WEAK_ALPHA_GAINS = Object.freeze([0.08, 0.1, 0.12, 0.15, 0.2]);
const STANDARD_ANCHOR_WEAK_ALPHA_RESCUE_GAINS = Object.freeze([0.55, 0.7, 0.85]);
const STANDARD_ANCHOR_WEAK_RESCUE_MAX_SPATIAL = 0.35;
const STANDARD_ANCHOR_WEAK_RESCUE_MAX_GRADIENT = 0.24;
const STANDARD_ANCHOR_WEAK_RESCUE_MIN_IMPROVEMENT = 0.08;
const STANDARD_ANCHOR_WEAK_RESCUE_MAX_NEAR_BLACK_INCREASE = 0.02;
const STANDARD_ANCHOR_WEAK_RESCUE_MIN_BALANCED_ADVANTAGE = 0.03;
const CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_SPATIAL = 0.22;
const CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_GRADIENT = 0.36;
const CURRENT_LARGE_MARGIN_WEAK_RESCUE_MIN_ORIGINAL_SPATIAL = 0.17;
const CURRENT_LARGE_MARGIN_WEAK_RESCUE_MIN_ORIGINAL_GRADIENT = 0.12;
const CURRENT_LARGE_MARGIN_WEAK_RESCUE_MIN_IMPROVEMENT = 0.08;
const CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_NEAR_BLACK_INCREASE = 0.01;
const CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_TEXTURE = 0.55;
const CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MIN_ORIGINAL_SPATIAL = 0.4;
const CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MIN_ORIGINAL_GRADIENT = 0.25;
const CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MAX_SPATIAL = 0.36;
const CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MAX_GRADIENT = 0.24;
const CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MAX_TEXTURE = 0.1;
const CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MIN_ORIGINAL_SPATIAL = 0.8;
const CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MIN_ORIGINAL_GRADIENT = 0.8;
const CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MAX_SPATIAL = 0.35;
const CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MAX_GRADIENT = 0.18;
const CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MIN_IMPROVEMENT = 0.7;
const CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MAX_NEAR_BLACK_INCREASE = 0.05;
const CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MIN_ORIGINAL_GRADIENT = 0.5;
const CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MAX_ORIGINAL_SPATIAL = 0.35;
const CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MAX_ALPHA_GAIN = 0.6;
const CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MAX_TEXTURE = 0.08;
const CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MAX_SPATIAL = 0.32;
const CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MIN_GRADIENT_DROP = 0.12;

export {
    assessReferenceTextureAlignment,
    calculateNearBlackRatio,
    calculateNearWhiteRatio,
    scoreRegion
} from './restorationMetrics.js';

const ORIGIN_REGION = Object.freeze({ x: 0, y: 0 });

function mergeCandidateProvenance(...provenanceParts) {
    const merged = {};
    for (const provenance of provenanceParts) {
        if (!provenance || typeof provenance !== 'object') continue;
        Object.assign(merged, provenance);
    }

    return Object.keys(merged).length > 0 ? merged : null;
}

function inferCandidateSourcePriority({ source = '', provenance = null } = {}) {
    const catalogPriority = Number(provenance?.catalogSourcePriority);
    if (Number.isFinite(catalogPriority)) return catalogPriority;

    if (provenance?.localShift === true) return 6;
    if (provenance?.sizeJitter === true) return 7;
    if (provenance?.previewAnchor === true || String(source).includes('preview-anchor')) return 8;
    if (provenance?.adaptive === true || source === 'adaptive') return 9;
    if (String(source).startsWith('standard+catalog')) return 3;
    if (String(source).startsWith('standard')) return 0;
    return 9;
}

function inferAlphaPriorityIndex(alphaGain) {
    const index = CORE_ALPHA_PRIORITY_GAINS.findIndex((candidateGain) => (
        Math.abs(candidateGain - alphaGain) < 0.0001
    ));
    return index >= 0 ? index : 99;
}

function isProjectedPreviewCatalogConfig(originalImageData, candidateConfig, baseConfig) {
    if (!originalImageData || !candidateConfig) return false;
    if (candidateConfig.fixedVariant === true) return false;
    if (matchOfficialGeminiImageSize(originalImageData.width, originalImageData.height)) return false;

    return candidateConfig.logoSize < 48 ||
        (
            candidateConfig.logoSize <= 48 &&
            candidateConfig.marginRight < 32 &&
            candidateConfig.marginBottom < 32
        );
}

function createCatalogConfigKey(config) {
    return [
        config?.logoSize,
        config?.marginRight,
        config?.marginBottom,
        config?.alphaVariant ?? 'default'
    ].join(':');
}

function isPreservablePositiveLargeMarginCatalogEntry(entry) {
    return entry?.config?.logoSize === 96 &&
        entry.config.marginRight === 192 &&
        entry.config.marginBottom === 192 &&
        entry.config.alphaVariant === '20260520' &&
        entry.metadata?.family === 'known-new-margin-variant' &&
        entry.metadata?.evidenceGate === 'required';
}

// Correlation-based config resolution can replace the initial 96px anchor and
// accidentally hide its cataloged 192px-margin candidate. Preserve only the
// independently cataloged positive profile: deriving dark/outline profiles
// from this newly restored prior damaged clean-content controls.
function resolveStandardCandidateCatalogEntries({
    originalImageData,
    config,
    catalogPriorConfig
}) {
    const catalogEntries = resolveGeminiWatermarkSearchCatalogEntries(
        originalImageData.width,
        originalImageData.height,
        config
    );
    if (!catalogPriorConfig) return catalogEntries;

    const existingKeys = new Set(catalogEntries.map((entry) => (
        createCatalogConfigKey(entry?.config)
    )));
    const preservedEntries = resolveGeminiWatermarkSearchCatalogEntries(
        originalImageData.width,
        originalImageData.height,
        catalogPriorConfig
    )
        .filter((entry) => (
            isPreservablePositiveLargeMarginCatalogEntry(entry) &&
            !existingKeys.has(createCatalogConfigKey(entry.config))
        ))
        .map((entry) => ({
            ...entry,
            metadata: {
                ...entry.metadata,
                preservedInitialCatalogPrior: true,
                preservedCatalogDerivationPolicy: 'positive-only'
            }
        }));

    return preservedEntries.length === 0
        ? catalogEntries
        : [...catalogEntries, ...preservedEntries];
}

function buildStandardCandidateSeeds({
    originalImageData,
    config,
    catalogPriorConfig = null,
    position,
    alpha48,
    alpha96,
    alpha96Variants = null,
    getAlphaMap,
    resolveAlphaMap = null,
    includeCatalogVariants = true
}) {
    const catalogEntries = includeCatalogVariants
        ? resolveStandardCandidateCatalogEntries({
            originalImageData,
            config,
            catalogPriorConfig
        })
        : [{ config, metadata: null }];
    const seeds = [];

    for (const catalogEntry of catalogEntries) {
        const candidateConfig = catalogEntry.config;
        const candidatePosition = candidateConfig === config
            ? position
            : {
                x: originalImageData.width - candidateConfig.marginRight - candidateConfig.logoSize,
                y: originalImageData.height - candidateConfig.marginBottom - candidateConfig.logoSize,
                width: candidateConfig.logoSize,
                height: candidateConfig.logoSize
            };
        if (
            candidatePosition.x < 0 ||
            candidatePosition.y < 0 ||
            candidatePosition.x + candidatePosition.width > originalImageData.width ||
            candidatePosition.y + candidatePosition.height > originalImageData.height
        ) {
            continue;
        }

        const alphaMap = resolveAlphaMapForConfig(candidateConfig, {
            alpha48,
            alpha96,
            alpha96Variants,
            getAlphaMap,
            resolveAlphaMap
        });
        if (!alphaMap) continue;

        const projectedPreviewCatalog = isProjectedPreviewCatalogConfig(
            originalImageData,
            candidateConfig,
            config
        );

        const positiveOnlyPrior =
            catalogEntry.metadata?.preservedInitialCatalogPrior === true &&
            catalogEntry.metadata?.preservedCatalogDerivationPolicy === 'positive-only';
        const baseSeed = {
            config: candidateConfig,
            position: candidatePosition,
            alphaMap,
            source: projectedPreviewCatalog
                ? 'standard+preview-anchor'
                : (candidateConfig === config ? 'standard' : 'standard+catalog'),
            provenance: mergeCandidateProvenance(
                candidateConfig === config ? null : { catalogVariant: true },
                candidateConfig.fixedVariant === true ? { fixedVariant: true } : null,
                projectedPreviewCatalog ? { previewAnchor: true } : null,
                candidateConfig.alphaVariant ? { alphaVariant: candidateConfig.alphaVariant } : null,
                catalogEntry.metadata ? {
                    catalogFamily: catalogEntry.metadata.family,
                    catalogSourcePriority: catalogEntry.metadata.sourcePriority,
                    catalogEvidenceGate: catalogEntry.metadata.evidenceGate,
                    ...(positiveOnlyPrior ? {
                        preservedInitialCatalogPrior: true,
                        preservedCatalogDerivationPolicy: 'positive-only'
                    } : {})
                } : null
            )
        };
        seeds.push(baseSeed);

        const outlineLightAlphaMap = !positiveOnlyPrior &&
            candidateConfig.logoSize === 96 &&
            candidateConfig.marginRight === 192 &&
            candidateConfig.marginBottom === 192
            ? alpha96Variants?.['outline-light'] ?? null
            : null;
        if (outlineLightAlphaMap) {
            seeds.push({
                ...baseSeed,
                config: {
                    ...candidateConfig,
                    alphaVariant: 'outline-light'
                },
                alphaMap: outlineLightAlphaMap,
                source: `${baseSeed.source}+outline-light`,
                provenance: mergeCandidateProvenance(
                    baseSeed.provenance,
                    {
                        catalogVariant: true,
                        alphaVariant: 'outline-light',
                        outlineLight: true
                    }
                )
            });
        }

        const outlineDarkAlphaMap = !positiveOnlyPrior &&
            candidateConfig.logoSize === 96 &&
            candidateConfig.marginRight === 192 &&
            candidateConfig.marginBottom === 192
            ? alpha96Variants?.['outline-dark'] ?? null
            : null;
        if (outlineDarkAlphaMap) {
            seeds.push({
                ...baseSeed,
                config: {
                    ...candidateConfig,
                    alphaVariant: 'outline-dark'
                },
                alphaMap: outlineDarkAlphaMap,
                source: `${baseSeed.source}+outline-dark`,
                provenance: mergeCandidateProvenance(
                    baseSeed.provenance,
                    {
                        catalogVariant: true,
                        alphaVariant: 'outline-dark',
                        outlineDark: true,
                        outlineDarkBodyGain: 1
                    }
                )
            });
        }

        if (!positiveOnlyPrior && shouldAddDarkPolaritySeed(candidateConfig)) {
            const weakDarkPolarity48 = candidateConfig.logoSize === 48;
            seeds.push({
                ...baseSeed,
                alphaMap: createNegativeAlphaMap(alphaMap),
                source: `${baseSeed.source}+dark-polarity`,
                provenance: mergeCandidateProvenance(
                    baseSeed.provenance,
                    {
                        darkPolarity: true,
                        ...(weakDarkPolarity48 ? { weakDarkPolarity48: true } : {})
                    }
                )
            });
        }
    }

    return seeds;
}

function shouldAddDarkPolaritySeed(config) {
    if (
        config?.logoSize === 96 &&
        config.marginRight === 192 &&
        config.marginBottom === 192
    ) {
        return true;
    }

    return config?.logoSize === 48 &&
        config.marginRight >= 90 &&
        config.marginRight <= 100 &&
        config.marginBottom >= 90 &&
        config.marginBottom <= 100;
}

const negativeAlphaMapCache = new WeakMap();
const outlineDarkBodyGainAlphaMapCache = new WeakMap();

function createOutlineDarkBodyGainAlphaMap(alphaMap, bodyGain) {
    if (bodyGain === 1) return alphaMap;

    let gainCache = outlineDarkBodyGainAlphaMapCache.get(alphaMap);
    if (!gainCache) {
        gainCache = new Map();
        outlineDarkBodyGainAlphaMapCache.set(alphaMap, gainCache);
    }

    const cached = gainCache.get(bodyGain);
    if (cached) return cached;

    const scaled = new Float32Array(alphaMap.length);
    for (let index = 0; index < alphaMap.length; index++) {
        const value = alphaMap[index];
        scaled[index] = value > 0 ? value * bodyGain : value;
    }
    gainCache.set(bodyGain, scaled);
    return scaled;
}

function createNegativeAlphaMap(alphaMap) {
    const cached = negativeAlphaMapCache.get(alphaMap);
    if (cached) return cached;
    const negative = new Float32Array(alphaMap.length);
    for (let index = 0; index < alphaMap.length; index++) {
        negative[index] = -alphaMap[index];
    }
    negativeAlphaMapCache.set(alphaMap, negative);
    return negative;
}

function inferDecisionTier(candidate, { directMatch = false } = {}) {
    if (!candidate) return 'insufficient';
    if (directMatch) return 'direct-match';
    if (candidate.source?.includes('validated')) return 'validated-match';
    if (candidate.accepted) return 'validated-match';
    return 'safe-removal';
}

function shouldEscalateSearch(candidate) {
    if (!candidate) return true;

    return Math.abs(candidate.processedSpatialScore) > STANDARD_FAST_PATH_RESIDUAL_THRESHOLD ||
        Math.max(0, candidate.processedGradientScore) > STANDARD_FAST_PATH_GRADIENT_THRESHOLD;
}

function shouldExpandCatalogForWeakOriginalStandardEvidence(candidate) {
    if (!candidate) return true;
    if (!isStandardCandidateSource(candidate)) return false;
    if (candidate?.provenance?.catalogVariant === true) return false;

    const originalGradient = Number(candidate.originalGradientScore);
    if (!Number.isFinite(originalGradient)) return false;

    return originalGradient < STANDARD_EXPAND_CATALOG_MIN_ORIGINAL_GRADIENT;
}

function shouldSearchNearbyStandardCandidate(candidate, originalImageData) {
    if (!candidate) return true;

    return Number(candidate.position?.width) >= 72 &&
        Number(originalImageData?.height) > Number(originalImageData?.width) * 1.25 &&
        (
            Math.abs(candidate.processedSpatialScore) > STANDARD_NEARBY_SEARCH_RESIDUAL_THRESHOLD ||
            Math.max(0, candidate.processedGradientScore) > STANDARD_NEARBY_SEARCH_GRADIENT_THRESHOLD
        );
}

function resolveAlphaMapForSize(size, { alpha48, alpha96, getAlphaMap } = {}) {
    if (size === 48) return alpha48;
    if (size === 96) return alpha96;

    const provided = typeof getAlphaMap === 'function' ? getAlphaMap(size) : null;
    if (provided) return provided;

    return alpha96 ? interpolateAlphaMap(alpha96, 96, size) : null;
}

export function resolveSizeJitterAlphaMap(seed, size, {
    alpha48,
    alpha96,
    getAlphaMap,
    resolveAlphaMap = null
} = {}) {
    const seedSize = Number(seed?.position?.width);
    if (seed?.alphaMap && Number.isFinite(seedSize) && seedSize > 0) {
        if (size === seedSize) return seed.alphaMap;
        return interpolateAlphaMap(seed.alphaMap, seedSize, size);
    }

    return typeof resolveAlphaMap === 'function'
        ? resolveAlphaMap(size)
        : resolveAlphaMapForSize(size, { alpha48, alpha96, getAlphaMap });
}

function resolveAlphaMapForConfig(config, {
    alpha48,
    alpha96,
    alpha96Variants = null,
    getAlphaMap,
    resolveAlphaMap = null
} = {}) {
    if (!config) return null;
    if (config.alphaVariant && config.logoSize === 96 && alpha96Variants) {
        return alpha96Variants[config.alphaVariant] ?? null;
    }
    if (config.alphaVariant && typeof getAlphaMap === 'function') {
        const variantAlpha = getAlphaMap(`${config.logoSize}-${config.alphaVariant}`);
        if (variantAlpha) return variantAlpha;
    }
    return typeof resolveAlphaMap === 'function'
        ? resolveAlphaMap(config.logoSize)
        : resolveAlphaMapForSize(config.logoSize, {
            alpha48,
            alpha96,
            getAlphaMap
        });
}

function createAlphaMapResolver({ alpha48, alpha96, getAlphaMap }) {
    const cache = new Map();

    return (size) => {
        if (cache.has(size)) {
            return cache.get(size);
        }

        const resolved = resolveAlphaMapForSize(size, {
            alpha48,
            alpha96,
            getAlphaMap
        });
        cache.set(size, resolved);
        return resolved;
    };
}

function isPreviewAnchorGainSearchRequired(candidate) {
    if (!candidate) return true;

    return Math.abs(candidate.processedSpatialScore) > PREVIEW_ANCHOR_GAIN_SKIP_RESIDUAL_THRESHOLD ||
        Math.max(0, candidate.processedGradientScore) > PREVIEW_ANCHOR_GAIN_SKIP_GRADIENT_THRESHOLD;
}

function isCleanStandardAlphaCandidate(candidate) {
    if (!candidate?.accepted) return false;

    return Math.abs(candidate.processedSpatialScore) <= STANDARD_FAST_PATH_RESIDUAL_THRESHOLD &&
        Math.max(0, candidate.processedGradientScore) <= STANDARD_FAST_PATH_GRADIENT_THRESHOLD;
}

function isStrictFixedCoreCandidate(candidate) {
    if (!candidate?.accepted) return false;

    const processedSpatial = Number(candidate.processedSpatialScore);
    if (!Number.isFinite(processedSpatial)) return false;

    if (Math.abs(processedSpatial) <= FIXED_CORE_MAX_ACCEPTED_SPATIAL_RESIDUAL) {
        return true;
    }

    const originalSpatial = Number(candidate.originalSpatialScore);
    const originalGradient = Number(candidate.originalGradientScore);
    const processedGradient = Number(candidate.processedGradientScore);
    const improvement = Number(candidate.improvement);
    const texturePenalty = Number(candidate.texturePenalty);
    const nearBlackIncrease = Number(candidate.nearBlackIncrease);
    if (
        !Number.isFinite(originalSpatial) ||
        !Number.isFinite(originalGradient) ||
        !Number.isFinite(processedGradient) ||
        !Number.isFinite(improvement) ||
        !Number.isFinite(texturePenalty) ||
        !Number.isFinite(nearBlackIncrease)
    ) {
        return false;
    }

    const isStrongStandard96 =
        candidate.config?.logoSize === 96 &&
        isStandardCandidateSource(candidate) &&
        candidate.provenance?.localShift !== true &&
        candidate.provenance?.sizeJitter !== true &&
        candidate.provenance?.previewAnchor !== true;
    if (!isStrongStandard96 || candidate.hardReject === true) return false;

    const boundedNegativeOvershoot =
        processedSpatial < 0 &&
        Math.abs(processedSpatial) <= FIXED_CORE_STRONG_96_MAX_NEGATIVE_SPATIAL_RESIDUAL &&
        originalSpatial >= FIXED_CORE_STRONG_96_MIN_ORIGINAL_SPATIAL_SCORE &&
        originalGradient >= FIXED_CORE_STRONG_96_MIN_ORIGINAL_GRADIENT_SCORE &&
        processedGradient <= FIXED_CORE_STRONG_96_MAX_PROCESSED_GRADIENT_SCORE &&
        improvement >= FIXED_CORE_STRONG_96_MIN_IMPROVEMENT &&
        texturePenalty <= FIXED_CORE_STRONG_96_MAX_TEXTURE &&
        nearBlackIncrease <= FIXED_CORE_STRONG_96_MAX_NEAR_BLACK_INCREASE;
    const strongLowResidualFullAnchor =
        Math.abs(processedSpatial) <= FIXED_CORE_STRONG_96_LOW_RESIDUAL_MAX_SPATIAL_SCORE &&
        processedGradient <= FIXED_CORE_STRONG_96_LOW_RESIDUAL_MAX_GRADIENT_SCORE &&
        originalSpatial >= FIXED_CORE_STRONG_96_LOW_RESIDUAL_MIN_ORIGINAL_SPATIAL_SCORE &&
        originalGradient >= FIXED_CORE_STRONG_96_LOW_RESIDUAL_MIN_ORIGINAL_GRADIENT_SCORE &&
        improvement >= FIXED_CORE_STRONG_96_LOW_RESIDUAL_MIN_IMPROVEMENT &&
        texturePenalty <= FIXED_CORE_STRONG_96_MAX_TEXTURE &&
        nearBlackIncrease <= FIXED_CORE_STRONG_96_MAX_NEAR_BLACK_INCREASE;

    return boundedNegativeOvershoot || strongLowResidualFullAnchor;
}

function isCleanWeakAlphaPriorityCandidate(candidate) {
    if (!candidate?.accepted) return false;

    return Math.abs(candidate.processedSpatialScore) <= STANDARD_FAST_PATH_RESIDUAL_THRESHOLD &&
        Math.max(0, candidate.processedGradientScore) <= WEAK_ALPHA_PRIORITY_CLEAN_GRADIENT_THRESHOLD;
}

function normalizeAlphaPriorityGains(alphaPriorityGains) {
    const gains = Array.isArray(alphaPriorityGains) && alphaPriorityGains.length > 0
        ? alphaPriorityGains
        : [1];
    const normalized = [];
    const seen = new Set();
    for (const gain of gains) {
        if (!Number.isFinite(gain) || gain <= 0) continue;
        const key = gain.toFixed(4);
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(gain);
    }

    if (!seen.has('1.0000')) {
        normalized.push(1);
    }

    return normalized;
}

function isWeakAlphaPrioritySeed(seed) {
    return seed?.config?.logoSize === 48 &&
        seed.config.marginRight === 96 &&
        seed.config.marginBottom === 96;
}

function isWeakDarkPolarity48Seed(seed) {
    return seed?.provenance?.weakDarkPolarity48 === true;
}

function resolveStandardSeedAlphaPriorityGains(seed, alphaPriorityGains) {
    if (isWeakDarkPolarity48Seed(seed)) {
        return DARK_POLARITY_48_ULTRA_WEAK_ALPHA_GAINS;
    }

    const extras = isWeakAlphaPrioritySeed(seed)
        ? [
            ...CURRENT_LARGE_MARGIN_ULTRA_WEAK_ALPHA_GAINS,
            STANDARD_CONSERVATIVE_CATALOG_PREFERRED_ALPHA_GAIN
        ]
        : STANDARD_ANCHOR_WEAK_ALPHA_RESCUE_GAINS;

    return normalizeAlphaPriorityGains([
        ...alphaPriorityGains,
        ...extras
    ]);
}

function isWeakAlphaRescueCandidate(seed, trial) {
    if (!trial?.accepted || trial.alphaGain >= 1) {
        return false;
    }

    if (isWeakAlphaPrioritySeed(seed)) {
        const isVisibleStrongRescue =
            trial.originalSpatialScore >= CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MIN_ORIGINAL_SPATIAL &&
            trial.originalGradientScore >= CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MIN_ORIGINAL_GRADIENT &&
            Math.abs(trial.processedSpatialScore) <= CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MAX_SPATIAL &&
            Math.max(0, trial.processedGradientScore) <= CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MAX_GRADIENT &&
            trial.improvement >= CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MIN_IMPROVEMENT &&
            trial.nearBlackIncrease <= CURRENT_LARGE_MARGIN_VISIBLE_RESCUE_MAX_NEAR_BLACK_INCREASE;
        if (isVisibleStrongRescue) {
            return true;
        }

        const isMediumSafeRescue =
            (
                trial.originalSpatialScore >= CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MIN_ORIGINAL_SPATIAL ||
                trial.originalGradientScore >= CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MIN_ORIGINAL_GRADIENT
            ) &&
            Math.abs(trial.processedSpatialScore) <= CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MAX_SPATIAL &&
            Math.max(0, trial.processedGradientScore) <= CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MAX_GRADIENT &&
            trial.improvement >= CURRENT_LARGE_MARGIN_WEAK_RESCUE_MIN_IMPROVEMENT &&
            trial.nearBlackIncrease <= CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_NEAR_BLACK_INCREASE &&
            trial.texturePenalty <= CURRENT_LARGE_MARGIN_MEDIUM_RESCUE_MAX_TEXTURE &&
            trial.hardReject !== true;
        if (isMediumSafeRescue) {
            return true;
        }

        const hasRescueEvidence =
            trial.originalSpatialScore >= CURRENT_LARGE_MARGIN_WEAK_RESCUE_MIN_ORIGINAL_SPATIAL ||
            trial.originalGradientScore >= CURRENT_LARGE_MARGIN_WEAK_RESCUE_MIN_ORIGINAL_GRADIENT ||
            (
                trial.originalSpatialScore >= STANDARD_CONSERVATIVE_CATALOG_MIN_ORIGINAL_SPATIAL_SCORE &&
                trial.originalGradientScore >= STANDARD_CONSERVATIVE_CATALOG_MIN_ORIGINAL_GRADIENT_SCORE
            );

        return hasRescueEvidence &&
            Math.abs(trial.processedSpatialScore) <= CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_SPATIAL &&
            Math.max(0, trial.processedGradientScore) <= CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_GRADIENT &&
            trial.improvement >= CURRENT_LARGE_MARGIN_WEAK_RESCUE_MIN_IMPROVEMENT &&
            trial.nearBlackIncrease <= CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_NEAR_BLACK_INCREASE &&
            trial.texturePenalty <= CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_TEXTURE;
    }

    if (trial.hardReject === true) {
        return false;
    }

    return trial.originalEvidence?.tier === 'strong' &&
        Math.abs(trial.processedSpatialScore) <= STANDARD_ANCHOR_WEAK_RESCUE_MAX_SPATIAL &&
        Math.max(0, trial.processedGradientScore) <= STANDARD_ANCHOR_WEAK_RESCUE_MAX_GRADIENT &&
        trial.improvement >= STANDARD_ANCHOR_WEAK_RESCUE_MIN_IMPROVEMENT &&
        trial.nearBlackIncrease <= STANDARD_ANCHOR_WEAK_RESCUE_MAX_NEAR_BLACK_INCREASE &&
        trial.texturePenalty <= 0.25;
}

function isStandardTextOverlapWeakAlphaCandidate(seed, trial) {
    if (!trial?.accepted || trial.alphaGain >= 1 || trial.hardReject === true) {
        return false;
    }
    if (
        seed?.config?.logoSize !== 96 ||
        seed.config.marginRight !== 64 ||
        seed.config.marginBottom !== 64
    ) {
        return false;
    }

    return trial.originalSpatialScore >= STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MIN_ORIGINAL_SPATIAL_SCORE &&
        trial.originalGradientScore >= STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MIN_ORIGINAL_GRADIENT_SCORE &&
        trial.improvement >= STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MIN_IMPROVEMENT &&
        Math.abs(trial.processedSpatialScore) <= STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MAX_SPATIAL_RESIDUAL &&
        Math.max(0, trial.processedGradientScore) <= STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MAX_GRADIENT_RESIDUAL &&
        trial.nearBlackIncrease <= STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MAX_NEAR_BLACK_INCREASE &&
        trial.texturePenalty <= STANDARD_TEXT_OVERLAP_WEAK_ALPHA_MAX_TEXTURE;
}

function tagCandidateSource(candidate, tag) {
    if (!candidate || String(candidate.source).includes(tag)) return candidate;
    return {
        ...candidate,
        source: `${candidate.source}+${tag}`
    };
}

function shouldPreferLargeMarginGradientClearance(currentBest, candidate) {
    if (!isCurrentLargeMarginCatalogCandidate(currentBest) || !isCurrentLargeMarginCatalogCandidate(candidate)) {
        return false;
    }
    if (currentBest.alphaGain >= 1 || candidate.alphaGain >= 1) {
        return false;
    }
    if (candidate.alphaGain > CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MAX_ALPHA_GAIN) {
        return false;
    }
    if (
        candidate.originalGradientScore < CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MIN_ORIGINAL_GRADIENT ||
        candidate.originalSpatialScore > CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MAX_ORIGINAL_SPATIAL
    ) {
        return false;
    }
    if (
        candidate.texturePenalty > CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MAX_TEXTURE ||
        currentBest.texturePenalty > CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MAX_TEXTURE
    ) {
        return false;
    }
    if (Math.abs(candidate.processedSpatialScore) > CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MAX_SPATIAL) {
        return false;
    }
    if (candidate.nearBlackIncrease > CURRENT_LARGE_MARGIN_WEAK_RESCUE_MAX_NEAR_BLACK_INCREASE) {
        return false;
    }

    return Math.max(0, currentBest.processedGradientScore) -
        Math.max(0, candidate.processedGradientScore) >= CURRENT_LARGE_MARGIN_GRADIENT_CLEAR_MIN_GRADIENT_DROP;
}

function pickBetterWeakAlphaRescueCandidate(seed, currentBest, candidate) {
    if (!candidate?.accepted) return currentBest;
    if (!currentBest) return candidate;
    if (
        isWeakAlphaPrioritySeed(seed) &&
        shouldPreferLargeMarginGradientClearance(currentBest, candidate)
    ) {
        return candidate;
    }
    return pickBetterCandidate(currentBest, candidate, 0.002);
}

function shouldPreferWeakAlphaRescueOverAccepted(acceptedTrial, rescueTrial) {
    if (!acceptedTrial?.accepted || !rescueTrial?.accepted) return false;
    if (rescueTrial.alphaGain >= 1) return false;

    const acceptedCost = Number(acceptedTrial.validationCost);
    const rescueCost = Number(rescueTrial.validationCost);
    if (!Number.isFinite(acceptedCost) || !Number.isFinite(rescueCost)) return false;

    return rescueCost <= acceptedCost - STANDARD_ANCHOR_WEAK_RESCUE_MIN_BALANCED_ADVANTAGE &&
        Math.abs(rescueTrial.processedSpatialScore) <= Math.abs(acceptedTrial.processedSpatialScore) &&
        Math.max(0, rescueTrial.processedGradientScore) <= STANDARD_ANCHOR_WEAK_RESCUE_MAX_GRADIENT &&
        rescueTrial.nearBlackIncrease <= STANDARD_ANCHOR_WEAK_RESCUE_MAX_NEAR_BLACK_INCREASE;
}

function evaluateStandardTrialForSeed({
    originalImageData,
    seed,
    alphaPriorityGains
}) {
    const priorityGains = resolveStandardSeedAlphaPriorityGains(seed, alphaPriorityGains);
    let fallbackTrial = null;
    let bestAcceptedTrial = null;
    let bestWeakAlphaPriorityTrial = null;
    let bestWeakAlphaRescueTrial = null;

    for (const alphaGain of priorityGains) {
        const trial = evaluateRestorationCandidate({
            originalImageData,
            alphaMap: seed.alphaMap,
            position: seed.position,
            source: alphaGain === 1 ? seed.source : `${seed.source}+gain`,
            config: seed.config,
            baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, seed.position),
            alphaGain,
            provenance: seed.provenance,
            includeImageData: false
        });
        if (!trial) continue;

        if (alphaGain === 1 || !fallbackTrial) {
            fallbackTrial = trial;
        }
        if (alphaGain < 1) {
            if (isStandardTextOverlapWeakAlphaCandidate(seed, trial)) {
                bestWeakAlphaPriorityTrial = pickBetterCandidate(
                    bestWeakAlphaPriorityTrial,
                    tagCandidateSource(trial, 'text-overlap'),
                    0.002
                );
            }
            if (
                isWeakAlphaPrioritySeed(seed) &&
                isCleanWeakAlphaPriorityCandidate(trial) &&
                isWeakAlphaRescueCandidate(seed, trial)
            ) {
                bestWeakAlphaPriorityTrial = pickBetterCandidate(bestWeakAlphaPriorityTrial, trial, 0.002);
            }
            if (isWeakAlphaRescueCandidate(seed, trial)) {
                bestWeakAlphaRescueTrial = pickBetterWeakAlphaRescueCandidate(seed, bestWeakAlphaRescueTrial, trial);
            }
            continue;
        }
        if (trial.accepted) {
            bestAcceptedTrial = pickBetterCandidate(bestAcceptedTrial, trial, 0.002);
        }
    }

    const selected = isWeakAlphaPrioritySeed(seed)
        ? bestWeakAlphaPriorityTrial ?? bestWeakAlphaRescueTrial ?? bestAcceptedTrial ?? fallbackTrial
        : bestWeakAlphaPriorityTrial ??
            (
                shouldPreferWeakAlphaRescueOverAccepted(bestAcceptedTrial, bestWeakAlphaRescueTrial)
                    ? bestWeakAlphaRescueTrial
                    : bestAcceptedTrial
            ) ??
            bestWeakAlphaRescueTrial ??
            fallbackTrial;

    return isWeakDarkPolarity48Seed(seed) && selected?.accepted !== true
        ? null
        : selected;
}

export function evaluateRestorationCandidate({
    originalImageData,
    alphaMap,
    position,
    source,
    config,
    baselineNearBlackRatio,
    adaptiveConfidence = null,
    alphaGain = 1,
    provenance = null,
    includeImageData = true,
    sourcePriority = null,
    alphaPriorityIndex = null
}) {
    if (!alphaMap || !position) return null;

    const originalScores = scoreRegion(originalImageData, alphaMap, position);
    const regionCandidate = createCandidateRegionImageData({
        originalImageData,
        alphaMap,
        position,
        alphaGain,
        provenance
    });
    const regionImageData = regionCandidate.imageData;
    const outlineDarkRepair = regionCandidate.outlineDarkRepair;
    const regionPosition = {
        x: ORIGIN_REGION.x,
        y: ORIGIN_REGION.y,
        width: position.width,
        height: position.height
    };
    const processedScores = scoreRegion(regionImageData, alphaMap, regionPosition);
    const nearBlackRatio = calculateNearBlackRatio(regionImageData, regionPosition);
    const nearBlackIncrease = nearBlackRatio - baselineNearBlackRatio;
    const baselineNearWhiteRatio = calculateNearWhiteRatio(originalImageData, position);
    const nearWhiteRatio = calculateNearWhiteRatio(regionImageData, regionPosition);
    const nearWhiteIncrease = nearWhiteRatio - baselineNearWhiteRatio;
    // Signed suppression keeps legitimate "slight overshoot" restores eligible.
    const improvement = originalScores.spatialScore - processedScores.spatialScore;
    const gradientIncrease = processedScores.gradientScore - originalScores.gradientScore;
    const textureAssessment = assessReferenceTextureAlignmentFromStats({
        originalImageData,
        referenceImageData: originalImageData,
        candidateTextureStats: getRegionTextureStats(regionImageData, regionPosition),
        position
    });
    const texturePenalty = textureAssessment.texturePenalty;
    const gradientDrop = originalScores.gradientScore - processedScores.gradientScore;
    const strongStandardSignalNearBlackOverride =
        isStandardCandidateSource({ source }) &&
        alphaGain === 1 &&
        originalScores.spatialScore >= STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MIN_SPATIAL_SCORE &&
        originalScores.gradientScore >= STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MIN_GRADIENT_SCORE &&
        Math.abs(processedScores.spatialScore) <= STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MAX_RESIDUAL &&
        processedScores.gradientScore <= STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MAX_GRADIENT &&
        improvement >= STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MIN_IMPROVEMENT &&
        gradientDrop >= STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MIN_GRADIENT_DROP &&
        nearBlackIncrease <= STANDARD_STRONG_SIGNAL_NEAR_BLACK_OVERRIDE_MAX_NEAR_BLACK_INCREASE;
    const nearBlackIncreaseAllowed =
        nearBlackIncrease <= MAX_NEAR_BLACK_RATIO_INCREASE ||
        strongStandardSignalNearBlackOverride ||
        (
            source === 'standard' &&
            originalScores.spatialScore >= STANDARD_TEXT_OVERLAP_MIN_SPATIAL_SCORE &&
            originalScores.gradientScore >= STANDARD_TEXT_OVERLAP_MIN_GRADIENT_SCORE &&
            improvement >= STANDARD_TEXT_OVERLAP_MIN_IMPROVEMENT &&
            Math.abs(processedScores.spatialScore) <= STANDARD_TEXT_OVERLAP_MAX_RESIDUAL &&
            gradientDrop >= STANDARD_TEXT_OVERLAP_MIN_GRADIENT_DROP
        );
    const hardRejectAllowed =
        textureAssessment.hardReject !== true ||
        (
            isStandardCandidateSource({ source }) &&
            originalScores.spatialScore >= STANDARD_HARD_REJECT_OVERRIDE_MIN_SPATIAL_SCORE &&
            originalScores.gradientScore >= STANDARD_HARD_REJECT_OVERRIDE_MIN_GRADIENT_SCORE &&
            Math.abs(processedScores.spatialScore) <= STANDARD_HARD_REJECT_OVERRIDE_MAX_RESIDUAL &&
            processedScores.gradientScore <= STANDARD_HARD_REJECT_OVERRIDE_MAX_GRADIENT &&
            improvement >= STANDARD_HARD_REJECT_OVERRIDE_MIN_IMPROVEMENT &&
            nearBlackIncrease <= STANDARD_HARD_REJECT_OVERRIDE_MAX_NEAR_BLACK_INCREASE
        );
    const conservativeCatalogHardRejectAllowed =
        textureAssessment.hardReject === true &&
        isCurrentLargeMarginCatalogCandidate({ config, provenance }) &&
        alphaGain <= STANDARD_CONSERVATIVE_CATALOG_MAX_ALPHA_GAIN &&
        originalScores.spatialScore >= STANDARD_CONSERVATIVE_CATALOG_MIN_ORIGINAL_SPATIAL_SCORE &&
        originalScores.gradientScore >= STANDARD_CONSERVATIVE_CATALOG_MIN_ORIGINAL_GRADIENT_SCORE &&
        Math.abs(processedScores.spatialScore) <= STANDARD_CONSERVATIVE_CATALOG_MAX_RESIDUAL &&
        processedScores.gradientScore <= STANDARD_CONSERVATIVE_CATALOG_MAX_GRADIENT &&
        improvement >= STANDARD_CONSERVATIVE_CATALOG_MIN_IMPROVEMENT &&
        nearBlackIncrease <= STANDARD_CONSERVATIVE_CATALOG_MAX_NEAR_BLACK_INCREASE;
    const visibleCatalogHardRejectAllowed =
        textureAssessment.hardReject === true &&
        isCurrentLargeMarginCatalogCandidate({ config, provenance }) &&
        alphaGain <= STANDARD_VISIBLE_CATALOG_MAX_ALPHA_GAIN &&
        originalScores.spatialScore >= STANDARD_VISIBLE_CATALOG_MIN_ORIGINAL_SPATIAL_SCORE &&
        originalScores.gradientScore >= STANDARD_VISIBLE_CATALOG_MIN_ORIGINAL_GRADIENT_SCORE &&
        Math.abs(processedScores.spatialScore) <= STANDARD_VISIBLE_CATALOG_MAX_SPATIAL_RESIDUAL &&
        processedScores.gradientScore <= STANDARD_VISIBLE_CATALOG_MAX_GRADIENT_RESIDUAL &&
        improvement >= STANDARD_VISIBLE_CATALOG_MIN_IMPROVEMENT &&
        nearBlackIncrease <= STANDARD_VISIBLE_CATALOG_MAX_NEAR_BLACK_INCREASE;
    const newMarginAlphaHardRejectAllowed =
        textureAssessment.hardReject === true &&
        isNewMarginAlphaVariantTrial({ config, provenance }) &&
        alphaGain === 1 &&
        originalScores.spatialScore >= STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MIN_SPATIAL_SCORE &&
        originalScores.gradientScore >= STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MIN_GRADIENT_SCORE &&
        Math.abs(processedScores.spatialScore) <= STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MAX_RESIDUAL &&
        processedScores.gradientScore <= STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MAX_GRADIENT &&
        improvement >= STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MIN_IMPROVEMENT &&
        gradientDrop >= STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MIN_GRADIENT_DROP &&
        nearBlackIncrease <= STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MAX_NEAR_BLACK_INCREASE &&
        texturePenalty <= STANDARD_NEW_MARGIN_ALPHA_OVERRIDE_MAX_TEXTURE;
    const originalEvidenceAllowed =
        !isStandardCandidateSource({ source }) ||
        originalScores.spatialScore >= STANDARD_VALIDATION_MIN_ORIGINAL_SPATIAL_SCORE ||
        originalScores.gradientScore >= STANDARD_VALIDATION_MIN_ORIGINAL_GRADIENT_SCORE;
    const catalogEvidenceGate = provenance?.catalogEvidenceGate ?? null;
    const catalogEvidenceAllowed =
        catalogEvidenceGate !== 'medium' ||
        originalScores.spatialScore >= 0.15 ||
        originalScores.gradientScore >= 0.08;
    const strongDarkPolarityOriginalEvidence =
        originalScores.spatialScore >= DARK_POLARITY_CATALOG_MIN_ORIGINAL_SPATIAL ||
        originalScores.gradientScore >= DARK_POLARITY_CATALOG_MIN_ORIGINAL_GRADIENT;
    const isLargeMargin48DarkPolarity =
        provenance?.darkPolarity === true &&
        config?.logoSize === 48 &&
        config.marginRight >= 90 &&
        config.marginRight <= 100 &&
        config.marginBottom >= 90 &&
        config.marginBottom <= 100;
    const largeMargin48DarkPolarityEvidenceAllowed =
        !isLargeMargin48DarkPolarity ||
        (
            originalScores.spatialScore >= DARK_POLARITY_48_MIN_ORIGINAL_SPATIAL &&
            originalScores.gradientScore >= DARK_POLARITY_48_MIN_ORIGINAL_GRADIENT
        );
    const weakDarkPolarity48ScopeAllowed =
        provenance?.weakDarkPolarity48 !== true ||
        (
            config?.logoSize === 48 &&
            config.marginRight >= 90 &&
            config.marginRight <= 100 &&
            config.marginBottom >= 90 &&
            config.marginBottom <= 100 &&
            alphaGain <= 0.2
        );
    const darkPolarityCatalogEvidenceAllowed =
        provenance?.darkPolarity !== true ||
        provenance?.catalogVariant !== true ||
        (
            weakDarkPolarity48ScopeAllowed &&
            largeMargin48DarkPolarityEvidenceAllowed &&
            (
                strongDarkPolarityOriginalEvidence ||
                texturePenalty <= DARK_POLARITY_CATALOG_MAX_TEXTURE_FOR_WEAK_EVIDENCE
            )
        );
    const strongDarkPolarityNearWhiteOverrideEvidence =
        originalScores.spatialScore >= DARK_POLARITY_NEAR_WHITE_OVERRIDE_MIN_ORIGINAL_SPATIAL ||
        originalScores.gradientScore >= DARK_POLARITY_NEAR_WHITE_OVERRIDE_MIN_ORIGINAL_GRADIENT;
    const darkPolarityNearWhiteIncreaseAllowed =
        provenance?.darkPolarity !== true ||
        strongDarkPolarityNearWhiteOverrideEvidence ||
        nearWhiteIncrease <= DARK_POLARITY_MAX_NEAR_WHITE_RATIO_INCREASE_FOR_WEAK_EVIDENCE;
    const outlineLightEvidenceAllowed =
        provenance?.outlineLight !== true ||
        (
            alphaGain === 1 &&
            originalScores.gradientScore >= OUTLINE_LIGHT_MIN_ORIGINAL_GRADIENT &&
            improvement >= OUTLINE_LIGHT_MIN_IMPROVEMENT &&
            Math.abs(processedScores.spatialScore) <= OUTLINE_LIGHT_MAX_PROCESSED_SPATIAL &&
                processedScores.gradientScore <= OUTLINE_LIGHT_MAX_PROCESSED_GRADIENT
        );
    const outlineDarkBodyGain = Number.isFinite(provenance?.outlineDarkBodyGain)
        ? provenance.outlineDarkBodyGain
        : 1;
    const outlineDarkMinImprovement = OUTLINE_DARK_MIN_IMPROVEMENT * Math.max(
        OUTLINE_DARK_MIN_BODY_GAIN,
        Math.min(1, outlineDarkBodyGain)
    );
    const outlineDarkEvidenceAllowed =
        provenance?.outlineDark !== true ||
        (
            alphaGain === 1 &&
            outlineDarkRepair?.accepted === true &&
            outlineDarkRepair.maskPixels >= OUTLINE_DARK_MIN_REPAIR_PIXELS &&
            outlineDarkRepair.maskPixels <= OUTLINE_DARK_MAX_REPAIR_PIXELS &&
            originalScores.gradientScore >= OUTLINE_DARK_MIN_ORIGINAL_GRADIENT &&
            improvement >= outlineDarkMinImprovement &&
            Math.abs(processedScores.spatialScore) <= OUTLINE_DARK_MAX_PROCESSED_SPATIAL &&
            processedScores.gradientScore <= OUTLINE_DARK_MAX_PROCESSED_GRADIENT
        );
    const outlineDarkHardRejectAllowed =
        textureAssessment.hardReject === true &&
        outlineDarkEvidenceAllowed &&
        provenance?.outlineDark === true &&
        nearBlackIncrease <= 0.01;
    const baseValidationAccepted =
        (
            hardRejectAllowed ||
            conservativeCatalogHardRejectAllowed ||
            visibleCatalogHardRejectAllowed ||
            newMarginAlphaHardRejectAllowed ||
            outlineDarkHardRejectAllowed
        ) &&
        nearBlackIncreaseAllowed &&
        improvement >= VALIDATION_MIN_IMPROVEMENT &&
        (
            Math.abs(processedScores.spatialScore) <= VALIDATION_TARGET_RESIDUAL ||
            gradientIncrease <= VALIDATION_MAX_GRADIENT_INCREASE
        );
    const mergedProvenance = mergeCandidateProvenance(provenance);
    const resolvedSourcePriority = Number.isFinite(sourcePriority)
        ? sourcePriority
        : inferCandidateSourcePriority({ source, provenance: mergedProvenance });
    const resolvedAlphaPriorityIndex = Number.isFinite(alphaPriorityIndex)
        ? alphaPriorityIndex
        : inferAlphaPriorityIndex(alphaGain);
    const originalEvidence = scoreOriginalEvidence({
        spatial: originalScores.spatialScore,
        gradient: originalScores.gradientScore
    });
    const residual = scoreResidual({
        processedSpatial: processedScores.spatialScore,
        processedGradient: processedScores.gradientScore,
        suppressionGain: improvement
    });
    const balancedVisual = scoreBalancedVisualCandidate({
        processedSpatial: processedScores.spatialScore,
        processedGradient: processedScores.gradientScore,
        nearBlackIncrease,
        texturePenalty,
        gradientIncrease
    });
    const hardRejectBypassed =
        conservativeCatalogHardRejectAllowed ||
        visibleCatalogHardRejectAllowed ||
        newMarginAlphaHardRejectAllowed ||
        outlineDarkHardRejectAllowed;
    const damage = scoreDamage({
        hardReject: textureAssessment.hardReject === true && !hardRejectBypassed,
        nearBlackIncrease,
        texturePenalty
    });
    const evaluation = createCandidateEvaluation({
        source,
        config,
        provenance: mergedProvenance,
        originalScores,
        processedScores,
        improvement,
        residual,
        damage,
        gates: {
            originalEvidenceAllowed,
            catalogEvidenceAllowed,
            darkPolarityCatalogEvidenceAllowed,
            darkPolarityNearWhiteIncreaseAllowed,
            outlineLightEvidenceAllowed,
            outlineDarkEvidenceAllowed,
            baseValidationAccepted
        }
    });
    const accepted = evaluation.eligible;
    const rankingKey = buildRankingKey({
        sourcePriority: resolvedSourcePriority,
        originalEvidenceTier: originalEvidence.tier,
        damageSafe: damage.safe,
        residualScore: residual.score,
        alphaPriorityIndex: resolvedAlphaPriorityIndex,
        damagePenalty: damage.penalty
    });
    const earlyAccept = shouldEarlyAccept({
        sourcePriority: resolvedSourcePriority,
        originalEvidence,
        residual,
        damage
    });

    return {
        accepted,
        source,
        config,
        position,
        alphaMap,
        adaptiveConfidence,
        alphaGain,
        sourcePriority: resolvedSourcePriority,
        alphaPriorityIndex: resolvedAlphaPriorityIndex,
        rankingKey,
        earlyAccept,
        provenance: mergedProvenance,
        imageData: includeImageData
            ? materializeCandidateImageData(originalImageData, alphaMap, position, alphaGain, provenance)
            : null,
        outlineDarkRepair,
        originalSpatialScore: originalScores.spatialScore,
        originalGradientScore: originalScores.gradientScore,
        processedSpatialScore: processedScores.spatialScore,
        processedGradientScore: processedScores.gradientScore,
        improvement,
        nearBlackRatio,
        nearBlackIncrease,
        nearWhiteRatio,
        nearWhiteIncrease,
        gradientIncrease,
        tooDark: textureAssessment.tooDark,
        tooFlat: textureAssessment.tooFlat,
        hardReject: textureAssessment.hardReject,
        texturePenalty,
        originalEvidence,
        residual,
        damage,
        evaluation,
        balancedVisual,
        validationCost: balancedVisual.score
    };
}

function pickBestValidatedCandidate(candidates) {
    const accepted = candidates.filter((candidate) => candidate?.accepted);
    if (accepted.length === 0) return null;

    accepted.sort((a, b) => {
        if (a.validationCost !== b.validationCost) {
            return a.validationCost - b.validationCost;
        }

        return b.improvement - a.improvement;
    });

    const validationBest = accepted[0];
    const preservedStrongCanonical96 = accepted.find((candidate) => (
        shouldPreserveStrongCanonical96AgainstWeakCurrentLargeMargin(candidate, validationBest)
    ));
    return preservedStrongCanonical96 ?? validationBest;
}

function pickAggressiveStrongLocatedCandidate(candidates) {
    const located = candidates
        .filter((candidate) => (
            candidate &&
            isAggressiveLocatedCandidate(candidate)
        ))
        .sort((left, right) => {
            const rightSignal =
                Number(right.originalSpatialScore) +
                Math.max(0, Number(right.originalGradientScore)) * 0.75;
            const leftSignal =
                Number(left.originalSpatialScore) +
                Math.max(0, Number(left.originalGradientScore)) * 0.75;
            if (rightSignal !== leftSignal) return rightSignal - leftSignal;
            return Number(left.validationCost ?? Infinity) - Number(right.validationCost ?? Infinity);
        });
    return located[0] ?? null;
}

function isAggressiveLocatedCandidate(candidate) {
    const spatialScore = Number(candidate.originalSpatialScore);
    const gradientScore = Number(candidate.originalGradientScore);
    if (!Number.isFinite(spatialScore) || !Number.isFinite(gradientScore)) return false;

    const highConfidence = spatialScore >= 0.75 && gradientScore >= 0.5;
    const clearShape = spatialScore >= 0.38 && gradientScore >= -0.06;
    const lowContrastShape = spatialScore >= 0.24 && gradientScore >= 0.02;
    const visibleGradient = spatialScore >= 0.12 && gradientScore >= 0.28;

    return highConfidence || clearShape || lowContrastShape || visibleGradient;
}

function createCandidateRegionImageData({
    originalImageData,
    alphaMap,
    position,
    alphaGain,
    provenance = null
}) {
    const regionImageData = {
        width: position.width,
        height: position.height,
        data: new Uint8ClampedArray(position.width * position.height * 4)
    };

    for (let row = 0; row < position.height; row++) {
        const srcStart = ((position.y + row) * originalImageData.width + position.x) * 4;
        const srcEnd = srcStart + position.width * 4;
        const destStart = row * position.width * 4;
        regionImageData.data.set(originalImageData.data.subarray(srcStart, srcEnd), destStart);
    }

    removeWatermark(regionImageData, alphaMap, {
        x: 0,
        y: 0,
        width: position.width,
        height: position.height
    }, { alphaGain });

    const outlineDarkRepair = provenance?.outlineDark === true && alphaGain === 1
        ? repairDarkOutlineContour(regionImageData, {
            x: 0,
            y: 0,
            width: position.width,
            height: position.height
        })
        : null;

    return { imageData: regionImageData, outlineDarkRepair };
}

function materializeCandidateImageData(originalImageData, alphaMap, position, alphaGain, provenance = null) {
    const candidateImageData = cloneImageData(originalImageData);
    removeWatermark(candidateImageData, alphaMap, position, { alphaGain });
    if (provenance?.outlineDark === true && alphaGain === 1) {
        repairDarkOutlineContour(candidateImageData, position);
    }
    return candidateImageData;
}

function ensureCandidateImageData(candidate, originalImageData) {
    if (!candidate) return candidate;
    if (candidate.imageData) return candidate;

    return {
        ...candidate,
        imageData: materializeCandidateImageData(
            originalImageData,
            candidate.alphaMap,
            candidate.position,
            candidate.alphaGain ?? 1,
            candidate.provenance
        )
    };
}

export function materializeCandidateTrial(candidate, originalImageData) {
    if (!candidate?.alphaMap || !candidate?.position) return null;
    return {
        ...candidate,
        imageData: materializeCandidateImageData(
            originalImageData,
            candidate.alphaMap,
            candidate.position,
            candidate.alphaGain ?? 1,
            candidate.provenance
        )
    };
}

function sameCandidateAnchor(left, right) {
    if (!left || !right) return false;

    const leftConfig = left.config;
    const rightConfig = right.config;
    const leftPosition = left.position;
    const rightPosition = right.position;
    if (!leftConfig || !rightConfig || !leftPosition || !rightPosition) return false;

    return leftConfig.logoSize === rightConfig.logoSize &&
        leftConfig.marginRight === rightConfig.marginRight &&
        leftConfig.marginBottom === rightConfig.marginBottom &&
        leftPosition.x === rightPosition.x &&
        leftPosition.y === rightPosition.y &&
        leftPosition.width === rightPosition.width &&
        leftPosition.height === rightPosition.height;
}

function compareSameAnchorCandidateRanking(currentBest, candidate) {
    if (!sameCandidateAnchor(currentBest, candidate)) return null;
    if (currentBest?.provenance?.previewAnchor === true || candidate?.provenance?.previewAnchor === true) {
        return null;
    }
    if (!Array.isArray(currentBest?.rankingKey) || !Array.isArray(candidate?.rankingKey)) {
        return null;
    }

    return compareRankingKey(candidate.rankingKey, currentBest.rankingKey);
}

function shouldPreserveExactNewMarginVariant(exactCandidate, competingCandidate) {
    const exactConfig = exactCandidate?.config ?? {};
    const competingConfig = competingCandidate?.config ?? {};
    const exactVariant = exactConfig.alphaVariant ?? exactCandidate?.provenance?.alphaVariant;
    const competingVariant = competingConfig.alphaVariant ?? competingCandidate?.provenance?.alphaVariant;

    if (exactCandidate?.accepted !== true || exactCandidate?.damage?.safe !== true) return false;
    if (exactConfig.logoSize !== 96 || exactConfig.marginRight !== 192 || exactConfig.marginBottom !== 192) {
        return false;
    }
    if (exactVariant !== '20260520') return false;
    if (competingCandidate?.provenance?.sizeJitter !== true) return false;
    if (competingConfig.marginRight !== 192 || competingConfig.marginBottom !== 192) return false;
    if (competingVariant !== exactVariant) return false;

    return !hasMuchStrongerOriginalSignal(competingCandidate, exactCandidate);
}

export function pickBetterCandidate(currentBest, candidate, minCostDelta = 0.005) {
    if (!candidate?.accepted) return currentBest;
    if (!currentBest) return candidate;
    const evaluationDecision = arbitrateCandidateByEvaluation(currentBest, candidate);
    if (evaluationDecision) return evaluationDecision;
    if (shouldPreserveExactNewMarginVariant(currentBest, candidate)) {
        return currentBest;
    }
    if (shouldPreserveExactNewMarginVariant(candidate, currentBest)) {
        return candidate;
    }
    if (shouldPreserveCatalogOriginalSignal(currentBest, candidate)) {
        return currentBest;
    }
    if (shouldPreserveDominantBottomRight48AgainstWeakStandard(currentBest, candidate)) {
        return currentBest;
    }
    if (shouldPreserveDominantBottomRight48AgainstWeakStandard(candidate, currentBest)) {
        return candidate;
    }
    if (shouldPreserveStrongCanonical96AgainstWeakCurrentLargeMargin(currentBest, candidate)) {
        return currentBest;
    }
    if (shouldPreserveStrongCanonical96AgainstWeakCurrentLargeMargin(candidate, currentBest)) {
        return candidate;
    }
    if (shouldPreserveStrongCanonical96AgainstWeakNewMargin(currentBest, candidate)) {
        return currentBest;
    }
    if (shouldPreserveStrongCanonical96AgainstWeakNewMargin(candidate, currentBest)) {
        return candidate;
    }
    if (shouldPreserveStandardAlphaCanonical96AgainstDarkGain(currentBest, candidate)) {
        return currentBest;
    }
    if (shouldPreserveStandardAlphaCanonical96AgainstDarkGain(candidate, currentBest)) {
        return candidate;
    }
    if (shouldPreserveBalancedAlphaCanonical96(currentBest, candidate)) {
        return currentBest;
    }
    if (shouldPreserveBalancedAlphaCanonical96(candidate, currentBest)) {
        return candidate;
    }
    if (shouldPreferCatalogOriginalSignal(candidate, currentBest)) {
        return candidate;
    }
    if (shouldPreserveStrongStandardAnchor(currentBest, candidate)) {
        return currentBest;
    }
    if (shouldPreferPreviewAnchorCandidate(currentBest, candidate)) {
        return candidate;
    }
    if (shouldPreferPreviewAnchorCandidate(candidate, currentBest)) {
        return currentBest;
    }
    const rankingComparison = compareSameAnchorCandidateRanking(currentBest, candidate);
    if (rankingComparison !== null) {
        if (rankingComparison < 0) return candidate;
        if (rankingComparison > 0) return currentBest;
    }
    if (candidate.validationCost < currentBest.validationCost - minCostDelta) {
        return candidate;
    }
    if (Math.abs(candidate.validationCost - currentBest.validationCost) <= minCostDelta &&
        candidate.improvement > currentBest.improvement + 0.01) {
        return candidate;
    }
    return currentBest;
}

function isStandardCandidateSource(candidate) {
    return typeof candidate?.source === 'string' && candidate.source.startsWith('standard');
}

function isDriftedStandardCandidate(candidate) {
    return isStandardCandidateSource(candidate) &&
        (
            candidate?.provenance?.localShift === true ||
            candidate?.provenance?.sizeJitter === true ||
            candidate?.provenance?.previewAnchor === true ||
            String(candidate?.source || '').includes('+warp')
        );
}

function isCanonicalStandardCandidate(candidate) {
    return isStandardCandidateSource(candidate) &&
        candidate?.provenance?.localShift !== true &&
        candidate?.provenance?.sizeJitter !== true &&
        candidate?.provenance?.previewAnchor !== true;
}

function hasStrongCanonicalAnchorSignal(candidate) {
    const baseSpatial = Number(candidate?.originalSpatialScore);
    const baseGradient = Number(candidate?.originalGradientScore);
    if (!Number.isFinite(baseSpatial) || !Number.isFinite(baseGradient)) {
        return false;
    }
    return (
        baseGradient >= STANDARD_LOCAL_SHIFT_CANONICAL_MIN_GRADIENT_SCORE &&
        baseSpatial >= STANDARD_LOCAL_SHIFT_CANONICAL_MIN_SPATIAL_SCORE
    ) ||
        baseGradient >= STANDARD_LOCAL_SHIFT_STRONG_BASE_GRADIENT_SCORE ||
        baseSpatial >= STANDARD_LOCAL_SHIFT_STRONG_BASE_SPATIAL_SCORE;
}

function hasReliableCandidateOriginalSignal(candidate) {
    return hasReliableStandardWatermarkSignal({
        spatialScore: candidate?.originalSpatialScore,
        gradientScore: candidate?.originalGradientScore
    });
}

function hasMuchStrongerOriginalSignal(candidate, otherCandidate) {
    const spatial = Number(candidate?.originalSpatialScore);
    const gradient = Number(candidate?.originalGradientScore);
    const otherSpatial = Number(otherCandidate?.originalSpatialScore);
    const otherGradient = Number(otherCandidate?.originalGradientScore);
    if (
        !Number.isFinite(spatial) ||
        !Number.isFinite(gradient) ||
        !Number.isFinite(otherSpatial) ||
        !Number.isFinite(otherGradient)
    ) {
        return false;
    }

    return spatial >= otherSpatial + STRONG_ORIGINAL_SIGNAL_SPATIAL_ADVANTAGE &&
        gradient >= otherGradient + STRONG_ORIGINAL_SIGNAL_GRADIENT_ADVANTAGE;
}

function isCatalogVariantCandidate(candidate) {
    return candidate?.provenance?.catalogVariant === true;
}

function isCurrentLargeMarginCatalogCandidate(candidate) {
    return isCatalogVariantCandidate(candidate) &&
        isCurrentLargeMarginCandidate(candidate);
}

function isCurrentLargeMarginCandidate(candidate) {
    return candidate?.config?.logoSize === 48 &&
        candidate.config.marginRight === 96 &&
        candidate.config.marginBottom === 96;
}

function isBottomRight48Candidate(candidate) {
    return candidate?.config?.logoSize === 48 &&
        candidate.config.marginRight === 32 &&
        candidate.config.marginBottom === 32 &&
        candidate?.provenance?.localShift !== true &&
        candidate?.provenance?.sizeJitter !== true &&
        candidate?.provenance?.previewAnchor !== true;
}

function isWeakCompetingStandardAnchor(candidate) {
    return isStandardCandidateSource(candidate) &&
        candidate?.provenance?.localShift !== true &&
        candidate?.provenance?.sizeJitter !== true &&
        candidate?.provenance?.previewAnchor !== true &&
        !isBottomRight48Candidate(candidate);
}

function shouldPreserveDominantBottomRight48AgainstWeakStandard(bottomRightCandidate, competingCandidate) {
    if (!isBottomRight48Candidate(bottomRightCandidate)) return false;
    if (!isWeakCompetingStandardAnchor(competingCandidate)) return false;

    const bottomSpatial = Number(bottomRightCandidate.originalSpatialScore);
    const bottomGradient = Number(bottomRightCandidate.originalGradientScore);
    const largeSpatial = Number(competingCandidate.originalSpatialScore);
    const largeGradient = Number(competingCandidate.originalGradientScore);
    const bottomResidual = Number(bottomRightCandidate.residual?.score);
    const largeResidual = Number(competingCandidate.residual?.score);
    if (
        !Number.isFinite(bottomSpatial) ||
        !Number.isFinite(bottomGradient) ||
        !Number.isFinite(largeSpatial) ||
        !Number.isFinite(largeGradient) ||
        !Number.isFinite(bottomResidual) ||
        !Number.isFinite(largeResidual)
    ) {
        return false;
    }

    return bottomSpatial >= BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_MIN_SPATIAL &&
        bottomGradient >= BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_MIN_GRADIENT &&
        bottomSpatial >= largeSpatial + BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_SPATIAL_ADVANTAGE &&
        bottomGradient >= largeGradient + BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_GRADIENT_ADVANTAGE &&
        bottomResidual <= largeResidual + BOTTOM_RIGHT_48_EVIDENCE_DOMINANCE_MAX_RESIDUAL_DELTA;
}

function isPreviewAnchorCandidate(candidate) {
    return candidate?.provenance?.previewAnchor === true;
}

function shouldPreferCatalogOriginalSignal(candidate, currentBest) {
    if (!isCurrentLargeMarginCandidate(candidate)) return false;
    if (currentBest?.provenance?.localShift === true || currentBest?.provenance?.sizeJitter === true) {
        return false;
    }

    const candidateReliable = hasReliableCandidateOriginalSignal(candidate);
    const currentReliable = hasReliableCandidateOriginalSignal(currentBest);
    if (candidateReliable && !currentReliable) return true;

    return candidateReliable &&
        currentReliable &&
        hasMuchStrongerOriginalSignal(candidate, currentBest);
}

function shouldPreserveCatalogOriginalSignal(currentBest, candidate) {
    if (!isCurrentLargeMarginCandidate(currentBest)) return false;

    const currentReliable = hasReliableCandidateOriginalSignal(currentBest);
    const candidateReliable = hasReliableCandidateOriginalSignal(candidate);
    if (currentReliable && !candidateReliable) return true;

    return currentReliable &&
        candidateReliable &&
        hasMuchStrongerOriginalSignal(currentBest, candidate);
}

function isCanonicalDefault96Candidate(candidate) {
    return isStandardCandidateSource(candidate) &&
        candidate?.provenance?.catalogVariant !== true &&
        candidate?.provenance?.localShift !== true &&
        candidate?.provenance?.sizeJitter !== true &&
        candidate?.provenance?.previewAnchor !== true &&
        candidate?.config?.logoSize === 96 &&
        candidate.config.marginRight === 64 &&
        candidate.config.marginBottom === 64;
}

function isDefault96GeometryCandidate(candidate) {
    return isStandardCandidateSource(candidate) &&
        candidate?.provenance?.localShift !== true &&
        candidate?.provenance?.sizeJitter !== true &&
        candidate?.provenance?.previewAnchor !== true &&
        candidate?.config?.logoSize === 96 &&
        candidate.config.marginRight === 64 &&
        candidate.config.marginBottom === 64;
}

function isNewMargin96Candidate(candidate) {
    return isStandardCandidateSource(candidate) &&
        candidate?.provenance?.localShift !== true &&
        candidate?.provenance?.sizeJitter !== true &&
        candidate?.provenance?.previewAnchor !== true &&
        candidate?.config?.logoSize === 96 &&
        candidate.config.marginRight === 192 &&
        candidate.config.marginBottom === 192;
}

function shouldPreserveStrongCanonical96AgainstWeakCurrentLargeMargin(currentBest, candidate) {
    if (!isCanonicalDefault96Candidate(currentBest)) return false;
    if (!isCurrentLargeMarginCatalogCandidate(candidate)) return false;

    const currentSpatial = Number(currentBest.originalSpatialScore);
    const currentGradient = Number(currentBest.originalGradientScore);
    const currentProcessedSpatial = Number(currentBest.processedSpatialScore);
    const currentProcessedGradient = Number(currentBest.processedGradientScore);
    const candidateSpatial = Number(candidate.originalSpatialScore);
    const candidateGradient = Number(candidate.originalGradientScore);
    if (
        !Number.isFinite(currentSpatial) ||
        !Number.isFinite(currentGradient) ||
        !Number.isFinite(currentProcessedSpatial) ||
        !Number.isFinite(currentProcessedGradient) ||
        !Number.isFinite(candidateSpatial) ||
        !Number.isFinite(candidateGradient)
    ) {
        return false;
    }

    const currentAlreadyCleared = currentBest.residual?.cleared === true;
    const currentStrongLowResidual =
        currentSpatial >= 0.55 &&
        currentGradient >= 0.5 &&
        Math.abs(currentProcessedSpatial) <= 0.08 &&
        currentProcessedGradient <= 0.24;
    const candidateHasWeakOriginalSignal =
        candidateGradient < STANDARD_VALIDATION_MIN_ORIGINAL_GRADIENT_SCORE ||
        (
            candidateSpatial <= currentSpatial - 0.2 &&
            candidateGradient <= currentGradient - 0.3
        );

    return currentSpatial >= 0.4 &&
        currentGradient >= 0.2 &&
        (currentAlreadyCleared || currentStrongLowResidual) &&
        candidateHasWeakOriginalSignal;
}

function shouldPreserveStrongCanonical96AgainstWeakNewMargin(currentBest, candidate) {
    if (!isCanonicalDefault96Candidate(currentBest)) return false;
    if (!isNewMargin96Candidate(candidate)) return false;

    const currentSpatial = Number(currentBest.originalSpatialScore);
    const currentGradient = Number(currentBest.originalGradientScore);
    const candidateSpatial = Number(candidate.originalSpatialScore);
    const candidateGradient = Number(candidate.originalGradientScore);
    if (
        !Number.isFinite(currentSpatial) ||
        !Number.isFinite(currentGradient) ||
        !Number.isFinite(candidateSpatial) ||
        !Number.isFinite(candidateGradient)
    ) {
        return false;
    }

    const currentHasStrongCanonicalSignal =
        currentSpatial >= 0.55 &&
        currentGradient >= 0.2;
    const candidateHasStrongNewMarginSignal =
        candidateSpatial >= 0.55 &&
        candidateGradient >= 0.3;
    const candidateHasWeakOrMuchWeakerSignal =
        candidateSpatial < STANDARD_VALIDATION_MIN_ORIGINAL_SPATIAL_SCORE ||
        candidateGradient < STANDARD_VALIDATION_MIN_ORIGINAL_GRADIENT_SCORE ||
        (
            candidateSpatial <= currentSpatial - STRONG_ORIGINAL_SIGNAL_SPATIAL_ADVANTAGE &&
            candidateGradient <= currentGradient - STRONG_ORIGINAL_SIGNAL_GRADIENT_ADVANTAGE
        );

    return currentHasStrongCanonicalSignal &&
        !candidateHasStrongNewMarginSignal &&
        candidateHasWeakOrMuchWeakerSignal;
}

function isBalancedCanonical96AlphaGain(candidate) {
    const alphaGain = Number(candidate?.alphaGain);
    return Number.isFinite(alphaGain) && alphaGain >= 1 && alphaGain <= 1.1;
}

function shouldPreserveStandardAlphaCanonical96AgainstDarkGain(currentBest, candidate) {
    if (!sameCandidateAnchor(currentBest, candidate)) return false;
    if (!isCanonicalDefault96Candidate(currentBest)) return false;

    const currentAlphaGain = Number(currentBest?.alphaGain);
    const candidateAlphaGain = Number(candidate?.alphaGain);
    if (
        !Number.isFinite(currentAlphaGain) ||
        !Number.isFinite(candidateAlphaGain) ||
        currentAlphaGain !== 1 ||
        candidateAlphaGain <= 1 ||
        candidate?.tooDark !== true
    ) {
        return false;
    }

    const originalSpatial = Number(currentBest.originalSpatialScore);
    const originalGradient = Number(currentBest.originalGradientScore);
    const currentSpatial = Number(currentBest.processedSpatialScore);
    const currentGradient = Number(currentBest.processedGradientScore);
    if (
        !Number.isFinite(originalSpatial) ||
        !Number.isFinite(originalGradient) ||
        !Number.isFinite(currentSpatial) ||
        !Number.isFinite(currentGradient)
    ) {
        return false;
    }

    return originalSpatial >= 0.55 &&
        originalGradient >= 0.2 &&
        currentSpatial >= 0 &&
        currentSpatial <= 0.35 &&
        Math.max(0, currentGradient) <= 0.08;
}

function shouldPreserveBalancedAlphaCanonical96(currentBest, candidate) {
    if (!sameCandidateAnchor(currentBest, candidate)) return false;
    if (!isCanonicalDefault96Candidate(currentBest)) return false;
    if (!isBalancedCanonical96AlphaGain(currentBest)) return false;

    const candidateAlphaGain = Number(candidate?.alphaGain);
    if (!Number.isFinite(candidateAlphaGain) || candidateAlphaGain <= 1.1) return false;

    const originalSpatial = Number(currentBest.originalSpatialScore);
    const originalGradient = Number(currentBest.originalGradientScore);
    const currentSpatial = Number(currentBest.processedSpatialScore);
    const currentGradient = Number(currentBest.processedGradientScore);
    if (
        !Number.isFinite(originalSpatial) ||
        !Number.isFinite(originalGradient) ||
        !Number.isFinite(currentSpatial) ||
        !Number.isFinite(currentGradient)
    ) {
        return false;
    }

    return originalSpatial >= 0.55 &&
        originalGradient >= 0.2 &&
        currentSpatial >= 0 &&
        currentSpatial <= 0.22 &&
        Math.max(0, currentGradient) <= 0.1;
}

function hasWeakDriftEvidence(candidate) {
    const candidateSpatial = Number(candidate?.originalSpatialScore);
    const candidateGradient = Number(candidate?.originalGradientScore);
    if (!Number.isFinite(candidateSpatial) || !Number.isFinite(candidateGradient)) {
        return false;
    }
    return candidateGradient < STANDARD_LOCAL_SHIFT_WEAK_CANDIDATE_GRADIENT_SCORE ||
        candidateSpatial < STANDARD_LOCAL_SHIFT_WEAK_CANDIDATE_SPATIAL_SCORE;
}

function leavesWorseResidualGradientThanCanonical(canonicalCandidate, driftCandidate) {
    const canonicalProcessedGradientRaw = Number(canonicalCandidate?.processedGradientScore);
    const driftProcessedGradientRaw = Number(driftCandidate?.processedGradientScore);
    if (
        !Number.isFinite(canonicalProcessedGradientRaw) ||
        !Number.isFinite(driftProcessedGradientRaw)
    ) {
        return false;
    }

    return Math.max(0, canonicalProcessedGradientRaw) <= STANDARD_LOCAL_SHIFT_PRESERVE_CLEAN_BASE_GRADIENT_THRESHOLD &&
        Math.max(0, driftProcessedGradientRaw) >= STANDARD_LOCAL_SHIFT_MAX_CANDIDATE_GRADIENT_FOR_CLEAN_BASE;
}

function leavesMuchWorseResidualGradientThanCanonical(canonicalCandidate, driftCandidate) {
    const canonicalProcessedSpatial = Number(canonicalCandidate?.processedSpatialScore);
    const canonicalProcessedGradient = Number(canonicalCandidate?.processedGradientScore);
    const canonicalImprovement = Number(canonicalCandidate?.improvement);
    const driftProcessedGradient = Number(driftCandidate?.processedGradientScore);
    if (
        !Number.isFinite(canonicalProcessedSpatial) ||
        !Number.isFinite(canonicalProcessedGradient) ||
        !Number.isFinite(canonicalImprovement) ||
        !Number.isFinite(driftProcessedGradient)
    ) {
        return false;
    }

    return Math.abs(canonicalProcessedSpatial) <= STANDARD_PRESERVE_MAX_RESIDUAL &&
        canonicalImprovement >= STANDARD_PRESERVE_MIN_IMPROVEMENT &&
        driftProcessedGradient >= canonicalProcessedGradient + STANDARD_PRESERVE_GRADIENT_DELTA;
}

function shouldPreserveCanonicalAnchor(canonicalCandidate, driftCandidate) {
    if (!isCanonicalStandardCandidate(canonicalCandidate)) return false;
    if (!isDriftedStandardCandidate(driftCandidate)) return false;

    const validationAdvantage = Number(canonicalCandidate.validationCost) - Number(driftCandidate.validationCost);
    if (
        !Number.isFinite(validationAdvantage)
    ) {
        return false;
    }

    return (
        hasStrongCanonicalAnchorSignal(canonicalCandidate) &&
        hasWeakDriftEvidence(driftCandidate) &&
        validationAdvantage < STANDARD_LOCAL_SHIFT_MIN_VALIDATION_ADVANTAGE
    ) ||
        leavesWorseResidualGradientThanCanonical(canonicalCandidate, driftCandidate) ||
        leavesMuchWorseResidualGradientThanCanonical(canonicalCandidate, driftCandidate);
}

function shouldPreserveStrongStandardAnchor(currentBest, candidate) {
    if (currentBest?.provenance?.localShift === true) return false;
    if (!isStandardCandidateSource(candidate)) return false;
    return shouldPreserveCanonicalAnchor(currentBest, candidate);
}

function shouldRevertLocalShiftToStandardTrial(selectedCandidate, standardTrial) {
    if (selectedCandidate?.provenance?.localShift !== true) return false;
    if (!isStandardCandidateSource(selectedCandidate) || !isStandardCandidateSource(standardTrial)) return false;
    if (!standardTrial?.accepted) return false;
    return shouldPreserveCanonicalAnchor(standardTrial, selectedCandidate);
}

function shouldSkipStandardLocalSearch(seedCandidate) {
    if (!seedCandidate) return false;

    return Math.max(0, Number(seedCandidate.processedGradientScore)) <=
        STANDARD_LOCAL_SHIFT_SKIP_PROCESSED_GRADIENT_THRESHOLD;
}

function isPreviewAnchorSearchEligible(originalImageData, config) {
    if (!config || config.logoSize !== 48) return false;

    const width = Number(originalImageData?.width);
    const height = Number(originalImageData?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    if (width < 384 || width > 1536) return false;
    if (height < 384 || height > 1536) return false;
    if (Math.max(width, height) < 512) return false;

    return matchOfficialGeminiImageSize(width, height) === null;
}

function shouldPreferPreviewAnchorCandidate(currentBest, candidate) {
    if (candidate?.provenance?.previewAnchor !== true) return false;
    if (!currentBest || currentBest?.provenance?.previewAnchor === true) return false;

    const currentSpatial = Number(currentBest.originalSpatialScore);
    const currentGradient = Number(currentBest.originalGradientScore);
    const candidateSpatial = Number(candidate.originalSpatialScore);
    const candidateGradient = Number(candidate.originalGradientScore);

    if (
        !Number.isFinite(currentSpatial) ||
        !Number.isFinite(currentGradient) ||
        !Number.isFinite(candidateSpatial) ||
        !Number.isFinite(candidateGradient)
    ) {
        return false;
    }

    const currentReliable = hasReliableStandardWatermarkSignal({
        spatialScore: currentSpatial,
        gradientScore: currentGradient
    });
    const candidateReliable = hasReliableStandardWatermarkSignal({
        spatialScore: candidateSpatial,
        gradientScore: candidateGradient
    });

    if (candidateReliable && !currentReliable) {
        return true;
    }

    return candidateGradient >= currentGradient + 0.2 &&
        candidateSpatial >= currentSpatial + 0.05;
}

function findBestTemplateWarp({
    originalImageData,
    alphaMap,
    position,
    baselineSpatialScore,
    baselineGradientScore,
    shiftCandidates = TEMPLATE_ALIGN_SHIFTS,
    scaleCandidates = TEMPLATE_ALIGN_SCALES
}) {
    const size = position.width;
    if (!size || size <= 8) return null;

    let best = {
        spatialScore: baselineSpatialScore,
        gradientScore: baselineGradientScore,
        shift: { dx: 0, dy: 0, scale: 1 },
        alphaMap
    };

    for (const scale of scaleCandidates) {
        for (const dy of shiftCandidates) {
            for (const dx of shiftCandidates) {
                if (dx === 0 && dy === 0 && scale === 1) continue;
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                const spatialScore = computeRegionSpatialCorrelation({
                    imageData: originalImageData,
                    alphaMap: warped,
                    region: { x: position.x, y: position.y, size }
                });
                const gradientScore = computeRegionGradientCorrelation({
                    imageData: originalImageData,
                    alphaMap: warped,
                    region: { x: position.x, y: position.y, size }
                });

                const confidence =
                    Math.max(0, spatialScore) * 0.7 +
                    Math.max(0, gradientScore) * 0.3;
                const bestConfidence =
                    Math.max(0, best.spatialScore) * 0.7 +
                    Math.max(0, best.gradientScore) * 0.3;

                if (confidence > bestConfidence + 0.01) {
                    best = {
                        spatialScore,
                        gradientScore,
                        shift: { dx, dy, scale },
                        alphaMap: warped
                    };
                }
            }
        }
    }

    const improvedSpatial = best.spatialScore >= baselineSpatialScore + 0.01;
    const improvedGradient = best.gradientScore >= baselineGradientScore + 0.01;
    return improvedSpatial || improvedGradient ? best : null;
}

function searchNearbyStandardCandidate({
    originalImageData,
    candidateSeeds,
    adaptiveConfidence = null
}) {
    if (!Array.isArray(candidateSeeds) || candidateSeeds.length === 0) return null;

    let bestCandidate = null;
    for (const seed of candidateSeeds) {
        if (shouldSkipStandardLocalSearch(seed)) continue;
        for (const dy of STANDARD_NEARBY_SHIFTS) {
            for (const dx of STANDARD_NEARBY_SHIFTS) {
                if (dx === 0 && dy === 0) continue;

                const candidatePosition = {
                    x: seed.position.x + dx,
                    y: seed.position.y + dy,
                    width: seed.position.width,
                    height: seed.position.height
                };
                if (candidatePosition.x < 0 || candidatePosition.y < 0) continue;
                if (candidatePosition.x + candidatePosition.width > originalImageData.width) continue;
                if (candidatePosition.y + candidatePosition.height > originalImageData.height) continue;

                const candidate = evaluateRestorationCandidate({
                    originalImageData,
                    alphaMap: seed.alphaMap,
                    position: candidatePosition,
                    source: `${seed.source}+local`,
                    config: seed.config,
                    baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, candidatePosition),
                    adaptiveConfidence,
                    provenance: mergeCandidateProvenance(seed.provenance, { localShift: true }),
                    includeImageData: false
                });

                if (!candidate?.accepted) continue;
                bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
            }
        }
    }

    return bestCandidate;
}

function searchStandardSizeJitterCandidate({
    originalImageData,
    candidateSeeds,
    alpha48,
    alpha96,
    getAlphaMap,
    resolveAlphaMap = null,
    adaptiveConfidence = null
}) {
    if (!Array.isArray(candidateSeeds) || candidateSeeds.length === 0) return null;

    let bestCandidate = null;
    for (const seed of candidateSeeds) {
        for (const delta of STANDARD_SIZE_JITTERS) {
            const size = seed.position.width + delta;
            if (size <= 24) continue;
            if (size === seed.position.width) continue;

            const candidatePosition = {
                x: originalImageData.width - seed.config.marginRight - size,
                y: originalImageData.height - seed.config.marginBottom - size,
                width: size,
                height: size
            };
            if (candidatePosition.x < 0 || candidatePosition.y < 0) continue;
            if (candidatePosition.x + candidatePosition.width > originalImageData.width) continue;
            if (candidatePosition.y + candidatePosition.height > originalImageData.height) continue;

            const candidateAlphaMap = resolveSizeJitterAlphaMap(seed, size, {
                alpha48,
                alpha96,
                getAlphaMap,
                resolveAlphaMap
            });
            if (!candidateAlphaMap) continue;

            const candidate = evaluateRestorationCandidate({
                originalImageData,
                alphaMap: candidateAlphaMap,
                position: candidatePosition,
                source: `${seed.source}+size`,
                config: {
                    ...seed.config,
                    logoSize: size
                },
                baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, candidatePosition),
                adaptiveConfidence,
                provenance: mergeCandidateProvenance(seed.provenance, { sizeJitter: true }),
                includeImageData: false
            });

            if (!candidate?.accepted) continue;
            bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
        }
    }

    return bestCandidate;
}

function searchFineStandardLocalCandidate({
    originalImageData,
    seedCandidate,
    adaptiveConfidence = null,
    shiftCandidates = STANDARD_FINE_LOCAL_SHIFTS
}) {
    if (!seedCandidate?.alphaMap || !seedCandidate?.position) return null;
    if (shouldSkipStandardLocalSearch(seedCandidate)) return null;

    let bestCandidate = null;
    for (const dy of shiftCandidates) {
        for (const dx of shiftCandidates) {
            if (dx === 0 && dy === 0) continue;

            const candidatePosition = {
                x: seedCandidate.position.x + dx,
                y: seedCandidate.position.y + dy,
                width: seedCandidate.position.width,
                height: seedCandidate.position.height
            };
            if (candidatePosition.x < 0 || candidatePosition.y < 0) continue;
            if (candidatePosition.x + candidatePosition.width > originalImageData.width) continue;
            if (candidatePosition.y + candidatePosition.height > originalImageData.height) continue;

            const candidate = evaluateRestorationCandidate({
                originalImageData,
                alphaMap: seedCandidate.alphaMap,
                position: candidatePosition,
                source: `${seedCandidate.source}+local`,
                config: seedCandidate.config,
                baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, candidatePosition),
                adaptiveConfidence,
                provenance: mergeCandidateProvenance(seedCandidate.provenance, { localShift: true }),
                includeImageData: false
            });

            if (!candidate?.accepted) continue;
            bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
        }
    }

    return bestCandidate;
}

function searchCandidateAlphaGain({
    originalImageData,
    seedCandidate,
    adaptiveConfidence = null,
    alphaGainCandidates = []
}) {
    if (!seedCandidate?.alphaMap || !seedCandidate?.position) return null;

    let bestCandidate = null;
    for (const candidateGain of alphaGainCandidates) {
        if (!Number.isFinite(candidateGain) || candidateGain <= 0 || candidateGain === 1) continue;

        const candidate = evaluateRestorationCandidate({
            originalImageData,
            alphaMap: seedCandidate.alphaMap,
            position: seedCandidate.position,
            source: `${seedCandidate.source}+gain`,
            config: seedCandidate.config,
            baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, seedCandidate.position),
            adaptiveConfidence,
            alphaGain: candidateGain,
            provenance: seedCandidate.provenance,
            includeImageData: false
        });

        if (!candidate?.accepted) continue;
        if (
            candidateGain < 1 &&
            (
                candidate.improvement < STANDARD_PRESERVE_MIN_IMPROVEMENT ||
                Math.abs(candidate.processedSpatialScore) > VALIDATION_TARGET_RESIDUAL
            )
        ) {
            continue;
        }
        bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
    }

    return bestCandidate;
}

function searchBestEffortCurrentLargeMarginWeakAlpha({
    originalImageData,
    standardTrials,
    alphaGainCandidates
}) {
    let bestCandidate = null;

    for (const seedCandidate of standardTrials) {
        if (!isCurrentLargeMarginCatalogCandidate(seedCandidate)) continue;
        if (!hasReliableCandidateOriginalSignal(seedCandidate)) continue;

        for (const candidateGain of alphaGainCandidates) {
            if (!Number.isFinite(candidateGain) || candidateGain <= 0 || candidateGain >= 1) continue;

            const candidate = evaluateRestorationCandidate({
                originalImageData,
                alphaMap: seedCandidate.alphaMap,
                position: seedCandidate.position,
                source: `${seedCandidate.source}+validated+gain`,
                config: seedCandidate.config,
                baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, seedCandidate.position),
                alphaGain: candidateGain,
                provenance: seedCandidate.provenance,
                includeImageData: false
            });

            if (!candidate?.accepted) continue;
            bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
        }
    }

    return bestCandidate;
}

function hasFixedCoreLocalOriginalEvidence({
    seed,
    sizeDelta,
    marginRightDelta,
    marginBottomDelta,
    originalScores
}) {
    if (
        originalScores.spatialScore >= FIXED_CORE_LOCAL_MIN_ORIGINAL_SPATIAL_SCORE &&
        originalScores.gradientScore >= FIXED_CORE_LOCAL_MIN_ORIGINAL_GRADIENT_SCORE
    ) {
        return true;
    }

    return seed?.provenance?.sampleDerivedRescueSeed === true &&
        sizeDelta === 0 &&
        marginRightDelta === 0 &&
        marginBottomDelta === 0 &&
        originalScores.spatialScore >= FIXED_CORE_LOCAL_VISIBLE_CATALOG_MIN_ORIGINAL_SPATIAL_SCORE &&
        originalScores.gradientScore >= FIXED_CORE_LOCAL_VISIBLE_CATALOG_MIN_ORIGINAL_GRADIENT_SCORE;
}

function searchFixedCoreLocalGeometryCandidate({
    originalImageData,
    candidateSeeds,
    resolveAlphaMap,
    alphaGainCandidates
}) {
    let bestCandidate = null;
    const localSeeds = [...(Array.isArray(candidateSeeds) ? candidateSeeds : [])];
    if (!localSeeds.some((seed) => seed?.provenance?.sampleDerivedRescueSeed === true)) {
        const position = {
            x: originalImageData.width - 96 - 48,
            y: originalImageData.height - 96 - 48,
            width: 48,
            height: 48
        };
        if (
            position.x >= 0 &&
            position.y >= 0 &&
            position.x + position.width <= originalImageData.width &&
            position.y + position.height <= originalImageData.height
        ) {
            localSeeds.push({
                config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
                position,
                alphaMap: resolveAlphaMap(48),
                source: 'standard+catalog',
                provenance: { catalogVariant: true, sampleDerivedRescueSeed: true }
            });
        }
    }

    for (const seed of localSeeds) {
        if (seed?.config?.logoSize !== 48) continue;
        const restrictToExactCatalogAnchor =
            seed?.provenance?.sampleDerivedRescueSeed !== true &&
            isCurrentLargeMarginCatalogCandidate(seed);

        for (const sizeDelta of FIXED_CORE_LOCAL_SIZE_DELTAS) {
            if (restrictToExactCatalogAnchor && sizeDelta !== 0) continue;
            const size = seed.config.logoSize + sizeDelta;
            if (size < 40 || size > 56) continue;

            const alphaMap = resolveAlphaMap(size);
            if (!alphaMap) continue;

            for (const marginRightDelta of FIXED_CORE_LOCAL_MARGIN_DELTAS) {
                if (restrictToExactCatalogAnchor && marginRightDelta !== 0) continue;
                const marginRight = seed.config.marginRight + marginRightDelta;
                if (marginRight < 0) continue;

                for (const marginBottomDelta of FIXED_CORE_LOCAL_MARGIN_DELTAS) {
                    if (restrictToExactCatalogAnchor && marginBottomDelta !== 0) continue;
                    const marginBottom = seed.config.marginBottom + marginBottomDelta;
                    if (marginBottom < 0) continue;

                    const position = {
                        x: originalImageData.width - marginRight - size,
                        y: originalImageData.height - marginBottom - size,
                        width: size,
                        height: size
                    };
                    if (position.x < 0 || position.y < 0) continue;
                    if (position.x + position.width > originalImageData.width) continue;
                    if (position.y + position.height > originalImageData.height) continue;

                    const originalScores = scoreRegion(originalImageData, alphaMap, position);
                    if (!hasFixedCoreLocalOriginalEvidence({
                        seed,
                        sizeDelta,
                        marginRightDelta,
                        marginBottomDelta,
                        originalScores
                    })) {
                        continue;
                    }

                    for (const alphaGain of alphaGainCandidates) {
                        if (!Number.isFinite(alphaGain) || alphaGain <= 0) continue;

                        const candidate = evaluateRestorationCandidate({
                            originalImageData,
                            alphaMap,
                            position,
                            source: alphaGain === 1
                                ? `${seed.source}+fixed-local`
                                : `${seed.source}+fixed-local+gain`,
                            config: {
                                logoSize: size,
                                marginRight,
                                marginBottom
                            },
                            baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, position),
                            alphaGain,
                            provenance: mergeCandidateProvenance(seed.provenance, {
                                fixedCoreLocalGeometry: true,
                                localShift: marginRightDelta !== 0 || marginBottomDelta !== 0,
                                sizeJitter: sizeDelta !== 0
                            }),
                            includeImageData: false
                        });
                        if (!candidate?.accepted) continue;
                        if (!isStrictFixedCoreCandidate(candidate)) continue;

                        bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
                    }
                }
            }
        }
    }

    return bestCandidate;
}

function searchStrongStandardTrialAlphaGain({
    originalImageData,
    standardTrials,
    standardTrial,
    baseCandidate,
    baseDecisionTier,
    alphaGainCandidates
}) {
    let nextBaseCandidate = baseCandidate;
    let nextBaseDecisionTier = baseDecisionTier;

    for (const candidate of standardTrials) {
        if (!candidate || candidate.accepted) continue;
        if (candidate === standardTrial && nextBaseCandidate) continue;

        const reliableMatch = hasReliableStandardWatermarkSignal({
            spatialScore: candidate.originalSpatialScore,
            gradientScore: candidate.originalGradientScore
        });
        if (!reliableMatch) continue;

        const gainedCandidate = searchCandidateAlphaGain({
            originalImageData,
            seedCandidate: {
                ...candidate,
                source: `${candidate.source}+validated`
            },
            adaptiveConfidence: null,
            alphaGainCandidates
        });
        if (!gainedCandidate) continue;

        ({
            baseCandidate: nextBaseCandidate,
            baseDecisionTier: nextBaseDecisionTier
        } = promoteBaseCandidate(nextBaseCandidate, nextBaseDecisionTier, gainedCandidate, {
            reliableMatch,
            minCostDelta: 0.002
        }));
    }

    return {
        baseCandidate: nextBaseCandidate,
        baseDecisionTier: nextBaseDecisionTier
    };
}

function searchFixedCoreStrongStandardAlphaGain({
    originalImageData,
    baseCandidate,
    alphaGainCandidates
}) {
    if (!isCanonicalDefault96Candidate(baseCandidate)) return null;
    if (!hasReliableCandidateOriginalSignal(baseCandidate)) return null;

    let bestCandidate = null;
    const baselineNearBlackRatio = calculateNearBlackRatio(originalImageData, baseCandidate.position);
    for (const candidateGain of alphaGainCandidates) {
        if (!Number.isFinite(candidateGain) || candidateGain <= 0 || candidateGain === 1) continue;
        const candidate = evaluateRestorationCandidate({
            originalImageData,
            alphaMap: baseCandidate.alphaMap,
            position: baseCandidate.position,
            source: `${baseCandidate.source}+gain`,
            config: baseCandidate.config,
            baselineNearBlackRatio,
            alphaGain: candidateGain,
            provenance: baseCandidate.provenance,
            includeImageData: false
        });
        if (!candidate?.accepted || !isStrictFixedCoreCandidate(candidate)) continue;
        bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
    }

    return bestCandidate;
}

function createDefaultAlphaRescueProvenance(provenance) {
    const {
        alphaVariant,
        ...baseProvenance
    } = provenance ?? {};
    return mergeCandidateProvenance(baseProvenance, {
        defaultAlphaVariantRescue: true
    });
}

function searchDefaultAlphaNewMarginRescue({
    originalImageData,
    standardTrials,
    alpha96,
    alphaGainCandidates
}) {
    if (!alpha96) return null;

    let bestCandidate = null;
    const rescueGains = normalizeAlphaPriorityGains([
        ...alphaGainCandidates,
        ...STANDARD_ANCHOR_WEAK_ALPHA_RESCUE_GAINS
    ]);

    for (const seedCandidate of standardTrials) {
        if (!isNewMarginAlphaVariantTrial(seedCandidate)) continue;
        if (seedCandidate.provenance?.darkPolarity === true) continue;

        const config = {
            logoSize: 96,
            marginRight: 192,
            marginBottom: 192
        };
        const provenance = createDefaultAlphaRescueProvenance(seedCandidate.provenance);
        const baselineNearBlackRatio = calculateNearBlackRatio(originalImageData, seedCandidate.position);

        for (const alphaGain of rescueGains) {
            if (!Number.isFinite(alphaGain) || alphaGain <= 0) continue;

            const candidate = evaluateRestorationCandidate({
                originalImageData,
                alphaMap: alpha96,
                position: seedCandidate.position,
                source: alphaGain === 1
                    ? `${seedCandidate.source}+default-alpha`
                    : `${seedCandidate.source}+default-alpha+gain`,
                config,
                baselineNearBlackRatio,
                alphaGain,
                provenance,
                includeImageData: false
            });
            if (!candidate?.accepted) continue;
            if (!hasSafeDefaultAlphaNewMarginResidual(candidate)) continue;

            bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
        }
    }

    return bestCandidate;
}

function insertTopPreviewCandidate(topCandidates, candidate) {
    topCandidates.push(candidate);
    topCandidates.sort((a, b) => b.coarseScore - a.coarseScore);
    if (topCandidates.length > PREVIEW_ANCHOR_TOP_K) {
        topCandidates.length = PREVIEW_ANCHOR_TOP_K;
    }
}

function searchBottomRightPreviewCandidate({
    originalImageData,
    config,
    alpha48,
    alpha96,
    getAlphaMap,
    resolveAlphaMap = null,
    adaptiveConfidence = null
}) {
    if (!isPreviewAnchorSearchEligible(originalImageData, config)) return null;

    const minSize = Math.max(
        PREVIEW_ANCHOR_MIN_SIZE,
        Math.round(config.logoSize * PREVIEW_ANCHOR_MIN_SIZE_RATIO)
    );
    const maxSize = Math.max(
        minSize,
        Math.round(config.logoSize * PREVIEW_ANCHOR_MAX_SIZE_RATIO)
    );
    const minMarginRight = Math.max(8, config.marginRight - PREVIEW_ANCHOR_MARGIN_WINDOW);
    const maxMarginRight = config.marginRight + PREVIEW_ANCHOR_MARGIN_EXTENSION;
    const minMarginBottom = Math.max(8, config.marginBottom - PREVIEW_ANCHOR_MARGIN_WINDOW);
    const maxMarginBottom = config.marginBottom + PREVIEW_ANCHOR_MARGIN_EXTENSION;
    const topCandidates = [];

    for (let size = minSize; size <= maxSize; size += PREVIEW_ANCHOR_SIZE_STEP) {
        const alphaMap = typeof resolveAlphaMap === 'function'
            ? resolveAlphaMap(size)
            : resolveAlphaMapForSize(size, {
                alpha48,
                alpha96,
                getAlphaMap
            });
        if (!alphaMap) continue;

        for (let marginRight = minMarginRight; marginRight <= maxMarginRight; marginRight += PREVIEW_ANCHOR_MARGIN_STEP) {
            const x = originalImageData.width - marginRight - size;
            if (x < 0 || x + size > originalImageData.width) continue;

            for (let marginBottom = minMarginBottom; marginBottom <= maxMarginBottom; marginBottom += PREVIEW_ANCHOR_MARGIN_STEP) {
                const y = originalImageData.height - marginBottom - size;
                if (y < 0 || y + size > originalImageData.height) continue;

                const coarseSpatialScore = computeRegionSpatialCorrelation({
                    imageData: originalImageData,
                    alphaMap,
                    region: { x, y, size }
                });
                const coarseGradientScore = computeRegionGradientCorrelation({
                    imageData: originalImageData,
                    alphaMap,
                    region: { x, y, size }
                });
                const coarseScore =
                    Math.max(0, coarseGradientScore) * 0.6 +
                    Math.max(0, coarseSpatialScore) * 0.4;

                if (coarseScore < PREVIEW_ANCHOR_MIN_SCORE) continue;

                insertTopPreviewCandidate(topCandidates, {
                    coarseScore,
                    alphaMap,
                    position: { x, y, width: size, height: size },
                    config: {
                        logoSize: size,
                        marginRight,
                        marginBottom
                    }
                });
            }
        }
    }

    let bestCandidate = null;
    for (const coarseCandidate of topCandidates) {
        for (const sizeDelta of PREVIEW_ANCHOR_LOCAL_DELTAS) {
            const size = coarseCandidate.position.width + sizeDelta;
            if (size < PREVIEW_ANCHOR_MIN_SIZE) continue;

            const alphaMap = typeof resolveAlphaMap === 'function'
                ? resolveAlphaMap(size)
                : resolveAlphaMapForSize(size, {
                    alpha48,
                    alpha96,
                    getAlphaMap
                });
            if (!alphaMap) continue;

            for (const dx of PREVIEW_ANCHOR_LOCAL_DELTAS) {
                for (const dy of PREVIEW_ANCHOR_LOCAL_DELTAS) {
                    const position = {
                        x: coarseCandidate.position.x + dx,
                        y: coarseCandidate.position.y + dy,
                        width: size,
                        height: size
                    };
                    if (position.x < 0 || position.y < 0) continue;
                    if (position.x + position.width > originalImageData.width) continue;
                    if (position.y + position.height > originalImageData.height) continue;

                    const config = {
                        logoSize: size,
                        marginRight: originalImageData.width - position.x - size,
                        marginBottom: originalImageData.height - position.y - size
                    };
                    const candidate = evaluateRestorationCandidate({
                        originalImageData,
                        alphaMap,
                        position,
                        source: 'standard+preview-anchor',
                        config,
                        baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, position),
                        adaptiveConfidence,
                        provenance: {
                            previewAnchor: true,
                            previewAnchorLocalRefine: sizeDelta !== 0 || dx !== 0 || dy !== 0
                        },
                        includeImageData: false
                    });

                    if (!candidate?.accepted) continue;
                    bestCandidate = pickBetterCandidate(bestCandidate, candidate, 0.002);
                }
            }
        }
    }

    return bestCandidate;
}

function evaluateStandardTrialsForSeeds({
    originalImageData,
    candidateSeeds,
    alphaPriorityGains = [1]
}) {
    const standardTrials = candidateSeeds
        .map((seed) => evaluateStandardTrialForSeed({
            originalImageData,
            seed,
            alphaPriorityGains
        }))
        .filter(Boolean);
    const standardTrial = standardTrials.find((candidate) => candidate.source === 'standard') ?? standardTrials[0] ?? null;
    const standardSpatialScore = standardTrial?.originalSpatialScore ?? null;
    const standardGradientScore = standardTrial?.originalGradientScore ?? null;
    const hasReliableStandardMatch = hasReliableStandardWatermarkSignal({
        spatialScore: standardSpatialScore,
        gradientScore: standardGradientScore
    });

    return {
        standardTrials,
        standardTrial,
        standardSpatialScore,
        standardGradientScore,
        hasReliableStandardMatch
    };
}

function resolveStandardAnchorSelection({
    originalImageData,
    config,
    catalogPriorConfig,
    position,
    alpha48,
    alpha96,
    alpha96Variants,
    getAlphaMap,
    resolveAlphaMap,
    alphaPriorityGains,
    forceCatalogVariants = false
}) {
    let standardCandidateSeeds = buildStandardCandidateSeeds({
        originalImageData,
        config,
        catalogPriorConfig,
        position,
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap,
        resolveAlphaMap,
        includeCatalogVariants: false
    });
    let standardSelection = evaluateStandardTrialsForSeeds({
        originalImageData,
        candidateSeeds: standardCandidateSeeds,
        alphaPriorityGains
    });

    const shouldSearchCatalogRescue =
        standardSelection.standardTrial &&
        !standardSelection.standardTrial.accepted &&
        shouldEscalateSearch(standardSelection.standardTrial);
    const shouldExpandStandardCatalog =
        forceCatalogVariants ||
        shouldSearchCatalogRescue ||
        !standardSelection.hasReliableStandardMatch &&
        (
            !standardSelection.standardTrial ||
            shouldEscalateSearch(standardSelection.standardTrial) ||
            (
                matchOfficialGeminiImageSize(originalImageData.width, originalImageData.height) === null &&
                shouldExpandCatalogForWeakOriginalStandardEvidence(standardSelection.standardTrial)
            )
        );

    if (shouldExpandStandardCatalog) {
        standardCandidateSeeds = buildStandardCandidateSeeds({
            originalImageData,
            config,
            catalogPriorConfig,
            position,
            alpha48,
            alpha96,
            alpha96Variants,
            getAlphaMap,
            resolveAlphaMap,
            includeCatalogVariants: true
        });
        standardSelection = evaluateStandardTrialsForSeeds({
            originalImageData,
            candidateSeeds: standardCandidateSeeds,
            alphaPriorityGains
        });
    }

    return {
        standardCandidateSeeds,
        ...standardSelection
    };
}

function resolveCandidatePromotion(candidate, {
    reliableMatch = false
} = {}) {
    if (!candidate?.accepted) {
        return null;
    }

    if (reliableMatch) {
        return {
            candidate,
            decisionTier: 'direct-match'
        };
    }

    return {
        candidate: {
            ...candidate,
            source: `${candidate.source}+validated`
        },
        decisionTier: 'validated-match'
    };
}

function promoteBaseCandidate(baseCandidate, baseDecisionTier, candidate, {
    reliableMatch = false,
    minCostDelta = 0.002
} = {}) {
    const promotion = resolveCandidatePromotion(candidate, {
        reliableMatch
    });
    if (!promotion) {
        return {
            baseCandidate,
            baseDecisionTier
        };
    }

    if (
        shouldPreserveCanonicalAnchor(baseCandidate, promotion.candidate)
    ) {
        return {
            baseCandidate,
            baseDecisionTier
        };
    }

    if (
        reliableMatch &&
        shouldPreferCatalogOriginalSignal(promotion.candidate, baseCandidate)
    ) {
        return {
            baseCandidate: promotion.candidate,
            baseDecisionTier: promotion.decisionTier
        };
    }

    const previousCandidate = baseCandidate;
    const nextCandidate = pickBetterCandidate(baseCandidate, promotion.candidate, minCostDelta);
    return {
        baseCandidate: nextCandidate,
        baseDecisionTier: nextCandidate !== previousCandidate
            ? promotion.decisionTier
            : baseDecisionTier
    };
}

function shouldPreferOutlineDarkCandidate(currentCandidate, outlineDarkCandidate) {
    if (
        outlineDarkCandidate?.accepted !== true ||
        outlineDarkCandidate?.provenance?.outlineDark !== true ||
        outlineDarkCandidate?.evaluation?.gates?.outlineDarkEvidenceAllowed !== true
    ) {
        return false;
    }
    if (!currentCandidate) return true;
    if (currentCandidate?.provenance?.outlineDark === true) return false;
    if (!sameCandidateAnchor(currentCandidate, outlineDarkCandidate)) return false;

    return currentCandidate?.damage?.safe !== true ||
        Math.abs(Number(currentCandidate.processedSpatialScore)) > OUTLINE_DARK_MAX_PROCESSED_SPATIAL ||
        Math.max(0, Number(currentCandidate.processedGradientScore)) > OUTLINE_DARK_MAX_PROCESSED_GRADIENT;
}

function getOutlineDarkBodyGainResidualCost(candidate) {
    const processedSpatial = Number(candidate?.processedSpatialScore);
    const processedGradient = Number(candidate?.processedGradientScore);
    if (!Number.isFinite(processedSpatial) || !Number.isFinite(processedGradient)) {
        return Infinity;
    }

    return Math.abs(processedSpatial) +
        Math.max(0, processedGradient) * OUTLINE_DARK_BODY_GAIN_GRADIENT_WEIGHT;
}

function pickBestOutlineDarkCandidate(candidates) {
    const accepted = candidates.filter((candidate) => (
        candidate?.accepted === true &&
        candidate?.provenance?.outlineDark === true &&
        candidate?.evaluation?.gates?.outlineDarkEvidenceAllowed === true
    ));
    if (accepted.length === 0) return null;

    const fullBodyCandidate = accepted.find((candidate) => (
        Number(candidate.provenance?.outlineDarkBodyGain ?? 1) === 1
    )) ?? null;
    const anchorCandidate = fullBodyCandidate ?? accepted[0];
    let bestCandidate = anchorCandidate;
    let bestCost = getOutlineDarkBodyGainResidualCost(bestCandidate);

    for (const candidate of accepted) {
        if (!sameCandidateAnchor(anchorCandidate, candidate)) continue;
        const candidateCost = getOutlineDarkBodyGainResidualCost(candidate);
        if (candidateCost < bestCost) {
            bestCandidate = candidate;
            bestCost = candidateCost;
        }
    }

    if (!fullBodyCandidate || bestCandidate === fullBodyCandidate) {
        return bestCandidate;
    }

    const fullBodyCost = getOutlineDarkBodyGainResidualCost(fullBodyCandidate);
    return fullBodyCost - bestCost >= OUTLINE_DARK_BODY_GAIN_MIN_COST_IMPROVEMENT
        ? bestCandidate
        : fullBodyCandidate;
}

function searchOutlineDarkBodyGainCandidates({
    originalImageData,
    standardTrials
}) {
    const fullBodyCandidate = standardTrials.find((candidate) => (
        candidate?.provenance?.outlineDark === true &&
        Number(candidate.provenance?.outlineDarkBodyGain ?? 1) === 1
    )) ?? null;
    if (!fullBodyCandidate) return [];

    const fullBodySpatial = Number(fullBodyCandidate.processedSpatialScore);
    const shouldSearch =
        fullBodyCandidate.outlineDarkRepair?.accepted === true &&
        Number.isFinite(fullBodySpatial) &&
        fullBodySpatial <= OUTLINE_DARK_BODY_GAIN_SEARCH_MAX_FULL_BODY_SPATIAL;
    if (!shouldSearch) return [fullBodyCandidate];

    const candidates = [fullBodyCandidate];
    const baselineNearBlackRatio = calculateNearBlackRatio(
        originalImageData,
        fullBodyCandidate.position
    );
    for (const bodyGain of OUTLINE_DARK_BODY_GAINS) {
        if (bodyGain === 1) continue;
        const candidate = evaluateRestorationCandidate({
            originalImageData,
            alphaMap: createOutlineDarkBodyGainAlphaMap(fullBodyCandidate.alphaMap, bodyGain),
            position: fullBodyCandidate.position,
            source: `${fullBodyCandidate.source}+body-gain`,
            config: fullBodyCandidate.config,
            baselineNearBlackRatio,
            alphaGain: 1,
            provenance: mergeCandidateProvenance(
                fullBodyCandidate.provenance,
                { outlineDarkBodyGain: bodyGain }
            ),
            includeImageData: false
        });
        if (candidate) candidates.push(candidate);
    }

    return candidates;
}

function evaluateAdaptiveTrial({
    originalImageData,
    config,
    alpha96,
    resolveAlphaMap,
    allowAdaptiveSearch
}) {
    if (!allowAdaptiveSearch || !alpha96) {
        return {
            adaptive: null,
            adaptiveConfidence: null,
            adaptiveTrial: null
        };
    }

    const adaptive = detectAdaptiveWatermarkRegion({
        imageData: originalImageData,
        alpha96,
        defaultConfig: config
    });
    const adaptiveConfidence = adaptive?.confidence ?? null;

    if (!adaptive?.region || !(
        hasReliableAdaptiveWatermarkSignal(adaptive) ||
        adaptive.confidence >= VALIDATION_MIN_CONFIDENCE_FOR_ADAPTIVE_TRIAL
    )) {
        return {
            adaptive,
            adaptiveConfidence,
            adaptiveTrial: null
        };
    }

    const size = adaptive.region.size;
    const adaptivePosition = {
        x: adaptive.region.x,
        y: adaptive.region.y,
        width: size,
        height: size
    };
    const adaptiveAlphaMap = resolveAlphaMap(size);
    if (!adaptiveAlphaMap) {
        throw new Error(`Missing alpha map for adaptive size ${size}`);
    }
    const adaptiveConfig = {
        logoSize: size,
        marginRight: originalImageData.width - adaptivePosition.x - size,
        marginBottom: originalImageData.height - adaptivePosition.y - size
    };

    return {
        adaptive,
        adaptiveConfidence,
        adaptiveTrial: evaluateRestorationCandidate({
            originalImageData,
            alphaMap: adaptiveAlphaMap,
            position: adaptivePosition,
            source: 'adaptive',
            config: adaptiveConfig,
            baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, adaptivePosition),
            adaptiveConfidence: adaptive.confidence,
            provenance: mergeCandidateProvenance(
                { adaptive: true },
                adaptive.strongUndersizedMatch === true
                    ? { strongUndersizedMatch: true }
                    : null
            ),
            includeImageData: false
        })
    };
}

function refineSelectedAnchorCandidate({
    originalImageData,
    baseCandidate,
    baseDecisionTier,
    adaptiveConfidence,
    alphaGainCandidates,
    allowTemplateWarp = true
}) {
    let selectedTrial = ensureCandidateImageData(baseCandidate, originalImageData);
    let alphaMap = baseCandidate.alphaMap;
    let position = baseCandidate.position;
    let config = baseCandidate.config;
    let source = baseCandidate.source;
    let decisionTier = baseDecisionTier || inferDecisionTier(baseCandidate);
    let templateWarp = null;
    let selectedAlphaGain = baseCandidate.alphaGain ?? 1;

    const warpCandidate = allowTemplateWarp
        ? findBestTemplateWarp({
            originalImageData,
            alphaMap,
            position,
            baselineSpatialScore: selectedTrial.originalSpatialScore,
            baselineGradientScore: selectedTrial.originalGradientScore,
            shiftCandidates: selectedTrial.provenance?.previewAnchor === true
                ? PREVIEW_TEMPLATE_ALIGN_SHIFTS
                : TEMPLATE_ALIGN_SHIFTS,
            scaleCandidates: selectedTrial.provenance?.previewAnchor === true
                ? PREVIEW_TEMPLATE_ALIGN_SCALES
                : TEMPLATE_ALIGN_SCALES
        })
        : null;
    if (warpCandidate) {
        const warpedTrial = evaluateRestorationCandidate({
            originalImageData,
            alphaMap: warpCandidate.alphaMap,
            position,
            source: `${source}+warp`,
            config,
            baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, position),
            adaptiveConfidence,
            provenance: selectedTrial.provenance,
            includeImageData: false
        });
        const betterWarpTrial = pickBetterCandidate(selectedTrial, warpedTrial);
        if (betterWarpTrial !== selectedTrial) {
            alphaMap = warpedTrial.alphaMap;
            source = betterWarpTrial.source;
            selectedTrial = ensureCandidateImageData(betterWarpTrial, originalImageData);
            templateWarp = warpCandidate.shift;
            decisionTier = inferDecisionTier(betterWarpTrial, {
                directMatch: decisionTier === 'direct-match'
            });
        }
    }

    const shouldRunGainSearch = selectedTrial.provenance?.previewAnchor === true
        ? isPreviewAnchorGainSearchRequired(selectedTrial)
        : (
            isCurrentLargeMarginCatalogCandidate(selectedTrial) && selectedTrial.alphaGain < 1
                ? false
                : shouldEscalateSearch(selectedTrial)
        );
    let bestGainTrial = selectedTrial;
    if (shouldRunGainSearch) {
        for (const candidateGain of alphaGainCandidates) {
            if (!Number.isFinite(candidateGain) || candidateGain <= 1) continue;
            if (
                selectedTrial.provenance?.previewAnchor === true &&
                position.width < 40 &&
                candidateGain > 1.1
            ) {
                continue;
            }
            const gainTrial = evaluateRestorationCandidate({
                originalImageData,
                alphaMap,
                position,
                source: `${source}+gain`,
                config,
                baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, position),
                adaptiveConfidence,
                alphaGain: candidateGain,
                provenance: selectedTrial.provenance,
                includeImageData: false
            });
            bestGainTrial = pickBetterCandidate(bestGainTrial, gainTrial);
        }
    }
    if (bestGainTrial !== selectedTrial) {
        selectedTrial = ensureCandidateImageData(bestGainTrial, originalImageData);
        source = bestGainTrial.source;
        selectedAlphaGain = bestGainTrial.alphaGain;
        decisionTier = inferDecisionTier(bestGainTrial, {
            directMatch: decisionTier === 'direct-match'
        });
    }

    return {
        selectedTrial: ensureCandidateImageData(selectedTrial, originalImageData),
        source,
        alphaMap,
        position,
        config,
        templateWarp,
        alphaGain: selectedAlphaGain,
        decisionTier
    };
}

export function selectInitialCandidate({
    originalImageData,
    config,
    catalogPriorConfig = null,
    position,
    alpha48,
    alpha96,
    getAlphaMap,
    allowAdaptiveSearch,
    allowAutomaticSearch = true,
    allowAggressiveStrongLocated = false,
    alphaGainCandidates,
    alphaPriorityGains = [1],
    alpha96Variants = null
}) {
    const resolveAlphaMap = createAlphaMapResolver({ alpha48, alpha96, getAlphaMap });
    const fallbackAlphaMap = config.logoSize === 96 ? alpha96 : alpha48;
    const {
        standardCandidateSeeds,
        standardTrials,
        standardTrial,
        standardSpatialScore,
        standardGradientScore,
        hasReliableStandardMatch
    } = resolveStandardAnchorSelection({
        originalImageData,
        config,
        catalogPriorConfig,
        position,
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap,
        resolveAlphaMap,
        alphaPriorityGains,
        forceCatalogVariants: !allowAutomaticSearch
    });
    const candidatePool = [];
    const observeCandidates = (...values) => {
        for (const candidate of values.flat()) {
            if (candidate && !candidatePool.includes(candidate)) {
                candidatePool.push(candidate);
            }
        }
    };
    observeCandidates(standardTrials);
    let baseCandidate = null;
    let baseDecisionTier = 'insufficient';
    if (hasReliableStandardMatch && standardTrial?.accepted) {
        baseCandidate = standardTrial;
        baseDecisionTier = 'direct-match';
    } else if (standardTrial?.accepted) {
        baseCandidate = {
            ...standardTrial,
            source: `${standardTrial.source}+validated`
        };
        baseDecisionTier = 'validated-match';
    }

    let adaptive = null;
    let adaptiveConfidence = null;
    let adaptiveTrial = null;
    for (const candidate of standardTrials) {
        if (!candidate || candidate === standardTrial) continue;
        if (candidate.provenance?.outlineDark === true) continue;
        ({
            baseCandidate,
            baseDecisionTier
        } = promoteBaseCandidate(baseCandidate, baseDecisionTier, candidate, {
            reliableMatch: hasReliableStandardWatermarkSignal({
                spatialScore: candidate.originalSpatialScore,
                gradientScore: candidate.originalGradientScore
            })
        }));
    }

    const outlineDarkCandidate = pickBestOutlineDarkCandidate(
        searchOutlineDarkBodyGainCandidates({
            originalImageData,
            standardTrials
        })
    );
    observeCandidates(outlineDarkCandidate);
    if (shouldPreferOutlineDarkCandidate(baseCandidate, outlineDarkCandidate)) {
        baseCandidate = outlineDarkCandidate;
        baseDecisionTier = hasReliableStandardWatermarkSignal({
            spatialScore: outlineDarkCandidate.originalSpatialScore,
            gradientScore: outlineDarkCandidate.originalGradientScore
        })
            ? 'direct-match'
            : 'validated-match';
    }

    ({
        baseCandidate,
        baseDecisionTier
    } = searchStrongStandardTrialAlphaGain({
        originalImageData,
        standardTrials,
        standardTrial,
        baseCandidate,
        baseDecisionTier,
        alphaGainCandidates
    }));
    observeCandidates(baseCandidate);

    const defaultAlphaNewMarginRescue = searchDefaultAlphaNewMarginRescue({
        originalImageData,
        standardTrials,
        alpha96,
        alphaGainCandidates
    });
    observeCandidates(defaultAlphaNewMarginRescue);
    if (defaultAlphaNewMarginRescue) {
        ({
            baseCandidate,
            baseDecisionTier
        } = promoteBaseCandidate(baseCandidate, baseDecisionTier, defaultAlphaNewMarginRescue));
    }

    if (allowAutomaticSearch) {
        const previewAnchorCandidate = searchBottomRightPreviewCandidate({
            originalImageData,
            config,
            alpha48,
            alpha96,
            getAlphaMap,
            resolveAlphaMap,
            adaptiveConfidence
        });
        observeCandidates(previewAnchorCandidate);
        if (previewAnchorCandidate) {
            ({
                baseCandidate,
                baseDecisionTier
            } = promoteBaseCandidate(baseCandidate, baseDecisionTier, previewAnchorCandidate));
        }
    }

    if (
        allowAutomaticSearch &&
        baseDecisionTier !== 'direct-match' &&
        !baseCandidate?.provenance?.previewAnchor &&
        shouldEscalateSearch(baseCandidate)
    ) {
        const sizeJitterCandidate = searchStandardSizeJitterCandidate({
            originalImageData,
            candidateSeeds: standardCandidateSeeds,
            alpha48,
            alpha96,
            getAlphaMap,
            resolveAlphaMap
        });
        observeCandidates(sizeJitterCandidate);
        if (sizeJitterCandidate) {
            ({
                baseCandidate,
                baseDecisionTier
            } = promoteBaseCandidate(baseCandidate, baseDecisionTier, sizeJitterCandidate));
        }
    }

    if (
        allowAutomaticSearch &&
        baseDecisionTier !== 'direct-match' &&
        baseCandidate?.provenance?.sizeJitter === true &&
        !baseCandidate?.provenance?.previewAnchor &&
        isStandardCandidateSource(baseCandidate) &&
        shouldEscalateSearch(baseCandidate)
    ) {
        const fineLocalCandidate = searchFineStandardLocalCandidate({
            originalImageData,
            seedCandidate: baseCandidate,
            adaptiveConfidence
        });
        observeCandidates(fineLocalCandidate);
        if (fineLocalCandidate) {
            ({
                baseCandidate,
                baseDecisionTier
            } = promoteBaseCandidate(baseCandidate, baseDecisionTier, fineLocalCandidate));
        }
    }

    const shouldEvaluateAdaptive = () => {
        if (!allowAdaptiveSearch || !alpha96) return false;
        if (!baseCandidate) return true;
        if (!shouldEscalateSearch(baseCandidate)) return false;

        baseCandidate = ensureCandidateImageData(baseCandidate, originalImageData);

        return shouldAttemptAdaptiveFallback({
            processedImageData: baseCandidate.imageData,
            alphaMap: baseCandidate.alphaMap,
            position: baseCandidate.position,
            originalImageData,
            originalSpatialMismatchThreshold: 0
        });
    };

    if (allowAutomaticSearch && shouldEvaluateAdaptive()) {
        ({
            adaptive,
            adaptiveConfidence,
            adaptiveTrial
        } = evaluateAdaptiveTrial({
            originalImageData,
            config,
            alpha96,
            resolveAlphaMap,
            allowAdaptiveSearch
        }));
    }

    if (adaptiveTrial) {
        observeCandidates(adaptiveTrial);
        ({
            baseCandidate,
            baseDecisionTier
        } = promoteBaseCandidate(baseCandidate, baseDecisionTier, adaptiveTrial, {
            reliableMatch: hasReliableAdaptiveWatermarkSignal(adaptive)
        }));
    }

    if (
        allowAutomaticSearch &&
        !baseCandidate?.provenance?.previewAnchor &&
        !hasReliableAdaptiveWatermarkSignal(adaptive) &&
        shouldSearchNearbyStandardCandidate(baseCandidate, originalImageData)
    ) {
        const nearbyStandardCandidate = searchNearbyStandardCandidate({
            originalImageData,
            candidateSeeds: standardCandidateSeeds,
            adaptiveConfidence
        });
        observeCandidates(nearbyStandardCandidate);
        if (nearbyStandardCandidate) {
            ({
                baseCandidate,
                baseDecisionTier
            } = promoteBaseCandidate(baseCandidate, baseDecisionTier, nearbyStandardCandidate));
        }
    }

    if (allowAutomaticSearch && !baseCandidate) {
        const bestEffortCandidate = searchBestEffortCurrentLargeMarginWeakAlpha({
            originalImageData,
            standardTrials,
            alphaGainCandidates
        });
        observeCandidates(bestEffortCandidate);
        if (bestEffortCandidate) {
            baseCandidate = bestEffortCandidate;
            baseDecisionTier = 'direct-match';
        }
    }

    if (!allowAutomaticSearch && !baseCandidate) {
        const bestEffortCandidate = searchBestEffortCurrentLargeMarginWeakAlpha({
            originalImageData,
            standardTrials,
            alphaGainCandidates
        });
        observeCandidates(bestEffortCandidate);
        if (bestEffortCandidate) {
            baseCandidate = bestEffortCandidate;
            baseDecisionTier = 'direct-match';
        } else {
            const fixedCoreLocalGeometryCandidate = searchFixedCoreLocalGeometryCandidate({
                originalImageData,
                candidateSeeds: standardCandidateSeeds,
                resolveAlphaMap,
                alphaGainCandidates
            });
            observeCandidates(fixedCoreLocalGeometryCandidate);
            if (fixedCoreLocalGeometryCandidate) {
                baseCandidate = fixedCoreLocalGeometryCandidate;
                baseDecisionTier = 'direct-match';
            }
        }
    }

    if (!baseCandidate) {
        if (hasReliableStandardMatch && standardTrial?.accepted) {
            baseCandidate = standardTrial;
            baseDecisionTier = 'direct-match';
        } else if (hasReliableAdaptiveWatermarkSignal(adaptive) && adaptiveTrial) {
            baseCandidate = adaptiveTrial;
            baseDecisionTier = 'direct-match';
        }
    }

    if (!baseCandidate) {
        const validatedCandidate = pickBestValidatedCandidate([
            ...standardTrials,
            adaptiveTrial
        ]);
        if (!validatedCandidate) {
            const aggressiveLocatedCandidate = allowAggressiveStrongLocated
                ? pickAggressiveStrongLocatedCandidate([
                    ...standardTrials,
                    adaptiveTrial
                ])
                : null;
            if (aggressiveLocatedCandidate) {
                baseCandidate = {
                    ...aggressiveLocatedCandidate,
                    source: `${aggressiveLocatedCandidate.source}+aggressive-located`
                };
                observeCandidates(baseCandidate);
                baseDecisionTier = 'direct-match';
            } else {
            const fixedCoreLocalGeometryCandidate = !allowAutomaticSearch
                ? searchFixedCoreLocalGeometryCandidate({
                    originalImageData,
                    candidateSeeds: standardCandidateSeeds,
                    resolveAlphaMap,
                    alphaGainCandidates
                })
                : null;
            if (fixedCoreLocalGeometryCandidate) {
                observeCandidates(fixedCoreLocalGeometryCandidate);
                baseCandidate = fixedCoreLocalGeometryCandidate;
                baseDecisionTier = 'direct-match';
            } else {
                return {
                    selectedTrial: null,
                    candidatePool,
                    source: 'skipped',
                    alphaMap: fallbackAlphaMap,
                    position,
                    config,
                    adaptiveConfidence,
                    standardSpatialScore,
                    standardGradientScore,
                    templateWarp: null,
                    alphaGain: 1,
                    decisionTier: 'insufficient'
                };
            }
            }
        } else {
            baseCandidate = {
                ...validatedCandidate,
                source: `${validatedCandidate.source}+validated`
            };
            observeCandidates(baseCandidate);
            baseDecisionTier = 'validated-match';
        }
    }

    if (shouldRevertLocalShiftToStandardTrial(baseCandidate, standardTrial)) {
        baseCandidate = standardTrial;
        baseDecisionTier = hasReliableStandardMatch ? 'direct-match' : 'validated-match';
    }

    if (!allowAutomaticSearch && isCurrentLargeMarginCatalogCandidate(baseCandidate)) {
        const initialCanonical96Candidate = (
            config?.logoSize === 96 &&
            config.marginRight === 64 &&
            config.marginBottom === 64 &&
            fallbackAlphaMap
        )
            ? evaluateRestorationCandidate({
                originalImageData,
                alphaMap: fallbackAlphaMap,
                position,
                source: 'standard',
                config,
                baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, position),
                alphaGain: 1,
                provenance: null,
                includeImageData: false
            })
            : null;
        observeCandidates(initialCanonical96Candidate);
        const fixedCoreCanonical96Candidate = searchFixedCoreStrongStandardAlphaGain({
            originalImageData,
            baseCandidate: initialCanonical96Candidate,
            alphaGainCandidates
        });
        observeCandidates(fixedCoreCanonical96Candidate);
        if (shouldPreserveStrongCanonical96AgainstWeakCurrentLargeMargin(fixedCoreCanonical96Candidate, baseCandidate)) {
            baseCandidate = fixedCoreCanonical96Candidate;
            baseDecisionTier = 'direct-match';
        }
    }

    if (!allowAutomaticSearch && !isStrictFixedCoreCandidate(baseCandidate)) {
        const fixedCoreStrongAlphaGainCandidate = searchFixedCoreStrongStandardAlphaGain({
            originalImageData,
            baseCandidate,
            alphaGainCandidates
        });
        observeCandidates(fixedCoreStrongAlphaGainCandidate);
        if (fixedCoreStrongAlphaGainCandidate) {
            baseCandidate = fixedCoreStrongAlphaGainCandidate;
            baseDecisionTier = 'direct-match';
        } else {
            const bestEffortCandidate = searchBestEffortCurrentLargeMarginWeakAlpha({
                originalImageData,
                standardTrials,
                alphaGainCandidates
            });
            observeCandidates(bestEffortCandidate);
            if (bestEffortCandidate) {
                baseCandidate = bestEffortCandidate;
                baseDecisionTier = 'direct-match';
            } else {
                const fixedCoreLocalGeometryCandidate = searchFixedCoreLocalGeometryCandidate({
                    originalImageData,
                    candidateSeeds: standardCandidateSeeds,
                    resolveAlphaMap,
                    alphaGainCandidates
                });
                observeCandidates(fixedCoreLocalGeometryCandidate);
                baseCandidate = fixedCoreLocalGeometryCandidate;
                baseDecisionTier = fixedCoreLocalGeometryCandidate ? 'direct-match' : 'insufficient';
            }
        }
    }

    if (!baseCandidate) {
        const validatedCandidate = allowAutomaticSearch
            ? pickBestValidatedCandidate([
                ...standardTrials,
                adaptiveTrial
            ])
            : null;
        if (!validatedCandidate) {
            const aggressiveLocatedCandidate = allowAggressiveStrongLocated
                ? pickAggressiveStrongLocatedCandidate([
                    ...standardTrials,
                    adaptiveTrial
                ])
                : null;
            if (aggressiveLocatedCandidate) {
                baseCandidate = {
                    ...aggressiveLocatedCandidate,
                    source: `${aggressiveLocatedCandidate.source}+aggressive-located`
                };
                observeCandidates(baseCandidate);
                baseDecisionTier = 'direct-match';
            } else {
            const fixedCoreLocalGeometryCandidate = !allowAutomaticSearch
                ? searchFixedCoreLocalGeometryCandidate({
                    originalImageData,
                    candidateSeeds: standardCandidateSeeds,
                    resolveAlphaMap,
                    alphaGainCandidates
                })
                : null;
            if (fixedCoreLocalGeometryCandidate) {
                observeCandidates(fixedCoreLocalGeometryCandidate);
                baseCandidate = fixedCoreLocalGeometryCandidate;
                baseDecisionTier = 'direct-match';
            } else {
                return {
                    selectedTrial: null,
                    candidatePool,
                    source: 'skipped',
                    alphaMap: fallbackAlphaMap,
                    position,
                    config,
                    adaptiveConfidence,
                    standardSpatialScore,
                    standardGradientScore,
                    templateWarp: null,
                    alphaGain: 1,
                    decisionTier: 'insufficient'
                };
            }
            }
        } else {
            baseCandidate = {
                ...validatedCandidate,
                source: `${validatedCandidate.source}+validated`
            };
            observeCandidates(baseCandidate);
            baseDecisionTier = 'validated-match';
        }
    }

    if (isCurrentLargeMarginCatalogCandidate(baseCandidate)) {
        const initialCanonical96Seed = (
            config?.logoSize === 96 &&
            config.marginRight === 64 &&
            config.marginBottom === 64 &&
            fallbackAlphaMap
        )
            ? evaluateRestorationCandidate({
                originalImageData,
                alphaMap: fallbackAlphaMap,
                position,
                source: 'standard',
                config,
                baselineNearBlackRatio: calculateNearBlackRatio(originalImageData, position),
                alphaGain: 1,
                provenance: null,
                includeImageData: false
            })
            : null;
        observeCandidates(initialCanonical96Seed);
        const rawCanonical96Seed =
            standardTrials.find((candidate) => isCanonicalDefault96Candidate(candidate)) ??
            (isCanonicalDefault96Candidate(standardTrial) ? standardTrial : null) ??
            standardTrials.find((candidate) => isDefault96GeometryCandidate(candidate)) ??
            (isDefault96GeometryCandidate(standardTrial) ? standardTrial : null) ??
            initialCanonical96Seed;
        const canonical96Seed = rawCanonical96Seed && !isCanonicalDefault96Candidate(rawCanonical96Seed)
            ? {
                ...rawCanonical96Seed,
                source: 'standard',
                provenance: null
            }
            : rawCanonical96Seed;
        const strictCanonical96Candidate = isStrictFixedCoreCandidate(canonical96Seed)
            ? canonical96Seed
            : searchFixedCoreStrongStandardAlphaGain({
                originalImageData,
                baseCandidate: canonical96Seed,
                alphaGainCandidates
            });
        observeCandidates(strictCanonical96Candidate);
        if (shouldPreserveStrongCanonical96AgainstWeakCurrentLargeMargin(strictCanonical96Candidate, baseCandidate)) {
            baseCandidate = strictCanonical96Candidate;
            baseDecisionTier = 'direct-match';
        }
    }

    const {
        selectedTrial,
        source,
        alphaMap,
        position: refinedPosition,
        config: refinedConfig,
        templateWarp,
        alphaGain,
        decisionTier
    } = refineSelectedAnchorCandidate({
        originalImageData,
        baseCandidate,
        baseDecisionTier,
        adaptiveConfidence,
        alphaGainCandidates,
        allowTemplateWarp: allowAutomaticSearch
    });

    const materializedSelectedTrial = ensureCandidateImageData(selectedTrial, originalImageData);
    observeCandidates(materializedSelectedTrial);

    return {
        selectedTrial: materializedSelectedTrial,
        candidatePool,
        source,
        alphaMap,
        position: refinedPosition,
        config: refinedConfig,
        adaptiveConfidence,
        standardSpatialScore,
        standardGradientScore,
        templateWarp,
        alphaGain,
        decisionTier
    };
}

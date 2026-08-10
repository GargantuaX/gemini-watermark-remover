import { removeWatermark } from './blendModes.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    interpolateAlphaMap,
    warpAlphaMap
} from './adaptiveDetector.js';
import {
    createAlphaGradientMask,
    getAlphaGradientWeight
} from './alphaGradientMask.js';
import {
    calculateNearBlackRatio,
    scoreRegion
} from './candidateSelector.js';
import {
    assessAlphaBandHalo,
    assessCalibratedWatermarkResidualVisibility,
    assessReferenceTextureAlignment,
    assessReferenceTextureAlignmentFromStats,
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility,
    getRegionTextureStats
} from './restorationMetrics.js';
import {
    scoreBalancedVisualCandidate,
    scoreDamage,
    scoreResidual
} from './watermarkScoring.js';
import {
    blurAlphaMap,
    buildPreviewNeighborhoodPrior,
    measurePreviewBoundaryMetrics
} from './previewAlphaCalibration.js';
import { runImageWatermarkPipeline } from './imageWatermarkPipeline.js';
import {
    createImageWatermarkPipelineCleanupConfig,
    createImageWatermarkPipelineRequest
} from './imageWatermarkPipelineRequest.js';
import {
    createRegionCorrelationMetrics
} from './pipelineMetrics.js';

const RESIDUAL_RECALIBRATION_THRESHOLD = 0.5;
const MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION = 0.18;
const MIN_RECALIBRATION_SCORE_DELTA = 0.18;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const OUTLINE_REFINEMENT_THRESHOLD = 0.42;
const OUTLINE_REFINEMENT_MIN_GAIN = 1.2;
const SUBPIXEL_REFINE_SHIFTS = [-0.25, 0, 0.25];
const SUBPIXEL_REFINE_SCALES = [0.99, 1, 1.01];
const ALPHA_PARAMETER_GROUPS = Object.freeze([
    { name: 'gemini-weak-alpha-202606', alphaGain: 0.6, standardPriority: true },
    { name: 'gemini-standard-alpha', alphaGain: 1, standardPriority: true },
    { name: 'gemini-balanced-strong-alpha-202606', alphaGain: 1.1 },
    { name: 'gemini-strong-alpha-202606', alphaGain: 1.15 },
    { name: 'gemini-strong-alpha-high-202606', alphaGain: 1.3 },
    { name: 'weak-alpha-extra-conservative', alphaGain: 0.45 },
    { name: 'weak-alpha-light', alphaGain: 0.7 },
    { name: 'weak-alpha-mid', alphaGain: 0.85 },
    { name: 'weak-alpha-conservative', alphaGain: 0.55 }
]);
const ALPHA_GAIN_CANDIDATES = ALPHA_PARAMETER_GROUPS.map((group) => group.alphaGain);
const LOCATED_AGGRESSIVE_ALPHA_GAINS = Object.freeze([0.85, 1, 1.15, 1.3, 1.45, 1.7, 2, 2.4]);
const LOCATED_AGGRESSIVE_MIN_BALANCED_GAIN = 0.015;
const LOCATED_AGGRESSIVE_PASSABLE_SPATIAL_THRESHOLD = 0.22;
const LOCATED_AGGRESSIVE_MAX_PASSABLE_SPATIAL_DRIFT = 0.02;
const ENABLE_VISUAL_POST_PROCESSING = false;
const CATALOG_DARK_ALPHA_GAIN_CANDIDATES = Object.freeze([0.9, 0.85, 0.8, 0.95, 0.7, 0.6]);
const STANDARD_ALPHA_PRIORITY_GAINS = ALPHA_PARAMETER_GROUPS
    .filter((group) => group.standardPriority === true)
    .map((group) => group.alphaGain);
const PREVIEW_EDGE_CLEANUP_MAX_SIZE = 32;
const KNOWN_48_EDGE_CLEANUP_MIN_SIZE = 40;
const KNOWN_48_EDGE_CLEANUP_MAX_SIZE = 56;
const KNOWN_48_EDGE_CLEANUP_MIN_GRADIENT = 0.22;
const KNOWN_48_EDGE_CLEANUP_MAX_ABS_SPATIAL = 0.55;
const KNOWN_48_EDGE_CLEANUP_MIN_GRADIENT_IMPROVEMENT = 0.015;
const KNOWN_48_EDGE_CLEANUP_MAX_SPATIAL_DRIFT = 0.06;
const V2_SMALL_EDGE_CLEANUP_SIZE = 36;
const V2_SMALL_EDGE_CLEANUP_SIZE_TOLERANCE = 2;
const V2_SMALL_EDGE_CLEANUP_MIN_GRADIENT = 0.22;
const V2_SMALL_EDGE_CLEANUP_MAX_ABS_SPATIAL = 0.08;
const V2_SMALL_EDGE_CLEANUP_MIN_GRADIENT_IMPROVEMENT = 0.025;
const V2_SMALL_EDGE_CLEANUP_MAX_SPATIAL_DRIFT = 0.035;
const KNOWN_48_FLAT_FILL_MIN_GRADIENT = 0.28;
const STRONG_UNDERSIZED_FLAT_FILL_MIN_GRADIENT = 0.27;
const KNOWN_48_FLAT_FILL_MAX_BACKGROUND_STD = 6;
const KNOWN_48_FLAT_FILL_MIN_GRADIENT_IMPROVEMENT = 0.045;
const KNOWN_48_FLAT_FILL_SECOND_PASS_MIN_GRADIENT_IMPROVEMENT = 0.025;
const KNOWN_48_FLAT_FILL_MAX_APPLIED_PASSES = 2;
const KNOWN_48_FLAT_FILL_MAX_SPATIAL_DRIFT = 0.12;
const KNOWN_48_FLAT_FILL_MAX_ACCEPTED_ABS_SPATIAL = 0.38;
const KNOWN_48_FLAT_FILL_PAD = 10;
const KNOWN_48_FLAT_FILL_OUTSIDE_ALPHA_MAX = 0.012;
const KNOWN_48_FLAT_FILL_PRESETS = Object.freeze([
    { name: 'edge', minAlpha: 0.012, maxAlpha: 0.5, strength: 0.9 },
    { name: 'wide', minAlpha: 0.008, maxAlpha: 0.99, strength: 0.92 },
    { name: 'hard', minAlpha: 0.004, maxAlpha: 0.99, strength: 1 }
]);
const NEW_MARGIN_96_FLAT_FILL_MIN_GRADIENT = 0.12;
const NEW_MARGIN_96_FLAT_FILL_MAX_BACKGROUND_STD = 7;
const NEW_MARGIN_96_FLAT_FILL_MIN_GRADIENT_IMPROVEMENT = 0.025;
const NEW_MARGIN_96_FLAT_FILL_MAX_SPATIAL_DRIFT = 0.08;
const NEW_MARGIN_96_FLAT_FILL_MAX_ACCEPTED_ABS_SPATIAL = 0.22;
const NEW_MARGIN_96_FLAT_FILL_PRESETS = Object.freeze([
    { name: 'edge', minAlpha: 0.006, maxAlpha: 0.45, strength: 0.75 },
    {
        name: 'expanded-edge',
        minAlpha: 0.006,
        maxAlpha: 0.45,
        strength: 1,
        edgeMaskAlphaScale: 0.2,
        minBaselineGradient: 0.6
    }
]);
const NEW_MARGIN_96_SMOOTH_EDGE_MIN_ALPHA_GAIN = 0.8;
const NEW_MARGIN_96_SMOOTH_EDGE_MAX_ALPHA_GAIN = 0.9;
const NEW_MARGIN_96_SMOOTH_EDGE_MAX_BACKGROUND_STD = 6;
const NEW_MARGIN_96_SMOOTH_EDGE_MAX_BASELINE_ABS_SPATIAL = 0.12;
const NEW_MARGIN_96_SMOOTH_EDGE_MIN_BASELINE_GRADIENT = 0.45;
const NEW_MARGIN_96_SMOOTH_EDGE_MIN_GRADIENT_IMPROVEMENT = 0.25;
const NEW_MARGIN_96_SMOOTH_EDGE_MAX_FINAL_ABS_SPATIAL = 0.18;
const NEW_MARGIN_96_SMOOTH_EDGE_MAX_FINAL_ABS_GRADIENT = 0.18;
const NEW_MARGIN_96_SMOOTH_EDGE_MAX_BOUNDARY_RAW_SCORE = 1.75;
const NEW_MARGIN_96_SMOOTH_EDGE_MAX_ARTIFACT_COST = 0.05;
const NEW_MARGIN_96_SMOOTH_EDGE_SCRATCH_PAD = 12;
const NEW_MARGIN_96_SMOOTH_EDGE_PRESETS = Object.freeze([
    { maxAlpha: 0.3, strength: 0.6 },
    { maxAlpha: 0.3, strength: 0.85 },
    { maxAlpha: 0.3, strength: 1 },
    { maxAlpha: 0.5, strength: 0.6 },
    { maxAlpha: 0.5, strength: 0.85 },
    { maxAlpha: 0.5, strength: 1 }
]);
const NEW_MARGIN_96_VARIANT_RESCUE_PROFILES = Object.freeze([
    { exponent: 1.06, alphaGain: 1.05 },
    { exponent: 0.82, alphaGain: 0.9 }
]);
const NEW_MARGIN_96_VARIANT_RESCUE_MIN_ORIGINAL_SPATIAL = 0.7;
const NEW_MARGIN_96_VARIANT_RESCUE_MIN_ORIGINAL_GRADIENT = 0.7;
const NEW_MARGIN_96_VARIANT_RESCUE_MIN_CURRENT_SPATIAL = 0.28;
const NEW_MARGIN_96_VARIANT_RESCUE_MAX_CURRENT_GRADIENT = 0.18;
const NEW_MARGIN_96_VARIANT_RESCUE_MAX_SPATIAL = 0.12;
const NEW_MARGIN_96_VARIANT_RESCUE_MAX_GRADIENT = 0.2;
const NEW_MARGIN_96_VARIANT_RESCUE_MAX_VISUAL_ARTIFACT = 0.24;
const NEW_MARGIN_96_VARIANT_RESCUE_MAX_CLIPPED = 0.012;
const KNOWN_48_LUMA_EDGE_MIN_GRADIENT = 0.2;
const KNOWN_48_LUMA_EDGE_MIN_GRADIENT_IMPROVEMENT = 0.02;
const KNOWN_48_LUMA_EDGE_MAX_SPATIAL_DRIFT = 0.04;
const KNOWN_48_LUMA_EDGE_MAX_ACCEPTED_ABS_SPATIAL = 0.38;
const KNOWN_48_LUMA_EDGE_PRESETS = Object.freeze([
    { name: 'soft', minAlpha: 0.012, maxAlpha: 0.7, referenceAlphaMax: 0.025, radius: 2, strength: 0.28, colorSigma: 34, maxDelta: 22 },
    { name: 'mid', minAlpha: 0.012, maxAlpha: 0.7, referenceAlphaMax: 0.04, radius: 3, strength: 0.42, colorSigma: 34, maxDelta: 32 },
    { name: 'wide', minAlpha: 0.012, maxAlpha: 0.7, referenceAlphaMax: 0.055, radius: 4, strength: 0.48, colorSigma: 34, maxDelta: 40 }
]);
const KNOWN_48_MID_CORE_BIAS_STRENGTH = 0.25;
const KNOWN_48_MID_CORE_BIAS_MIN_HALO = 8;
const KNOWN_48_MID_CORE_BIAS_MIN_HALO_REDUCTION = 0.5;
const KNOWN_48_MID_CORE_BIAS_MAX_GRADIENT_DRIFT = 0.01;
const KNOWN_48_MID_CORE_BIAS_MAX_SPATIAL_DRIFT = 0.02;
const KNOWN_48_MID_CORE_BIAS_MAX_ARTIFACT_DRIFT = 0.001;
const KNOWN_48_MID_CORE_BIAS_MAX_NEW_CLIP_DRIFT = 0.001;
const PREVIEW_EDGE_CLEANUP_SPATIAL_THRESHOLD = 0.08;
const PREVIEW_EDGE_CLEANUP_GRADIENT_THRESHOLD = 0.1;
const SMALL_PREVIEW_EDGE_CLEANUP_MAX_SIZE = 32;
const SMALL_PREVIEW_EDGE_CLEANUP_GRADIENT_THRESHOLD = 0.05;
const PREVIEW_EDGE_CLEANUP_MIN_GRADIENT_IMPROVEMENT = 0.03;
const PREVIEW_EDGE_CLEANUP_MAX_SPATIAL_DRIFT = 0.04;
const PREVIEW_EDGE_CLEANUP_MAX_APPLIED_PASSES = 3;
const PREVIEW_EDGE_CLEANUP_FINE_GRADIENT_THRESHOLD = 0.16;
const PREVIEW_EDGE_CLEANUP_FINE_MIN_GRADIENT_IMPROVEMENT = 0.005;
const PREVIEW_EDGE_CLEANUP_HALO_RELAXED_MIN_GRADIENT_IMPROVEMENT = 0.01;
const PREVIEW_EDGE_CLEANUP_HALO_WEIGHT = 0.02;
const PREVIEW_EDGE_CLEANUP_MIN_HALO_REDUCTION = 1.5;
const PREVIEW_EDGE_CLEANUP_STRONG_HALO_THRESHOLD = 4;
const PREVIEW_EDGE_CLEANUP_HALO_SPATIAL_THRESHOLD = 0.18;
const PREVIEW_EDGE_CLEANUP_PRESETS = Object.freeze([
    { minAlpha: 0.02, maxAlpha: 0.45, radius: 2, strength: 0.7, outsideAlphaMax: 0.05 },
    { minAlpha: 0.05, maxAlpha: 0.55, radius: 3, strength: 0.7, outsideAlphaMax: 0.08 },
    { minAlpha: 0.1, maxAlpha: 0.7, radius: 3, strength: 0.8, outsideAlphaMax: 0.12 },
    { minAlpha: 0.01, maxAlpha: 0.35, radius: 4, strength: 1.4, outsideAlphaMax: 0.05 }
]);
const SMALL_PREVIEW_EDGE_CLEANUP_PRESETS = Object.freeze([
    {
        minAlpha: 0.01,
        maxAlpha: 0.55,
        radius: 2,
        strength: 2.4,
        outsideAlphaMax: 0.05,
        minGradientImprovement: 0.04,
        maxSpatialDrift: 0.12,
        maxAcceptedSpatial: 0.12
    }
]);
const PREVIEW_EDGE_CLEANUP_STRONG_GRADIENT_THRESHOLD = 0.45;
const PREVIEW_EDGE_CLEANUP_AGGRESSIVE_PRESETS = Object.freeze([
    {
        minAlpha: 0.01,
        maxAlpha: 0.55,
        radius: 2,
        strength: 1.3,
        outsideAlphaMax: 0.05,
        minGradientImprovement: 0.12,
        maxSpatialDrift: 0.18,
        maxAcceptedSpatial: 0.18
    }
]);
const SMALL_PREVIEW_FLAT_FILL_MIN_SAMPLE_LUM = 190;
const SMALL_PREVIEW_FLAT_FILL_MIN_BACKGROUND_MEAN = 230;
const SMALL_PREVIEW_FLAT_FILL_MAX_BACKGROUND_STD = 8;
const SMALL_PREVIEW_FLAT_FILL_MAX_GRADIENT = 0.02;
const SMALL_PREVIEW_FLAT_FILL_MAX_ABS_SPATIAL = 0.08;
const SMALL_PREVIEW_FLAT_FILL_PRESET = Object.freeze({
    pad: 14,
    outsideAlphaMax: 0.012,
    minSampleLum: SMALL_PREVIEW_FLAT_FILL_MIN_SAMPLE_LUM,
    minAlpha: 0.004,
    minTargetLum: 170,
    strength: 1,
    maxBackgroundStd: SMALL_PREVIEW_FLAT_FILL_MAX_BACKGROUND_STD,
});
const LOCATED_AGGRESSIVE_EDGE_PRESETS = Object.freeze([
    { minAlpha: 0.004, maxAlpha: 0.99, radius: 2, strength: 0.85, outsideAlphaMax: 0.08 },
    { minAlpha: 0.004, maxAlpha: 0.99, radius: 3, strength: 1.15, outsideAlphaMax: 0.12 },
    { minAlpha: 0.004, maxAlpha: 0.99, radius: 5, strength: 1.45, outsideAlphaMax: 0.18 },
    { minAlpha: 0.02, maxAlpha: 0.99, radius: 6, strength: 1.8, outsideAlphaMax: 0.25 }
]);
const PREVIEW_BACKGROUND_CLEANUP_MAX_SIZE = 52;
const PREVIEW_BACKGROUND_CLEANUP_MIN_RESIDUAL = 0.3;
const PREVIEW_BACKGROUND_CLEANUP_MAX_BORDER_STD = 24;
const PREVIEW_BACKGROUND_CLEANUP_PAD = 8;
const PREVIEW_BACKGROUND_CLEANUP_PRIOR_RADIUS = 10;
const SMOOTH_PRIOR_LOCATED_MIN_SIZE = 80;
const SMOOTH_PRIOR_LOCATED_MAX_SIZE = 160;
const SMOOTH_PRIOR_LOCATED_MIN_BORDER_MEAN = 120;
const SMOOTH_PRIOR_LOCATED_MIN_SPATIAL = 0.25;
const SMOOTH_PRIOR_LOCATED_MAX_GRADIENT = 0.22;
const SMOOTH_PRIOR_LOCATED_MIN_SPATIAL_IMPROVEMENT = 0.16;
const SMOOTH_PRIOR_LOCATED_MAX_GRADIENT_DRIFT = 0.05;
const SMOOTH_PRIOR_LOCATED_MIN_ARTIFACT_IMPROVEMENT = 0.025;
const SMOOTH_PRIOR_LOCATED_MAX_ACCEPTED_GRADIENT = 0.18;
const SMOOTH_PRIOR_LOCATED_PRESETS = Object.freeze([
    { radius: 24, threshold: 0, blurRadius: 0, strength: 0.75, gamma: 0.45 },
    { radius: 36, threshold: 0, blurRadius: 0, strength: 0.75, gamma: 0.45 },
    { radius: 24, threshold: 0.01, blurRadius: 0, strength: 0.75, gamma: 0.45 },
    { radius: 36, threshold: 0.01, blurRadius: 0, strength: 0.75, gamma: 0.45 }
]);
const OVER_SUBTRACTION_SPATIAL_THRESHOLD = -0.25;
const OVER_SUBTRACTION_GRADIENT_THRESHOLD = 0.35;
const OVER_SUBTRACTION_MIN_ABS_SPATIAL_IMPROVEMENT = 0.08;
const OVER_SUBTRACTION_MIN_GRADIENT_IMPROVEMENT = 0.08;
const OVER_SUBTRACTION_FINE_ALPHA_STEP = 0.02;
const OVER_SUBTRACTION_FINE_ALPHA_WINDOW = 0.04;
const LOCAL_ALPHA_SEARCH_MIN_ORIGINAL_SPATIAL = 0.25;
const LOCAL_ALPHA_SEARCH_MIN_ORIGINAL_GRADIENT = 0.2;
const LOCAL_ALPHA_SEARCH_DAMAGE_COARSE_STEP = 0.05;
const LOCAL_ALPHA_SEARCH_DAMAGE_MAX_DROP = 0.2;
const LOCAL_ALPHA_SEARCH_FINE_STEP = 0.002;
const LOCAL_ALPHA_SEARCH_OVERSHOOT_WINDOW = 0.05;
const LOCAL_ALPHA_SEARCH_OVERSHOOT_STEP = 0.01;
const LOCAL_ALPHA_SEARCH_MAX_ABS_SPATIAL = 0.18;
const LOCAL_ALPHA_SEARCH_MAX_GRADIENT = 0.22;
const LOCAL_ALPHA_SEARCH_MAX_NEWLY_CLIPPED_RATIO = 0.02;
const LOCAL_ALPHA_SEARCH_DAMAGE_WEIGHT = 0.25;
const LOCAL_ALPHA_SEARCH_MIN_COST_IMPROVEMENT = 0.02;
const LOCAL_ALPHA_SEARCH_COST_TIE = 0.002;
// assessWatermarkResidualVisibility reads a 4px outer ring. Keep the scratch
// window at least that wide so trial eligibility matches full-image scoring.
const LOCAL_ALPHA_SEARCH_SCRATCH_PAD = 4;
// On an almost-black support, valid inverse-alpha removal can trip the generic
// clipping gate. This path is intentionally narrow and must converge against
// several independently reconstructed neighborhood priors before acceptance.
const DARK_SUPPORT_SEARCH_SCRATCH_PAD = 12;
const DARK_SUPPORT_SEARCH_MIN_ORIGINAL_SPATIAL = 0.95;
const DARK_SUPPORT_SEARCH_MIN_ORIGINAL_GRADIENT = 0.8;
const DARK_SUPPORT_SEARCH_MIN_ORIGINAL_NEAR_BLACK = 0.2;
const DARK_SUPPORT_SEARCH_MIN_GAIN = 0.58;
const DARK_SUPPORT_SEARCH_MAX_GAIN = 0.64;
const DARK_SUPPORT_SEARCH_GAIN_STEP = 0.002;
const DARK_SUPPORT_MAX_ABS_SPATIAL = 0.18;
const DARK_SUPPORT_MAX_GRADIENT = 0.18;
const DARK_SUPPORT_MAX_NEWLY_CLIPPED_RATIO = 0.25;
const DARK_SUPPORT_MAX_OUTSIDE_ALPHA_CLIP_RATIO = 0.005;
const DARK_SUPPORT_MIN_STRONG_ALPHA_CLIP_RATIO = 0.8;
const DARK_SUPPORT_ALPHA_MIN = 0.05;
const DARK_SUPPORT_ALPHA_STRONG_MIN = 0.2;
const DARK_SUPPORT_MAX_TEXTURE_PENALTY = 0.02;
const DARK_SUPPORT_MAX_PRIOR_MEAN_LUMINANCE = 8;
const DARK_SUPPORT_MAX_CANDIDATE_MEAN_LUMINANCE = 8;
const DARK_SUPPORT_MAX_PRIOR_MEAN_DELTA = 1.5;
const DARK_SUPPORT_MAX_PRIOR_MAE = 2.25;
const DARK_SUPPORT_MAX_PRIOR_WEIGHTED_MAE = 3.5;
const DARK_SUPPORT_MAX_BOUNDARY_SCORE = 0.3;
const DARK_SUPPORT_MAX_OPPOSITE_HALO_LUMINANCE = 1;
const DARK_SUPPORT_MIN_ABS_SPATIAL_IMPROVEMENT = 0.2;
const DARK_SUPPORT_MIN_GRADIENT_IMPROVEMENT = 0.2;
const DARK_SUPPORT_PRIOR_RELAXATION_PASSES = 32;
const DARK_SUPPORT_PRIOR_RADII = Object.freeze([4, 8, 12]);
const WEAK_ALPHA_FINE_TUNE_MIN_ORIGINAL_SPATIAL = 0.45;
const WEAK_ALPHA_FINE_TUNE_MIN_POSITIVE_RESIDUAL = 0.05;
const WEAK_ALPHA_FINE_TUNE_MIN_ABS_SPATIAL_IMPROVEMENT = 0.04;
const WEAK_ALPHA_FINE_TUNE_MAX_GRADIENT_INCREASE = 0.08;
const STRONG_POSITIVE_FINE_TUNE_MIN_ORIGINAL_SPATIAL = 0.75;
const STRONG_POSITIVE_FINE_TUNE_MIN_ORIGINAL_GRADIENT = 0.65;
const STRONG_POSITIVE_FINE_TUNE_MIN_CURRENT_SPATIAL = 0.3;
const STRONG_POSITIVE_FINE_TUNE_MID_GAINS = Object.freeze([0.7, 0.85]);
const STRONG_POSITIVE_FINE_TUNE_EXTRA_GAINS = Object.freeze([0.95, 1]);
const STRONG_POSITIVE_FINE_TUNE_MAX_ACCEPTED_SPATIAL = 0.12;
const STRONG_POSITIVE_FINE_TUNE_MAX_ACCEPTED_GRADIENT = 0.25;
const STRONG_POSITIVE_FINE_TUNE_MAX_POSITIVE_HALO_LUM = 4;
const CANONICAL_96_MODERATE_SIGNAL_MIN_ORIGINAL_SPATIAL = 0.4;
const CANONICAL_96_MODERATE_SIGNAL_MIN_ORIGINAL_GRADIENT = 0.1;
const CANONICAL_96_MODERATE_SIGNAL_MAX_CURRENT_SPATIAL = 0.26;
const CANONICAL_96_MODERATE_SIGNAL_MAX_CURRENT_GRADIENT = 0.04;
const FULL_STRENGTH_NEW_MARGIN_MIN_ORIGINAL_GRADIENT = 0.08;
const FULL_STRENGTH_NEW_MARGIN_MAX_CURRENT_GRADIENT = 0.1;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MIN_ORIGINAL_SPATIAL = 0.4;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MIN_ORIGINAL_GRADIENT = 0.3;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_ABS_CURRENT_SPATIAL = 0.12;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_CURRENT_GRADIENT = 0.08;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MIN_HALO = 6;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MIN_HALO_REDUCTION = 4;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_POSITIVE_HALO = 2.3;
const CANONICAL_96_POSITIVE_HALO_RESCUE_ALPHA_GAIN = 1;
const CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_RADIUS = 56;
const CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_MIN_ALPHA = 0.08;
const CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_THRESHOLD = 3;
const CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_STRENGTH = 1;
const CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_GAMMA = 0.7;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_SPATIAL = 0.18;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_GRADIENT = 0.08;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_VISUAL_ARTIFACT = 0.07;
const CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_NEWLY_CLIPPED = 0.01;
const CATALOG_ALPHA_DARK_FINE_TUNE_MIN_ORIGINAL_SPATIAL = 0.6;
const CATALOG_ALPHA_DARK_FINE_TUNE_MIN_ORIGINAL_GRADIENT = 0.45;
const CATALOG_ALPHA_DARK_FINE_TUNE_MAX_NEGATIVE_RESIDUAL = -0.12;
const CATALOG_ALPHA_DARK_FINE_TUNE_MAX_GRADIENT_INCREASE = 0.12;
const SMALL_PREVIEW_REFINEMENT_MAX_SIZE = 40;
const SMALL_PREVIEW_REFINEMENT_MAX_REFINED_SIZE = 56;
const SMALL_PREVIEW_REFINEMENT_MIN_ABS_SPATIAL_IMPROVEMENT = 0.03;
const SMALL_PREVIEW_REFINEMENT_MIN_GRADIENT_IMPROVEMENT = 0.03;
const SMALL_PREVIEW_REFINEMENT_MAX_SOURCE_SIZE = 32;
const SMALL_PREVIEW_REFINEMENT_MAX_ORIGINAL_GRADIENT = 0.15;
const SMALL_PREVIEW_REFINEMENT_MIN_CURRENT_SPATIAL = 0.04;
const SMALL_PREVIEW_REFINEMENT_MAX_CURRENT_GRADIENT = 0.08;
const SMALL_ANCHOR_RELOCATION_MIN_SIZE = 40;
const SMALL_ANCHOR_RELOCATION_MAX_SIZE = 56;
const SMALL_ANCHOR_RELOCATION_SIZE_DELTA = 5;
const SMALL_ANCHOR_RELOCATION_MARGIN_DELTA = 10;
const SMALL_ANCHOR_RELOCATION_MIN_CURRENT_GRADIENT = 0.24;
const SMALL_ANCHOR_RELOCATION_MAX_ACCEPTED_SPATIAL = 0.14;
const SMALL_ANCHOR_RELOCATION_MAX_ACCEPTED_GRADIENT = 0.24;
const SMALL_ANCHOR_RELOCATION_MIN_ORIGINAL_SPATIAL = 0.32;
const SMALL_ANCHOR_RELOCATION_MIN_SUPPRESSION_GAIN = 0.22;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_SPATIAL = 0.4;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_GRADIENT = 0.45;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_SPATIAL = 0.25;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_GRADIENT = 0.4;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_CURRENT_SPATIAL = -0.16;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_CURRENT_GRADIENT = 0.18;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_BALANCED_GAIN = 0.035;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_SPATIAL = 0.12;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_GRADIENT = 0.2;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_DARK_HALO = 4;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_VISUAL_ARTIFACT = 0.2;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_GAINS = Object.freeze([0.45, 0.55, 0.6, 0.7, 0.85]);
const KNOWN_48_ANTI_TEMPLATE_RESCUE_SHARPEN_AMOUNT = 0.25;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_SHARPEN_ALPHA_GAIN = 0.55;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MIN_ALPHA = 0.24;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MAX_ALPHA = 0.78;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_SCALE = 0.9;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_ALPHA_GAIN = 0.65;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MAX_SPATIAL = 0.14;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MAX_CURRENT_SPATIAL = -0.2;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MAX_CURRENT_GRADIENT = -0.05;
const KNOWN_48_POWER_PROFILE_RESCUE_CANDIDATES = Object.freeze([
    { exponent: 1.08, alphaGain: 0.6, maxSpatial: 0.14 },
    { exponent: 0.88, alphaGain: 0.55, maxSpatial: 0.16 }
]);
const LARGE_MARGIN_48_PROFILE_ALPHA_RESCUE = Object.freeze({
    exponent: 0.9,
    alphaGain: 0.85
});
const LARGE_MARGIN_48_PROFILE_MIN_ORIGINAL_SPATIAL = 0.65;
const LARGE_MARGIN_48_PROFILE_MIN_ORIGINAL_GRADIENT = 0.4;
const LARGE_MARGIN_48_PROFILE_MAX_ABS_CURRENT_SPATIAL = 0.1;
const LARGE_MARGIN_48_PROFILE_MAX_CURRENT_GRADIENT = 0.1;
const LARGE_MARGIN_48_PROFILE_MIN_CURRENT_POSITIVE_HALO = 12;
const LARGE_MARGIN_48_PROFILE_MIN_CURRENT_CLIPPED_RATIO = 0.05;
const LARGE_MARGIN_48_PROFILE_MAX_CURRENT_CLIPPED_RATIO = 0.11;
const LARGE_MARGIN_48_PROFILE_MAX_CURRENT_ARTIFACT = 0.13;
const LARGE_MARGIN_48_PROFILE_MAX_SPATIAL = 0.12;
const LARGE_MARGIN_48_PROFILE_MAX_GRADIENT = 0.1;
const LARGE_MARGIN_48_PROFILE_MAX_POSITIVE_HALO = 4;
const LARGE_MARGIN_48_PROFILE_MAX_CLIPPED_RATIO = 0.02;
const LARGE_MARGIN_48_PROFILE_MAX_ARTIFACT = 0.12;
const KNOWN_48_POWER_PROFILE_RESCUE_MIN_ORIGINAL_SPATIAL = 0.9;
const KNOWN_48_POWER_PROFILE_RESCUE_MIN_ORIGINAL_GRADIENT = 0.8;
const KNOWN_48_POWER_PROFILE_RESCUE_MIN_CURRENT_SPATIAL = 0.3;
const KNOWN_48_POWER_PROFILE_RESCUE_MAX_CURRENT_GRADIENT = 0.14;
const KNOWN_48_RESIDUAL_REBALANCE_GAINS = Object.freeze([0.62, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1.05]);
const KNOWN_48_RESIDUAL_REBALANCE_POWER_PROFILES = Object.freeze([
    { exponent: 1.08, gains: [0.65] },
    { exponent: 1.2, gains: [0.7] },
    { exponent: 0.75, gains: [0.51] }
]);
const KNOWN_48_RESIDUAL_REBALANCE_MIN_ORIGINAL_SPATIAL = 0.45;
const KNOWN_48_RESIDUAL_REBALANCE_MIN_ORIGINAL_GRADIENT = 0.16;
const KNOWN_48_RESIDUAL_REBALANCE_MIN_CURRENT_SPATIAL = 0.22;
const KNOWN_48_RESIDUAL_REBALANCE_MAX_CURRENT_GRADIENT = 0.05;
const KNOWN_48_RESIDUAL_REBALANCE_MAX_ACCEPTED_SPATIAL = 0.22;
const KNOWN_48_RESIDUAL_REBALANCE_MAX_ACCEPTED_GRADIENT = 0.32;
const KNOWN_48_RESIDUAL_REBALANCE_MAX_VISUAL_ARTIFACT = 0.34;
const KNOWN_48_RESIDUAL_REBALANCE_MAX_DARK_HALO = 0.2;
const KNOWN_48_RESIDUAL_REBALANCE_MAX_CLIPPED_RATIO = 0.01;
const KNOWN_48_RESIDUAL_REBALANCE_MIN_POSITIVE_HALO_DROP = 0.5;
const KNOWN_48_RESIDUAL_REBALANCE_MAX_CLEARED_POSITIVE_HALO = 1.5;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_ORIGINAL_SPATIAL = 0.75;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_ORIGINAL_GRADIENT = 0.55;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_CURRENT_SPATIAL = 0.14;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_CURRENT_SPATIAL = 0.24;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_CURRENT_GRADIENT = 0.04;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_CURRENT_GRADIENT = 0.14;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_NEAR_BLACK_RATIO = 0.35;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_BALANCED_GAIN = 0.03;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_ARTIFACT_DELTA = 0.02;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_ARTIFACT = 0.16;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_SPATIAL = 0.13;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_GRADIENT = 0.13;
const KNOWN_48_BOUNDARY_REPAIR_RESCUE_PRESET = Object.freeze({
    radius: 18,
    minAlpha: 0.04,
    maxAlpha: 0.75,
    strength: 0.68,
    gamma: 0.62
});
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_PRESETS = Object.freeze([
    { radius: 72, minAlpha: 0.004, maxAlpha: 0.7, strength: 1.3, gamma: 0.45 },
    { radius: 72, minAlpha: 0.02, maxAlpha: 0.7, strength: 1, gamma: 0.45 },
    { radius: 56, minAlpha: 0.004, maxAlpha: 0.7, strength: 1.3, gamma: 0.45 }
]);
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MIN_ORIGINAL_SPATIAL = 0.9;
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MIN_ORIGINAL_GRADIENT = 0.9;
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MIN_CURRENT_SPATIAL = 0.22;
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_CURRENT_GRADIENT = 0.12;
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MIN_SPATIAL_IMPROVEMENT = 0.07;
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_SPATIAL = 0.16;
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_GRADIENT = 0.24;
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_ARTIFACT = 0.26;
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_CLIPPED = 0.005;
const KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_DARK_HALO = 0.2;
const SMALL_LOCATED_PRIOR_REPAIR_PRESETS = Object.freeze([
    { radius: 16, minAlpha: 0.02, maxAlpha: 0.99, strength: 1, gamma: 0.45 },
    { radius: 72, minAlpha: 0.004, maxAlpha: 0.7, strength: 1.3, gamma: 0.45 },
    { radius: 72, minAlpha: 0.02, maxAlpha: 0.7, strength: 1, gamma: 0.45 },
    { radius: 8, minAlpha: 0.02, maxAlpha: 0.99, strength: 1, gamma: 0.45 }
]);
const SMALL_LOCATED_PRIOR_REPAIR_MIN_SIZE = 36;
const SMALL_LOCATED_PRIOR_REPAIR_MAX_SIZE = 56;
const SMALL_LOCATED_PRIOR_REPAIR_MIN_ORIGINAL_SPATIAL = 0.42;
const SMALL_LOCATED_PRIOR_REPAIR_MIN_ORIGINAL_GRADIENT = 0.16;
const SMALL_LOCATED_PRIOR_REPAIR_MIN_CURRENT_SPATIAL = 0.23;
const SMALL_LOCATED_PRIOR_REPAIR_MAX_CURRENT_GRADIENT = 0.2;
const SMALL_LOCATED_PRIOR_REPAIR_MIN_SPATIAL_IMPROVEMENT = 0.08;
const SMALL_LOCATED_PRIOR_REPAIR_MAX_SPATIAL = 0.16;
const SMALL_LOCATED_PRIOR_REPAIR_MAX_GRADIENT = 0.24;
const SMALL_LOCATED_PRIOR_REPAIR_MAX_ARTIFACT = 0.28;
const SMALL_LOCATED_PRIOR_REPAIR_MAX_CLIPPED = 0.005;
const SMALL_LOCATED_PRIOR_REPAIR_MAX_DARK_HALO = 3;
// The extra 3px models the observed projected/JPEG edge footprint around a
// validated 36px candidate. It is a repair support expansion, not a catalog size.
const PROJECTED_SMALL_DARK_SUPPORT_SIZE = 36;
const PROJECTED_SMALL_DARK_SUPPORT_MIN_MARGIN = 64;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_MARGIN = 80;
const PROJECTED_SMALL_DARK_SUPPORT_EXPANSION = 3;
const PROJECTED_SMALL_DARK_SUPPORT_PRIOR_RADII = Object.freeze([2, 4, 8]);
const PROJECTED_SMALL_DARK_SUPPORT_PRESET = Object.freeze({
    minAlpha: 0.002,
    maxAlpha: 0.99,
    strength: 1.3,
    gamma: 0.35
});
const PROJECTED_SMALL_DARK_SUPPORT_MIN_ORIGINAL_SPATIAL = 0.95;
const PROJECTED_SMALL_DARK_SUPPORT_MIN_ORIGINAL_GRADIENT = 0.8;
const PROJECTED_SMALL_DARK_SUPPORT_MIN_ORIGINAL_NEAR_BLACK = 0.5;
const PROJECTED_SMALL_DARK_SUPPORT_MIN_CURRENT_SPATIAL = 0.35;
const PROJECTED_SMALL_DARK_SUPPORT_MIN_CURRENT_GRADIENT = 0.35;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_CURRENT_GRADIENT = 0.5;
const PROJECTED_SMALL_DARK_SUPPORT_MIN_POSITIVE_HALO = 12;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_ABS_SPATIAL = 0.18;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_GRADIENT = 0.18;
const PROJECTED_SMALL_DARK_SUPPORT_MIN_ABS_SPATIAL_IMPROVEMENT = 0.2;
const PROJECTED_SMALL_DARK_SUPPORT_MIN_GRADIENT_IMPROVEMENT = 0.2;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_ARTIFACT = 0.42;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_CLIPPED = 0.005;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_POSITIVE_HALO = 1;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_PRIOR_MEAN_LUMINANCE = 4;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_CANDIDATE_MEAN_LUMINANCE = 4;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_PRIOR_MEAN_DELTA = 0.5;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_PRIOR_MAE = 1;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_PRIOR_WEIGHTED_MAE = 0.5;
const PROJECTED_SMALL_DARK_SUPPORT_MAX_BOUNDARY_SCORE = 0.35;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_SIZE = 46;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MARGIN = 97;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MIN_ALPHA = 0.12;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_ALPHA = 0.42;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_SCALE = 1.24;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_ALPHA_GAIN = 0.45;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MIN_ORIGINAL_SPATIAL = 0.12;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MIN_ORIGINAL_GRADIENT = 0.4;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_SPATIAL = 0.14;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_VISUAL_ARTIFACT = 0.22;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_CURRENT_SPATIAL = -0.18;
const KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_CURRENT_GRADIENT = 0.05;
const QUANTIZED_BODY_CORRECTION_SIZE = 48;
const QUANTIZED_BODY_CORRECTION_MARGIN = 96;
const QUANTIZED_BODY_CORRECTION_MAX_CURRENT_SPATIAL = -0.16;
const QUANTIZED_BODY_CORRECTION_MAX_CURRENT_GRADIENT = 0.08;
const QUANTIZED_BODY_CORRECTION_LOW_ALPHA_MAX = 0.04;
const QUANTIZED_BODY_CORRECTION_LOW_ABS_MAX = 4;
const QUANTIZED_BODY_CORRECTION_BODY_MIN_ALPHA = 0.12;
const QUANTIZED_BODY_CORRECTION_BODY_MEAN_MAX = -0.5;
const QUANTIZED_BODY_CORRECTION_BODY_NEGATIVE_RATIO_MIN = 0.2;
const QUANTIZED_BODY_CORRECTION_RESIDUAL_THRESHOLD = -0.5;
const QUANTIZED_BODY_CORRECTION_PRIOR_RADIUS = 6;
const QUANTIZED_BODY_CORRECTION_MIN_BALANCED_GAIN = 0.03;
const QUANTIZED_BODY_CORRECTION_MAX_ARTIFACT_INCREASE = 0.05;
const DARK_HALO_RESCUE_MIN_DARK_HALO_LUM = 10;
const DARK_HALO_RESCUE_MAX_CURRENT_SPATIAL = -0.16;
const DARK_HALO_RESCUE_MAX_ABS_CURRENT_GRADIENT = 0.08;
const DARK_HALO_RESCUE_MAX_DARK_HALO_LUM = 4;
const DARK_HALO_RESCUE_MAX_VISUAL_ARTIFACT = 0.22;
const DARK_HALO_RESCUE_MAX_NEWLY_CLIPPED_RATIO = 0.04;
const DARK_HALO_RESCUE_MIN_BALANCED_GAIN = 0.04;
const DARK_HALO_RESCUE_GAINS = Object.freeze([0.25, 0.35, 0.45]);
const DARK_HALO_RESCUE_LOGO_VALUES = Object.freeze([224, 232, 240]);
const DARK_HALO_RESCUE_CONFIGS = Object.freeze([
    { logoSize: 48, marginRight: 96, marginBottom: 98 },
    { logoSize: 48, marginRight: 96, marginBottom: 97 },
    { logoSize: 48, marginRight: 96, marginBottom: 96 },
    { logoSize: 46, marginRight: 97, marginBottom: 97 },
    { logoSize: 46, marginRight: 97, marginBottom: 96 },
    { logoSize: 46, marginRight: 96, marginBottom: 97 },
    { logoSize: 47, marginRight: 96, marginBottom: 96 },
    { logoSize: 47, marginRight: 97, marginBottom: 96 }
]);

function nowMs() {
    if (typeof globalThis.performance?.now === 'function') {
        return globalThis.performance.now();
    }
    return Date.now();
}

function cloneImageData(imageData) {
    if (typeof ImageData !== 'undefined' && imageData instanceof ImageData) {
        return new ImageData(
            new Uint8ClampedArray(imageData.data),
            imageData.width,
            imageData.height
        );
    }

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

function refineSubpixelOutline({
    sourceImageData,
    alphaMap,
    position,
    alphaGain,
    originalNearBlackRatio,
    baselineSpatialScore,
    baselineGradientScore,
    baselineShift,
    minGain = OUTLINE_REFINEMENT_MIN_GAIN,
    shiftCandidates = SUBPIXEL_REFINE_SHIFTS,
    scaleCandidates = SUBPIXEL_REFINE_SCALES,
    minGradientImprovement = 0.04,
    maxSpatialDrift = 0.08
}) {
    const size = position.width;
    if (!size || size <= 8) return null;
    if (alphaGain < minGain) return null;

    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    const gainCandidates = [alphaGain];
    const lower = Math.max(1, Number((alphaGain - 0.01).toFixed(2)));
    const upper = Number((alphaGain + 0.01).toFixed(2));
    if (lower !== alphaGain) gainCandidates.push(lower);
    if (upper !== alphaGain) gainCandidates.push(upper);

    const baseDx = baselineShift?.dx ?? 0;
    const baseDy = baselineShift?.dy ?? 0;
    const baseScale = baselineShift?.scale ?? 1;

    let best = null;
    for (const scaleDelta of scaleCandidates) {
        const scale = Number((baseScale * scaleDelta).toFixed(4));
        for (const dyDelta of shiftCandidates) {
            const dy = baseDy + dyDelta;
            for (const dxDelta of shiftCandidates) {
                const dx = baseDx + dxDelta;
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                for (const gain of gainCandidates) {
                    const candidate = cloneImageData(sourceImageData);
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
                            shift: { dx, dy, scale },
                            spatialScore,
                            gradientScore,
                            nearBlackRatio,
                            cost
                        };
                    }
                }
            }
        }
    }

    if (!best) return null;

    const improvedGradient = best.gradientScore <= baselineGradientScore - minGradientImprovement;
    const keptSpatial = Math.abs(best.spatialScore) <= Math.abs(baselineSpatialScore) + maxSpatialDrift;
    if (!improvedGradient || !keptSpatial) return null;

    return best;
}

function recalibrateAlphaStrength({
    sourceImageData,
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
        const candidate = cloneImageData(sourceImageData);
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

function createLocalAlphaSearchInstrumentation({ debugEnabled = false } = {}) {
    return {
        debugEnabled,
        trialCount: 0,
        trialAllocatedPixels: 0,
        maxTrialBufferPixels: 0,
        trialFullImageCloneCount: 0,
        fullImageMaterializationCount: 0,
        darkSupportTrialCount: 0,
        darkSupportAcceptedTrialCount: 0,
        darkSupportBestProbe: null,
        acceptedTrials: []
    };
}

function createLocalAlphaSearchWindow(
    imageData,
    position,
    scratchPad = LOCAL_ALPHA_SEARCH_SCRATCH_PAD
) {
    const x = Math.max(0, position.x - scratchPad);
    const y = Math.max(0, position.y - scratchPad);
    const right = Math.min(
        imageData.width,
        position.x + position.width + scratchPad
    );
    const bottom = Math.min(
        imageData.height,
        position.y + position.height + scratchPad
    );
    return {
        x,
        y,
        width: right - x,
        height: bottom - y,
        position: {
            x: position.x - x,
            y: position.y - y,
            width: position.width,
            height: position.height
        }
    };
}

function extractLocalAlphaSearchScratch(imageData, window) {
    const scratch = {
        width: window.width,
        height: window.height,
        data: new Uint8ClampedArray(window.width * window.height * 4)
    };
    for (let row = 0; row < window.height; row++) {
        const sourceStart = ((window.y + row) * imageData.width + window.x) * 4;
        const sourceEnd = sourceStart + window.width * 4;
        scratch.data.set(
            imageData.data.subarray(sourceStart, sourceEnd),
            row * window.width * 4
        );
    }
    return scratch;
}

function createLocalAlphaSearchContext(
    originalImageData,
    position,
    scratchPad = LOCAL_ALPHA_SEARCH_SCRATCH_PAD
) {
    const window = createLocalAlphaSearchWindow(
        originalImageData,
        position,
        scratchPad
    );
    return {
        window,
        position: window.position,
        originalScratch: extractLocalAlphaSearchScratch(originalImageData, window)
    };
}

function cloneLocalAlphaTrialScratch({
    originalScratch,
    originalImageData,
    instrumentation
}) {
    const scratch = cloneImageData(originalScratch);
    if (instrumentation?.debugEnabled === true) {
        const pixels = scratch.width * scratch.height;
        instrumentation.trialCount++;
        instrumentation.trialAllocatedPixels += pixels;
        instrumentation.maxTrialBufferPixels = Math.max(
            instrumentation.maxTrialBufferPixels,
            pixels
        );
        if (pixels >= originalImageData.width * originalImageData.height) {
            instrumentation.trialFullImageCloneCount++;
        }
    }
    return scratch;
}

function evaluateLocalAlphaGainCandidate({
    originalImageData,
    candidateImageData = null,
    alphaMap,
    position,
    alphaGain,
    originalSpatialScore,
    originalNearBlackRatio,
    searchContext = createLocalAlphaSearchContext(originalImageData, position),
    instrumentation = null
}) {
    const scratchPosition = searchContext.position;
    const scratchImageData = candidateImageData
        ? extractLocalAlphaSearchScratch(candidateImageData, searchContext.window)
        : cloneLocalAlphaTrialScratch({
            originalScratch: searchContext.originalScratch,
            originalImageData,
            instrumentation
        });
    if (!candidateImageData) {
        removeWatermark(scratchImageData, alphaMap, scratchPosition, { alphaGain });
    }

    const spatialScore = computeRegionSpatialCorrelation({
        imageData: scratchImageData,
        alphaMap,
        region: {
            x: scratchPosition.x,
            y: scratchPosition.y,
            size: scratchPosition.width
        }
    });
    const gradientScore = computeRegionGradientCorrelation({
        imageData: scratchImageData,
        alphaMap,
        region: {
            x: scratchPosition.x,
            y: scratchPosition.y,
            size: scratchPosition.width
        }
    });
    const nearBlackRatio = calculateNearBlackRatio(scratchImageData, scratchPosition);
    const nearBlackIncrease = nearBlackRatio - originalNearBlackRatio;
    const texture = assessReferenceTextureAlignmentFromStats({
        originalImageData,
        referenceImageData: originalImageData,
        candidateTextureStats: getRegionTextureStats(
            scratchImageData,
            scratchPosition
        ),
        position
    });
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData: searchContext.originalScratch,
        candidateImageData: scratchImageData,
        alphaMap,
        position: scratchPosition,
        alphaGain
    });
    const damage = scoreDamage({
        hardReject: texture?.hardReject === true,
        nearBlackIncrease,
        texturePenalty: texture?.texturePenalty ?? 0,
        newlyClippedRatio: artifacts?.newlyClippedRatio ?? 0,
        halo: artifacts?.halo ?? null
    });
    const suppressionGain = originalSpatialScore - spatialScore;
    const residual = scoreResidual({
        processedSpatial: spatialScore,
        processedGradient: gradientScore,
        suppressionGain,
        artifactCost: artifacts?.visualArtifactCost ?? 0
    });
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData: scratchImageData,
        position: scratchPosition,
        alphaMap
    });
    const cost = residual.score + damage.penalty * LOCAL_ALPHA_SEARCH_DAMAGE_WEIGHT;

    return {
        scratchImageData,
        alphaMap,
        position,
        alphaGain,
        spatialScore,
        gradientScore,
        nearBlackRatio,
        nearBlackIncrease,
        suppressionGain,
        texture,
        artifacts,
        damage,
        residual,
        residualVisibility,
        cost
    };
}

function measureDarkSupportClipping({
    originalImageData,
    candidateImageData,
    alphaMap,
    position
}) {
    let newlyClippedCount = 0;
    let outsideAlphaSupportCount = 0;
    let strongAlphaSupportCount = 0;
    const total = position.width * position.height;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const pixelIndex = (
                (position.y + row) * originalImageData.width +
                position.x +
                col
            ) * 4;
            const newlyClipped = [0, 1, 2].some((channel) => (
                candidateImageData.data[pixelIndex + channel] === 0 &&
                originalImageData.data[pixelIndex + channel] > 5
            ));
            if (!newlyClipped) continue;

            newlyClippedCount++;
            const alpha = Math.abs(alphaMap[localIndex]);
            if (alpha < DARK_SUPPORT_ALPHA_MIN) {
                outsideAlphaSupportCount++;
            }
            if (alpha >= DARK_SUPPORT_ALPHA_STRONG_MIN) {
                strongAlphaSupportCount++;
            }
        }
    }

    return {
        newlyClippedRatio: newlyClippedCount / Math.max(1, total),
        outsideAlphaSupportRatio: newlyClippedCount > 0
            ? outsideAlphaSupportCount / newlyClippedCount
            : 0,
        strongAlphaSupportRatio: newlyClippedCount > 0
            ? strongAlphaSupportCount / newlyClippedCount
            : 1
    };
}

function measureDarkSupportPriorConvergence({
    candidateImageData,
    priorImageData,
    alphaMap,
    position
}) {
    let absoluteDelta = 0;
    let weightedAbsoluteDelta = 0;
    let alphaWeight = 0;
    let candidateLuminance = 0;
    let priorLuminance = 0;
    let channelCount = 0;
    let pixelCount = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = Math.abs(alphaMap[localIndex]);
            const pixelIndex = (
                (position.y + row) * candidateImageData.width +
                position.x +
                col
            ) * 4;
            const candidateR = candidateImageData.data[pixelIndex];
            const candidateG = candidateImageData.data[pixelIndex + 1];
            const candidateB = candidateImageData.data[pixelIndex + 2];
            const priorR = priorImageData.data[pixelIndex];
            const priorG = priorImageData.data[pixelIndex + 1];
            const priorB = priorImageData.data[pixelIndex + 2];

            for (let channel = 0; channel < 3; channel++) {
                const delta = Math.abs(
                    candidateImageData.data[pixelIndex + channel] -
                    priorImageData.data[pixelIndex + channel]
                );
                absoluteDelta += delta;
                weightedAbsoluteDelta += delta * alpha;
                channelCount++;
            }
            alphaWeight += alpha;
            candidateLuminance += (
                0.2126 * candidateR +
                0.7152 * candidateG +
                0.0722 * candidateB
            );
            priorLuminance += (
                0.2126 * priorR +
                0.7152 * priorG +
                0.0722 * priorB
            );
            pixelCount++;
        }
    }

    const candidateMeanLuminance =
        candidateLuminance / Math.max(1, pixelCount);
    const priorMeanLuminance = priorLuminance / Math.max(1, pixelCount);
    return {
        meanAbsoluteDelta: absoluteDelta / Math.max(1, channelCount),
        weightedMeanAbsoluteDelta:
            weightedAbsoluteDelta / Math.max(1e-8, alphaWeight * 3),
        candidateMeanLuminance,
        priorMeanLuminance,
        meanLuminanceDelta: Math.abs(
            candidateMeanLuminance -
            priorMeanLuminance
        )
    };
}

function createDarkSupportSearchContext(originalImageData, position) {
    const searchContext = createLocalAlphaSearchContext(
        originalImageData,
        position,
        DARK_SUPPORT_SEARCH_SCRATCH_PAD
    );
    const priors = DARK_SUPPORT_PRIOR_RADII.map((radius) => ({
        radius,
        imageData: buildPreviewNeighborhoodPrior({
            previewImageData: searchContext.originalScratch,
            position: searchContext.position,
            radius,
            relaxationPasses: DARK_SUPPORT_PRIOR_RELAXATION_PASSES
        })
    }));
    return {
        ...searchContext,
        priors
    };
}

function assessDarkBackgroundSupportConvergence({
    candidate,
    searchContext
}) {
    const priorMetrics = searchContext.priors.map(({ radius, imageData }) => ({
        radius,
        ...measureDarkSupportPriorConvergence({
            candidateImageData: candidate.scratchImageData,
            priorImageData: imageData,
            alphaMap: candidate.alphaMap,
            position: searchContext.position
        })
    }));
    const clipping = measureDarkSupportClipping({
        originalImageData: searchContext.originalScratch,
        candidateImageData: candidate.scratchImageData,
        alphaMap: candidate.alphaMap,
        position: searchContext.position
    });
    const boundary = measurePreviewBoundaryMetrics(
        candidate.scratchImageData,
        searchContext.originalScratch,
        searchContext.position
    );
    const maximumPriorMeanLuminance = Math.max(
        ...priorMetrics.map((item) => item.priorMeanLuminance)
    );
    const maximumCandidateMeanLuminance = Math.max(
        ...priorMetrics.map((item) => item.candidateMeanLuminance)
    );
    const maximumPriorMeanDelta = Math.max(
        ...priorMetrics.map((item) => item.meanLuminanceDelta)
    );
    const maximumPriorMae = Math.max(
        ...priorMetrics.map((item) => item.meanAbsoluteDelta)
    );
    const maximumPriorWeightedMae = Math.max(
        ...priorMetrics.map((item) => item.weightedMeanAbsoluteDelta)
    );
    const accepted = Boolean(
        candidate.residualVisibility?.visible === false &&
        Math.abs(candidate.spatialScore) <= DARK_SUPPORT_MAX_ABS_SPATIAL &&
        candidate.gradientScore <= DARK_SUPPORT_MAX_GRADIENT &&
        candidate.texture?.hardReject !== true &&
        Number(candidate.texture?.texturePenalty ?? Infinity) <=
            DARK_SUPPORT_MAX_TEXTURE_PENALTY &&
        Number(candidate.artifacts?.newlyClippedRatio ?? Infinity) <=
            DARK_SUPPORT_MAX_NEWLY_CLIPPED_RATIO &&
        Number(candidate.artifacts?.oppositeDirectionHaloLum ?? Infinity) <=
            DARK_SUPPORT_MAX_OPPOSITE_HALO_LUMINANCE &&
        clipping.outsideAlphaSupportRatio <=
            DARK_SUPPORT_MAX_OUTSIDE_ALPHA_CLIP_RATIO &&
        clipping.strongAlphaSupportRatio >=
            DARK_SUPPORT_MIN_STRONG_ALPHA_CLIP_RATIO &&
        maximumPriorMeanLuminance <=
            DARK_SUPPORT_MAX_PRIOR_MEAN_LUMINANCE &&
        maximumCandidateMeanLuminance <=
            DARK_SUPPORT_MAX_CANDIDATE_MEAN_LUMINANCE &&
        maximumPriorMeanDelta <= DARK_SUPPORT_MAX_PRIOR_MEAN_DELTA &&
        maximumPriorMae <= DARK_SUPPORT_MAX_PRIOR_MAE &&
        maximumPriorWeightedMae <= DARK_SUPPORT_MAX_PRIOR_WEIGHTED_MAE &&
        boundary.normalizedScore <= DARK_SUPPORT_MAX_BOUNDARY_SCORE
    );

    return {
        accepted,
        priorRadii: [...DARK_SUPPORT_PRIOR_RADII],
        maximumPriorMeanLuminance,
        maximumCandidateMeanLuminance,
        maximumPriorMeanDelta,
        maximumPriorMae,
        maximumPriorWeightedMae,
        boundaryScore: boundary.normalizedScore,
        clipping
    };
}

function materializeLocalAlphaGainCandidate({
    candidate,
    originalImageData,
    instrumentation
}) {
    const imageData = cloneImageData(originalImageData);
    if (instrumentation?.debugEnabled === true) {
        instrumentation.fullImageMaterializationCount++;
    }
    removeWatermark(imageData, candidate.alphaMap, candidate.position, {
        alphaGain: candidate.alphaGain
    });
    const { scratchImageData, ...rest } = candidate;
    return {
        ...rest,
        imageData
    };
}

function isEligibleLocalAlphaGainCandidate(candidate) {
    const standardEligible = Boolean(
        candidate &&
        candidate.residualVisibility?.visible === false &&
        Math.abs(candidate.spatialScore) <= LOCAL_ALPHA_SEARCH_MAX_ABS_SPATIAL &&
        candidate.gradientScore <= LOCAL_ALPHA_SEARCH_MAX_GRADIENT &&
        (candidate.artifacts?.newlyClippedRatio ?? 0) <=
            LOCAL_ALPHA_SEARCH_MAX_NEWLY_CLIPPED_RATIO
    );
    return standardEligible ||
        candidate?.darkBackgroundSupportConvergence?.accepted === true;
}

function pickBetterLocalAlphaGainCandidate(currentBest, candidate) {
    if (!isEligibleLocalAlphaGainCandidate(candidate)) return currentBest;
    if (!currentBest) return candidate;
    if (candidate.damage.safe !== currentBest.damage.safe) {
        return candidate.damage.safe ? candidate : currentBest;
    }
    if (candidate.cost < currentBest.cost - LOCAL_ALPHA_SEARCH_COST_TIE) {
        return candidate;
    }
    if (
        Math.abs(candidate.cost - currentBest.cost) <= LOCAL_ALPHA_SEARCH_COST_TIE &&
        candidate.alphaGain > currentBest.alphaGain
    ) {
        return candidate;
    }
    return currentBest;
}

function fineTuneEvidenceGatedLocalAlpha({
    originalImageData,
    currentImageData,
    alphaMap,
    position,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore,
    originalNearBlackRatio,
    instrumentation = null
}) {
    if (
        position?.width !== 48 ||
        position?.height !== 48 ||
        originalSpatialScore < LOCAL_ALPHA_SEARCH_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < LOCAL_ALPHA_SEARCH_MIN_ORIGINAL_GRADIENT ||
        !Number.isFinite(currentAlphaGain) ||
        currentAlphaGain <= 0
    ) {
        return null;
    }

    const searchContext = createLocalAlphaSearchContext(originalImageData, position);
    if (
        currentAlphaGain < 1 &&
        assessWatermarkResidualVisibility({
            imageData: currentImageData,
            position,
            alphaMap
        })?.visible !== true
    ) {
        return null;
    }

    const current = evaluateLocalAlphaGainCandidate({
        originalImageData,
        candidateImageData: currentImageData,
        alphaMap,
        position,
        alphaGain: currentAlphaGain,
        originalSpatialScore,
        originalNearBlackRatio,
        searchContext
    });
    const damageTriggered = currentAlphaGain === 1 && current.damage.safe === false;
    const overshootTriggered =
        currentAlphaGain < 1 &&
        current.residualVisibility?.visible === true &&
        currentSpatialScore <= OVER_SUBTRACTION_SPATIAL_THRESHOLD;
    if (!damageTriggered && !overshootTriggered) return null;

    let best = null;
    let trigger = null;

    if (damageTriggered) {
        let lowerBracket = null;
        const coarseStepCount = Math.round(
            LOCAL_ALPHA_SEARCH_DAMAGE_MAX_DROP / LOCAL_ALPHA_SEARCH_DAMAGE_COARSE_STEP
        );
        for (let step = 1; step <= coarseStepCount; step++) {
            const alphaGain = Number((
                currentAlphaGain - step * LOCAL_ALPHA_SEARCH_DAMAGE_COARSE_STEP
            ).toFixed(3));
            if (alphaGain <= 0) break;
            const candidate = evaluateLocalAlphaGainCandidate({
                originalImageData,
                alphaMap,
                position,
                alphaGain,
                originalSpatialScore,
                originalNearBlackRatio,
                searchContext,
                instrumentation
            });
            if (
                candidate.damage.safe === true &&
                (candidate.artifacts?.newlyClippedRatio ?? 0) <=
                    LOCAL_ALPHA_SEARCH_MAX_NEWLY_CLIPPED_RATIO
            ) {
                lowerBracket = candidate;
                break;
            }
        }
        if (!lowerBracket) {
            if (
                originalSpatialScore <
                    DARK_SUPPORT_SEARCH_MIN_ORIGINAL_SPATIAL ||
                originalGradientScore <
                    DARK_SUPPORT_SEARCH_MIN_ORIGINAL_GRADIENT ||
                originalNearBlackRatio <
                    DARK_SUPPORT_SEARCH_MIN_ORIGINAL_NEAR_BLACK
            ) {
                return null;
            }

            const darkSupportSearchContext = createDarkSupportSearchContext(
                originalImageData,
                position
            );
            const stepCount = Math.round(
                (
                    DARK_SUPPORT_SEARCH_MAX_GAIN -
                    DARK_SUPPORT_SEARCH_MIN_GAIN
                ) /
                DARK_SUPPORT_SEARCH_GAIN_STEP
            );
            for (let step = 0; step <= stepCount; step++) {
                const alphaGain = Number((
                    DARK_SUPPORT_SEARCH_MIN_GAIN +
                    step * DARK_SUPPORT_SEARCH_GAIN_STEP
                ).toFixed(3));
                const candidate = evaluateLocalAlphaGainCandidate({
                    originalImageData,
                    alphaMap,
                    position,
                    alphaGain,
                    originalSpatialScore,
                    originalNearBlackRatio,
                    searchContext: darkSupportSearchContext,
                    instrumentation
                });
                candidate.darkBackgroundSupportConvergence =
                    assessDarkBackgroundSupportConvergence({
                        candidate,
                        searchContext: darkSupportSearchContext
                    });
                if (instrumentation?.debugEnabled === true) {
                    instrumentation.darkSupportTrialCount++;
                    if (
                        candidate.darkBackgroundSupportConvergence.accepted ===
                        true
                    ) {
                        instrumentation.darkSupportAcceptedTrialCount++;
                        if (
                            !instrumentation.darkSupportBestProbe ||
                            candidate.cost <
                                instrumentation.darkSupportBestProbe.cost
                        ) {
                            instrumentation.darkSupportBestProbe = {
                                alphaGain,
                                spatialScore: candidate.spatialScore,
                                gradientScore: candidate.gradientScore,
                                cost: candidate.cost,
                                damageSafe: candidate.damage.safe === true,
                                convergence:
                                    candidate.darkBackgroundSupportConvergence
                            };
                        }
                    }
                }
                if (
                    candidate.darkBackgroundSupportConvergence.accepted !== true
                ) {
                    continue;
                }
                best = pickBetterLocalAlphaGainCandidate(best, candidate);
            }
            if (!best) return null;
            trigger = 'dark-background-support';
        } else {
            const fineStepCount = Math.floor(
                (currentAlphaGain - lowerBracket.alphaGain) /
                LOCAL_ALPHA_SEARCH_FINE_STEP
            );
            for (let step = 0; step <= fineStepCount; step++) {
                const alphaGain = Number((
                    lowerBracket.alphaGain + step * LOCAL_ALPHA_SEARCH_FINE_STEP
                ).toFixed(3));
                if (alphaGain >= currentAlphaGain) continue;
                const candidate = step === 0
                    ? lowerBracket
                    : evaluateLocalAlphaGainCandidate({
                        originalImageData,
                        alphaMap,
                        position,
                        alphaGain,
                        originalSpatialScore,
                        originalNearBlackRatio,
                        searchContext,
                        instrumentation
                    });
                best = pickBetterLocalAlphaGainCandidate(best, candidate);
            }
            trigger = 'damage';
        }
    } else {
        const stepCount = Math.round(
            LOCAL_ALPHA_SEARCH_OVERSHOOT_WINDOW / LOCAL_ALPHA_SEARCH_OVERSHOOT_STEP
        );
        for (let step = stepCount; step >= 1; step--) {
            const alphaGain = Number((
                currentAlphaGain - step * LOCAL_ALPHA_SEARCH_OVERSHOOT_STEP
            ).toFixed(3));
            if (alphaGain <= 0) continue;
            const candidate = evaluateLocalAlphaGainCandidate({
                originalImageData,
                alphaMap,
                position,
                alphaGain,
                originalSpatialScore,
                originalNearBlackRatio,
                searchContext,
                instrumentation
            });
            best = pickBetterLocalAlphaGainCandidate(best, candidate);
        }
        trigger = 'overshoot';
    }

    const darkSupportImproved = Boolean(
        trigger === 'dark-background-support' &&
        best?.darkBackgroundSupportConvergence?.accepted === true &&
        Math.abs(current.spatialScore) - Math.abs(best.spatialScore) >=
            DARK_SUPPORT_MIN_ABS_SPATIAL_IMPROVEMENT &&
        current.gradientScore - best.gradientScore >=
            DARK_SUPPORT_MIN_GRADIENT_IMPROVEMENT
    );
    if (
        !best ||
        (
            !darkSupportImproved &&
            best.cost > current.cost - LOCAL_ALPHA_SEARCH_MIN_COST_IMPROVEMENT
        )
    ) {
        return null;
    }

    const materialized = materializeLocalAlphaGainCandidate({
        candidate: best,
        originalImageData,
        instrumentation
    });
    instrumentation?.acceptedTrials.push({
        trigger,
        damageSafe: best.damage.safe === true,
        darkBackgroundSupportConvergence:
            best.darkBackgroundSupportConvergence ?? null,
        alphaMap: best.alphaMap,
        position: best.position,
        alphaGain: best.alphaGain,
        spatialScore: best.spatialScore,
        gradientScore: best.gradientScore
    });

    return {
        ...materialized,
        localSearchTrigger: trigger,
        beforeDamage: current.damage,
        beforeResidual: current.residual
    };
}

function recalibrateOverSubtractedAlpha({
    originalImageData,
    alphaMap,
    position,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalNearBlackRatio
}) {
    if (
        currentSpatialScore > OVER_SUBTRACTION_SPATIAL_THRESHOLD ||
        currentGradientScore < OVER_SUBTRACTION_GRADIENT_THRESHOLD
    ) {
        return null;
    }

    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    let best = null;

    const evaluateAlphaGain = (alphaGain) => {
        const candidate = cloneImageData(originalImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const nearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (nearBlackRatio > maxAllowedNearBlackRatio) return null;

        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const artifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData: candidate,
            alphaMap,
            position,
            alphaGain
        });
        const absSpatialImprovement = Math.abs(currentSpatialScore) - Math.abs(spatialScore);
        const gradientImprovement = currentGradientScore - gradientScore;
        if (
            absSpatialImprovement < OVER_SUBTRACTION_MIN_ABS_SPATIAL_IMPROVEMENT ||
            gradientImprovement < OVER_SUBTRACTION_MIN_GRADIENT_IMPROVEMENT
        ) {
            return null;
        }

        const cost = artifacts?.visualArtifactCost ?? (
            Math.abs(spatialScore) + Math.max(0, gradientScore) * 0.8 + nearBlackRatio * 2
        );
        return {
            imageData: candidate,
            alphaGain,
            spatialScore,
            gradientScore,
            nearBlackRatio,
            suppressionGain: originalSpatialScore - spatialScore,
            cost
        };
    };

    for (const alphaGain of ALPHA_GAIN_CANDIDATES) {
        if (alphaGain >= currentAlphaGain) continue;

        const candidate = evaluateAlphaGain(alphaGain);
        if (!candidate) continue;

        if (!best || candidate.cost < best.cost) {
            best = candidate;
        }
    }

    if (!best) return null;

    const fineGains = new Set();
    const fineStepCount = Math.round(OVER_SUBTRACTION_FINE_ALPHA_WINDOW / OVER_SUBTRACTION_FINE_ALPHA_STEP);
    for (let step = -fineStepCount; step <= fineStepCount; step++) {
        const alphaGain = Number((best.alphaGain + step * OVER_SUBTRACTION_FINE_ALPHA_STEP).toFixed(2));
        if (alphaGain <= 0 || alphaGain >= currentAlphaGain) continue;
        fineGains.add(alphaGain);
    }

    for (const alphaGain of fineGains) {
        if (alphaGain === best.alphaGain) continue;

        const candidate = evaluateAlphaGain(alphaGain);
        if (!candidate) continue;

        if (candidate.cost < best.cost) {
            best = candidate;
        }
    }

    return best;
}

function fineTuneWeakPositiveResidualAlpha({
    originalImageData,
    currentImageData,
    alphaMap,
    position,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore,
    originalNearBlackRatio
}) {
    if (
        currentAlphaGain >= 1 ||
        originalSpatialScore < WEAK_ALPHA_FINE_TUNE_MIN_ORIGINAL_SPATIAL ||
        currentSpatialScore < WEAK_ALPHA_FINE_TUNE_MIN_POSITIVE_RESIDUAL
    ) {
        return null;
    }
    const currentResidualVisibility = currentImageData
        ? assessWatermarkResidualVisibility({
            imageData: currentImageData,
            position,
            alphaMap
        })
        : null;
    if (currentResidualVisibility?.visible === false) return null;

    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    let best = null;
    const fineStepCount = Math.round(OVER_SUBTRACTION_FINE_ALPHA_WINDOW / OVER_SUBTRACTION_FINE_ALPHA_STEP);
    const alphaGainCandidates = new Set();

    for (let step = 1; step <= fineStepCount; step++) {
        const alphaGain = Number((currentAlphaGain + step * OVER_SUBTRACTION_FINE_ALPHA_STEP).toFixed(2));
        if (alphaGain >= 1) continue;
        alphaGainCandidates.add(alphaGain);
    }

    const shouldTryStrongPositiveFineTune =
        currentSpatialScore >= STRONG_POSITIVE_FINE_TUNE_MIN_CURRENT_SPATIAL &&
        originalSpatialScore >= STRONG_POSITIVE_FINE_TUNE_MIN_ORIGINAL_SPATIAL &&
        originalGradientScore >= STRONG_POSITIVE_FINE_TUNE_MIN_ORIGINAL_GRADIENT;

    if (shouldTryStrongPositiveFineTune) {
        for (const alphaGain of [
            ...STRONG_POSITIVE_FINE_TUNE_MID_GAINS,
            ...STRONG_POSITIVE_FINE_TUNE_EXTRA_GAINS
        ]) {
            alphaGainCandidates.add(alphaGain);
        }
    }

    for (const alphaGain of alphaGainCandidates) {
        if (alphaGain <= currentAlphaGain || alphaGain > 1) continue;

        const candidate = cloneImageData(originalImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const nearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const artifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData: candidate,
            alphaMap,
            position,
            alphaGain
        });
        const absSpatialImprovement = Math.abs(currentSpatialScore) - Math.abs(spatialScore);
        const gradientIncrease = gradientScore - currentGradientScore;
        const strongPositiveClearsResidual = shouldTryStrongPositiveFineTune &&
            Math.abs(spatialScore) <= STRONG_POSITIVE_FINE_TUNE_MAX_ACCEPTED_SPATIAL &&
            gradientScore <= STRONG_POSITIVE_FINE_TUNE_MAX_ACCEPTED_GRADIENT &&
            (artifacts?.halo?.positiveDeltaLum ?? Number.POSITIVE_INFINITY) <= STRONG_POSITIVE_FINE_TUNE_MAX_POSITIVE_HALO_LUM;
        if (!strongPositiveClearsResidual && (
            absSpatialImprovement < WEAK_ALPHA_FINE_TUNE_MIN_ABS_SPATIAL_IMPROVEMENT ||
            gradientIncrease > WEAK_ALPHA_FINE_TUNE_MAX_GRADIENT_INCREASE
        )) {
            continue;
        }

        const cost = artifacts
            ? artifacts.visualArtifactCost + Math.max(0, gradientIncrease) * 0.25
            : Math.abs(spatialScore) + Math.max(0, gradientIncrease) * 0.25 + nearBlackRatio * 2;
        const clearsResidual = strongPositiveClearsResidual;
        if (!best || (clearsResidual && !best.clearsResidual) || (clearsResidual === best.clearsResidual && cost < best.cost)) {
            best = {
                imageData: candidate,
                alphaGain,
                spatialScore,
                gradientScore,
                nearBlackRatio,
                suppressionGain: originalSpatialScore - spatialScore,
                cost,
                clearsResidual
            };
        }
    }

    return best;
}

function fineTuneDarkCatalogAlpha({
    originalImageData,
    alphaMap,
    position,
    source,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore,
    originalNearBlackRatio
}) {
    if (
        typeof source !== 'string' ||
        !source.includes('catalog') ||
        currentAlphaGain < 1 ||
        originalSpatialScore < CATALOG_ALPHA_DARK_FINE_TUNE_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < CATALOG_ALPHA_DARK_FINE_TUNE_MIN_ORIGINAL_GRADIENT ||
        currentSpatialScore > CATALOG_ALPHA_DARK_FINE_TUNE_MAX_NEGATIVE_RESIDUAL
    ) {
        return null;
    }

    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    let best = null;

    for (const alphaGain of CATALOG_DARK_ALPHA_GAIN_CANDIDATES) {
        if (alphaGain >= currentAlphaGain) continue;

        const candidate = cloneImageData(originalImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const nearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const artifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData: candidate,
            alphaMap,
            position,
            alphaGain
        });
        const absSpatialImprovement = Math.abs(currentSpatialScore) - Math.abs(spatialScore);
        const gradientIncrease = gradientScore - currentGradientScore;
        if (
            absSpatialImprovement <= 0 ||
            gradientIncrease > CATALOG_ALPHA_DARK_FINE_TUNE_MAX_GRADIENT_INCREASE
        ) {
            continue;
        }

        const cost = artifacts?.visualArtifactCost ?? (
            Math.abs(spatialScore) * 0.25 +
            Math.max(0, gradientScore) +
            nearBlackRatio * 2
        );
        if (!best || cost < best.cost) {
            best = {
                imageData: candidate,
                alphaGain,
                spatialScore,
                gradientScore,
                nearBlackRatio,
                suppressionGain: originalSpatialScore - spatialScore,
                cost
            };
        }
    }

    return best;
}

function shouldRefineResidualEdge({
    source,
    position,
    baselineSpatialScore,
    baselineGradientScore,
    baselinePositiveHalo,
    mode = 'preview'
}) {
    if (mode === 'known-48') {
        return position?.width >= KNOWN_48_EDGE_CLEANUP_MIN_SIZE &&
            position?.width <= KNOWN_48_EDGE_CLEANUP_MAX_SIZE &&
            Math.abs(baselineSpatialScore) <= KNOWN_48_EDGE_CLEANUP_MAX_ABS_SPATIAL &&
            (
                baselineGradientScore >= KNOWN_48_EDGE_CLEANUP_MIN_GRADIENT ||
                baselinePositiveHalo >= PREVIEW_EDGE_CLEANUP_STRONG_HALO_THRESHOLD
            );
    }

    if (mode === 'v2-small') {
        return position?.width >= V2_SMALL_EDGE_CLEANUP_SIZE - V2_SMALL_EDGE_CLEANUP_SIZE_TOLERANCE &&
            position?.width <= V2_SMALL_EDGE_CLEANUP_SIZE + V2_SMALL_EDGE_CLEANUP_SIZE_TOLERANCE &&
            Math.abs(baselineSpatialScore) <= V2_SMALL_EDGE_CLEANUP_MAX_ABS_SPATIAL &&
            baselineGradientScore >= V2_SMALL_EDGE_CLEANUP_MIN_GRADIENT;
    }

    const isSmallPreviewAnchor = position?.width >= 24 &&
        position?.width <= SMALL_PREVIEW_EDGE_CLEANUP_MAX_SIZE;
    const gradientThreshold = isSmallPreviewAnchor
        ? SMALL_PREVIEW_EDGE_CLEANUP_GRADIENT_THRESHOLD
        : PREVIEW_EDGE_CLEANUP_GRADIENT_THRESHOLD;

    return typeof source === 'string' &&
        source.includes('preview-anchor') &&
        position?.width >= 24 &&
        position?.width <= PREVIEW_EDGE_CLEANUP_MAX_SIZE &&
        (
            Math.abs(baselineSpatialScore) <= PREVIEW_EDGE_CLEANUP_SPATIAL_THRESHOLD ||
            (
                baselinePositiveHalo >= PREVIEW_EDGE_CLEANUP_STRONG_HALO_THRESHOLD &&
                Math.abs(baselineSpatialScore) <= PREVIEW_EDGE_CLEANUP_HALO_SPATIAL_THRESHOLD
            )
        ) &&
        baselineGradientScore >= gradientThreshold;
}

function blendPreviewResidualEdge({
    sourceImageData,
    alphaMap,
    position,
    minAlpha,
    maxAlpha,
    radius,
    strength,
    outsideAlphaMax
}) {
    const candidate = cloneImageData(sourceImageData);
    const { width: imageWidth, height: imageHeight, data } = sourceImageData;
    const regionSize = position.width;
    const maxAlphaSafe = Math.max(maxAlpha, 1e-6);
    const edgeMask = createAlphaGradientMask({
        alphaMap,
        width: regionSize,
        height: regionSize
    });

    for (let row = 0; row < regionSize; row++) {
        for (let col = 0; col < regionSize; col++) {
            const localIndex = row * regionSize + col;
            const alpha = Math.abs(alphaMap[localIndex]);
            if (alpha < minAlpha || alpha > maxAlpha) continue;

            let sumR = 0;
            let sumG = 0;
            let sumB = 0;
            let sumWeight = 0;

            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (dx === 0 && dy === 0) continue;

                    const localY = row + dy;
                    const localX = col + dx;
                    const pixelX = position.x + localX;
                    const pixelY = position.y + localY;

                    if (pixelX < 0 || pixelY < 0 || pixelX >= imageWidth || pixelY >= imageHeight) {
                        continue;
                    }

                    let neighborAlpha = 0;
                    if (localY >= 0 && localX >= 0 && localY < regionSize && localX < regionSize) {
                        neighborAlpha = Math.abs(alphaMap[localY * regionSize + localX]);
                    }
                    if (neighborAlpha > outsideAlphaMax) continue;

                    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
                    const weight = 1 / distance;
                    const pixelIndex = (pixelY * imageWidth + pixelX) * 4;
                    sumR += data[pixelIndex] * weight;
                    sumG += data[pixelIndex + 1] * weight;
                    sumB += data[pixelIndex + 2] * weight;
                    sumWeight += weight;
                }
            }

            if (sumWeight <= 0) continue;

            const edgeWeight = getAlphaGradientWeight(edgeMask, localIndex);
            const blend = Math.max(0, Math.min(1, strength * alpha / maxAlphaSafe * edgeWeight));
            const pixelIndex = ((position.y + row) * imageWidth + (position.x + col)) * 4;
            candidate.data[pixelIndex] = Math.round(data[pixelIndex] * (1 - blend) + (sumR / sumWeight) * blend);
            candidate.data[pixelIndex + 1] = Math.round(data[pixelIndex + 1] * (1 - blend) + (sumG / sumWeight) * blend);
            candidate.data[pixelIndex + 2] = Math.round(data[pixelIndex + 2] * (1 - blend) + (sumB / sumWeight) * blend);
        }
    }

    return candidate;
}

function solveLinear3x3(matrix, vector) {
    const augmented = matrix.map((row, index) => [...row, vector[index]]);

    for (let column = 0; column < 3; column++) {
        let pivot = column;
        for (let row = column + 1; row < 3; row++) {
            if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
                pivot = row;
            }
        }

        if (Math.abs(augmented[pivot][column]) < 1e-8) return null;
        if (pivot !== column) {
            [augmented[pivot], augmented[column]] = [augmented[column], augmented[pivot]];
        }

        const divisor = augmented[column][column];
        for (let next = column; next < 4; next++) {
            augmented[column][next] /= divisor;
        }

        for (let row = 0; row < 3; row++) {
            if (row === column) continue;
            const factor = augmented[row][column];
            for (let next = column; next < 4; next++) {
                augmented[row][next] -= factor * augmented[column][next];
            }
        }
    }

    return [augmented[0][3], augmented[1][3], augmented[2][3]];
}

function fitColorPlane(samples, channel) {
    const matrix = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
    ];
    const vector = [0, 0, 0];

    for (const sample of samples) {
        const terms = [1, sample.x, sample.y];
        const value = sample[channel];
        for (let row = 0; row < 3; row++) {
            vector[row] += terms[row] * value;
            for (let column = 0; column < 3; column++) {
                matrix[row][column] += terms[row] * terms[column];
            }
        }
    }

    return solveLinear3x3(matrix, vector);
}

function calculateBackgroundSampleStats(samples) {
    let sum = 0;
    let squareSum = 0;

    for (const sample of samples) {
        const luminance = 0.2126 * sample.r + 0.7152 * sample.g + 0.0722 * sample.b;
        sum += luminance;
        squareSum += luminance * luminance;
    }

    const count = samples.length;
    const mean = count > 0 ? sum / count : 0;
    return {
        count,
        mean,
        std: count > 0 ? Math.sqrt(Math.max(0, squareSum / count - mean * mean)) : Number.POSITIVE_INFINITY
    };
}

function sampleFlatBackgroundPixels(imageData, alphaMap, position, {
    pad = KNOWN_48_FLAT_FILL_PAD,
    outsideAlphaMax = KNOWN_48_FLAT_FILL_OUTSIDE_ALPHA_MAX,
    minSampleLum = 0
} = {}) {
    const samples = [];
    const left = Math.max(0, position.x - pad);
    const top = Math.max(0, position.y - pad);
    const right = Math.min(imageData.width - 1, position.x + position.width + pad - 1);
    const bottom = Math.min(imageData.height - 1, position.y + position.height + pad - 1);

    for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
            const inside = x >= position.x &&
                x < position.x + position.width &&
                y >= position.y &&
                y < position.y + position.height;

            if (inside) {
                const row = y - position.y;
                const col = x - position.x;
                if (alphaMap[row * position.width + col] > outsideAlphaMax) {
                    continue;
                }
            }

            const pixelIndex = (y * imageData.width + x) * 4;
            const luminance =
                0.2126 * imageData.data[pixelIndex] +
                0.7152 * imageData.data[pixelIndex + 1] +
                0.0722 * imageData.data[pixelIndex + 2];
            if (luminance < minSampleLum) continue;

            samples.push({
                x: (x - position.x) / Math.max(1, position.width),
                y: (y - position.y) / Math.max(1, position.height),
                r: imageData.data[pixelIndex],
                g: imageData.data[pixelIndex + 1],
                b: imageData.data[pixelIndex + 2]
            });
        }
    }

    return samples;
}

function applyFlatBackgroundFill({
    sourceImageData,
    alphaMap,
    position,
    minAlpha,
    maxAlpha,
    strength,
    maxBackgroundStd = KNOWN_48_FLAT_FILL_MAX_BACKGROUND_STD,
    edgeWeightFloor = 0.35,
    edgeMaskAlphaScale = 0,
    pad = KNOWN_48_FLAT_FILL_PAD,
    outsideAlphaMax = KNOWN_48_FLAT_FILL_OUTSIDE_ALPHA_MAX,
    minSampleLum = 0
}) {
    const samples = sampleFlatBackgroundPixels(sourceImageData, alphaMap, position, {
        pad,
        outsideAlphaMax,
        minSampleLum
    });
    const stats = calculateBackgroundSampleStats(samples);
    if (
        stats.count < 24 ||
        stats.std > maxBackgroundStd
    ) {
        return null;
    }

    const redPlane = fitColorPlane(samples, 'r');
    const greenPlane = fitColorPlane(samples, 'g');
    const bluePlane = fitColorPlane(samples, 'b');
    if (!redPlane || !greenPlane || !bluePlane) return null;

    const candidate = cloneImageData(sourceImageData);
    const edgeMask = createAlphaGradientMask({
        alphaMap,
        width: position.width,
        height: position.height
    });
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = alphaMap[localIndex];
            const edgeWeight = getAlphaGradientWeight(edgeMask, localIndex, edgeWeightFloor);
            const repairAlpha = Math.max(
                alpha,
                Number(edgeMask[localIndex] ?? 0) * edgeMaskAlphaScale
            );
            if (repairAlpha < minAlpha || repairAlpha > maxAlpha) continue;

            const x = col / Math.max(1, position.width);
            const y = row / Math.max(1, position.height);
            const target = [
                redPlane[0] + redPlane[1] * x + redPlane[2] * y,
                greenPlane[0] + greenPlane[1] * x + greenPlane[2] * y,
                bluePlane[0] + bluePlane[1] * x + bluePlane[2] * y
            ];
            const pixelIndex = ((position.y + row) * candidate.width + position.x + col) * 4;
            const blend = Math.max(0, Math.min(
                1,
                strength * Math.min(1, repairAlpha / 0.2) * edgeWeight
            ));
            for (let channel = 0; channel < 3; channel++) {
                candidate.data[pixelIndex + channel] = clampChannel(
                    candidate.data[pixelIndex + channel] * (1 - blend) + target[channel] * blend
                );
            }
        }
    }

    return { imageData: candidate, stats };
}

function applySmallPreviewBrightBackgroundFill({
    sourceImageData,
    alphaMap,
    position,
    minAlpha,
    minTargetLum,
    strength,
    pad,
    outsideAlphaMax,
    minSampleLum,
    maxBackgroundStd
}) {
    const samples = sampleFlatBackgroundPixels(sourceImageData, alphaMap, position, {
        pad,
        outsideAlphaMax,
        minSampleLum
    });
    const stats = calculateBackgroundSampleStats(samples);
    if (
        stats.count < 24 ||
        stats.std > maxBackgroundStd
    ) {
        return null;
    }

    const redPlane = fitColorPlane(samples, 'r');
    const greenPlane = fitColorPlane(samples, 'g');
    const bluePlane = fitColorPlane(samples, 'b');
    if (!redPlane || !greenPlane || !bluePlane) return null;

    const candidate = cloneImageData(sourceImageData);
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            if (alphaMap[localIndex] < minAlpha) continue;

            const pixelIndex = ((position.y + row) * candidate.width + position.x + col) * 4;
            const currentLum =
                0.2126 * candidate.data[pixelIndex] +
                0.7152 * candidate.data[pixelIndex + 1] +
                0.0722 * candidate.data[pixelIndex + 2];
            if (currentLum < minTargetLum) continue;

            const x = col / Math.max(1, position.width);
            const y = row / Math.max(1, position.height);
            const target = [
                redPlane[0] + redPlane[1] * x + redPlane[2] * y,
                greenPlane[0] + greenPlane[1] * x + greenPlane[2] * y,
                bluePlane[0] + bluePlane[1] * x + bluePlane[2] * y
            ];
            for (let channel = 0; channel < 3; channel++) {
                candidate.data[pixelIndex + channel] = clampChannel(
                    candidate.data[pixelIndex + channel] * (1 - strength) + target[channel] * strength
                );
            }
        }
    }

    return { imageData: candidate, stats };
}

function refineKnown48FlatBackgroundResidual({
    sourceImageData,
    alphaMap,
    position,
    baselineSpatialScore,
    baselineGradientScore,
    minBaselineGradient = KNOWN_48_FLAT_FILL_MIN_GRADIENT,
    minGradientImprovement = KNOWN_48_FLAT_FILL_MIN_GRADIENT_IMPROVEMENT
}) {
    if (
        position?.width < KNOWN_48_EDGE_CLEANUP_MIN_SIZE ||
        position?.width > KNOWN_48_EDGE_CLEANUP_MAX_SIZE ||
        baselineGradientScore < minBaselineGradient
    ) {
        return null;
    }

    let best = null;
    for (const preset of KNOWN_48_FLAT_FILL_PRESETS) {
        const filled = applyFlatBackgroundFill({
            sourceImageData,
            alphaMap,
            position,
            ...preset
        });
        if (!filled) continue;

        const spatialScore = computeRegionSpatialCorrelation({
            imageData: filled.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: filled.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientImprovement = baselineGradientScore - gradientScore;
        const keptSpatial = Math.abs(spatialScore) <= Math.abs(baselineSpatialScore) + KNOWN_48_FLAT_FILL_MAX_SPATIAL_DRIFT;
        const acceptedSpatial = Math.abs(spatialScore) <= KNOWN_48_FLAT_FILL_MAX_ACCEPTED_ABS_SPATIAL;
        if (
            gradientImprovement < minGradientImprovement ||
            !keptSpatial ||
            !acceptedSpatial
        ) {
            continue;
        }

        const cost = Math.abs(spatialScore) * 0.45 + Math.max(0, gradientScore);
        if (!best || cost < best.cost) {
            best = {
                imageData: filled.imageData,
                spatialScore,
                gradientScore,
                stats: filled.stats,
                preset: preset.name,
                cost
            };
        }
    }

    return best;
}

function isNewMargin96AlphaVariantConfig(config) {
    return config?.logoSize === 96 &&
        config.marginRight === 192 &&
        config.marginBottom === 192 &&
        config.alphaVariant === '20260520';
}

function refineNewMargin96FlatBackgroundResidual({
    sourceImageData,
    alphaMap,
    position,
    config,
    alphaGain,
    baselineSpatialScore,
    baselineGradientScore
}) {
    if (
        !isNewMargin96AlphaVariantConfig(config) ||
        alphaGain !== 1 ||
        position?.width !== 96 ||
        baselineGradientScore < NEW_MARGIN_96_FLAT_FILL_MIN_GRADIENT
    ) {
        return null;
    }

    let best = null;
    for (const preset of NEW_MARGIN_96_FLAT_FILL_PRESETS) {
        if (
            Number.isFinite(preset.minBaselineGradient) &&
            baselineGradientScore < preset.minBaselineGradient
        ) {
            continue;
        }
        const filled = applyFlatBackgroundFill({
            sourceImageData,
            alphaMap,
            position,
            maxBackgroundStd: NEW_MARGIN_96_FLAT_FILL_MAX_BACKGROUND_STD,
            edgeWeightFloor: 0.85,
            ...preset
        });
        if (!filled) continue;

        const spatialScore = computeRegionSpatialCorrelation({
            imageData: filled.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: filled.imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientImprovement = baselineGradientScore - gradientScore;
        const keptSpatial = Math.abs(spatialScore) <= Math.abs(baselineSpatialScore) + NEW_MARGIN_96_FLAT_FILL_MAX_SPATIAL_DRIFT;
        const acceptedSpatial = Math.abs(spatialScore) <= NEW_MARGIN_96_FLAT_FILL_MAX_ACCEPTED_ABS_SPATIAL;
        if (
            gradientImprovement < NEW_MARGIN_96_FLAT_FILL_MIN_GRADIENT_IMPROVEMENT ||
            !keptSpatial ||
            !acceptedSpatial
        ) {
            continue;
        }

        const cost = Math.abs(spatialScore) * 0.6 + Math.max(0, gradientScore);
        if (!best || cost < best.cost) {
            best = {
                imageData: filled.imageData,
                spatialScore,
                gradientScore,
                stats: filled.stats,
                preset: preset.name,
                cost
            };
        }
    }

    return best;
}

function refineNewMargin96SmoothEdgeResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSource,
    currentAlphaGain,
    currentSpatialScore,
    currentGradientScore
}) {
    if (
        !isNewMargin96AlphaVariantConfig(currentConfig) ||
        typeof currentSource !== 'string' ||
        !currentSource.includes('located-aggressive') ||
        currentPosition?.width !== 96 ||
        currentPosition?.height !== 96 ||
        currentAlphaGain < NEW_MARGIN_96_SMOOTH_EDGE_MIN_ALPHA_GAIN ||
        currentAlphaGain > NEW_MARGIN_96_SMOOTH_EDGE_MAX_ALPHA_GAIN ||
        Math.abs(currentSpatialScore) >
            NEW_MARGIN_96_SMOOTH_EDGE_MAX_BASELINE_ABS_SPATIAL ||
        currentGradientScore < NEW_MARGIN_96_SMOOTH_EDGE_MIN_BASELINE_GRADIENT
    ) {
        return null;
    }

    const samples = sampleFlatBackgroundPixels(
        currentImageData,
        currentAlphaMap,
        currentPosition,
        { pad: 10, outsideAlphaMax: 0.012 }
    );
    const backgroundStats = calculateBackgroundSampleStats(samples);
    if (
        backgroundStats.count < 24 ||
        backgroundStats.std > NEW_MARGIN_96_SMOOTH_EDGE_MAX_BACKGROUND_STD
    ) {
        return null;
    }

    const searchContext = createLocalAlphaSearchContext(
        currentImageData,
        currentPosition,
        NEW_MARGIN_96_SMOOTH_EDGE_SCRATCH_PAD
    );
    const originalScratch = extractLocalAlphaSearchScratch(
        originalImageData,
        searchContext.window
    );
    const priorImageData = buildPreviewNeighborhoodPrior({
        previewImageData: searchContext.originalScratch,
        position: searchContext.position,
        radius: 4,
        relaxationPasses: 0
    });
    const edgeMask = createAlphaGradientMask({
        alphaMap: currentAlphaMap,
        width: currentPosition.width,
        height: currentPosition.height,
        gamma: 0.4,
        dilateRadius: 2,
        blurSigma: 1
    });
    let best = null;
    for (const preset of NEW_MARGIN_96_SMOOTH_EDGE_PRESETS) {
        const candidateScratch = cloneImageData(searchContext.originalScratch);
        for (let row = 0; row < searchContext.position.height; row++) {
            for (let col = 0; col < searchContext.position.width; col++) {
                const localIndex = row * searchContext.position.width + col;
                const alpha = Math.abs(currentAlphaMap[localIndex]);
                if (alpha < 0.003 || alpha > preset.maxAlpha) continue;
                const blend = Math.min(1, preset.strength * edgeMask[localIndex]);
                if (blend <= 0) continue;
                const pixelIndex = (
                    (searchContext.position.y + row) * candidateScratch.width +
                    searchContext.position.x +
                    col
                ) * 4;
                for (let channel = 0; channel < 3; channel++) {
                    candidateScratch.data[pixelIndex + channel] = clampChannel(
                        candidateScratch.data[pixelIndex + channel] * (1 - blend) +
                        priorImageData.data[pixelIndex + channel] * blend
                    );
                }
            }
        }

        const region = {
            x: searchContext.position.x,
            y: searchContext.position.y,
            size: searchContext.position.width
        };
        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidateScratch,
            alphaMap: currentAlphaMap,
            region
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidateScratch,
            alphaMap: currentAlphaMap,
            region
        });
        const visibility = assessCalibratedWatermarkResidualVisibility({
            imageData: candidateScratch,
            originalImageData: originalScratch,
            position: searchContext.position,
            alphaMap: currentAlphaMap,
            alphaGain: currentAlphaGain
        });
        const boundary = measurePreviewBoundaryMetrics(
            candidateScratch,
            searchContext.originalScratch,
            searchContext.position
        );
        const artifacts = assessRemovalDiffArtifacts({
            originalImageData: originalScratch,
            candidateImageData: candidateScratch,
            alphaMap: currentAlphaMap,
            position: searchContext.position,
            alphaGain: currentAlphaGain
        });
        if (
            visibility?.visible !== false ||
            currentGradientScore - gradientScore <
                NEW_MARGIN_96_SMOOTH_EDGE_MIN_GRADIENT_IMPROVEMENT ||
            Math.abs(spatialScore) >
                NEW_MARGIN_96_SMOOTH_EDGE_MAX_FINAL_ABS_SPATIAL ||
            Math.abs(gradientScore) >
                NEW_MARGIN_96_SMOOTH_EDGE_MAX_FINAL_ABS_GRADIENT ||
            boundary.rawScore > NEW_MARGIN_96_SMOOTH_EDGE_MAX_BOUNDARY_RAW_SCORE ||
            Number(artifacts?.visualArtifactCost ?? Infinity) >
                NEW_MARGIN_96_SMOOTH_EDGE_MAX_ARTIFACT_COST
        ) {
            continue;
        }

        const cost = Math.abs(spatialScore) * 0.45 +
            Math.abs(gradientScore) * 0.55 +
            Number(artifacts?.visualArtifactCost ?? 0) * 0.25;
        if (!best || cost < best.cost) {
            best = {
                candidateScratch,
                spatialScore,
                gradientScore,
                boundary,
                artifacts,
                preset,
                cost
            };
        }
    }
    if (!best) return null;

    const imageData = cloneImageData(currentImageData);
    for (let row = 0; row < currentPosition.height; row++) {
        const sourceStart = (
            (searchContext.position.y + row) * best.candidateScratch.width +
            searchContext.position.x
        ) * 4;
        const targetStart = (
            (currentPosition.y + row) * imageData.width +
            currentPosition.x
        ) * 4;
        imageData.data.set(
            best.candidateScratch.data.subarray(
                sourceStart,
                sourceStart + currentPosition.width * 4
            ),
            targetStart
        );
    }
    return {
        imageData,
        spatialScore: best.spatialScore,
        gradientScore: best.gradientScore,
        backgroundStats,
        boundary: best.boundary,
        artifacts: best.artifacts,
        preset: best.preset,
        cost: best.cost
    };
}

function refineNewMargin96VariantResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    originalSpatialScore,
    originalGradientScore,
    variantAlphaMap
}) {
    if (
        !variantAlphaMap ||
        currentConfig?.logoSize !== 96 ||
        currentConfig.marginRight !== 192 ||
        currentConfig.marginBottom !== 192 ||
        currentConfig.alphaVariant === '20260520' ||
        currentPosition?.width !== 96 ||
        currentPosition?.height !== 96 ||
        originalSpatialScore < NEW_MARGIN_96_VARIANT_RESCUE_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < NEW_MARGIN_96_VARIANT_RESCUE_MIN_ORIGINAL_GRADIENT ||
        currentSpatialScore < NEW_MARGIN_96_VARIANT_RESCUE_MIN_CURRENT_SPATIAL ||
        currentGradientScore > NEW_MARGIN_96_VARIANT_RESCUE_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (currentVisibility?.visibleSpatialResidual !== true) return null;

    let best = null;
    for (const profile of NEW_MARGIN_96_VARIANT_RESCUE_PROFILES) {
        const alphaMap = powerKnown48AlphaMap(variantAlphaMap, profile.exponent);
        const variantOriginalSpatial = computeRegionSpatialCorrelation({
            imageData: originalImageData,
            alphaMap,
            region: {
                x: currentPosition.x,
                y: currentPosition.y,
                size: currentPosition.width
            }
        });
        const variantOriginalGradient = computeRegionGradientCorrelation({
            imageData: originalImageData,
            alphaMap,
            region: {
                x: currentPosition.x,
                y: currentPosition.y,
                size: currentPosition.width
            }
        });
        if (
            variantOriginalSpatial < NEW_MARGIN_96_VARIANT_RESCUE_MIN_ORIGINAL_SPATIAL ||
            variantOriginalGradient < NEW_MARGIN_96_VARIANT_RESCUE_MIN_ORIGINAL_GRADIENT
        ) {
            continue;
        }

        const candidate = scoreKnown48AntiTemplateRescueCandidate({
            originalImageData,
            alphaMap,
            position: currentPosition,
            alphaGain: profile.alphaGain,
            baselineGradientScore: currentGradientScore,
            maxSpatial: NEW_MARGIN_96_VARIANT_RESCUE_MAX_SPATIAL,
            maxVisualArtifact: NEW_MARGIN_96_VARIANT_RESCUE_MAX_VISUAL_ARTIFACT
        });
        if (!candidate) continue;
        if (
            candidate.gradientScore > NEW_MARGIN_96_VARIANT_RESCUE_MAX_GRADIENT ||
            (candidate.artifacts?.newlyClippedRatio ?? 0) > NEW_MARGIN_96_VARIANT_RESCUE_MAX_CLIPPED
        ) {
            continue;
        }

        const cost =
            Math.abs(candidate.spatialScore) +
            Math.max(0, candidate.gradientScore) * 0.7 +
            (candidate.artifacts?.visualArtifactCost ?? 0) * 0.35;
        if (!best || cost < best.cost) {
            best = {
                ...candidate,
                config: {
                    logoSize: 96,
                    marginRight: 192,
                    marginBottom: 192,
                    alphaVariant: '20260520'
                },
                profileExponent: profile.exponent,
                originalSpatialScore: variantOriginalSpatial,
                originalGradientScore: variantOriginalGradient,
                suppressionGain: variantOriginalSpatial - candidate.spatialScore,
                cost
            };
        }
    }

    return best;
}

function pixelLuminance(data, index) {
    return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
}

function applyLumaEdgeCorrection({
    sourceImageData,
    alphaMap,
    position,
    minAlpha,
    maxAlpha,
    referenceAlphaMax,
    radius,
    strength,
    colorSigma,
    maxDelta
}) {
    const candidate = cloneImageData(sourceImageData);
    const { data, width: imageWidth, height: imageHeight } = sourceImageData;
    const size = position.width;
    const colorSigmaSafe = Math.max(1, colorSigma);
    const edgeMask = createAlphaGradientMask({
        alphaMap,
        width: size,
        height: size
    });

    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const localIndex = row * size + col;
            const alpha = alphaMap[localIndex];
            if (alpha < minAlpha || alpha > maxAlpha) continue;

            const x = position.x + col;
            const y = position.y + row;
            const pixelIndex = (y * imageWidth + x) * 4;
            const currentLum = pixelLuminance(data, pixelIndex);
            let weightedLum = 0;
            let sumWeight = 0;

            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const distanceSquared = dx * dx + dy * dy;
                    if (distanceSquared > radius * radius) continue;

                    const localX = col + dx;
                    const localY = row + dy;
                    const pixelX = x + dx;
                    const pixelY = y + dy;
                    if (pixelX < 0 || pixelY < 0 || pixelX >= imageWidth || pixelY >= imageHeight) continue;

                    let neighborAlpha = 0;
                    if (localX >= 0 && localY >= 0 && localX < size && localY < size) {
                        neighborAlpha = alphaMap[localY * size + localX];
                    }
                    if (neighborAlpha > referenceAlphaMax && neighborAlpha >= alpha) continue;

                    const neighborIndex = (pixelY * imageWidth + pixelX) * 4;
                    const neighborLum = pixelLuminance(data, neighborIndex);
                    const colorDistance =
                        Math.abs(data[pixelIndex] - data[neighborIndex]) +
                        Math.abs(data[pixelIndex + 1] - data[neighborIndex + 1]) +
                        Math.abs(data[pixelIndex + 2] - data[neighborIndex + 2]);
                    const colorWeight = Math.exp(
                        -(colorDistance * colorDistance) / (2 * colorSigmaSafe * colorSigmaSafe * 9)
                    );
                    const alphaWeight = neighborAlpha <= referenceAlphaMax ? 1.25 : 0.65;
                    const distanceWeight = 1 / Math.sqrt(distanceSquared);
                    const weight = colorWeight * alphaWeight * distanceWeight;
                    weightedLum += neighborLum * weight;
                    sumWeight += weight;
                }
            }

            if (sumWeight <= 0) continue;

            const targetLum = weightedLum / sumWeight;
            const delta = Math.max(-maxDelta, Math.min(maxDelta, targetLum - currentLum)) * strength;
            const edgeWeight = getAlphaGradientWeight(edgeMask, localIndex);
            const scaledStrength = Math.min(1, Math.max(0, alpha / Math.max(maxAlpha, 1e-6))) * edgeWeight;
            const finalDelta = delta * scaledStrength;
            candidate.data[pixelIndex] = clampChannel(data[pixelIndex] + finalDelta);
            candidate.data[pixelIndex + 1] = clampChannel(data[pixelIndex + 1] + finalDelta);
            candidate.data[pixelIndex + 2] = clampChannel(data[pixelIndex + 2] + finalDelta);
        }
    }

    return candidate;
}

function refineKnown48LumaEdgeResidual({
    sourceImageData,
    alphaMap,
    position,
    baselineSpatialScore,
    baselineGradientScore
}) {
    if (
        position?.width < KNOWN_48_EDGE_CLEANUP_MIN_SIZE ||
        position?.width > KNOWN_48_EDGE_CLEANUP_MAX_SIZE ||
        baselineGradientScore < KNOWN_48_LUMA_EDGE_MIN_GRADIENT
    ) {
        return null;
    }

    let best = null;
    for (const preset of KNOWN_48_LUMA_EDGE_PRESETS) {
        const candidate = applyLumaEdgeCorrection({
            sourceImageData,
            alphaMap,
            position,
            ...preset
        });
        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientImprovement = baselineGradientScore - gradientScore;
        const keptSpatial = Math.abs(spatialScore) <= Math.abs(baselineSpatialScore) + KNOWN_48_LUMA_EDGE_MAX_SPATIAL_DRIFT;
        const acceptedSpatial = Math.abs(spatialScore) <= KNOWN_48_LUMA_EDGE_MAX_ACCEPTED_ABS_SPATIAL;
        if (
            gradientImprovement < KNOWN_48_LUMA_EDGE_MIN_GRADIENT_IMPROVEMENT ||
            !keptSpatial ||
            !acceptedSpatial
        ) {
            continue;
        }

        const cost = Math.abs(spatialScore) * 0.45 + Math.max(0, gradientScore);
        if (!best || cost < best.cost) {
            best = {
                imageData: candidate,
                spatialScore,
                gradientScore,
                preset: preset.name,
                cost
            };
        }
    }

    return best;
}

function alphaBandBiasWeight(alpha, {
    outerMinAlpha = 0.12,
    innerMinAlpha = 0.18,
    innerMaxAlpha = 0.35,
    outerMaxAlpha = 0.42
} = {}) {
    if (alpha < outerMinAlpha || alpha > outerMaxAlpha) return 0;
    if (alpha >= innerMinAlpha && alpha <= innerMaxAlpha) return 1;
    if (alpha < innerMinAlpha) {
        return smoothstep(outerMinAlpha, innerMinAlpha, alpha);
    }
    return 1 - smoothstep(innerMaxAlpha, outerMaxAlpha, alpha);
}

function smoothstep(edge0, edge1, value) {
    if (edge0 === edge1) return value >= edge1 ? 1 : 0;
    const t = clamp01((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function applyMidCoreBiasCorrection({ sourceImageData, alphaMap, position, positiveHaloLum, strength }) {
    const candidate = cloneImageData(sourceImageData);
    const bias = Math.max(0, positiveHaloLum) * strength;
    if (bias <= 0) return candidate;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = alphaMap[localIndex] ?? 0;
            const weight = alphaBandBiasWeight(alpha);
            if (weight <= 0) continue;

            const pixelIndex = ((position.y + row) * candidate.width + position.x + col) * 4;
            const delta = bias * weight;
            candidate.data[pixelIndex] = clampChannel(candidate.data[pixelIndex] - delta);
            candidate.data[pixelIndex + 1] = clampChannel(candidate.data[pixelIndex + 1] - delta);
            candidate.data[pixelIndex + 2] = clampChannel(candidate.data[pixelIndex + 2] - delta);
        }
    }

    return candidate;
}

function positiveBandDelta(imageData, position, alphaMap, minAlpha, maxAlpha) {
    const halo = assessAlphaBandHalo({
        imageData,
        position,
        alphaMap,
        minAlpha,
        maxAlpha,
        outsideAlphaMax: 0.012,
        outerMargin: 4
    });
    return halo.positiveDeltaLum ?? 0;
}

function hasDominantMidCoreHalo({ imageData, position, alphaMap }) {
    const edge = positiveBandDelta(imageData, position, alphaMap, 0.02, 0.12);
    const midCore = positiveBandDelta(imageData, position, alphaMap, 0.18, 0.35);
    const highCore = positiveBandDelta(imageData, position, alphaMap, 0.35, 0.78);
    return midCore > edge && midCore > highCore;
}

function refineKnown48MidCoreBiasResidual({
    originalImageData,
    currentImageData,
    alphaMap,
    position,
    source,
    alphaGain,
    baselineSpatialScore,
    baselineGradientScore
}) {
    if (
        position?.width < KNOWN_48_EDGE_CLEANUP_MIN_SIZE ||
        position?.width > KNOWN_48_EDGE_CLEANUP_MAX_SIZE ||
        typeof source !== 'string' ||
        !source.includes('edge-cleanup') ||
        source.includes('v2-small-edge-cleanup')
    ) {
        return null;
    }

    const baselineVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position,
        alphaMap
    });
    if (
        baselineVisibility?.visiblePositiveHalo !== true ||
        (baselineVisibility.positiveHaloLum ?? 0) < KNOWN_48_MID_CORE_BIAS_MIN_HALO ||
        !hasDominantMidCoreHalo({ imageData: currentImageData, position, alphaMap })
    ) {
        return null;
    }

    const baselineArtifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: currentImageData,
        alphaMap,
        position,
        alphaGain
    });
    const baselineArtifactCost = Number(baselineArtifacts?.visualArtifactCost);
    if (!Number.isFinite(baselineArtifactCost)) return null;

    const candidate = applyMidCoreBiasCorrection({
        sourceImageData: currentImageData,
        alphaMap,
        position,
        positiveHaloLum: baselineVisibility.positiveHaloLum,
        strength: KNOWN_48_MID_CORE_BIAS_STRENGTH
    });
    const spatialScore = computeRegionSpatialCorrelation({
        imageData: candidate,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const gradientScore = computeRegionGradientCorrelation({
        imageData: candidate,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData: candidate,
        position,
        alphaMap
    });
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: candidate,
        alphaMap,
        position,
        alphaGain
    });
    const artifactCost = Number(artifacts?.visualArtifactCost);
    if (!Number.isFinite(artifactCost)) return null;

    const haloReduction = (baselineVisibility.positiveHaloLum ?? 0) - (residualVisibility?.positiveHaloLum ?? 0);
    const gradientDrift = gradientScore - baselineGradientScore;
    const spatialDrift = Math.abs(spatialScore) - Math.abs(baselineSpatialScore);
    const artifactDrift = artifactCost - baselineArtifactCost;
    const newClipDrift = (artifacts?.newlyClippedRatio ?? 0) - (baselineArtifacts?.newlyClippedRatio ?? 0);
    if (
        haloReduction < KNOWN_48_MID_CORE_BIAS_MIN_HALO_REDUCTION ||
        gradientDrift > KNOWN_48_MID_CORE_BIAS_MAX_GRADIENT_DRIFT ||
        spatialDrift > KNOWN_48_MID_CORE_BIAS_MAX_SPATIAL_DRIFT ||
        artifactDrift > KNOWN_48_MID_CORE_BIAS_MAX_ARTIFACT_DRIFT ||
        newClipDrift > KNOWN_48_MID_CORE_BIAS_MAX_NEW_CLIP_DRIFT
    ) {
        return null;
    }

    return {
        imageData: candidate,
        spatialScore,
        gradientScore,
        residualVisibility,
        cost: artifactCost,
        haloReduction,
        artifactDrift,
        newClipDrift
    };
}

function expandPosition(position, imageData, pad) {
    const left = Math.max(0, position.x - pad);
    const top = Math.max(0, position.y - pad);
    const right = Math.min(imageData.width, position.x + position.width + pad);
    const bottom = Math.min(imageData.height, position.y + position.height + pad);

    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top
    };
}

function measureOuterBorderLuminanceStats(imageData, position, margin = 10) {
    let sum = 0;
    let sq = 0;
    let count = 0;

    const left = Math.max(0, position.x - margin);
    const top = Math.max(0, position.y - margin);
    const right = Math.min(imageData.width, position.x + position.width + margin);
    const bottom = Math.min(imageData.height, position.y + position.height + margin);

    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            const inside = x >= position.x &&
                x < position.x + position.width &&
                y >= position.y &&
                y < position.y + position.height;
            if (inside) continue;

            const idx = (y * imageData.width + x) * 4;
            const lum =
                0.2126 * imageData.data[idx] +
                0.7152 * imageData.data[idx + 1] +
                0.0722 * imageData.data[idx + 2];
            sum += lum;
            sq += lum * lum;
            count++;
        }
    }

    if (count <= 0) {
        return {
            mean: Number.POSITIVE_INFINITY,
            std: Number.POSITIVE_INFINITY,
            count
        };
    }

    const mean = sum / count;
    return {
        mean,
        std: Math.sqrt(Math.max(0, sq / count - mean * mean)),
        count
    };
}

function measureOuterBorderLuminanceStd(imageData, position, margin = 10) {
    return measureOuterBorderLuminanceStats(imageData, position, margin).std;
}

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function clampChannel(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function estimateAlphaMapFromBackgroundPrior({
    originalImageData,
    priorImageData,
    position,
    threshold,
    blurRadius
}) {
    const alphaMap = new Float32Array(position.width * position.height);

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const pixelIndex = ((position.y + row) * originalImageData.width + position.x + col) * 4;
            let estimatedAlpha = 0;

            for (let channel = 0; channel < 3; channel++) {
                const denominator = 255 - priorImageData.data[pixelIndex + channel];
                if (denominator <= 2) continue;

                estimatedAlpha = Math.max(
                    estimatedAlpha,
                    (originalImageData.data[pixelIndex + channel] - priorImageData.data[pixelIndex + channel]) / denominator
                );
            }

            alphaMap[localIndex] = Math.min(0.9, clamp01((estimatedAlpha - threshold) * 1.2));
        }
    }

    return blurRadius > 0
        ? blurAlphaMap(alphaMap, position.width, blurRadius)
        : alphaMap;
}

function applyEstimatedPriorBlend({
    sourceImageData,
    priorImageData,
    estimatedAlphaMap,
    position,
    strength,
    gamma
}) {
    const candidate = cloneImageData(sourceImageData);

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = estimatedAlphaMap[localIndex];
            if (alpha <= 0.005) continue;

            const blend = clamp01(Math.pow(alpha, gamma) * strength);
            if (blend <= 0.005) continue;

            const pixelIndex = ((position.y + row) * sourceImageData.width + position.x + col) * 4;
            for (let channel = 0; channel < 3; channel++) {
                candidate.data[pixelIndex + channel] = clampChannel(
                    sourceImageData.data[pixelIndex + channel] * (1 - blend) +
                    priorImageData.data[pixelIndex + channel] * blend
                );
            }
        }
    }

    return candidate;
}

function refineSmoothLocatedResidualWithEstimatedPrior({
    originalImageData,
    currentImageData,
    alphaMap,
    position,
    source,
    alphaGain,
    baselineSpatialScore,
    baselineGradientScore
}) {
    if (
        typeof source !== 'string' ||
        !source.includes('located-aggressive') ||
        position?.width < SMOOTH_PRIOR_LOCATED_MIN_SIZE ||
        position?.width > SMOOTH_PRIOR_LOCATED_MAX_SIZE ||
        baselineSpatialScore < SMOOTH_PRIOR_LOCATED_MIN_SPATIAL ||
        baselineGradientScore > SMOOTH_PRIOR_LOCATED_MAX_GRADIENT
    ) {
        return null;
    }

    const borderStats = measureOuterBorderLuminanceStats(originalImageData, position, 16);
    if (borderStats.mean < SMOOTH_PRIOR_LOCATED_MIN_BORDER_MEAN) {
        return null;
    }

    const baselineArtifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: currentImageData,
        alphaMap,
        position,
        alphaGain
    });
    const baselineArtifactCost = Number(baselineArtifacts?.visualArtifactCost);
    if (!Number.isFinite(baselineArtifactCost)) return null;

    let best = null;
    const priorByRadius = new Map();

    for (const preset of SMOOTH_PRIOR_LOCATED_PRESETS) {
        let priorImageData = priorByRadius.get(preset.radius);
        if (!priorImageData) {
            priorImageData = buildPreviewNeighborhoodPrior({
                previewImageData: originalImageData,
                position,
                radius: preset.radius
            });
            priorByRadius.set(preset.radius, priorImageData);
        }

        const estimatedAlphaMap = estimateAlphaMapFromBackgroundPrior({
            originalImageData,
            priorImageData,
            position,
            threshold: preset.threshold,
            blurRadius: preset.blurRadius
        });
        const candidateImageData = applyEstimatedPriorBlend({
            sourceImageData: currentImageData,
            priorImageData,
            estimatedAlphaMap,
            position,
            strength: preset.strength,
            gamma: preset.gamma
        });
        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidateImageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidateImageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const artifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData,
            alphaMap,
            position,
            alphaGain
        });
        const artifactCost = Number(artifacts?.visualArtifactCost);
        if (!Number.isFinite(artifactCost)) continue;

        const spatialImprovement = Math.abs(baselineSpatialScore) - Math.abs(spatialScore);
        const gradientDrift = gradientScore - baselineGradientScore;
        const artifactImprovement = baselineArtifactCost - artifactCost;
        if (
            spatialImprovement < SMOOTH_PRIOR_LOCATED_MIN_SPATIAL_IMPROVEMENT ||
            gradientDrift > SMOOTH_PRIOR_LOCATED_MAX_GRADIENT_DRIFT ||
            artifactImprovement < SMOOTH_PRIOR_LOCATED_MIN_ARTIFACT_IMPROVEMENT ||
            gradientScore > SMOOTH_PRIOR_LOCATED_MAX_ACCEPTED_GRADIENT
        ) {
            continue;
        }

        const cost = Math.abs(spatialScore) * 0.75 +
            Math.max(0, gradientScore) * 0.9 +
            artifactCost * 0.5;
        if (!best || cost < best.cost) {
            best = {
                imageData: candidateImageData,
                spatialScore,
                gradientScore,
                cost,
                artifactCost,
                borderStats,
                preset
            };
        }
    }

    return best;
}

function averageStripColor(imageData, {
    xFrom,
    xTo,
    yFrom,
    yTo
}) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    const left = Math.max(0, xFrom);
    const right = Math.min(imageData.width - 1, xTo);
    const top = Math.max(0, yFrom);
    const bottom = Math.min(imageData.height - 1, yTo);

    for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
            const idx = (y * imageData.width + x) * 4;
            sumR += imageData.data[idx];
            sumG += imageData.data[idx + 1];
            sumB += imageData.data[idx + 2];
            count++;
        }
    }

    if (count <= 0) return [0, 0, 0];

    return [
        sumR / count,
        sumG / count,
        sumB / count
    ];
}

function lerpColor(left, right, t) {
    return [
        left[0] * (1 - t) + right[0] * t,
        left[1] * (1 - t) + right[1] * t,
        left[2] * (1 - t) + right[2] * t
    ];
}

function applyPreviewSmoothBackgroundCleanup({
    imageData,
    position
}) {
    const expandedPosition = expandPosition(
        position,
        imageData,
        PREVIEW_BACKGROUND_CLEANUP_PAD
    );
    const candidate = cloneImageData(imageData);
    const stripRadius = PREVIEW_BACKGROUND_CLEANUP_PRIOR_RADIUS;
    const leftBoundary = [];
    const rightBoundary = [];
    const topBoundary = [];
    const bottomBoundary = [];

    for (let row = 0; row < expandedPosition.height; row++) {
        const y = expandedPosition.y + row;
        leftBoundary.push(averageStripColor(imageData, {
            xFrom: expandedPosition.x - stripRadius,
            xTo: expandedPosition.x - 1,
            yFrom: y - 1,
            yTo: y + 1
        }));
        rightBoundary.push(averageStripColor(imageData, {
            xFrom: expandedPosition.x + expandedPosition.width,
            xTo: expandedPosition.x + expandedPosition.width + stripRadius - 1,
            yFrom: y - 1,
            yTo: y + 1
        }));
    }

    for (let col = 0; col < expandedPosition.width; col++) {
        const x = expandedPosition.x + col;
        topBoundary.push(averageStripColor(imageData, {
            xFrom: x - 1,
            xTo: x + 1,
            yFrom: expandedPosition.y - stripRadius,
            yTo: expandedPosition.y - 1
        }));
        bottomBoundary.push(averageStripColor(imageData, {
            xFrom: x - 1,
            xTo: x + 1,
            yFrom: expandedPosition.y + expandedPosition.height,
            yTo: expandedPosition.y + expandedPosition.height + stripRadius - 1
        }));
    }

    for (let row = 0; row < expandedPosition.height; row++) {
        const ty = expandedPosition.height <= 1 ? 0.5 : row / (expandedPosition.height - 1);
        for (let col = 0; col < expandedPosition.width; col++) {
            const tx = expandedPosition.width <= 1 ? 0.5 : col / (expandedPosition.width - 1);
            const horizontal = lerpColor(leftBoundary[row], rightBoundary[row], tx);
            const vertical = lerpColor(topBoundary[col], bottomBoundary[col], ty);
            const idx = ((expandedPosition.y + row) * candidate.width + expandedPosition.x + col) * 4;
            candidate.data[idx] = clampChannel((horizontal[0] + vertical[0]) * 0.5);
            candidate.data[idx + 1] = clampChannel((horizontal[1] + vertical[1]) * 0.5);
            candidate.data[idx + 2] = clampChannel((horizontal[2] + vertical[2]) * 0.5);
        }
    }

    return {
        imageData: candidate,
        expandedPosition
    };
}

function shouldApplyPreviewSmoothBackgroundCleanup({
    enabled = true,
    source,
    position,
    baselineSpatialScore,
    borderStd
}) {
    return enabled === true &&
        typeof source === 'string' &&
        source.includes('preview-anchor') &&
        position?.width >= 24 &&
        position?.width <= PREVIEW_BACKGROUND_CLEANUP_MAX_SIZE &&
        baselineSpatialScore >= PREVIEW_BACKGROUND_CLEANUP_MIN_RESIDUAL &&
        borderStd <= PREVIEW_BACKGROUND_CLEANUP_MAX_BORDER_STD;
}

function refineSmallPreviewAnchorCandidate({
    originalImageData,
    source,
    position,
    originalGradientScore,
    currentSpatialScore,
    currentGradientScore,
    getAlphaMap
}) {
    if (
        typeof source !== 'string' ||
        !source.includes('preview-anchor') ||
        !source.includes('edge-cleanup') ||
        position?.width > SMALL_PREVIEW_REFINEMENT_MAX_SOURCE_SIZE ||
        originalGradientScore > SMALL_PREVIEW_REFINEMENT_MAX_ORIGINAL_GRADIENT ||
        currentSpatialScore < SMALL_PREVIEW_REFINEMENT_MIN_CURRENT_SPATIAL ||
        currentGradientScore > SMALL_PREVIEW_REFINEMENT_MAX_CURRENT_GRADIENT ||
        typeof getAlphaMap !== 'function'
    ) {
        return null;
    }

    let best = null;
    const sizeCandidates = [
        position.width + 4,
        position.width + 6,
        position.width + 8
    ].filter((size) => size <= SMALL_PREVIEW_REFINEMENT_MAX_REFINED_SIZE);
    const shiftCandidates = [-8, -6, -4, -2, 0];
    const gainCandidates = ALPHA_GAIN_CANDIDATES.filter((gain) => gain < 1);

    for (const size of sizeCandidates) {
        const alphaMap = getAlphaMap(size);
        if (!alphaMap) continue;

        for (const dy of shiftCandidates) {
            for (const dx of shiftCandidates) {
                const candidatePosition = {
                    x: position.x + dx,
                    y: position.y + dy,
                    width: size,
                    height: size
                };
                if (
                    candidatePosition.x < 0 ||
                    candidatePosition.y < 0 ||
                    candidatePosition.x + size > originalImageData.width ||
                    candidatePosition.y + size > originalImageData.height
                ) {
                    continue;
                }

                for (const alphaGain of gainCandidates) {
                    const originalSpatialScore = computeRegionSpatialCorrelation({
                        imageData: originalImageData,
                        alphaMap,
                        region: { x: candidatePosition.x, y: candidatePosition.y, size }
                    });
                    const originalGradientScore = computeRegionGradientCorrelation({
                        imageData: originalImageData,
                        alphaMap,
                        region: { x: candidatePosition.x, y: candidatePosition.y, size }
                    });
                    const candidate = cloneImageData(originalImageData);
                    removeWatermark(candidate, alphaMap, candidatePosition, { alphaGain });
                    const spatialScore = computeRegionSpatialCorrelation({
                        imageData: candidate,
                        alphaMap,
                        region: { x: candidatePosition.x, y: candidatePosition.y, size }
                    });
                    const gradientScore = computeRegionGradientCorrelation({
                        imageData: candidate,
                        alphaMap,
                        region: { x: candidatePosition.x, y: candidatePosition.y, size }
                    });
                    const absSpatialImprovement = Math.abs(currentSpatialScore) - Math.abs(spatialScore);
                    const gradientImprovement = currentGradientScore - gradientScore;
                    if (
                        absSpatialImprovement < SMALL_PREVIEW_REFINEMENT_MIN_ABS_SPATIAL_IMPROVEMENT ||
                        gradientImprovement < SMALL_PREVIEW_REFINEMENT_MIN_GRADIENT_IMPROVEMENT
                    ) {
                        continue;
                    }

                    const nearBlackRatio = calculateNearBlackRatio(candidate, candidatePosition);
                    const cost = Math.abs(spatialScore) + Math.max(0, gradientScore) * 0.8 + nearBlackRatio * 2;
                    if (!best || cost < best.cost) {
                        best = {
                            imageData: candidate,
                            alphaMap,
                            alphaGain,
                            position: candidatePosition,
                            originalSpatialScore,
                            originalGradientScore,
                            spatialScore,
                            gradientScore,
                            nearBlackRatio,
                            cost
                        };
                    }
                }
            }
        }
    }

    return best;
}

function refinePreviewResidualEdge({
    sourceImageData,
    alphaMap,
    position,
    source,
    baselineSpatialScore,
    baselineGradientScore,
    minGradientImprovement = PREVIEW_EDGE_CLEANUP_MIN_GRADIENT_IMPROVEMENT,
    maxSpatialDrift = PREVIEW_EDGE_CLEANUP_MAX_SPATIAL_DRIFT,
    allowAggressivePresets = false,
    mode = 'preview'
}) {
    const baselineHalo = assessAlphaBandHalo({
        imageData: sourceImageData,
        position,
        alphaMap
    });
    const baselinePositiveHalo = baselineHalo.positiveDeltaLum;
    if (!shouldRefineResidualEdge({
        source,
        position,
        baselineSpatialScore,
        baselineGradientScore,
        baselinePositiveHalo,
        mode
    })) {
        return null;
    }

    const baselineNearBlackRatio = calculateNearBlackRatio(sourceImageData, position);
    const maxAllowedNearBlackRatio = Math.min(1, baselineNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    const resolvedMinGradientImprovement = baselineGradientScore <= PREVIEW_EDGE_CLEANUP_FINE_GRADIENT_THRESHOLD
        ? PREVIEW_EDGE_CLEANUP_FINE_MIN_GRADIENT_IMPROVEMENT
        : (
            baselinePositiveHalo >= PREVIEW_EDGE_CLEANUP_STRONG_HALO_THRESHOLD
                ? PREVIEW_EDGE_CLEANUP_HALO_RELAXED_MIN_GRADIENT_IMPROVEMENT
                : minGradientImprovement
        );
    const smallPreviewPresets = mode === 'preview' &&
        position?.width >= 24 &&
        position?.width <= SMALL_PREVIEW_EDGE_CLEANUP_MAX_SIZE
        ? SMALL_PREVIEW_EDGE_CLEANUP_PRESETS
        : [];
    const presets = allowAggressivePresets &&
        baselineGradientScore >= PREVIEW_EDGE_CLEANUP_STRONG_GRADIENT_THRESHOLD &&
        Math.abs(baselineSpatialScore) <= 0.05
        ? [...PREVIEW_EDGE_CLEANUP_PRESETS, ...PREVIEW_EDGE_CLEANUP_AGGRESSIVE_PRESETS]
        : [...PREVIEW_EDGE_CLEANUP_PRESETS, ...smallPreviewPresets];
    let best = null;

    for (const preset of presets) {
        const candidate = blendPreviewResidualEdge({
            sourceImageData,
            alphaMap,
            position,
            ...preset
        });
        const nearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidate,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const halo = assessAlphaBandHalo({
            imageData: candidate,
            position,
            alphaMap
        });

        const presetMinGradientImprovement = preset.minGradientImprovement ?? resolvedMinGradientImprovement;
        const presetMaxSpatialDrift = preset.maxSpatialDrift ?? maxSpatialDrift;
        const presetMaxAcceptedSpatial = preset.maxAcceptedSpatial ?? 0.22;
        const improvedGradient = gradientScore <= baselineGradientScore - presetMinGradientImprovement;
        const keptSpatial = Math.abs(spatialScore) <= Math.abs(baselineSpatialScore) + presetMaxSpatialDrift;
        const keptResidualWithinTarget = Math.abs(spatialScore) <= presetMaxAcceptedSpatial;
        const candidatePositiveHalo = halo.positiveDeltaLum;
        const improvedHalo = baselinePositiveHalo < PREVIEW_EDGE_CLEANUP_STRONG_HALO_THRESHOLD ||
            candidatePositiveHalo <= baselinePositiveHalo - PREVIEW_EDGE_CLEANUP_MIN_HALO_REDUCTION;
        if (!improvedGradient || !keptSpatial || !keptResidualWithinTarget || !improvedHalo) continue;

        const cost = Math.abs(spatialScore) * 0.6 +
            Math.max(0, gradientScore) +
            candidatePositiveHalo * PREVIEW_EDGE_CLEANUP_HALO_WEIGHT;
        if (!best || cost < best.cost) {
            best = {
                imageData: candidate,
                spatialScore,
                gradientScore,
                halo,
                cost
            };
        }
    }

    if (!best || !(
        mode === 'preview' &&
        position?.width >= 24 &&
        position?.width <= SMALL_PREVIEW_EDGE_CLEANUP_MAX_SIZE
    )) {
        return best;
    }

    const flatFilled = applySmallPreviewBrightBackgroundFill({
        sourceImageData: best.imageData,
        alphaMap,
        position,
        ...SMALL_PREVIEW_FLAT_FILL_PRESET
    });
    if (!flatFilled) return best;
    if (
        flatFilled.stats.mean < SMALL_PREVIEW_FLAT_FILL_MIN_BACKGROUND_MEAN ||
        flatFilled.stats.std > SMALL_PREVIEW_FLAT_FILL_MAX_BACKGROUND_STD
    ) {
        return best;
    }

    const flatSpatialScore = computeRegionSpatialCorrelation({
        imageData: flatFilled.imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const flatGradientScore = computeRegionGradientCorrelation({
        imageData: flatFilled.imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    if (
        Math.abs(flatSpatialScore) > SMALL_PREVIEW_FLAT_FILL_MAX_ABS_SPATIAL ||
        flatGradientScore > SMALL_PREVIEW_FLAT_FILL_MAX_GRADIENT
    ) {
        return best;
    }

    return {
        ...best,
        imageData: flatFilled.imageData,
        spatialScore: flatSpatialScore,
        gradientScore: flatGradientScore,
        flatFillStats: flatFilled.stats,
        cost: Math.abs(flatSpatialScore) * 0.6 + Math.max(0, flatGradientScore)
    };
}

function scoreLocatedAggressiveCandidate({
    imageData,
    originalImageData,
    alphaMap,
    position,
    alphaGain = 1,
    baselineGradientScore = null
}) {
    const spatialScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const gradientScore = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const nearBlackRatio = calculateNearBlackRatio(imageData, position);
    const baselineNearBlackRatio = originalImageData
        ? calculateNearBlackRatio(originalImageData, position)
        : nearBlackRatio;
    const artifacts = originalImageData
        ? assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData: imageData,
            alphaMap,
            position,
            alphaGain
        })
        : null;
    const balancedVisual = scoreBalancedVisualCandidate({
        processedSpatial: spatialScore,
        processedGradient: gradientScore,
        nearBlackIncrease: nearBlackRatio - baselineNearBlackRatio,
        newlyClippedRatio: artifacts?.newlyClippedRatio,
        darkHaloLum: Math.max(0, -(artifacts?.halo?.deltaLum ?? 0)),
        visualArtifactCost: artifacts?.visualArtifactCost,
        gradientIncrease: Number.isFinite(baselineGradientScore)
            ? gradientScore - baselineGradientScore
            : 0
    });
    return {
        spatialScore,
        gradientScore,
        nearBlackRatio,
        artifacts,
        balancedVisual,
        cost: balancedVisual.score
    };
}

function pickLocatedAggressiveCandidate(currentBest, candidate) {
    if (!candidate) return currentBest;
    if (!currentBest || candidate.cost < currentBest.cost) return candidate;
    return currentBest;
}

function buildLocatedAggressiveCandidate({
    originalImageData,
    sourceImageData,
    alphaMap,
    position,
    alphaGain,
    repeatCount,
    baselineGradientScore
}) {
    const candidate = cloneImageData(sourceImageData);
    for (let passIndex = 0; passIndex < repeatCount; passIndex++) {
        removeWatermark(candidate, alphaMap, position, { alphaGain });
    }
    return {
        imageData: candidate,
        alphaGain,
        repeatCount,
        ...scoreLocatedAggressiveCandidate({
            imageData: candidate,
            originalImageData,
            alphaMap,
            position,
            alphaGain,
            baselineGradientScore
        })
    };
}

function refineLocatedAggressiveRemoval({
    originalImageData,
    currentImageData,
    alphaMap,
    position,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    onRejected = null
}) {
    if (!position || !alphaMap || position.width !== position.height) return null;
    const current = {
        imageData: currentImageData,
        alphaGain: currentAlphaGain,
        repeatCount: 0,
        spatialScore: currentSpatialScore,
        gradientScore: currentGradientScore,
        nearBlackRatio: calculateNearBlackRatio(currentImageData, position),
        ...scoreLocatedAggressiveCandidate({
            imageData: currentImageData,
            originalImageData,
            alphaMap,
            position,
            alphaGain: currentAlphaGain,
            baselineGradientScore: currentGradientScore
        })
    };
    let best = current;
    const gains = new Set([
        currentAlphaGain,
        ...LOCATED_AGGRESSIVE_ALPHA_GAINS
    ].filter((value) => Number.isFinite(value) && value > 0));

    for (const alphaGain of gains) {
        for (const repeatCount of [1, 2]) {
            best = pickLocatedAggressiveCandidate(
                best,
                buildLocatedAggressiveCandidate({
                    originalImageData,
                    sourceImageData: originalImageData,
                    alphaMap,
                    position,
                    alphaGain,
                    repeatCount,
                    baselineGradientScore: currentGradientScore
                })
            );
        }
    }

    const edgeSources = [{
        imageData: best.imageData,
        alphaGain: best.alphaGain,
        repeatCount: best.repeatCount
    }];
    if (best.imageData !== currentImageData) {
        edgeSources.push({
            imageData: currentImageData,
            alphaGain: currentAlphaGain,
            repeatCount: 0
        });
    }
    for (const edgeSource of edgeSources) {
        for (const preset of LOCATED_AGGRESSIVE_EDGE_PRESETS) {
            const edgeCandidate = blendPreviewResidualEdge({
                sourceImageData: edgeSource.imageData,
                alphaMap,
                position,
                ...preset
            });
            best = pickLocatedAggressiveCandidate(best, {
                imageData: edgeCandidate,
                alphaGain: edgeSource.alphaGain,
                repeatCount: edgeSource.repeatCount,
                edgeCleanup: true,
                ...scoreLocatedAggressiveCandidate({
                    imageData: edgeCandidate,
                    originalImageData,
                    alphaMap,
                    position,
                    alphaGain: edgeSource.alphaGain,
                    baselineGradientScore: currentGradientScore
                })
            });
        }
    }

    if (best.imageData === currentImageData) return null;
    const currentSpatialPassable = current.spatialScore <= LOCATED_AGGRESSIVE_PASSABLE_SPATIAL_THRESHOLD;
    const bestSpatialFails = best.spatialScore > LOCATED_AGGRESSIVE_PASSABLE_SPATIAL_THRESHOLD;
    const spatialDrift = best.spatialScore - current.spatialScore;
    if (
        currentSpatialPassable &&
        bestSpatialFails &&
        spatialDrift > LOCATED_AGGRESSIVE_MAX_PASSABLE_SPATIAL_DRIFT
    ) {
        if (typeof onRejected === 'function') {
            onRejected({
                strategy: 'located-aggressive-alpha',
                blockedGate: 'passable-spatial-drift',
                currentSpatialScore: current.spatialScore,
                candidateSpatialScore: best.spatialScore,
                spatialDrift,
                currentGradientScore: current.gradientScore,
                candidateGradientScore: best.gradientScore,
                currentCost: current.cost,
                candidateCost: best.cost,
                alphaGain: best.alphaGain,
                repeatCount: best.repeatCount,
                edgeCleanup: best.edgeCleanup === true
            });
        }
        return null;
    }
    if (best.cost > current.cost - LOCATED_AGGRESSIVE_MIN_BALANCED_GAIN) {
        if (typeof onRejected === 'function') {
            onRejected({
                strategy: 'located-aggressive-alpha',
                blockedGate: 'insufficient-balanced-gain',
                currentSpatialScore: current.spatialScore,
                candidateSpatialScore: best.spatialScore,
                spatialDrift: best.spatialScore - current.spatialScore,
                currentGradientScore: current.gradientScore,
                candidateGradientScore: best.gradientScore,
                currentCost: current.cost,
                candidateCost: best.cost,
                alphaGain: best.alphaGain,
                repeatCount: best.repeatCount,
                edgeCleanup: best.edgeCleanup === true
            });
        }
        return null;
    }
    return best;
}

function shouldSkipLocatedAggressiveForCleanCanonical96({
    config,
    alphaGain,
    originalSpatialScore,
    originalGradientScore,
    currentSpatialScore,
    currentGradientScore
}) {
    const resolvedAlphaGain = Number(alphaGain);
    const originalSpatial = Number(originalSpatialScore);
    const originalGradient = Number(originalGradientScore);
    const currentSpatial = Number(currentSpatialScore);
    const currentGradient = Number(currentGradientScore);
    if (
        !Number.isFinite(resolvedAlphaGain) ||
        !Number.isFinite(originalSpatial) ||
        !Number.isFinite(originalGradient) ||
        !Number.isFinite(currentSpatial) ||
        !Number.isFinite(currentGradient)
    ) {
        return false;
    }

    const cleanExactNewMarginVariant =
        config?.logoSize === 96 &&
        config.marginRight === 192 &&
        config.marginBottom === 192 &&
        config.alphaVariant === '20260520' &&
        resolvedAlphaGain <= 1.3 &&
        originalSpatial >= 0.18 &&
        originalSpatial < 0.4 &&
        originalGradient >= 0.05 &&
        originalGradient < 0.08;
    if (cleanExactNewMarginVariant) return true;

    const cleanFullStrengthNewMarginVariant =
        config?.logoSize === 96 &&
        config.marginRight === 192 &&
        config.marginBottom === 192 &&
        config.alphaVariant === '20260520' &&
        resolvedAlphaGain === 1 &&
        originalSpatial > 0 &&
        originalGradient >= FULL_STRENGTH_NEW_MARGIN_MIN_ORIGINAL_GRADIENT &&
        currentGradient <= FULL_STRENGTH_NEW_MARGIN_MAX_CURRENT_GRADIENT;
    if (cleanFullStrengthNewMarginVariant) return true;

    if (
        config?.logoSize !== 96 ||
        config.marginRight !== 64 ||
        config.marginBottom !== 64
    ) {
        return false;
    }

    const cleanStandardAlpha =
        resolvedAlphaGain <= 1 &&
        currentSpatial >= 0 &&
        currentSpatial <= 0.35 &&
        Math.max(0, currentGradient) <= 0.08;
    const cleanBalancedAlpha =
        resolvedAlphaGain <= 1.1 &&
        currentSpatial >= 0 &&
        currentSpatial <= 0.22 &&
        Math.max(0, currentGradient) <= 0.1;
    const cleanModerateSignalStandardAlpha =
        resolvedAlphaGain <= 1 &&
        currentSpatial >= 0 &&
        currentSpatial <= CANONICAL_96_MODERATE_SIGNAL_MAX_CURRENT_SPATIAL &&
        Math.max(0, currentGradient) <= CANONICAL_96_MODERATE_SIGNAL_MAX_CURRENT_GRADIENT;

    return (
        originalSpatial >= 0.55 &&
        originalGradient >= 0.2 &&
        (cleanStandardAlpha || cleanBalancedAlpha)
    ) || (
        originalSpatial >= CANONICAL_96_MODERATE_SIGNAL_MIN_ORIGINAL_SPATIAL &&
        originalGradient >= CANONICAL_96_MODERATE_SIGNAL_MIN_ORIGINAL_GRADIENT &&
        cleanModerateSignalStandardAlpha
    );
}

function isCanonical96Config(config) {
    return config?.logoSize === 96 &&
        config.marginRight === 64 &&
        config.marginBottom === 64;
}

function luminanceAt(imageData, pixelIndex) {
    return 0.2126 * imageData.data[pixelIndex] +
        0.7152 * imageData.data[pixelIndex + 1] +
        0.0722 * imageData.data[pixelIndex + 2];
}

function repairCanonical96DarkClipResidual({ sourceImageData, priorImageData, alphaMap, position }) {
    const candidate = cloneImageData(sourceImageData);

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = alphaMap[localIndex] ?? 0;
            if (alpha < CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_MIN_ALPHA) continue;

            const pixelIndex = ((position.y + row) * candidate.width + position.x + col) * 4;
            const sourceLum = luminanceAt(sourceImageData, pixelIndex);
            const priorLum = luminanceAt(priorImageData, pixelIndex);
            if (priorLum - sourceLum < CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_THRESHOLD) {
                continue;
            }

            const blend = clamp01(
                Math.pow(alpha, CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_GAMMA) *
                CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_STRENGTH
            );
            if (blend <= 0.005) continue;

            for (let channel = 0; channel < 3; channel++) {
                candidate.data[pixelIndex + channel] = clampChannel(
                    sourceImageData.data[pixelIndex + channel] * (1 - blend) +
                    priorImageData.data[pixelIndex + channel] * blend
                );
            }
        }
    }

    return candidate;
}

function refineCanonical96PositiveHaloResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore
}) {
    if (
        !isCanonical96Config(currentConfig) ||
        currentPosition?.width !== 96 ||
        currentPosition?.height !== 96 ||
        originalSpatialScore < CANONICAL_96_POSITIVE_HALO_RESCUE_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < CANONICAL_96_POSITIVE_HALO_RESCUE_MIN_ORIGINAL_GRADIENT ||
        Math.abs(currentSpatialScore) > CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_ABS_CURRENT_SPATIAL ||
        currentGradientScore > CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const baselineVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (
        baselineVisibility?.visiblePositiveHalo !== true ||
        (baselineVisibility.positiveHaloLum ?? 0) < CANONICAL_96_POSITIVE_HALO_RESCUE_MIN_HALO
    ) {
        return null;
    }

    const alphaMap = currentAlphaMap;
    const baseImageData = cloneImageData(originalImageData);
    removeWatermark(baseImageData, alphaMap, currentPosition, {
        alphaGain: CANONICAL_96_POSITIVE_HALO_RESCUE_ALPHA_GAIN
    });
    const priorImageData = buildPreviewNeighborhoodPrior({
        previewImageData: baseImageData,
        position: currentPosition,
        radius: CANONICAL_96_POSITIVE_HALO_RESCUE_REPAIR_RADIUS
    });
    const imageData = repairCanonical96DarkClipResidual({
        sourceImageData: baseImageData,
        priorImageData,
        alphaMap,
        position: currentPosition
    });

    const spatialScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: { x: currentPosition.x, y: currentPosition.y, size: currentPosition.width }
    });
    const gradientScore = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region: { x: currentPosition.x, y: currentPosition.y, size: currentPosition.width }
    });
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData,
        position: currentPosition,
        alphaMap
    });
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: imageData,
        alphaMap,
        position: currentPosition,
        alphaGain: CANONICAL_96_POSITIVE_HALO_RESCUE_ALPHA_GAIN
    });

    const haloReduction = (baselineVisibility.positiveHaloLum ?? 0) -
        (residualVisibility?.positiveHaloLum ?? 0);
    if (
        residualVisibility?.visible !== false ||
        (residualVisibility.positiveHaloLum ?? 0) > CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_POSITIVE_HALO ||
        haloReduction < CANONICAL_96_POSITIVE_HALO_RESCUE_MIN_HALO_REDUCTION ||
        Math.abs(spatialScore) > CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_SPATIAL ||
        gradientScore > CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_GRADIENT ||
        (artifacts?.visualArtifactCost ?? 0) > CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_VISUAL_ARTIFACT ||
        (artifacts?.newlyClippedRatio ?? 0) > CANONICAL_96_POSITIVE_HALO_RESCUE_MAX_NEWLY_CLIPPED
    ) {
        return null;
    }

    const originalSpatial = computeRegionSpatialCorrelation({
        imageData: originalImageData,
        alphaMap,
        region: { x: currentPosition.x, y: currentPosition.y, size: currentPosition.width }
    });
    const originalGradient = computeRegionGradientCorrelation({
        imageData: originalImageData,
        alphaMap,
        region: { x: currentPosition.x, y: currentPosition.y, size: currentPosition.width }
    });
    const balancedVisual = scoreBalancedVisualCandidate({
        processedSpatial: spatialScore,
        processedGradient: gradientScore,
        newlyClippedRatio: artifacts?.newlyClippedRatio,
        visualArtifactCost: artifacts?.visualArtifactCost
    });

    return {
        imageData,
        alphaMap,
        position: currentPosition,
        config: currentConfig,
        alphaGain: CANONICAL_96_POSITIVE_HALO_RESCUE_ALPHA_GAIN,
        originalSpatialScore: originalSpatial,
        originalGradientScore: originalGradient,
        spatialScore,
        gradientScore,
        residualVisibility,
        artifacts,
        haloReduction,
        suppressionGain: originalSpatial - spatialScore,
        cost: balancedVisual.score
    };
}

function shouldRelocateSmallFixedLocalAnchor({
    source,
    config,
    position,
    currentGradientScore,
    currentResidualVisibility
}) {
    const sourceText = String(source || '');
    if (!sourceText.includes('fixed-local')) return false;
    if (
        !position ||
        position.width !== position.height ||
        position.width < SMALL_ANCHOR_RELOCATION_MIN_SIZE ||
        position.width > SMALL_ANCHOR_RELOCATION_MAX_SIZE
    ) {
        return false;
    }
    if (
        !config ||
        config.logoSize < SMALL_ANCHOR_RELOCATION_MIN_SIZE ||
        config.logoSize > SMALL_ANCHOR_RELOCATION_MAX_SIZE
    ) {
        return false;
    }
    if (!currentResidualVisibility?.visible) return false;
    return currentResidualVisibility.visiblePositiveHalo === true ||
        currentGradientScore >= SMALL_ANCHOR_RELOCATION_MIN_CURRENT_GRADIENT;
}

function resolveRelocationAlphaMap({ size, currentAlphaMap, currentPosition, alpha96, getAlphaMap }) {
    if (size === currentPosition?.width) return currentAlphaMap;
    if (typeof getAlphaMap === 'function') {
        const resolved = getAlphaMap(size);
        if (resolved) return resolved;
    }
    return interpolateAlphaMap(alpha96, 96, size);
}

function createSmallAnchorRelocationGeometry({
    originalImageData,
    alphaMap,
    size,
    marginRight,
    marginBottom
}) {
    const position = {
        x: originalImageData.width - marginRight - size,
        y: originalImageData.height - marginBottom - size,
        width: size,
        height: size
    };
    if (
        position.x < 0 ||
        position.y < 0 ||
        position.x + size > originalImageData.width ||
        position.y + size > originalImageData.height
    ) {
        return null;
    }

    const originalSpatialScore = computeRegionSpatialCorrelation({
        imageData: originalImageData,
        alphaMap,
        region: { x: position.x, y: position.y, size }
    });
    if (originalSpatialScore < SMALL_ANCHOR_RELOCATION_MIN_ORIGINAL_SPATIAL) {
        return null;
    }

    const originalGradientScore = computeRegionGradientCorrelation({
        imageData: originalImageData,
        alphaMap,
        region: { x: position.x, y: position.y, size }
    });

    return {
        alphaMap,
        position,
        size,
        marginRight,
        marginBottom,
        originalSpatialScore,
        originalGradientScore,
        searchContext: createLocalAlphaSearchContext(
            originalImageData,
            position
        )
    };
}

function buildSmallAnchorRelocationScratchCandidate({
    geometry,
    alphaGain
}) {
    const {
        alphaMap,
        position,
        size,
        marginRight,
        marginBottom,
        originalSpatialScore,
        originalGradientScore,
        searchContext
    } = geometry;
    // Spatial and gradient gates only read the candidate ROI, so the translated
    // scratch result is an exact cheap prefilter. Do not make the final
    // visibility decision here: halo scoring is re-run on the full image below.
    const scratchPosition = searchContext.position;
    const scratchImageData = cloneImageData(searchContext.originalScratch);
    removeWatermark(scratchImageData, alphaMap, scratchPosition, { alphaGain });
    const spatialScore = computeRegionSpatialCorrelation({
        imageData: scratchImageData,
        alphaMap,
        region: {
            x: scratchPosition.x,
            y: scratchPosition.y,
            size
        }
    });
    const gradientScore = computeRegionGradientCorrelation({
        imageData: scratchImageData,
        alphaMap,
        region: {
            x: scratchPosition.x,
            y: scratchPosition.y,
            size
        }
    });
    const suppressionGain = originalSpatialScore - spatialScore;
    if (
        Math.abs(spatialScore) > SMALL_ANCHOR_RELOCATION_MAX_ACCEPTED_SPATIAL ||
        gradientScore > SMALL_ANCHOR_RELOCATION_MAX_ACCEPTED_GRADIENT ||
        suppressionGain < SMALL_ANCHOR_RELOCATION_MIN_SUPPRESSION_GAIN
    ) {
        return null;
    }

    return {
        scratchImageData,
        alphaMap,
        position,
        config: { logoSize: size, marginRight, marginBottom },
        alphaGain,
        originalSpatialScore,
        originalGradientScore,
        spatialScore,
        gradientScore,
        suppressionGain
    };
}

function materializeSmallAnchorRelocationCandidate({
    candidate,
    originalImageData
}) {
    // A scratch candidate cannot be selected directly. Rebuild and re-score it
    // on the full image so this optimization preserves the original decision.
    const imageData = cloneImageData(originalImageData);
    removeWatermark(imageData, candidate.alphaMap, candidate.position, {
        alphaGain: candidate.alphaGain
    });
    const size = candidate.position.width;
    const spatialScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap: candidate.alphaMap,
        region: {
            x: candidate.position.x,
            y: candidate.position.y,
            size
        }
    });
    const gradientScore = computeRegionGradientCorrelation({
        imageData,
        alphaMap: candidate.alphaMap,
        region: {
            x: candidate.position.x,
            y: candidate.position.y,
            size
        }
    });
    const suppressionGain = candidate.originalSpatialScore - spatialScore;
    if (
        Math.abs(spatialScore) > SMALL_ANCHOR_RELOCATION_MAX_ACCEPTED_SPATIAL ||
        gradientScore > SMALL_ANCHOR_RELOCATION_MAX_ACCEPTED_GRADIENT ||
        suppressionGain < SMALL_ANCHOR_RELOCATION_MIN_SUPPRESSION_GAIN
    ) {
        return null;
    }
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData,
        position: candidate.position,
        alphaMap: candidate.alphaMap
    });
    if (residualVisibility.visible) return null;

    const { scratchImageData, ...rest } = candidate;
    return {
        ...rest,
        imageData,
        spatialScore,
        gradientScore,
        suppressionGain,
        residualVisibility,
        cost: Math.abs(spatialScore) * 0.8 +
            Math.max(0, gradientScore) * 0.75 +
            Math.max(
                0,
                residualVisibility.positiveHaloLum ?? 0
            ) * 0.01
    };
}

function refineSmallFixedLocalAnchorGeometry({
    originalImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSource,
    currentGradientScore,
    currentResidualVisibility,
    alpha96,
    getAlphaMap
}) {
    if (!shouldRelocateSmallFixedLocalAnchor({
        source: currentSource,
        config: currentConfig,
        position: currentPosition,
        currentGradientScore,
        currentResidualVisibility
    })) {
        return null;
    }

    const currentSize = currentConfig.logoSize ?? currentPosition.width;
    const currentMarginRight = currentConfig.marginRight;
    const currentMarginBottom = currentConfig.marginBottom;
    if (![currentSize, currentMarginRight, currentMarginBottom].every(Number.isFinite)) {
        return null;
    }

    let best = null;
    const minSize = Math.max(SMALL_ANCHOR_RELOCATION_MIN_SIZE, currentSize);
    const maxSize = Math.min(SMALL_ANCHOR_RELOCATION_MAX_SIZE, currentSize + SMALL_ANCHOR_RELOCATION_SIZE_DELTA);
    const minMarginRight = Math.max(0, currentMarginRight - SMALL_ANCHOR_RELOCATION_MARGIN_DELTA);
    const maxMarginRight = currentMarginRight + SMALL_ANCHOR_RELOCATION_MARGIN_DELTA;
    const minMarginBottom = Math.max(0, currentMarginBottom - SMALL_ANCHOR_RELOCATION_MARGIN_DELTA);
    const maxMarginBottom = currentMarginBottom + SMALL_ANCHOR_RELOCATION_MARGIN_DELTA;

    for (let size = minSize; size <= maxSize; size++) {
        const alphaMap = resolveRelocationAlphaMap({
            size,
            currentAlphaMap,
            currentPosition,
            alpha96,
            getAlphaMap
        });
        if (!alphaMap) continue;

        for (let marginRight = minMarginRight; marginRight <= maxMarginRight; marginRight++) {
            for (let marginBottom = minMarginBottom; marginBottom <= maxMarginBottom; marginBottom++) {
                const candidateY = originalImageData.height - marginBottom - size;
                if (candidateY > currentPosition.y + 1) continue;
                const geometry = createSmallAnchorRelocationGeometry({
                    originalImageData,
                    alphaMap,
                    size,
                    marginRight,
                    marginBottom
                });
                if (!geometry) continue;
                for (const candidateAlphaGain of ALPHA_GAIN_CANDIDATES) {
                    const scratchCandidate = buildSmallAnchorRelocationScratchCandidate({
                        geometry,
                        alphaGain: candidateAlphaGain
                    });
                    if (!scratchCandidate) continue;
                    const candidate = materializeSmallAnchorRelocationCandidate({
                        candidate: scratchCandidate,
                        originalImageData
                    });
                    if (!candidate) continue;
                    if (!best || candidate.cost < best.cost) {
                        best = candidate;
                    }
                }
            }
        }
    }

    return best;
}

function isKnown48LargeMarginConfig(config) {
    if (!config || config.logoSize !== 48) return false;
    return Math.abs(Number(config.marginRight) - 96) <= 2 &&
        Math.abs(Number(config.marginBottom) - 96) <= 2;
}

function sharpenKnown48AlphaMap(alphaMap, size, amount) {
    const sharpened = new Float32Array(alphaMap.length);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let sum = 0;
            let count = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const sourceY = y + dy;
                if (sourceY < 0 || sourceY >= size) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const sourceX = x + dx;
                    if (sourceX < 0 || sourceX >= size) continue;
                    sum += alphaMap[sourceY * size + sourceX];
                    count++;
                }
            }
            const index = y * size + x;
            const blurred = count > 0 ? sum / count : alphaMap[index];
            sharpened[index] = Math.max(0, Math.min(0.99, alphaMap[index] + (alphaMap[index] - blurred) * amount));
        }
    }
    return sharpened;
}

function scaleKnown48AlphaBand(alphaMap, { minAlpha, maxAlpha, scale }) {
    const scaled = new Float32Array(alphaMap.length);
    for (let index = 0; index < alphaMap.length; index++) {
        const alpha = alphaMap[index];
        scaled[index] = alpha >= minAlpha && alpha <= maxAlpha
            ? Math.max(0, Math.min(0.99, alpha * scale))
            : alpha;
    }
    return scaled;
}

function powerKnown48AlphaMap(alphaMap, exponent) {
    const transformed = new Float32Array(alphaMap.length);
    for (let index = 0; index < alphaMap.length; index++) {
        transformed[index] = Math.max(0, Math.min(0.99, Math.pow(alphaMap[index], exponent)));
    }
    return transformed;
}

function scoreKnown48AntiTemplateRescueCandidate({
    originalImageData,
    alphaMap,
    position,
    alphaGain,
    baselineGradientScore,
    logoValue = undefined,
    maxSpatial = KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_SPATIAL,
    maxVisualArtifact = KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_VISUAL_ARTIFACT
}) {
    const imageData = cloneImageData(originalImageData);
    removeWatermark(imageData, alphaMap, position, { alphaGain, logoValue });
    const spatialScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const gradientScore = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    if (
        Math.abs(spatialScore) > maxSpatial ||
        Math.max(0, gradientScore) > KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_GRADIENT
    ) {
        return null;
    }

    const residualVisibility = assessWatermarkResidualVisibility({
        imageData,
        position,
        alphaMap
    });
    if (residualVisibility?.visible !== false) return null;

    const nearBlackRatio = calculateNearBlackRatio(imageData, position);
    const baselineNearBlackRatio = calculateNearBlackRatio(originalImageData, position);
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: imageData,
        alphaMap,
        position,
        alphaGain
    });
    const darkHaloLum = Math.max(0, -(artifacts?.halo?.deltaLum ?? 0));
    const visualArtifactCost = artifacts?.visualArtifactCost ?? 0;
    if (
        darkHaloLum > KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_DARK_HALO ||
        visualArtifactCost > maxVisualArtifact
    ) {
        return null;
    }
    const balancedVisual = scoreBalancedVisualCandidate({
        processedSpatial: spatialScore,
        processedGradient: gradientScore,
        nearBlackIncrease: nearBlackRatio - baselineNearBlackRatio,
        newlyClippedRatio: artifacts?.newlyClippedRatio,
        darkHaloLum,
        visualArtifactCost,
        gradientIncrease: Number.isFinite(baselineGradientScore)
            ? gradientScore - baselineGradientScore
            : 0
    });

    return {
        imageData,
        alphaMap,
        position,
        config: {
            logoSize: position.width,
            marginRight: originalImageData.width - position.x - position.width,
            marginBottom: originalImageData.height - position.y - position.height
        },
        alphaGain,
        logoValue,
        spatialScore,
        gradientScore,
        residualVisibility,
        nearBlackRatio,
        artifacts,
        balancedVisual,
        cost: balancedVisual.score
    };
}

function refineLargeMargin48ProfileAlphaRescue({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore
}) {
    if (
        !isKnown48LargeMarginConfig(currentConfig) ||
        currentPosition?.width !== 48 ||
        currentPosition?.height !== 48 ||
        currentAlphaGain !== 1 ||
        originalSpatialScore < LARGE_MARGIN_48_PROFILE_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < LARGE_MARGIN_48_PROFILE_MIN_ORIGINAL_GRADIENT ||
        Math.abs(currentSpatialScore) > LARGE_MARGIN_48_PROFILE_MAX_ABS_CURRENT_SPATIAL ||
        currentGradientScore > LARGE_MARGIN_48_PROFILE_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (
        currentVisibility?.visible !== true ||
        currentVisibility.positiveHaloLum < LARGE_MARGIN_48_PROFILE_MIN_CURRENT_POSITIVE_HALO
    ) {
        return null;
    }

    const currentArtifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: currentImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition,
        alphaGain: currentAlphaGain
    });
    const currentClippedRatio = currentArtifacts?.newlyClippedRatio ?? 0;
    if (
        currentClippedRatio < LARGE_MARGIN_48_PROFILE_MIN_CURRENT_CLIPPED_RATIO ||
        currentClippedRatio > LARGE_MARGIN_48_PROFILE_MAX_CURRENT_CLIPPED_RATIO ||
        (currentArtifacts?.visualArtifactCost ?? Infinity) >
            LARGE_MARGIN_48_PROFILE_MAX_CURRENT_ARTIFACT
    ) {
        return null;
    }

    const profileAlphaMap = powerKnown48AlphaMap(
        currentAlphaMap,
        LARGE_MARGIN_48_PROFILE_ALPHA_RESCUE.exponent
    );
    const candidate = scoreKnown48AntiTemplateRescueCandidate({
        originalImageData,
        alphaMap: profileAlphaMap,
        position: currentPosition,
        alphaGain: LARGE_MARGIN_48_PROFILE_ALPHA_RESCUE.alphaGain,
        baselineGradientScore: currentGradientScore,
        maxSpatial: LARGE_MARGIN_48_PROFILE_MAX_SPATIAL,
        maxVisualArtifact: LARGE_MARGIN_48_PROFILE_MAX_ARTIFACT
    });
    if (
        !candidate ||
        candidate.residualVisibility?.visible !== false ||
        candidate.gradientScore > LARGE_MARGIN_48_PROFILE_MAX_GRADIENT ||
        candidate.residualVisibility.positiveHaloLum >
            LARGE_MARGIN_48_PROFILE_MAX_POSITIVE_HALO ||
        (candidate.artifacts?.newlyClippedRatio ?? Infinity) >
            LARGE_MARGIN_48_PROFILE_MAX_CLIPPED_RATIO ||
        (candidate.artifacts?.visualArtifactCost ?? Infinity) >
            LARGE_MARGIN_48_PROFILE_MAX_ARTIFACT
    ) {
        return null;
    }

    return {
        ...candidate,
        alphaMapSource: 'known-48-power-0.90',
        profileExponent: LARGE_MARGIN_48_PROFILE_ALPHA_RESCUE.exponent,
        originalSpatialScore,
        originalGradientScore,
        suppressionGain: originalSpatialScore - candidate.spatialScore
    };
}

function refineKnown48AntiTemplateResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore
}) {
    const hasStrongOriginalEvidence =
        originalSpatialScore >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_SPATIAL &&
        originalGradientScore >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_GRADIENT;
    const hasWeakOriginalEvidence =
        originalSpatialScore >= KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_SPATIAL &&
        originalGradientScore >= KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_GRADIENT;
    const hasMidBoostEntryEvidence =
        originalSpatialScore < KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_SPATIAL &&
        currentSpatialScore <= KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_CURRENT_SPATIAL &&
        currentGradientScore <= KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_CURRENT_GRADIENT;

    if (
        !isKnown48LargeMarginConfig(currentConfig) ||
        !currentPosition ||
        currentPosition.width !== currentPosition.height ||
        (!hasStrongOriginalEvidence && !hasWeakOriginalEvidence && !hasMidBoostEntryEvidence) ||
        currentSpatialScore > KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_CURRENT_SPATIAL ||
        Math.max(0, currentGradientScore) > KNOWN_48_ANTI_TEMPLATE_RESCUE_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (currentVisibility?.visible !== true || currentVisibility.visiblePositiveHalo === true) return null;

    const currentScore = scoreKnown48AntiTemplateRescueCandidate({
        originalImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition,
        alphaGain: currentAlphaGain,
        baselineGradientScore: currentGradientScore
    });
    const currentCost = currentScore?.cost ?? scoreLocatedAggressiveCandidate({
        imageData: currentImageData,
        originalImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition,
        alphaGain: currentAlphaGain,
        baselineGradientScore: currentGradientScore
    }).cost;
    let best = null;
    const minSize = Math.max(KNOWN_48_EDGE_CLEANUP_MIN_SIZE, currentConfig.logoSize - 2);
    const maxSize = Math.min(KNOWN_48_EDGE_CLEANUP_MAX_SIZE, currentConfig.logoSize + 1);
    const minMarginRight = Math.max(0, currentConfig.marginRight - 1);
    const maxMarginRight = currentConfig.marginRight + 2;
    const minMarginBottom = Math.max(0, currentConfig.marginBottom - 1);
    const maxMarginBottom = currentConfig.marginBottom + 2;

    for (let size = minSize; size <= maxSize; size++) {
        const alphaMap = size === currentPosition.width
            ? currentAlphaMap
            : interpolateAlphaMap(currentAlphaMap, currentPosition.width, size);
        if (!alphaMap) continue;

        for (let marginRight = minMarginRight; marginRight <= maxMarginRight; marginRight++) {
            for (let marginBottom = minMarginBottom; marginBottom <= maxMarginBottom; marginBottom++) {
                const position = {
                    x: originalImageData.width - marginRight - size,
                    y: originalImageData.height - marginBottom - size,
                    width: size,
                    height: size
                };
                if (
                    position.x < 0 ||
                    position.y < 0 ||
                    position.x + size > originalImageData.width ||
                    position.y + size > originalImageData.height
                ) {
                    continue;
                }
                const originalSpatial = computeRegionSpatialCorrelation({
                    imageData: originalImageData,
                    alphaMap,
                    region: { x: position.x, y: position.y, size }
                });
                const originalGradient = computeRegionGradientCorrelation({
                    imageData: originalImageData,
                    alphaMap,
                    region: { x: position.x, y: position.y, size }
                });
                const hasCandidateStrongEvidence =
                    originalSpatial >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_SPATIAL &&
                    originalGradient >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_GRADIENT;
                const hasCandidateWeakEvidence =
                    originalSpatial >= KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_SPATIAL &&
                    originalGradient >= KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_GRADIENT;
                if (!hasCandidateStrongEvidence && !hasCandidateWeakEvidence) {
                    continue;
                }

                for (const alphaGain of KNOWN_48_ANTI_TEMPLATE_RESCUE_GAINS) {
                    const candidate = scoreKnown48AntiTemplateRescueCandidate({
                        originalImageData,
                        alphaMap,
                        position,
                        alphaGain,
                        baselineGradientScore: currentGradientScore
                    });
                    if (!candidate) continue;
                    if (!best || candidate.cost < best.cost) {
                        best = {
                            ...candidate,
                            originalSpatialScore: originalSpatial,
                            originalGradientScore: originalGradient,
                            suppressionGain: originalSpatial - candidate.spatialScore
                        };
                    }
                }
            }
        }
    }

    if (currentPosition.width === 48 && currentPosition.height === 48) {
        const sharpenedAlphaMap = sharpenKnown48AlphaMap(
            currentAlphaMap,
            48,
            KNOWN_48_ANTI_TEMPLATE_RESCUE_SHARPEN_AMOUNT
        );
        const sharpenedOriginalSpatial = computeRegionSpatialCorrelation({
            imageData: originalImageData,
            alphaMap: sharpenedAlphaMap,
            region: { x: currentPosition.x, y: currentPosition.y, size: 48 }
        });
        const sharpenedOriginalGradient = computeRegionGradientCorrelation({
            imageData: originalImageData,
            alphaMap: sharpenedAlphaMap,
            region: { x: currentPosition.x, y: currentPosition.y, size: 48 }
        });
        const hasSharpenedStrongEvidence =
            sharpenedOriginalSpatial >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_SPATIAL &&
            sharpenedOriginalGradient >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_GRADIENT;
        const hasSharpenedWeakEvidence =
            sharpenedOriginalSpatial >= KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_SPATIAL &&
            sharpenedOriginalGradient >= KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_GRADIENT;
        if (hasSharpenedStrongEvidence || hasSharpenedWeakEvidence) {
            const sharpenedCandidate = scoreKnown48AntiTemplateRescueCandidate({
                originalImageData,
                alphaMap: sharpenedAlphaMap,
                position: currentPosition,
                alphaGain: KNOWN_48_ANTI_TEMPLATE_RESCUE_SHARPEN_ALPHA_GAIN,
                baselineGradientScore: currentGradientScore
            });
            if (sharpenedCandidate && (!best || sharpenedCandidate.cost < best.cost)) {
                best = {
                    ...sharpenedCandidate,
                    originalSpatialScore: sharpenedOriginalSpatial,
                    originalGradientScore: sharpenedOriginalGradient,
                    suppressionGain: sharpenedOriginalSpatial - sharpenedCandidate.spatialScore
                };
            }
        }

        if (
            currentSpatialScore <= KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MAX_CURRENT_SPATIAL &&
            currentGradientScore <= KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MAX_CURRENT_GRADIENT
        ) {
            const coreDampenedAlphaMap = scaleKnown48AlphaBand(currentAlphaMap, {
                minAlpha: KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MIN_ALPHA,
                maxAlpha: KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MAX_ALPHA,
                scale: KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_SCALE
            });
            const coreDampenedOriginalSpatial = computeRegionSpatialCorrelation({
                imageData: originalImageData,
                alphaMap: coreDampenedAlphaMap,
                region: { x: currentPosition.x, y: currentPosition.y, size: 48 }
            });
            const coreDampenedOriginalGradient = computeRegionGradientCorrelation({
                imageData: originalImageData,
                alphaMap: coreDampenedAlphaMap,
                region: { x: currentPosition.x, y: currentPosition.y, size: 48 }
            });
            const hasCoreDampenedStrongEvidence =
                coreDampenedOriginalSpatial >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_SPATIAL &&
                coreDampenedOriginalGradient >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_ORIGINAL_GRADIENT;
            const hasCoreDampenedWeakEvidence =
                coreDampenedOriginalSpatial >= KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_SPATIAL &&
                coreDampenedOriginalGradient >= KNOWN_48_ANTI_TEMPLATE_RESCUE_WEAK_MIN_ORIGINAL_GRADIENT;
            if (hasCoreDampenedStrongEvidence || hasCoreDampenedWeakEvidence) {
                const coreDampenedCandidate = scoreKnown48AntiTemplateRescueCandidate({
                    originalImageData,
                    alphaMap: coreDampenedAlphaMap,
                    position: currentPosition,
                    alphaGain: KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_ALPHA_GAIN,
                    baselineGradientScore: currentGradientScore,
                    maxSpatial: KNOWN_48_ANTI_TEMPLATE_RESCUE_CORE_DAMPEN_MAX_SPATIAL
                });
                if (coreDampenedCandidate && (!best || coreDampenedCandidate.cost < best.cost)) {
                    best = {
                        ...coreDampenedCandidate,
                        originalSpatialScore: coreDampenedOriginalSpatial,
                        originalGradientScore: coreDampenedOriginalGradient,
                        suppressionGain: coreDampenedOriginalSpatial - coreDampenedCandidate.spatialScore
                    };
                }
            }
        }

        if (
            hasMidBoostEntryEvidence &&
            currentSpatialScore <= KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_CURRENT_SPATIAL &&
            currentGradientScore <= KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_CURRENT_GRADIENT
        ) {
            const midBoostBaseAlphaMap = interpolateAlphaMap(
                currentAlphaMap,
                currentPosition.width,
                KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_SIZE
            );
            if (midBoostBaseAlphaMap) {
                const midBoostAlphaMap = scaleKnown48AlphaBand(midBoostBaseAlphaMap, {
                    minAlpha: KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MIN_ALPHA,
                    maxAlpha: KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_ALPHA,
                    scale: KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_SCALE
                });
                const midBoostPosition = {
                    x: originalImageData.width -
                        KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MARGIN -
                        KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_SIZE,
                    y: originalImageData.height -
                        KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MARGIN -
                        KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_SIZE,
                    width: KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_SIZE,
                    height: KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_SIZE
                };
                if (
                    midBoostPosition.x >= 0 &&
                    midBoostPosition.y >= 0 &&
                    midBoostPosition.x + midBoostPosition.width <= originalImageData.width &&
                    midBoostPosition.y + midBoostPosition.height <= originalImageData.height
                ) {
                    const midBoostOriginalSpatial = computeRegionSpatialCorrelation({
                        imageData: originalImageData,
                        alphaMap: midBoostAlphaMap,
                        region: {
                            x: midBoostPosition.x,
                            y: midBoostPosition.y,
                            size: midBoostPosition.width
                        }
                    });
                    const midBoostOriginalGradient = computeRegionGradientCorrelation({
                        imageData: originalImageData,
                        alphaMap: midBoostAlphaMap,
                        region: {
                            x: midBoostPosition.x,
                            y: midBoostPosition.y,
                            size: midBoostPosition.width
                        }
                    });
                    if (
                        midBoostOriginalSpatial >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MIN_ORIGINAL_SPATIAL &&
                        midBoostOriginalGradient >= KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MIN_ORIGINAL_GRADIENT
                    ) {
                        const midBoostCandidate = scoreKnown48AntiTemplateRescueCandidate({
                            originalImageData,
                            alphaMap: midBoostAlphaMap,
                            position: midBoostPosition,
                            alphaGain: KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_ALPHA_GAIN,
                            baselineGradientScore: currentGradientScore,
                            maxSpatial: KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_SPATIAL,
                            maxVisualArtifact: KNOWN_48_ANTI_TEMPLATE_RESCUE_MID_BOOST_MAX_VISUAL_ARTIFACT
                        });
                        if (midBoostCandidate && (!best || midBoostCandidate.cost < best.cost)) {
                            best = {
                                ...midBoostCandidate,
                                originalSpatialScore: midBoostOriginalSpatial,
                                originalGradientScore: midBoostOriginalGradient,
                                suppressionGain: midBoostOriginalSpatial - midBoostCandidate.spatialScore
                            };
                        }
                    }
                }
            }
        }
    }

    if (!best) return null;
    if (best.cost > currentCost - KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_BALANCED_GAIN) return null;
    return best;
}

function refineKnown48PowerProfileResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore
}) {
    if (
        !isKnown48LargeMarginConfig(currentConfig) ||
        currentPosition?.width !== 48 ||
        currentPosition?.height !== 48 ||
        originalSpatialScore < KNOWN_48_POWER_PROFILE_RESCUE_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < KNOWN_48_POWER_PROFILE_RESCUE_MIN_ORIGINAL_GRADIENT ||
        currentSpatialScore < KNOWN_48_POWER_PROFILE_RESCUE_MIN_CURRENT_SPATIAL ||
        currentGradientScore > KNOWN_48_POWER_PROFILE_RESCUE_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (
        currentVisibility?.visible !== true ||
        currentVisibility.visibleSpatialResidual !== true ||
        currentVisibility.visiblePositiveHalo === true
    ) {
        return null;
    }

    const currentCost = scoreLocatedAggressiveCandidate({
        imageData: currentImageData,
        originalImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition,
        alphaGain: currentAlphaGain,
        baselineGradientScore: currentGradientScore
    }).cost;
    let best = null;
    for (const profile of KNOWN_48_POWER_PROFILE_RESCUE_CANDIDATES) {
        const powerAlphaMap = powerKnown48AlphaMap(currentAlphaMap, profile.exponent);
        const candidate = scoreKnown48AntiTemplateRescueCandidate({
            originalImageData,
            alphaMap: powerAlphaMap,
            position: currentPosition,
            alphaGain: profile.alphaGain,
            baselineGradientScore: currentGradientScore,
            maxSpatial: profile.maxSpatial
        });
        if (!candidate) continue;
        const clearsVisibleSpatialResidual =
            currentVisibility.visibleSpatialResidual === true &&
            candidate.residualVisibility?.visible === false &&
            Math.abs(currentSpatialScore) - Math.abs(candidate.spatialScore) >= 0.25;
        if (
            !clearsVisibleSpatialResidual &&
            candidate.cost > currentCost - KNOWN_48_ANTI_TEMPLATE_RESCUE_MIN_BALANCED_GAIN
        ) {
            continue;
        }
        best = {
            ...candidate,
            profileExponent: profile.exponent
        };
        break;
    }
    if (!best) {
        return null;
    }

    return {
        ...best,
        originalSpatialScore,
        originalGradientScore,
        suppressionGain: originalSpatialScore - best.spatialScore
    };
}

function refineKnown48PositiveResidualRebalance({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore
}) {
    if (
        !currentConfig ||
        currentConfig.logoSize !== 48 ||
        !(
            (Math.abs(Number(currentConfig.marginRight) - 96) <= 2 &&
                Math.abs(Number(currentConfig.marginBottom) - 96) <= 2) ||
            (Math.abs(Number(currentConfig.marginRight) - 32) <= 2 &&
                Math.abs(Number(currentConfig.marginBottom) - 32) <= 2)
        ) ||
        currentPosition?.width !== 48 ||
        currentPosition?.height !== 48 ||
        originalSpatialScore < KNOWN_48_RESIDUAL_REBALANCE_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < KNOWN_48_RESIDUAL_REBALANCE_MIN_ORIGINAL_GRADIENT ||
        currentSpatialScore < KNOWN_48_RESIDUAL_REBALANCE_MIN_CURRENT_SPATIAL ||
        currentGradientScore > KNOWN_48_RESIDUAL_REBALANCE_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (currentVisibility?.visibleSpatialResidual !== true) return null;

    const currentPositiveHalo = Math.max(0, currentVisibility?.positiveHaloLum ?? 0);
    let best = null;
    const candidateProfiles = [{
        alphaMap: currentAlphaMap,
        profileExponent: null,
        gains: [
            ...KNOWN_48_RESIDUAL_REBALANCE_GAINS,
            Number((currentAlphaGain + 0.02).toFixed(2)),
            Number((currentAlphaGain + 0.05).toFixed(2)),
            Number((currentAlphaGain + 0.1).toFixed(2))
        ]
    }];
    for (const profile of KNOWN_48_RESIDUAL_REBALANCE_POWER_PROFILES) {
        candidateProfiles.push({
            alphaMap: powerKnown48AlphaMap(currentAlphaMap, profile.exponent),
            profileExponent: profile.exponent,
            gains: profile.gains
        });
    }

    for (const profile of candidateProfiles) {
        const gainCandidates = new Set(profile.gains);
        for (const alphaGain of gainCandidates) {
            if (!Number.isFinite(alphaGain) || alphaGain <= 0) continue;

            const imageData = cloneImageData(originalImageData);
            removeWatermark(imageData, profile.alphaMap, currentPosition, { alphaGain });
            const spatialScore = computeRegionSpatialCorrelation({
                imageData,
                alphaMap: profile.alphaMap,
                region: {
                    x: currentPosition.x,
                    y: currentPosition.y,
                    size: currentPosition.width
                }
            });
            const gradientScore = computeRegionGradientCorrelation({
                imageData,
                alphaMap: profile.alphaMap,
                region: {
                    x: currentPosition.x,
                    y: currentPosition.y,
                    size: currentPosition.width
                }
            });
            if (
                spatialScore >= KNOWN_48_RESIDUAL_REBALANCE_MAX_ACCEPTED_SPATIAL ||
                Math.abs(spatialScore) > KNOWN_48_RESIDUAL_REBALANCE_MAX_ACCEPTED_SPATIAL ||
                gradientScore > KNOWN_48_RESIDUAL_REBALANCE_MAX_ACCEPTED_GRADIENT
            ) {
                continue;
            }

            const residualVisibility = assessWatermarkResidualVisibility({
                imageData,
                position: currentPosition,
                alphaMap: profile.alphaMap
            });
            const positiveHaloDrop = currentPositiveHalo - Math.max(0, residualVisibility?.positiveHaloLum ?? 0);
            const lowVisibleHaloAccepted =
                residualVisibility?.visible === false &&
                Math.max(0, residualVisibility?.positiveHaloLum ?? 0) <=
                    KNOWN_48_RESIDUAL_REBALANCE_MAX_CLEARED_POSITIVE_HALO;
            if (
                residualVisibility?.visibleSpatialResidual === true ||
                (
                    positiveHaloDrop < KNOWN_48_RESIDUAL_REBALANCE_MIN_POSITIVE_HALO_DROP &&
                    !lowVisibleHaloAccepted
                )
            ) {
                continue;
            }

            const artifacts = assessRemovalDiffArtifacts({
                originalImageData,
                candidateImageData: imageData,
                alphaMap: profile.alphaMap,
                position: currentPosition,
                alphaGain
            });
            const darkHaloLum = Math.max(0, -(artifacts?.halo?.deltaLum ?? 0));
            const visualArtifactCost = artifacts?.visualArtifactCost ?? Number.POSITIVE_INFINITY;
            const newlyClippedRatio = artifacts?.newlyClippedRatio ?? 0;
            if (
                darkHaloLum > KNOWN_48_RESIDUAL_REBALANCE_MAX_DARK_HALO ||
                visualArtifactCost > KNOWN_48_RESIDUAL_REBALANCE_MAX_VISUAL_ARTIFACT ||
                newlyClippedRatio > KNOWN_48_RESIDUAL_REBALANCE_MAX_CLIPPED_RATIO
            ) {
                continue;
            }

            const cost =
                Math.abs(spatialScore) +
                Math.max(0, gradientScore) * 0.7 +
                visualArtifactCost * 0.35;
            if (!best || cost < best.cost) {
                best = {
                    imageData,
                    alphaMap: profile.alphaMap,
                    alphaGain,
                    profileExponent: profile.profileExponent,
                    spatialScore,
                    gradientScore,
                    residualVisibility,
                    artifacts,
                    darkHaloLum,
                    positiveHaloDrop,
                    suppressionGain: originalSpatialScore - spatialScore,
                    cost
                };
            }
        }
    }

    return best;
}

function applyKnown48BoundaryRepair({
    imageData,
    priorImageData,
    alphaMap,
    position,
    preset = KNOWN_48_BOUNDARY_REPAIR_RESCUE_PRESET
}) {
    const candidate = cloneImageData(imageData);
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = Math.abs(alphaMap[localIndex] ?? 0);
            if (alpha < preset.minAlpha || alpha > preset.maxAlpha) continue;

            const blend = clamp01(Math.pow(alpha, preset.gamma) * preset.strength);
            if (blend <= 0.005) continue;

            const pixelIndex = ((position.y + row) * candidate.width + position.x + col) * 4;
            for (let channel = 0; channel < 3; channel++) {
                candidate.data[pixelIndex + channel] = clampChannel(
                    imageData.data[pixelIndex + channel] * (1 - blend) +
                    priorImageData.data[pixelIndex + channel] * blend
                );
            }
        }
    }
    return candidate;
}

function scoreKnown48BoundaryRepairCandidate({
    originalImageData,
    imageData,
    alphaMap,
    position,
    alphaGain,
    baselineGradientScore
}) {
    const locatedScore = scoreLocatedAggressiveCandidate({
        imageData,
        originalImageData,
        alphaMap,
        position,
        alphaGain,
        baselineGradientScore
    });
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData,
        position,
        alphaMap
    });
    const calibratedVisibility = assessCalibratedWatermarkResidualVisibility({
        imageData,
        originalImageData,
        position,
        alphaMap,
        alphaGain
    });
    return {
        ...locatedScore,
        residualVisibility,
        calibratedVisibility,
        visualArtifactCost: locatedScore.artifacts?.visualArtifactCost ?? 0
    };
}

function refineKnown48BoundaryRepairResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore
}) {
    if (
        !isKnown48LargeMarginConfig(currentConfig) ||
        currentPosition?.width !== 48 ||
        currentPosition?.height !== 48 ||
        originalSpatialScore < KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_ORIGINAL_GRADIENT ||
        currentSpatialScore < KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_CURRENT_SPATIAL ||
        currentSpatialScore > KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_CURRENT_SPATIAL ||
        currentGradientScore < KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_CURRENT_GRADIENT ||
        currentGradientScore > KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (currentVisibility?.visible !== true) {
        return null;
    }

    const currentNearBlackRatio = calculateNearBlackRatio(currentImageData, currentPosition);
    if (currentNearBlackRatio < KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_NEAR_BLACK_RATIO) {
        return null;
    }

    const beforeScore = scoreKnown48BoundaryRepairCandidate({
        originalImageData,
        imageData: currentImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition,
        alphaGain: currentAlphaGain,
        baselineGradientScore: currentGradientScore
    });
    const priorImageData = buildPreviewNeighborhoodPrior({
        previewImageData: currentImageData,
        position: currentPosition,
        radius: KNOWN_48_BOUNDARY_REPAIR_RESCUE_PRESET.radius
    });
    const candidateImageData = applyKnown48BoundaryRepair({
        imageData: currentImageData,
        priorImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition
    });
    const afterScore = scoreKnown48BoundaryRepairCandidate({
        originalImageData,
        imageData: candidateImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition,
        alphaGain: currentAlphaGain,
        baselineGradientScore: currentGradientScore
    });
    const balancedGain = beforeScore.cost - afterScore.cost;
    const artifactDelta = afterScore.visualArtifactCost - beforeScore.visualArtifactCost;
    if (
        afterScore.residualVisibility?.visible !== false ||
        afterScore.calibratedVisibility?.calibratedVisible !== false ||
        afterScore.spatialScore > KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_SPATIAL ||
        afterScore.gradientScore > KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_GRADIENT ||
        afterScore.visualArtifactCost > KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_ARTIFACT ||
        balancedGain < KNOWN_48_BOUNDARY_REPAIR_RESCUE_MIN_BALANCED_GAIN ||
        artifactDelta > KNOWN_48_BOUNDARY_REPAIR_RESCUE_MAX_ARTIFACT_DELTA
    ) {
        return null;
    }

    return {
        imageData: candidateImageData,
        position: currentPosition,
        config: currentConfig,
        alphaMap: currentAlphaMap,
        alphaGain: currentAlphaGain,
        spatialScore: afterScore.spatialScore,
        gradientScore: afterScore.gradientScore,
        originalSpatialScore,
        originalGradientScore,
        suppressionGain: currentSpatialScore - afterScore.spatialScore,
        balancedGain,
        artifactDelta,
        cost: afterScore.cost
    };
}

function refineKnown48SmallMarginPriorRepairResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore,
    source
}) {
    if (
        typeof source !== 'string' ||
        !source.includes('located-aggressive') ||
        currentConfig?.logoSize !== 48 ||
        Math.abs(Number(currentConfig.marginRight) - 32) > 2 ||
        Math.abs(Number(currentConfig.marginBottom) - 32) > 2 ||
        currentPosition?.width !== 48 ||
        currentPosition?.height !== 48 ||
        originalSpatialScore < KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MIN_ORIGINAL_GRADIENT ||
        currentSpatialScore < KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MIN_CURRENT_SPATIAL ||
        currentGradientScore > KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (currentVisibility?.visibleSpatialResidual !== true) return null;

    let best = null;
    const priorByRadius = new Map();
    for (const preset of KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_PRESETS) {
        let priorImageData = priorByRadius.get(preset.radius);
        if (!priorImageData) {
            priorImageData = buildPreviewNeighborhoodPrior({
                previewImageData: currentImageData,
                position: currentPosition,
                radius: preset.radius
            });
            priorByRadius.set(preset.radius, priorImageData);
        }

        const candidateImageData = applyKnown48BoundaryRepair({
            imageData: currentImageData,
            priorImageData,
            alphaMap: currentAlphaMap,
            position: currentPosition,
            preset
        });
        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidateImageData,
            alphaMap: currentAlphaMap,
            region: {
                x: currentPosition.x,
                y: currentPosition.y,
                size: currentPosition.width
            }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidateImageData,
            alphaMap: currentAlphaMap,
            region: {
                x: currentPosition.x,
                y: currentPosition.y,
                size: currentPosition.width
            }
        });
        const spatialImprovement = Math.abs(currentSpatialScore) - Math.abs(spatialScore);
        if (
            spatialImprovement < KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MIN_SPATIAL_IMPROVEMENT ||
            spatialScore > KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_SPATIAL ||
            Math.abs(spatialScore) > KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_SPATIAL ||
            gradientScore > KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_GRADIENT
        ) {
            continue;
        }

        const residualVisibility = assessWatermarkResidualVisibility({
            imageData: candidateImageData,
            position: currentPosition,
            alphaMap: currentAlphaMap
        });
        if (residualVisibility?.visible !== false) continue;

        const artifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData,
            alphaMap: currentAlphaMap,
            position: currentPosition,
            alphaGain: currentAlphaGain
        });
        const visualArtifactCost = artifacts?.visualArtifactCost ?? Number.POSITIVE_INFINITY;
        const newlyClippedRatio = artifacts?.newlyClippedRatio ?? Number.POSITIVE_INFINITY;
        const darkHaloLum = Math.max(0, -(artifacts?.halo?.deltaLum ?? 0));
        if (
            visualArtifactCost > KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_ARTIFACT ||
            newlyClippedRatio > KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_CLIPPED ||
            darkHaloLum > KNOWN_48_SMALL_MARGIN_PRIOR_REPAIR_MAX_DARK_HALO
        ) {
            continue;
        }

        const cost =
            Math.abs(spatialScore) +
            Math.max(0, gradientScore) * 0.7 +
            visualArtifactCost * 0.35;
        if (!best || cost < best.cost) {
            best = {
                imageData: candidateImageData,
                alphaMap: currentAlphaMap,
                position: currentPosition,
                config: currentConfig,
                alphaGain: currentAlphaGain,
                spatialScore,
                gradientScore,
                residualVisibility,
                artifacts,
                spatialImprovement,
                suppressionGain: originalSpatialScore - spatialScore,
                preset,
                cost
            };
        }
    }

    return best;
}

function refineProjectedSmallDarkSupportResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore,
    source
}) {
    const marginRight = Number(currentConfig?.marginRight);
    const marginBottom = Number(currentConfig?.marginBottom);
    if (
        typeof source !== 'string' ||
        !source.includes('preview-anchor') ||
        !source.includes('located-aggressive') ||
        currentPosition?.width !== PROJECTED_SMALL_DARK_SUPPORT_SIZE ||
        currentPosition?.height !== PROJECTED_SMALL_DARK_SUPPORT_SIZE ||
        currentConfig?.logoSize !== PROJECTED_SMALL_DARK_SUPPORT_SIZE ||
        currentConfig?.alphaVariant ||
        !Number.isFinite(marginRight) ||
        !Number.isFinite(marginBottom) ||
        marginRight < PROJECTED_SMALL_DARK_SUPPORT_MIN_MARGIN ||
        marginRight > PROJECTED_SMALL_DARK_SUPPORT_MAX_MARGIN ||
        marginBottom < PROJECTED_SMALL_DARK_SUPPORT_MIN_MARGIN ||
        marginBottom > PROJECTED_SMALL_DARK_SUPPORT_MAX_MARGIN ||
        originalSpatialScore < PROJECTED_SMALL_DARK_SUPPORT_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < PROJECTED_SMALL_DARK_SUPPORT_MIN_ORIGINAL_GRADIENT ||
        currentSpatialScore < PROJECTED_SMALL_DARK_SUPPORT_MIN_CURRENT_SPATIAL ||
        currentGradientScore < PROJECTED_SMALL_DARK_SUPPORT_MIN_CURRENT_GRADIENT ||
        currentGradientScore > PROJECTED_SMALL_DARK_SUPPORT_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const originalNearBlackRatio = calculateNearBlackRatio(
        originalImageData,
        currentPosition
    );
    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (
        originalNearBlackRatio < PROJECTED_SMALL_DARK_SUPPORT_MIN_ORIGINAL_NEAR_BLACK ||
        currentVisibility?.visible !== true ||
        currentVisibility.visiblePositiveHalo !== true ||
        Number(currentVisibility.positiveHaloLum ?? 0) <
            PROJECTED_SMALL_DARK_SUPPORT_MIN_POSITIVE_HALO
    ) {
        return null;
    }

    const expansion = PROJECTED_SMALL_DARK_SUPPORT_EXPANSION;
    const expandedSize = currentPosition.width + expansion * 2;
    const expandedPosition = {
        x: currentPosition.x - expansion,
        y: currentPosition.y - expansion,
        width: expandedSize,
        height: expandedSize
    };
    if (
        expandedPosition.x < 0 ||
        expandedPosition.y < 0 ||
        expandedPosition.x + expandedPosition.width > originalImageData.width ||
        expandedPosition.y + expandedPosition.height > originalImageData.height
    ) {
        return null;
    }

    const expandedAlphaMap = interpolateAlphaMap(
        currentAlphaMap,
        currentPosition.width,
        expandedSize
    );
    const priors = PROJECTED_SMALL_DARK_SUPPORT_PRIOR_RADII.map((radius) => ({
        radius,
        imageData: buildPreviewNeighborhoodPrior({
            previewImageData: originalImageData,
            position: expandedPosition,
            radius,
            relaxationPasses: DARK_SUPPORT_PRIOR_RELAXATION_PASSES
        })
    }));
    let best = null;

    for (const prior of priors) {
        const candidateImageData = applyKnown48BoundaryRepair({
            imageData: currentImageData,
            priorImageData: prior.imageData,
            alphaMap: expandedAlphaMap,
            position: expandedPosition,
            preset: PROJECTED_SMALL_DARK_SUPPORT_PRESET
        });
        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidateImageData,
            alphaMap: currentAlphaMap,
            region: {
                x: currentPosition.x,
                y: currentPosition.y,
                size: currentPosition.width
            }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidateImageData,
            alphaMap: currentAlphaMap,
            region: {
                x: currentPosition.x,
                y: currentPosition.y,
                size: currentPosition.width
            }
        });
        const residualVisibility = assessWatermarkResidualVisibility({
            imageData: candidateImageData,
            position: currentPosition,
            alphaMap: currentAlphaMap
        });
        const artifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData,
            alphaMap: currentAlphaMap,
            position: currentPosition,
            alphaGain: currentAlphaGain
        });
        const expandedArtifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData,
            alphaMap: expandedAlphaMap,
            position: expandedPosition,
            alphaGain: currentAlphaGain
        });
        const priorMetrics = priors.map((candidatePrior) => ({
            radius: candidatePrior.radius,
            ...measureDarkSupportPriorConvergence({
                candidateImageData,
                priorImageData: candidatePrior.imageData,
                alphaMap: expandedAlphaMap,
                position: expandedPosition
            })
        }));
        const clipping = measureDarkSupportClipping({
            originalImageData,
            candidateImageData,
            alphaMap: expandedAlphaMap,
            position: expandedPosition
        });
        const boundary = measurePreviewBoundaryMetrics(
            candidateImageData,
            originalImageData,
            expandedPosition
        );
        const maximumPriorMeanLuminance = Math.max(
            ...priorMetrics.map((item) => item.priorMeanLuminance)
        );
        const maximumCandidateMeanLuminance = Math.max(
            ...priorMetrics.map((item) => item.candidateMeanLuminance)
        );
        const maximumPriorMeanDelta = Math.max(
            ...priorMetrics.map((item) => item.meanLuminanceDelta)
        );
        const maximumPriorMae = Math.max(
            ...priorMetrics.map((item) => item.meanAbsoluteDelta)
        );
        const maximumPriorWeightedMae = Math.max(
            ...priorMetrics.map((item) => item.weightedMeanAbsoluteDelta)
        );
        const spatialImprovement =
            Math.abs(currentSpatialScore) - Math.abs(spatialScore);
        const gradientImprovement = currentGradientScore - gradientScore;
        const visualArtifactCost = Number(
            expandedArtifacts?.visualArtifactCost ?? Infinity
        );
        const accepted = Boolean(
            residualVisibility?.visible === false &&
            Math.abs(spatialScore) <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_ABS_SPATIAL &&
            gradientScore <= PROJECTED_SMALL_DARK_SUPPORT_MAX_GRADIENT &&
            spatialImprovement >=
                PROJECTED_SMALL_DARK_SUPPORT_MIN_ABS_SPATIAL_IMPROVEMENT &&
            gradientImprovement >=
                PROJECTED_SMALL_DARK_SUPPORT_MIN_GRADIENT_IMPROVEMENT &&
            visualArtifactCost <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_ARTIFACT &&
            Number(expandedArtifacts?.newlyClippedRatio ?? Infinity) <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_CLIPPED &&
            Number(residualVisibility?.positiveHaloLum ?? Infinity) <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_POSITIVE_HALO &&
            clipping.outsideAlphaSupportRatio <=
                DARK_SUPPORT_MAX_OUTSIDE_ALPHA_CLIP_RATIO &&
            clipping.strongAlphaSupportRatio >=
                DARK_SUPPORT_MIN_STRONG_ALPHA_CLIP_RATIO &&
            maximumPriorMeanLuminance <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_PRIOR_MEAN_LUMINANCE &&
            maximumCandidateMeanLuminance <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_CANDIDATE_MEAN_LUMINANCE &&
            maximumPriorMeanDelta <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_PRIOR_MEAN_DELTA &&
            maximumPriorMae <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_PRIOR_MAE &&
            maximumPriorWeightedMae <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_PRIOR_WEIGHTED_MAE &&
            boundary.normalizedScore <=
                PROJECTED_SMALL_DARK_SUPPORT_MAX_BOUNDARY_SCORE
        );
        if (!accepted) continue;

        const darkBackgroundSupportConvergence = {
            accepted: true,
            mode: 'projected-small-dark-support',
            textureHardRejectResolved: true,
            supportExpansion: expansion,
            selectedPriorRadius: prior.radius,
            priorRadii: [...PROJECTED_SMALL_DARK_SUPPORT_PRIOR_RADII],
            maximumPriorMeanLuminance,
            maximumCandidateMeanLuminance,
            maximumPriorMeanDelta,
            maximumPriorMae,
            maximumPriorWeightedMae,
            boundaryScore: boundary.normalizedScore,
            clipping
        };
        const cost =
            Math.abs(spatialScore) +
            Math.max(0, gradientScore) * 0.7 +
            visualArtifactCost * 0.35;
        if (!best || cost < best.cost) {
            best = {
                imageData: candidateImageData,
                alphaMap: currentAlphaMap,
                position: currentPosition,
                config: currentConfig,
                alphaGain: currentAlphaGain,
                spatialScore,
                gradientScore,
                residualVisibility,
                artifacts,
                expandedArtifacts,
                spatialImprovement,
                suppressionGain: originalSpatialScore - spatialScore,
                darkBackgroundSupportConvergence,
                cost
            };
        }
    }

    return best;
}

function refineSmallLocatedPriorRepairResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    originalSpatialScore,
    originalGradientScore,
    source
}) {
    const projectedSmallDarkSupport = refineProjectedSmallDarkSupportResidual({
        originalImageData,
        currentImageData,
        currentAlphaMap,
        currentPosition,
        currentConfig,
        currentSpatialScore,
        currentGradientScore,
        currentAlphaGain,
        originalSpatialScore,
        originalGradientScore,
        source
    });
    if (projectedSmallDarkSupport) return projectedSmallDarkSupport;

    if (
        typeof source !== 'string' ||
        !source.includes('located-aggressive') ||
        currentPosition?.width !== currentPosition?.height ||
        currentPosition.width < SMALL_LOCATED_PRIOR_REPAIR_MIN_SIZE ||
        currentPosition.width > SMALL_LOCATED_PRIOR_REPAIR_MAX_SIZE ||
        currentConfig?.logoSize !== currentPosition.width ||
        originalSpatialScore < SMALL_LOCATED_PRIOR_REPAIR_MIN_ORIGINAL_SPATIAL ||
        originalGradientScore < SMALL_LOCATED_PRIOR_REPAIR_MIN_ORIGINAL_GRADIENT ||
        currentSpatialScore < SMALL_LOCATED_PRIOR_REPAIR_MIN_CURRENT_SPATIAL ||
        currentGradientScore > SMALL_LOCATED_PRIOR_REPAIR_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (currentVisibility?.visibleSpatialResidual !== true) return null;

    let best = null;
    const priorByRadius = new Map();
    for (const preset of SMALL_LOCATED_PRIOR_REPAIR_PRESETS) {
        let priorImageData = priorByRadius.get(preset.radius);
        if (!priorImageData) {
            priorImageData = buildPreviewNeighborhoodPrior({
                previewImageData: currentImageData,
                position: currentPosition,
                radius: preset.radius
            });
            priorByRadius.set(preset.radius, priorImageData);
        }

        const candidateImageData = applyKnown48BoundaryRepair({
            imageData: currentImageData,
            priorImageData,
            alphaMap: currentAlphaMap,
            position: currentPosition,
            preset
        });
        const spatialScore = computeRegionSpatialCorrelation({
            imageData: candidateImageData,
            alphaMap: currentAlphaMap,
            region: {
                x: currentPosition.x,
                y: currentPosition.y,
                size: currentPosition.width
            }
        });
        const gradientScore = computeRegionGradientCorrelation({
            imageData: candidateImageData,
            alphaMap: currentAlphaMap,
            region: {
                x: currentPosition.x,
                y: currentPosition.y,
                size: currentPosition.width
            }
        });
        const spatialImprovement = Math.abs(currentSpatialScore) - Math.abs(spatialScore);
        if (
            spatialImprovement < SMALL_LOCATED_PRIOR_REPAIR_MIN_SPATIAL_IMPROVEMENT ||
            spatialScore > SMALL_LOCATED_PRIOR_REPAIR_MAX_SPATIAL ||
            Math.abs(spatialScore) > SMALL_LOCATED_PRIOR_REPAIR_MAX_SPATIAL ||
            gradientScore > SMALL_LOCATED_PRIOR_REPAIR_MAX_GRADIENT
        ) {
            continue;
        }

        const residualVisibility = assessWatermarkResidualVisibility({
            imageData: candidateImageData,
            position: currentPosition,
            alphaMap: currentAlphaMap
        });
        if (residualVisibility?.visible !== false) continue;

        const artifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData,
            alphaMap: currentAlphaMap,
            position: currentPosition,
            alphaGain: currentAlphaGain
        });
        const visualArtifactCost = artifacts?.visualArtifactCost ?? Number.POSITIVE_INFINITY;
        const newlyClippedRatio = artifacts?.newlyClippedRatio ?? Number.POSITIVE_INFINITY;
        const darkHaloLum = Math.max(0, -(artifacts?.halo?.deltaLum ?? 0));
        if (
            visualArtifactCost > SMALL_LOCATED_PRIOR_REPAIR_MAX_ARTIFACT ||
            newlyClippedRatio > SMALL_LOCATED_PRIOR_REPAIR_MAX_CLIPPED ||
            darkHaloLum > SMALL_LOCATED_PRIOR_REPAIR_MAX_DARK_HALO
        ) {
            continue;
        }

        const cost =
            Math.abs(spatialScore) +
            Math.max(0, gradientScore) * 0.7 +
            visualArtifactCost * 0.35;
        if (!best || cost < best.cost) {
            best = {
                imageData: candidateImageData,
                alphaMap: currentAlphaMap,
                position: currentPosition,
                config: currentConfig,
                alphaGain: currentAlphaGain,
                spatialScore,
                gradientScore,
                residualVisibility,
                artifacts,
                spatialImprovement,
                suppressionGain: originalSpatialScore - spatialScore,
                preset,
                cost
            };
        }
    }

    return best;
}

function measureQuantizedBodyResidualProfile({ imageData, priorImageData, alphaMap, position }) {
    let lowCount = 0;
    let lowAbsResidualSum = 0;
    let bodyCount = 0;
    let bodyResidualSum = 0;
    let bodyNegativeCount = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = alphaMap[localIndex] ?? 0;
            const pixelIndex = ((position.y + row) * imageData.width + position.x + col) * 4;
            const residual = (
                (
                    imageData.data[pixelIndex] +
                    imageData.data[pixelIndex + 1] +
                    imageData.data[pixelIndex + 2]
                ) -
                (
                    priorImageData.data[pixelIndex] +
                    priorImageData.data[pixelIndex + 1] +
                    priorImageData.data[pixelIndex + 2]
                )
            ) / 3;

            if (alpha < QUANTIZED_BODY_CORRECTION_LOW_ALPHA_MAX) {
                lowCount++;
                lowAbsResidualSum += Math.abs(residual);
            }
            if (alpha >= QUANTIZED_BODY_CORRECTION_BODY_MIN_ALPHA) {
                bodyCount++;
                bodyResidualSum += residual;
                if (residual < -1) bodyNegativeCount++;
            }
        }
    }

    return {
        lowMeanAbsResidual: lowCount > 0 ? lowAbsResidualSum / lowCount : Number.POSITIVE_INFINITY,
        bodyMeanResidual: bodyCount > 0 ? bodyResidualSum / bodyCount : 0,
        bodyNegativeRatio: bodyCount > 0 ? bodyNegativeCount / bodyCount : 0
    };
}

function applyQuantizedBodyCorrection({ imageData, priorImageData, alphaMap, position }) {
    const candidate = cloneImageData(imageData);
    let changedPixels = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = alphaMap[localIndex] ?? 0;
            if (alpha < QUANTIZED_BODY_CORRECTION_BODY_MIN_ALPHA) continue;

            const pixelIndex = ((position.y + row) * imageData.width + position.x + col) * 4;
            const residual = (
                (
                    imageData.data[pixelIndex] +
                    imageData.data[pixelIndex + 1] +
                    imageData.data[pixelIndex + 2]
                ) -
                (
                    priorImageData.data[pixelIndex] +
                    priorImageData.data[pixelIndex + 1] +
                    priorImageData.data[pixelIndex + 2]
                )
            ) / 3;
            if (residual >= QUANTIZED_BODY_CORRECTION_RESIDUAL_THRESHOLD) continue;

            for (let channel = 0; channel < 3; channel++) {
                candidate.data[pixelIndex + channel] = clampChannel(imageData.data[pixelIndex + channel] + 1);
            }
            changedPixels++;
        }
    }

    return {
        imageData: candidate,
        changedPixels
    };
}

function scoreQuantizedBodyCorrectionImage({
    originalImageData,
    imageData,
    alphaMap,
    position,
    alphaGain,
    baselineGradientScore
}) {
    const spatialScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const gradientScore = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData,
        position,
        alphaMap
    });
    const calibratedVisibility = assessCalibratedWatermarkResidualVisibility({
        imageData,
        originalImageData,
        position,
        alphaMap,
        alphaGain
    });
    const nearBlackRatio = calculateNearBlackRatio(imageData, position);
    const baselineNearBlackRatio = calculateNearBlackRatio(originalImageData, position);
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: imageData,
        alphaMap,
        position,
        alphaGain
    });
    const darkHaloLum = Math.max(0, -(artifacts?.halo?.deltaLum ?? 0));
    const visualArtifactCost = artifacts?.visualArtifactCost ?? 0;
    const balancedVisual = scoreBalancedVisualCandidate({
        processedSpatial: spatialScore,
        processedGradient: gradientScore,
        nearBlackIncrease: nearBlackRatio - baselineNearBlackRatio,
        newlyClippedRatio: artifacts?.newlyClippedRatio,
        darkHaloLum,
        visualArtifactCost,
        gradientIncrease: Number.isFinite(baselineGradientScore)
            ? gradientScore - baselineGradientScore
            : 0
    });

    return {
        spatialScore,
        gradientScore,
        residualVisibility,
        calibratedVisibility,
        artifacts,
        darkHaloLum,
        visualArtifactCost,
        balancedVisual
    };
}

function refineQuantizedNegativeBodyResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain
}) {
    if (
        currentPosition?.width !== QUANTIZED_BODY_CORRECTION_SIZE ||
        currentPosition?.height !== QUANTIZED_BODY_CORRECTION_SIZE ||
        currentConfig?.logoSize !== QUANTIZED_BODY_CORRECTION_SIZE ||
        currentConfig?.marginRight !== QUANTIZED_BODY_CORRECTION_MARGIN ||
        currentConfig?.marginBottom !== QUANTIZED_BODY_CORRECTION_MARGIN ||
        currentSpatialScore > QUANTIZED_BODY_CORRECTION_MAX_CURRENT_SPATIAL ||
        currentGradientScore >= QUANTIZED_BODY_CORRECTION_MAX_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (currentVisibility?.visible !== true) return null;

    const priorImageData = buildPreviewNeighborhoodPrior({
        previewImageData: currentImageData,
        position: currentPosition,
        radius: QUANTIZED_BODY_CORRECTION_PRIOR_RADIUS
    });
    const profile = measureQuantizedBodyResidualProfile({
        imageData: currentImageData,
        priorImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition
    });
    if (
        profile.lowMeanAbsResidual > QUANTIZED_BODY_CORRECTION_LOW_ABS_MAX ||
        profile.bodyMeanResidual > QUANTIZED_BODY_CORRECTION_BODY_MEAN_MAX ||
        profile.bodyNegativeRatio < QUANTIZED_BODY_CORRECTION_BODY_NEGATIVE_RATIO_MIN
    ) {
        return null;
    }

    const beforeScore = scoreQuantizedBodyCorrectionImage({
        originalImageData,
        imageData: currentImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition,
        alphaGain: currentAlphaGain,
        baselineGradientScore: currentGradientScore
    });
    const correction = applyQuantizedBodyCorrection({
        imageData: currentImageData,
        priorImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition
    });
    if (correction.changedPixels <= 0) return null;

    const afterScore = scoreQuantizedBodyCorrectionImage({
        originalImageData,
        imageData: correction.imageData,
        alphaMap: currentAlphaMap,
        position: currentPosition,
        alphaGain: currentAlphaGain,
        baselineGradientScore: currentGradientScore
    });
    const balancedGain = beforeScore.balancedVisual.score - afterScore.balancedVisual.score;
    const artifactDelta = afterScore.visualArtifactCost - beforeScore.visualArtifactCost;
    const clearsVisible = afterScore.calibratedVisibility?.calibratedVisible === false &&
        afterScore.residualVisibility?.visible === false;
    if (
        !clearsVisible ||
        balancedGain < QUANTIZED_BODY_CORRECTION_MIN_BALANCED_GAIN ||
        artifactDelta > QUANTIZED_BODY_CORRECTION_MAX_ARTIFACT_INCREASE
    ) {
        return null;
    }

    return {
        imageData: correction.imageData,
        changedPixels: correction.changedPixels,
        profile,
        spatialScore: afterScore.spatialScore,
        gradientScore: afterScore.gradientScore,
        suppressionGain: currentSpatialScore - afterScore.spatialScore,
        balancedGain,
        artifactDelta,
        cost: afterScore.balancedVisual.score,
        alphaGain: currentAlphaGain
    };
}

function resolveRescueAlphaMaps({ size, currentAlphaMap, currentSize, alpha96, getAlphaMap }) {
    const alphaMaps = [];
    const addAlphaMap = (alphaMap, source) => {
        if (!alphaMap || alphaMaps.some((entry) => entry.alphaMap === alphaMap)) return;
        alphaMaps.push({ alphaMap, source });
    };
    if (typeof getAlphaMap === 'function') {
        addAlphaMap(getAlphaMap(size), 'provided');
    }
    if (size === currentSize) {
        addAlphaMap(currentAlphaMap, 'current');
    } else {
        addAlphaMap(interpolateAlphaMap(currentAlphaMap, currentSize, size), 'current-interpolated');
    }
    if (alpha96 && size !== 96) {
        addAlphaMap(interpolateAlphaMap(alpha96, 96, size), 'alpha96-interpolated');
    }
    return alphaMaps;
}

function refineDarkHaloResidual({
    originalImageData,
    currentImageData,
    currentAlphaMap,
    currentPosition,
    currentConfig,
    currentSpatialScore,
    currentGradientScore,
    currentAlphaGain,
    alpha96,
    getAlphaMap
}) {
    if (
        !isKnown48LargeMarginConfig(currentConfig) ||
        !currentPosition ||
        currentPosition.width !== currentPosition.height ||
        currentSpatialScore > DARK_HALO_RESCUE_MAX_CURRENT_SPATIAL ||
        Math.abs(currentGradientScore) > DARK_HALO_RESCUE_MAX_ABS_CURRENT_GRADIENT
    ) {
        return null;
    }

    const currentVisibility = assessWatermarkResidualVisibility({
        imageData: currentImageData,
        position: currentPosition,
        alphaMap: currentAlphaMap
    });
    if (currentVisibility?.visible !== true || currentVisibility.visiblePositiveHalo === true) {
        return null;
    }

    const currentArtifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: currentImageData,
        alphaMap: currentAlphaMap,
        position: currentPosition,
        alphaGain: currentAlphaGain
    });
    const currentDarkHaloLum = Math.max(0, -(currentArtifacts?.halo?.deltaLum ?? 0));
    if (currentDarkHaloLum < DARK_HALO_RESCUE_MIN_DARK_HALO_LUM) return null;

    const currentScore = scoreBalancedVisualCandidate({
        processedSpatial: currentSpatialScore,
        processedGradient: currentGradientScore,
        newlyClippedRatio: currentArtifacts?.newlyClippedRatio,
        darkHaloLum: currentDarkHaloLum,
        visualArtifactCost: currentArtifacts?.visualArtifactCost
    }).score;

    let best = null;
    for (const config of DARK_HALO_RESCUE_CONFIGS) {
        const size = config.logoSize;
        const alphaMaps = resolveRescueAlphaMaps({
            size,
            currentAlphaMap,
            currentSize: currentPosition.width,
            alpha96,
            getAlphaMap
        });
        if (alphaMaps.length === 0) continue;

        const position = {
            x: originalImageData.width - config.marginRight - size,
            y: originalImageData.height - config.marginBottom - size,
            width: size,
            height: size
        };
        if (
            position.x < 0 ||
            position.y < 0 ||
            position.x + position.width > originalImageData.width ||
            position.y + position.height > originalImageData.height
        ) {
            continue;
        }

        for (const alphaEntry of alphaMaps) {
            const { alphaMap } = alphaEntry;
            const originalSpatial = computeRegionSpatialCorrelation({
                imageData: originalImageData,
                alphaMap,
                region: { x: position.x, y: position.y, size }
            });
            const originalGradient = computeRegionGradientCorrelation({
                imageData: originalImageData,
                alphaMap,
                region: { x: position.x, y: position.y, size }
            });

            for (const alphaGain of DARK_HALO_RESCUE_GAINS) {
                for (const logoValue of DARK_HALO_RESCUE_LOGO_VALUES) {
                    const candidate = scoreKnown48AntiTemplateRescueCandidate({
                        originalImageData,
                        alphaMap,
                        position,
                        alphaGain,
                        logoValue,
                        baselineGradientScore: currentGradientScore,
                        maxSpatial: 0.18,
                        maxVisualArtifact: DARK_HALO_RESCUE_MAX_VISUAL_ARTIFACT
                    });
                    if (!candidate) continue;
                    const darkHaloLum = Math.max(0, -(candidate.artifacts?.halo?.deltaLum ?? 0));
                    const newlyClippedRatio = candidate.artifacts?.newlyClippedRatio ?? 0;
                    if (
                        darkHaloLum > DARK_HALO_RESCUE_MAX_DARK_HALO_LUM ||
                        newlyClippedRatio > DARK_HALO_RESCUE_MAX_NEWLY_CLIPPED_RATIO
                    ) {
                        continue;
                    }
                    if (!best || candidate.cost < best.cost) {
                        best = {
                            ...candidate,
                            alphaMapSource: alphaEntry.source,
                            originalSpatialScore: originalSpatial,
                            originalGradientScore: originalGradient,
                            suppressionGain: originalSpatial - candidate.spatialScore
                        };
                    }
                }
            }
        }
    }

    if (!best) return null;
    if (best.cost > currentScore - DARK_HALO_RESCUE_MIN_BALANCED_GAIN) return null;
    return best;
}

function createAcceptedPipelineMetrics() {
    return {
        calculateNearBlackRatio,
        computeRegionGradientCorrelation,
        createRegionCorrelationMetrics,
        measureOuterBorderLuminanceStd,
        assessWatermarkResidualVisibility
    };
}

function createAcceptedPipelineGates() {
    return {
        shouldRecalibrateAlphaStrength,
        shouldApplyPreviewSmoothBackgroundCleanup,
        shouldSkipLocatedAggressiveForCleanCanonical96
    };
}

function createAcceptedPipelineExecutorConfig() {
    return {
        maxNearBlackRatioIncrease: MAX_NEAR_BLACK_RATIO_INCREASE,
        outlineConfig: {
            outlineRefinementThreshold: OUTLINE_REFINEMENT_THRESHOLD,
            outlineRefinementMinGain: OUTLINE_REFINEMENT_MIN_GAIN,
            subpixelRefineShifts: SUBPIXEL_REFINE_SHIFTS,
            subpixelRefineScales: SUBPIXEL_REFINE_SCALES,
            minGradientImprovement: 0.04,
            maxSpatialDrift: 0.08
        },
        repairCleanupConfig: {
            previewEdgeCleanupMaxAppliedPasses: PREVIEW_EDGE_CLEANUP_MAX_APPLIED_PASSES,
            previewEdgeCleanupMinGradientImprovement: PREVIEW_EDGE_CLEANUP_MIN_GRADIENT_IMPROVEMENT,
            previewEdgeCleanupMaxSpatialDrift: PREVIEW_EDGE_CLEANUP_MAX_SPATIAL_DRIFT,
            known48EdgeCleanupMinGradientImprovement: KNOWN_48_EDGE_CLEANUP_MIN_GRADIENT_IMPROVEMENT,
            known48EdgeCleanupMaxSpatialDrift: KNOWN_48_EDGE_CLEANUP_MAX_SPATIAL_DRIFT,
            v2SmallEdgeCleanupMinGradientImprovement: V2_SMALL_EDGE_CLEANUP_MIN_GRADIENT_IMPROVEMENT,
            v2SmallEdgeCleanupMaxSpatialDrift: V2_SMALL_EDGE_CLEANUP_MAX_SPATIAL_DRIFT,
            known48FlatFillMaxAppliedPasses: KNOWN_48_FLAT_FILL_MAX_APPLIED_PASSES,
            known48FlatFillMinGradient: KNOWN_48_FLAT_FILL_MIN_GRADIENT,
            strongUndersizedFlatFillMinGradient: STRONG_UNDERSIZED_FLAT_FILL_MIN_GRADIENT,
            known48FlatFillMinGradientImprovement: KNOWN_48_FLAT_FILL_MIN_GRADIENT_IMPROVEMENT,
            known48FlatFillSecondPassMinGradientImprovement: KNOWN_48_FLAT_FILL_SECOND_PASS_MIN_GRADIENT_IMPROVEMENT
        }
    };
}

function hasSameLocalAlphaPosition(left, right) {
    return Boolean(
        left &&
        right &&
        left.x === right.x &&
        left.y === right.y &&
        left.width === right.width &&
        left.height === right.height
    );
}

function findSelectedLocalAlphaTrial({ result, instrumentation }) {
    const stage = result?.meta?.alphaAdjustmentStages?.find(
        (item) => item.stage === 'evidence-gated-local-alpha-search'
    );
    if (!stage) return null;

    const candidates = instrumentation.acceptedTrials.filter((trial) => (
        hasSameLocalAlphaPosition(trial.position, result.meta.position) &&
        Math.abs(trial.alphaGain - stage.toAlphaGain) <= 1e-9
    ));
    if (candidates.length !== 1) return null;
    const selected = candidates.reduce((best, trial) => {
        const distance =
            Math.abs(trial.spatialScore - stage.afterSpatialScore) +
            Math.abs(trial.gradientScore - stage.afterGradientScore);
        if (!best || distance < best.distance) return { trial, stage, distance };
        return best;
    }, null);
    return selected?.distance <= 1e-9 ? selected : null;
}

function attachLocalAlphaSearchDiagnostics({
    result,
    instrumentation
}) {
    if (!instrumentation) return result;

    if (result?.debugTimings) {
        Object.assign(result.debugTimings, {
            localAlphaSearchTrialCount: instrumentation.trialCount,
            localAlphaSearchTrialAllocatedPixels: instrumentation.trialAllocatedPixels,
            localAlphaSearchMaxTrialBufferPixels: instrumentation.maxTrialBufferPixels,
            localAlphaSearchTrialFullImageCloneCount:
                instrumentation.trialFullImageCloneCount,
            localAlphaSearchFullImageMaterializationCount:
                instrumentation.fullImageMaterializationCount,
            darkSupportSearchTrialCount:
                instrumentation.darkSupportTrialCount,
            darkSupportSearchAcceptedTrialCount:
                instrumentation.darkSupportAcceptedTrialCount,
            darkSupportSearchBestProbe:
                instrumentation.darkSupportBestProbe
        });
    }

    const selected = findSelectedLocalAlphaTrial({ result, instrumentation });
    if (!selected || !result?.imageData) return result;

    const finalDamageSafe = typeof result.meta.decisionPath?.alphaTrial?.damage?.safe === 'boolean'
        ? result.meta.decisionPath.alphaTrial.damage.safe
        : result.meta.qualitySignals?.damageWarning !== true;
    const darkBackgroundSupportConvergence =
        result.meta.qualitySignals?.darkBackgroundSupportConvergence?.accepted === true
            ? result.meta.qualitySignals.darkBackgroundSupportConvergence
            : null;
    const riskResolution = finalDamageSafe
        ? selected.trial.damageSafe
            ? null
            : 'repaired-downstream'
        : darkBackgroundSupportConvergence
            ? 'dark-background-support-converged'
            : 'best-effort-damage';
    const localAlphaSearch = {
        trigger: selected.trial.trigger,
        acceptedTrialDamageSafe: selected.trial.damageSafe,
        finalDamageSafe,
        riskResolution
    };

    return {
        ...result,
        meta: {
            ...result.meta,
            qualitySignals: {
                ...result.meta.qualitySignals,
                localAlphaSearch,
                darkBackgroundSupportConvergence
            }
        }
    };
}

function createAcceptedPipelineRefiners({
    localAlphaSearchInstrumentation = null
} = {}) {
    return {
        recalibrateAlphaStrength,
        refineLargeMargin48ProfileAlphaRescue,
        fineTuneEvidenceGatedLocalAlpha: (input) => fineTuneEvidenceGatedLocalAlpha({
            ...input,
            instrumentation: localAlphaSearchInstrumentation
        }),
        recalibrateOverSubtractedAlpha,
        fineTuneDarkCatalogAlpha,
        fineTuneWeakPositiveResidualAlpha,
        applyPreviewSmoothBackgroundCleanup,
        refineSubpixelOutline,
        refinePreviewResidualEdge,
        refineKnown48FlatBackgroundResidual,
        refineKnown48LumaEdgeResidual,
        refineNewMargin96FlatBackgroundResidual,
        refineSmallPreviewAnchorCandidate,
        refineSmallFixedLocalAnchorGeometry,
        refineLocatedAggressiveRemoval,
        refineCanonical96PositiveHaloResidual,
        refineSmoothLocatedResidualWithEstimatedPrior,
        refineNewMargin96SmoothEdgeResidual,
        refineNewMargin96VariantResidual,
        refineKnown48AntiTemplateResidual,
        refineKnown48PowerProfileResidual,
        refineKnown48PositiveResidualRebalance,
        refineKnown48SmallMarginPriorRepairResidual,
        refineSmallLocatedPriorRepairResidual,
        refineKnown48BoundaryRepairResidual,
        refineDarkHaloResidual,
        refineQuantizedNegativeBodyResidual,
        refineKnown48MidCoreBiasResidual
    };
}

function createAcceptedPipelineDependencies({
    localAlphaSearchInstrumentation = null
} = {}) {
    return {
        metrics: createAcceptedPipelineMetrics(),
        gates: createAcceptedPipelineGates(),
        config: createAcceptedPipelineExecutorConfig(),
        refiners: createAcceptedPipelineRefiners({
            localAlphaSearchInstrumentation
        })
    };
}

export const watermarkProcessorTestInternals = Object.freeze({
    createSmallAnchorRelocationGeometry,
    buildSmallAnchorRelocationScratchCandidate,
    materializeSmallAnchorRelocationCandidate
});

export function processWatermarkImageData(imageData, options = {}) {
    const instrumentationByCandidateId = new Map();
    const result = runImageWatermarkPipeline(createImageWatermarkPipelineRequest({
        imageData,
        options,
        nowMs,
        cloneImageData,
        alphaGainCandidates: ALPHA_GAIN_CANDIDATES,
        alphaPriorityGains: STANDARD_ALPHA_PRIORITY_GAINS,
        createAcceptedPipelineDependencies: (hypothesis) => {
            const instrumentation = createLocalAlphaSearchInstrumentation({
                debugEnabled: options.debugTimings === true
            });
            if (hypothesis?.id != null) {
                instrumentationByCandidateId.set(hypothesis.id, instrumentation);
            }
            return createAcceptedPipelineDependencies({
                localAlphaSearchInstrumentation: instrumentation
            });
        },
        cleanupConfig: createImageWatermarkPipelineCleanupConfig({
            previewEdgeCleanupMaxSize: PREVIEW_EDGE_CLEANUP_MAX_SIZE,
            known48EdgeCleanupMinSize: KNOWN_48_EDGE_CLEANUP_MIN_SIZE,
            known48EdgeCleanupMaxSize: KNOWN_48_EDGE_CLEANUP_MAX_SIZE,
            v2SmallEdgeCleanupSize: V2_SMALL_EDGE_CLEANUP_SIZE,
            v2SmallEdgeCleanupSizeTolerance: V2_SMALL_EDGE_CLEANUP_SIZE_TOLERANCE
        }),
        visualPostProcessingEnabled: ENABLE_VISUAL_POST_PROCESSING
    }));
    const selectedCandidateId = result?.meta?.selectedCandidate?.id;
    return attachLocalAlphaSearchDiagnostics({
        result,
        instrumentation: selectedCandidateId == null
            ? null
            : instrumentationByCandidateId.get(selectedCandidateId) ?? null
    });
}

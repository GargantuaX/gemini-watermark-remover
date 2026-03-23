// Keep detector thresholds, processed-meta attribution, and UI classification
// on the same vocabulary so "removed", "validated", and "Gemini-like" do not
// diverge across modules.
const STANDARD_DIRECT_MATCH_MIN_SPATIAL_SCORE = 0.3;
const STANDARD_DIRECT_MATCH_MIN_GRADIENT_SCORE = 0.12;

const ADAPTIVE_DIRECT_MATCH_MIN_CONFIDENCE = 0.5;
const ADAPTIVE_DIRECT_MATCH_MIN_SPATIAL_SCORE = 0.45;
const ADAPTIVE_DIRECT_MATCH_MIN_GRADIENT_SCORE = 0.12;
const ADAPTIVE_DIRECT_MATCH_MIN_SIZE = 40;
const ADAPTIVE_DIRECT_MATCH_MAX_SIZE = 192;

const ATTRIBUTION_MIN_SIZE = 24;
const ATTRIBUTION_MAX_SIZE = 192;
const ATTRIBUTION_MAX_RESIDUAL_SCORE = 0.2;
const ATTRIBUTION_MIN_SUPPRESSION_GAIN = 0.25;
const ATTRIBUTION_MIN_SPATIAL_SCORE = 0.22;
const ATTRIBUTION_MIN_VALIDATED_SPATIAL_SCORE = 0.2;
const ATTRIBUTION_MIN_VALIDATED_SUPPRESSION_GAIN = 0.3;
const ATTRIBUTION_MIN_ADAPTIVE_CONFIDENCE = 0.35;
const ATTRIBUTION_MIN_ADAPTIVE_SUPPRESSION_GAIN = 0.16;

function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPositionSized(position) {
    const width = toFiniteNumber(position?.width);
    const height = toFiniteNumber(position?.height);
    return width !== null && height !== null;
}

export function classifyStandardWatermarkSignal({ spatialScore, gradientScore }) {
    const spatial = toFiniteNumber(spatialScore);
    const gradient = toFiniteNumber(gradientScore);

    if (spatial === null || gradient === null) {
        return { tier: 'insufficient' };
    }

    if (
        spatial >= STANDARD_DIRECT_MATCH_MIN_SPATIAL_SCORE &&
        gradient >= STANDARD_DIRECT_MATCH_MIN_GRADIENT_SCORE
    ) {
        return { tier: 'direct-match' };
    }

    if (spatial > 0 || gradient > 0) {
        return { tier: 'needs-validation' };
    }

    return { tier: 'insufficient' };
}

export function classifyAdaptiveWatermarkSignal(adaptiveResult) {
    if (!adaptiveResult || adaptiveResult.found !== true) {
        return { tier: 'insufficient' };
    }

    const confidence = toFiniteNumber(adaptiveResult.confidence);
    const spatial = toFiniteNumber(adaptiveResult.spatialScore);
    const gradient = toFiniteNumber(adaptiveResult.gradientScore);
    const size = toFiniteNumber(adaptiveResult?.region?.size);

    if (
        confidence === null ||
        spatial === null ||
        gradient === null ||
        size === null
    ) {
        return { tier: 'insufficient' };
    }

    if (
        confidence >= ADAPTIVE_DIRECT_MATCH_MIN_CONFIDENCE &&
        spatial >= ADAPTIVE_DIRECT_MATCH_MIN_SPATIAL_SCORE &&
        gradient >= ADAPTIVE_DIRECT_MATCH_MIN_GRADIENT_SCORE &&
        size >= ADAPTIVE_DIRECT_MATCH_MIN_SIZE &&
        size <= ADAPTIVE_DIRECT_MATCH_MAX_SIZE
    ) {
        return { tier: 'direct-match' };
    }

    if (
        size >= ADAPTIVE_DIRECT_MATCH_MIN_SIZE &&
        size <= ADAPTIVE_DIRECT_MATCH_MAX_SIZE &&
        gradient >= ADAPTIVE_DIRECT_MATCH_MIN_GRADIENT_SCORE &&
        (confidence > 0 || spatial > 0)
    ) {
        return { tier: 'needs-validation' };
    }

    return { tier: 'insufficient' };
}

export function classifyGeminiAttributionFromWatermarkMeta(watermarkMeta) {
    if (!watermarkMeta || typeof watermarkMeta !== 'object') {
        return { tier: 'insufficient' };
    }
    if (watermarkMeta.applied === false) {
        return { tier: 'insufficient' };
    }

    const size = toFiniteNumber(watermarkMeta.size);
    if (size === null || size < ATTRIBUTION_MIN_SIZE || size > ATTRIBUTION_MAX_SIZE) {
        return { tier: 'insufficient' };
    }
    if (!isPositionSized(watermarkMeta.position)) {
        return { tier: 'insufficient' };
    }

    const detection = watermarkMeta.detection || {};
    const adaptiveConfidence = toFiniteNumber(detection.adaptiveConfidence);
    const originalSpatialScore = toFiniteNumber(detection.originalSpatialScore);
    const processedSpatialScore = toFiniteNumber(detection.processedSpatialScore);
    const suppressionGain = toFiniteNumber(detection.suppressionGain);
    const source = typeof watermarkMeta.source === 'string' ? watermarkMeta.source : '';

    // Adaptive/direct evidence is strongest, validated-match requires both a
    // validated source path and measurable suppression, and safe-removal keeps
    // "looks removable" separate from "confident Gemini attribution".
    if (
        adaptiveConfidence !== null &&
        suppressionGain !== null &&
        adaptiveConfidence >= ATTRIBUTION_MIN_ADAPTIVE_CONFIDENCE &&
        suppressionGain >= ATTRIBUTION_MIN_ADAPTIVE_SUPPRESSION_GAIN
    ) {
        return { tier: 'adaptive-match' };
    }

    if (
        source.includes('validated') &&
        originalSpatialScore !== null &&
        processedSpatialScore !== null &&
        suppressionGain !== null &&
        originalSpatialScore >= ATTRIBUTION_MIN_VALIDATED_SPATIAL_SCORE &&
        processedSpatialScore <= ATTRIBUTION_MAX_RESIDUAL_SCORE &&
        suppressionGain >= ATTRIBUTION_MIN_VALIDATED_SUPPRESSION_GAIN
    ) {
        return { tier: 'validated-match' };
    }

    if (
        originalSpatialScore !== null &&
        processedSpatialScore !== null &&
        suppressionGain !== null &&
        originalSpatialScore >= ATTRIBUTION_MIN_SPATIAL_SCORE &&
        processedSpatialScore <= ATTRIBUTION_MAX_RESIDUAL_SCORE &&
        suppressionGain >= ATTRIBUTION_MIN_SUPPRESSION_GAIN
    ) {
        return { tier: 'safe-removal' };
    }

    return { tier: 'insufficient' };
}

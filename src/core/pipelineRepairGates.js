const DEFAULT_PREVIEW_EDGE_CLEANUP_MAX_SIZE = 32;
const DEFAULT_KNOWN_48_EDGE_CLEANUP_MIN_SIZE = 40;
const DEFAULT_KNOWN_48_EDGE_CLEANUP_MAX_SIZE = 56;
const DEFAULT_V2_SMALL_EDGE_CLEANUP_SIZE = 36;
const DEFAULT_V2_SMALL_EDGE_CLEANUP_SIZE_TOLERANCE = 2;

export function shouldUsePreviewAnchorFastCleanup(
    selectedTrial,
    position,
    { previewEdgeCleanupMaxSize = DEFAULT_PREVIEW_EDGE_CLEANUP_MAX_SIZE } = {}
) {
    return selectedTrial?.provenance?.previewAnchor === true &&
        position?.width >= 24 &&
        position?.width <= previewEdgeCleanupMaxSize;
}

export function isKnown48AnchorConfig(
    config,
    {
        known48EdgeCleanupMinSize = DEFAULT_KNOWN_48_EDGE_CLEANUP_MIN_SIZE,
        known48EdgeCleanupMaxSize = DEFAULT_KNOWN_48_EDGE_CLEANUP_MAX_SIZE
    } = {}
) {
    if (!config || config.logoSize < known48EdgeCleanupMinSize || config.logoSize > known48EdgeCleanupMaxSize) {
        return false;
    }

    const marginRight = Number(config.marginRight);
    const marginBottom = Number(config.marginBottom);
    if (!Number.isFinite(marginRight) || !Number.isFinite(marginBottom)) return false;

    const isCurrentLargeMargin = Math.abs(marginRight - 96) <= 2 && Math.abs(marginBottom - 96) <= 2;
    const isCurrentStandardMargin = marginRight >= 28 && marginRight <= 36 && marginBottom >= 28 && marginBottom <= 36;
    return isCurrentLargeMargin || isCurrentStandardMargin;
}

export function shouldUseKnown48EdgeCleanup({
    selectedTrial,
    position,
    source,
    known48EdgeCleanupMinSize = DEFAULT_KNOWN_48_EDGE_CLEANUP_MIN_SIZE,
    known48EdgeCleanupMaxSize = DEFAULT_KNOWN_48_EDGE_CLEANUP_MAX_SIZE
} = {}) {
    if (selectedTrial?.provenance?.previewAnchor === true) return false;
    if (position?.width < known48EdgeCleanupMinSize || position?.width > known48EdgeCleanupMaxSize) return false;
    if (!isKnown48AnchorConfig(selectedTrial?.config, {
        known48EdgeCleanupMinSize,
        known48EdgeCleanupMaxSize
    })) return false;

    const sourceText = String(source || '');
    return sourceText === 'standard' ||
        sourceText.startsWith('standard+gain') ||
        sourceText.includes('catalog') ||
        sourceText.includes('fixed-local');
}

export function isV2SmallAnchorConfig(
    config,
    { v2SmallEdgeCleanupSize = DEFAULT_V2_SMALL_EDGE_CLEANUP_SIZE } = {}
) {
    if (!config || config.logoSize !== v2SmallEdgeCleanupSize || config.alphaVariant !== 'v2') {
        return false;
    }

    const marginRight = Number(config.marginRight);
    const marginBottom = Number(config.marginBottom);
    return Number.isFinite(marginRight) &&
        Number.isFinite(marginBottom) &&
        marginRight >= 48 &&
        marginBottom >= 48;
}

export function shouldUseV2SmallEdgeCleanup({
    selectedTrial,
    position,
    source,
    v2SmallEdgeCleanupSize = DEFAULT_V2_SMALL_EDGE_CLEANUP_SIZE,
    v2SmallEdgeCleanupSizeTolerance = DEFAULT_V2_SMALL_EDGE_CLEANUP_SIZE_TOLERANCE
} = {}) {
    if (selectedTrial?.provenance?.previewAnchor === true) return false;
    if (
        position?.width < v2SmallEdgeCleanupSize - v2SmallEdgeCleanupSizeTolerance ||
        position?.width > v2SmallEdgeCleanupSize + v2SmallEdgeCleanupSizeTolerance
    ) {
        return false;
    }
    if (!isV2SmallAnchorConfig(selectedTrial?.config, { v2SmallEdgeCleanupSize })) return false;
    if (selectedTrial?.provenance?.catalogFamily !== 'gemini-v2-small') return false;

    const sourceText = String(source || '');
    return sourceText.includes('catalog');
}

export function createRepairCleanupFlags({
    selectedTrial,
    position,
    source,
    previewEdgeCleanupMaxSize = DEFAULT_PREVIEW_EDGE_CLEANUP_MAX_SIZE,
    known48EdgeCleanupMinSize = DEFAULT_KNOWN_48_EDGE_CLEANUP_MIN_SIZE,
    known48EdgeCleanupMaxSize = DEFAULT_KNOWN_48_EDGE_CLEANUP_MAX_SIZE,
    v2SmallEdgeCleanupSize = DEFAULT_V2_SMALL_EDGE_CLEANUP_SIZE,
    v2SmallEdgeCleanupSizeTolerance = DEFAULT_V2_SMALL_EDGE_CLEANUP_SIZE_TOLERANCE
} = {}) {
    return {
        usePreviewAnchorFastCleanup: shouldUsePreviewAnchorFastCleanup(selectedTrial, position, {
            previewEdgeCleanupMaxSize
        }),
        useKnown48EdgeCleanup: shouldUseKnown48EdgeCleanup({
            selectedTrial,
            position,
            source,
            known48EdgeCleanupMinSize,
            known48EdgeCleanupMaxSize
        }),
        useV2SmallEdgeCleanup: shouldUseV2SmallEdgeCleanup({
            selectedTrial,
            position,
            source,
            v2SmallEdgeCleanupSize,
            v2SmallEdgeCleanupSizeTolerance
        })
    };
}

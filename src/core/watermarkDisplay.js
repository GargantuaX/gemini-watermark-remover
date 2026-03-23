function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function isValidPosition(position) {
    if (!position) return false;
    return isFiniteNumber(position.x) &&
        isFiniteNumber(position.y) &&
        isFiniteNumber(position.width) &&
        isFiniteNumber(position.height);
}

function buildConfigFromPosition(item, size, position) {
    if (!item?.originalImg) return null;

    return {
        logoSize: size,
        marginRight: item.originalImg.width - position.x - position.width,
        marginBottom: item.originalImg.height - position.y - position.height
    };
}

export function isConfirmedWatermarkDecision(item) {
    const decisionTier = item?.processedMeta?.decisionTier;
    if (typeof decisionTier === 'string') {
        return decisionTier !== 'insufficient';
    }

    return item?.processedMeta?.applied !== false;
}

/**
 * Resolve watermark info for UI display.
 * Prefer processed runtime metadata and fallback to static estimate.
 */
export function resolveDisplayWatermarkInfo(item, estimatedInfo) {
    const processedMeta = item?.processedMeta;
    const position = processedMeta?.position;

    if (isValidPosition(position)) {
        const size = isFiniteNumber(processedMeta.size) ? processedMeta.size : position.width;
        if (isFiniteNumber(size)) {
            return {
                size,
                position,
                config: processedMeta.config || buildConfigFromPosition(item, size, position),
                source: processedMeta.source || 'processed',
                decisionTier: processedMeta.decisionTier || null
            };
        }
    }

    if (!estimatedInfo) return null;

    return {
        ...estimatedInfo,
        source: 'estimated',
        decisionTier: null
    };
}

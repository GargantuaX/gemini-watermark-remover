export function createSelectionDebugSummary({
    selectedTrial,
    selectionSource = null
} = {}) {
    if (!selectedTrial) return null;

    const candidateSource = typeof selectionSource === 'string' && selectionSource
        ? selectionSource
        : (typeof selectedTrial.source === 'string' ? selectedTrial.source : null);

    return {
        candidateSource,
        texturePenalty: Number.isFinite(selectedTrial.texturePenalty) ? selectedTrial.texturePenalty : null,
        tooDark: selectedTrial.tooDark === true,
        tooFlat: selectedTrial.tooFlat === true,
        hardReject: selectedTrial.hardReject === true,
        usedSizeJitter: selectedTrial.provenance?.sizeJitter === true
    };
}

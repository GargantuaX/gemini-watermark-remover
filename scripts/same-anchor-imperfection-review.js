export const DEFAULT_EVIDENCE_TOLERANCE = 0.05;
export const DEFAULT_DAMAGE_TOLERANCE = 0.05;

function getCandidateId(candidate) {
    return candidate?.hypothesis?.id ?? candidate?.id ?? null;
}

function getFiniteNumber(...values) {
    return values.find((value) => Number.isFinite(value)) ?? null;
}

export function getCandidatePosition(candidate) {
    const position =
        candidate?.hypothesis?.trial?.position ??
        candidate?.hypothesis?.position ??
        candidate?.result?.meta?.position ??
        candidate?.position ??
        null;
    const config =
        candidate?.hypothesis?.config ?? candidate?.result?.meta?.config ?? null;
    const x = getFiniteNumber(position?.x);
    const y = getFiniteNumber(position?.y);
    const width = getFiniteNumber(
        position?.width,
        position?.watermarkSize,
        config?.watermarkSize
    );
    const height = getFiniteNumber(
        position?.height,
        position?.watermarkSize,
        config?.watermarkSize,
        width
    );

    if (![x, y, width, height].every(Number.isFinite)) return null;
    return { x, y, width, height };
}

export function hasSameAnchor(left, right) {
    const leftPosition = getCandidatePosition(left);
    const rightPosition = getCandidatePosition(right);
    if (!leftPosition || !rightPosition) return false;

    return (
        leftPosition.x === rightPosition.x &&
        leftPosition.y === rightPosition.y &&
        leftPosition.width === rightPosition.width &&
        leftPosition.height === rightPosition.height
    );
}

function compareAlternatives(left, right) {
    const leftSignals = left?.qualitySignals ?? {};
    const rightSignals = right?.qualitySignals ?? {};
    const imperfectionDifference =
        leftSignals.imperfections.score - rightSignals.imperfections.score;
    if (imperfectionDifference !== 0) return imperfectionDifference;

    const residualDifference =
        (leftSignals.residualLoss ?? Number.POSITIVE_INFINITY) -
        (rightSignals.residualLoss ?? Number.POSITIVE_INFINITY);
    if (residualDifference !== 0) return residualDifference;

    return String(getCandidateId(left)).localeCompare(String(getCandidateId(right)));
}

export function selectSameAnchorAlternative({
    selectedId,
    completedCandidates,
    evidenceTolerance = DEFAULT_EVIDENCE_TOLERANCE,
    damageTolerance = DEFAULT_DAMAGE_TOLERANCE
}) {
    const candidates = Array.isArray(completedCandidates) ? completedCandidates : [];
    // The pipeline may report the selected id twice when it adopts a
    // final re-run; the last report is the returned output.
    const selected = candidates.findLast(
        (candidate) => getCandidateId(candidate) === selectedId
    );
    if (!selected) {
        return {
            reason: 'selected-not-captured',
            selected: null,
            alternative: null
        };
    }

    const selectedSignals = selected.qualitySignals ?? {};
    const selectedImperfection = selectedSignals.imperfections?.score;
    const selectedEvidence = selectedSignals.evidenceLoss;
    const selectedDamage = selectedSignals.damageLoss;
    const plausible = candidates
        .filter((candidate) => getCandidateId(candidate) !== selectedId)
        .filter((candidate) => hasSameAnchor(selected, candidate))
        .filter((candidate) => {
            const signals = candidate.qualitySignals ?? {};
            const imperfection = signals.imperfections?.score;
            return (
                Number.isFinite(selectedImperfection) &&
                Number.isFinite(imperfection) &&
                imperfection < selectedImperfection &&
                Number.isFinite(selectedEvidence) &&
                Number.isFinite(signals.evidenceLoss) &&
                signals.evidenceLoss <= selectedEvidence + evidenceTolerance &&
                Number.isFinite(selectedDamage) &&
                Number.isFinite(signals.damageLoss) &&
                signals.damageLoss <= selectedDamage + damageTolerance
            );
        })
        .sort(compareAlternatives);

    if (plausible.length === 0) {
        return {
            reason: 'no-plausible-same-anchor-alternative',
            selected,
            alternative: null
        };
    }

    return {
        reason: 'matched',
        selected,
        alternative: plausible[0]
    };
}

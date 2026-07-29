import { measureOutputResidualLocalization } from './output-residual-localization.js';

function assertProfiles(profiles, position) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
        throw new TypeError('profiles must be a non-empty array');
    }
    const ids = new Set();
    for (const profile of profiles) {
        if (!profile || typeof profile.id !== 'string' || !profile.id) {
            throw new TypeError('every profile must have a non-empty id');
        }
        if (ids.has(profile.id)) {
            throw new TypeError('profile ids must be unique');
        }
        ids.add(profile.id);
        if (
            !profile.alphaMap ||
            profile.alphaMap.length !== position.width * position.height
        ) {
            throw new RangeError(
                'profile alphaMap length must match the scored position'
            );
        }
    }
}

function bestPositiveTrial(trials, scoreName) {
    const candidates = trials.filter(
        (trial) => Number.isFinite(trial[scoreName]) && trial[scoreName] > 0
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((best, trial) =>
        trial[scoreName] > best[scoreName] ? trial : best
    );
}

export function measureTwoSidedAlphaEdgeProfileBank({
    imageData,
    position,
    profiles,
    decoyShifts
}) {
    assertProfiles(profiles, position);
    const trials = profiles.map((profile) => {
        const localization = measureOutputResidualLocalization({
            imageData,
            alphaMap: profile.alphaMap,
            position,
            decoyShifts
        });
        return {
            id: profile.id,
            targetStrength: localization.twoSidedEdgeTarget,
            medianDecoyProminence:
                localization.twoSidedEdgeProminence,
            medianDecoyRatio: localization.twoSidedEdgeRatio,
            localProminence: localization.twoSidedEdgeLocalProminence,
            localRatio: localization.twoSidedEdgeLocalRatio,
            localWinnerShift:
                localization.twoSidedEdgeLocalWinnerShift
        };
    });
    const primary = bestPositiveTrial(trials, 'medianDecoyRatio');
    const secondary = bestPositiveTrial(trials, 'localProminence');
    return {
        primaryScore: primary?.medianDecoyRatio ?? null,
        primaryProfileId: primary?.id ?? null,
        secondaryScore: secondary?.localProminence ?? null,
        secondaryProfileId: secondary?.id ?? null,
        trials
    };
}

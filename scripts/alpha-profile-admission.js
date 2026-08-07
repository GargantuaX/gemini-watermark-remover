const ABSOLUTE_BAND_CLEAN_THRESHOLD = 0.5;
const REQUIRED_ALPHA_BANDS = Object.freeze(['edge', 'mid-core', 'high-core']);

export function buildAlphaProfileAdmission({ current, trial }) {
    const haloImproved = Number.isFinite(current.positiveHaloLum) &&
        Number.isFinite(trial.positiveHaloLum) &&
        trial.positiveHaloLum < current.positiveHaloLum - 0.5;
    const gradientSafe = Number.isFinite(current.gradient) &&
        Number.isFinite(trial.gradient) &&
        trial.gradient <= current.gradient + 0.01;
    const artifactSafe = Number.isFinite(current.visualArtifactCost) &&
        Number.isFinite(trial.visualArtifactCost) &&
        trial.visualArtifactCost <= current.visualArtifactCost + 0.001;
    const spatialSafe = Number.isFinite(current.spatial) &&
        Number.isFinite(trial.spatial) &&
        Math.abs(trial.spatial) <= Math.abs(current.spatial) + 0.02;
    const bandDeltas = REQUIRED_ALPHA_BANDS.map((band) => trial.bandProfile?.[band]?.positiveDeltaLum);
    const maxPositiveBandDelta = bandDeltas.every(Number.isFinite)
        ? Math.max(...bandDeltas)
        : null;
    const absoluteClean = trial.visible === false &&
        trial.visiblePositiveHalo !== true &&
        Number.isFinite(maxPositiveBandDelta) &&
        maxPositiveBandDelta <= ABSOLUTE_BAND_CLEAN_THRESHOLD;

    return {
        productionCandidate: haloImproved && gradientSafe && artifactSafe && spatialSafe && absoluteClean,
        haloImproved,
        gradientSafe,
        artifactSafe,
        spatialSafe,
        absoluteClean,
        maxPositiveBandDelta
    };
}

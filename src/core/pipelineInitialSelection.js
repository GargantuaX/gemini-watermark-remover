import {
    evaluateRestorationCandidate,
    selectInitialCandidate
} from './candidateSelector.js';
import {
    createCandidateHypothesis,
    selectDiverseCandidateHypotheses
} from './pipelineCandidatePool.js';
import {
    computeRegionSpatialCorrelation,
    interpolateAlphaMap
} from './adaptiveDetector.js';
import { calculateNearBlackRatio } from './restorationMetrics.js';
import { resolveGeminiWatermarkSearchCatalogEntries } from './geminiSizeCatalog.js';
import { measureOutputResidualLocalization } from './outputResidualLocalization.js';
import { hasReliableStandardWatermarkSignal } from './watermarkPresence.js';
import { shouldPreferFullStrengthNewMarginVariant } from './candidateEvaluation.js';

const AGGRESSIVE_FALLBACK_MAX_ABS_SPATIAL = 0.22;
const AGGRESSIVE_FALLBACK_MAX_NEAR_BLACK_INCREASE = 0.05;
const AGGRESSIVE_FALLBACK_MAX_NEAR_WHITE_INCREASE = 0.05;
const MIN_VALIDATED_GRADIENT_IMPROVEMENT = 0.01;
const MIN_VALIDATED_SPATIAL_SCORE = 0.6;
const MIN_VALIDATED_SPATIAL_SUPPRESSION = 0.3;
const MIN_LOCALIZED_PEAK_PROMINENCE = 0.06;
// A rejected restoration can still reveal the right geometry. Only let
// near-perfect, localized source evidence lock out disjoint weak fallbacks.
const STRONG_GEOMETRY_MIN_SPATIAL_SCORE = 0.95;
const STRONG_GEOMETRY_MIN_GRADIENT_SCORE = 0.8;
const GEOMETRY_LOCK_MIN_SIZE_RATIO = 0.75;
const GEOMETRY_LOCK_MIN_OVERLAP_RATIO = 0.5;
const SMALL_V2_MIN_SPATIAL_SCORE = 0.16;
const SMALL_V2_MIN_SPATIAL_SUPPRESSION = 0.13;
const SMALL_V2_MAX_ABS_SPATIAL_RESIDUAL = 0.08;
const BEST_EFFORT_SPATIAL_COLLISION_MIN_SCORE = 0.3;
const BEST_EFFORT_NONLOCAL_GRADIENT_EXCEPTION_MIN_SCORE = 0.28;
const REPEATED_TEMPLATE_CONTROL_MIN_SPATIAL_SCORE = 0.3;
const LOCALIZATION_CONTROL_OFFSETS = [
    [-1, 0],
    [0, -1],
    [-1, -1],
    [-2, 0],
    [0, -2],
    [-2, -2]
];
const REPEATED_TEMPLATE_CONTROL_SQUARES = [
    [[-1, 0], [0, -1], [-1, -1]],
    [[-2, 0], [0, -2], [-2, -2]]
];
const CONFIRMED_V2_MEDIUM_IMAGE_WIDTH = 768;
const CONFIRMED_V2_MEDIUM_IMAGE_HEIGHT = 1376;
const CONFIRMED_V2_MEDIUM_LOGO_SIZE = 48;
const CONFIRMED_V2_MEDIUM_MARGIN = 73;
const CONFIRMED_V2_MEDIUM_MIN_RESCUE_SPATIAL = 0.4;
const CONFIRMED_V2_MEDIUM_MIN_RESCUE_GRADIENT = 0.5;
const CONFIRMED_V2_SMALL_PRIOR_MIN_SPATIAL = 0.3;
const EXACT_48_R96_SOURCE_WITNESS_MIN_PRIMARY = 0.36;
const EXACT_48_R96_SOURCE_WITNESS_MIN_EDGE_PROMINENCE = 2.5;
const EXACT_48_R96_SOURCE_WITNESS_MIN_GRADIENT_PERCENTILE = 0.9;
const EXACT_48_R96_SOURCE_WITNESS_GAIN = 0.6;
const EXACT_48_R96_SOURCE_WITNESS_REASON =
    'exact-48-r96-source-witness';
const EXACT_48_R96_SOURCE_WITNESS_DECOY_SHIFTS = [
    [-12, 0], [-8, 0], [-4, 0], [4, 0], [8, 0], [12, 0],
    [0, -12], [0, -8], [0, -4], [0, 4], [0, 8], [0, 12],
    [-8, -8], [-4, -4], [4, 4], [8, 8],
    [-8, 8], [-4, 4], [4, -4], [8, -8],
    [-12, -6], [-6, -12], [6, 12], [12, 6]
];
const EXACT_96_R192_SOURCE_WITNESS_MIN_GRADIENT = 0.02;
const EXACT_96_R192_SOURCE_WITNESS_MIN_EDGE_PROMINENCE = 0.2;
const EXACT_96_R192_SOURCE_WITNESS_MIN_EDGE_PERCENTILE = 0.5;
const EXACT_96_R192_SOURCE_WITNESS_MIN_INVERSE_SPATIAL = 0.1;
const EXACT_96_R192_SOURCE_WITNESS_MIN_INVERSE_SPATIAL_PERCENTILE = 0.5;
const EXACT_96_R192_SOURCE_WITNESS_GAIN = 0.45;
const EXACT_96_R192_SOURCE_WITNESS_REASON =
    'exact-96-r192-source-witness';
const EXACT_96_R192_SOURCE_WITNESS_DECOY_SHIFTS = [
    [-24, 0], [-16, 0], [-8, 0], [8, 0], [16, 0], [24, 0],
    [0, -24], [0, -16], [0, -8], [0, 8], [0, 16], [0, 24],
    [-16, -16], [-8, -8], [8, 8], [16, 16],
    [-16, 16], [-8, 8], [8, -8], [16, -16],
    [-24, -12], [-12, -24], [12, 24], [24, 12]
];

// The Allenk V2 renderer and the trusted 768x1376 sample cluster agree on
// 48px / 73px geometry. Keep it out of the generic catalog because structured
// clean content at this size can still correlate with the V2 template.
function isConfirmedV2SmallSelection(trial) {
    return trial?.config?.logoSize === 36 &&
        trial.config.marginRight === 96 &&
        trial.config.marginBottom === 96 &&
        Number(trial.originalSpatialScore) >=
            CONFIRMED_V2_SMALL_PRIOR_MIN_SPATIAL &&
        (
            trial.config.alphaVariant === 'v2' ||
            trial.provenance?.alphaVariant === 'v2'
        );
}

function createConfirmedV2MediumRescueTrial({
    originalImageData,
    getAlphaMap,
    fixedSelection,
    automaticSelection
}) {
    if (
        originalImageData?.width !== CONFIRMED_V2_MEDIUM_IMAGE_WIDTH ||
        originalImageData?.height !== CONFIRMED_V2_MEDIUM_IMAGE_HEIGHT ||
        typeof getAlphaMap !== 'function'
    ) {
        return null;
    }

    const fixedTrial = fixedSelection?.selectedTrial;
    const automaticTrial = automaticSelection?.selectedTrial;
    const hasV2SmallPrior =
        isConfirmedV2SmallSelection(fixedTrial) ||
        isConfirmedV2SmallSelection(automaticTrial);

    const alpha36V2 = getAlphaMap('36-v2');
    if (!alpha36V2 || alpha36V2.length !== 36 * 36) return null;

    const alphaMap = interpolateAlphaMap(
        alpha36V2,
        36,
        CONFIRMED_V2_MEDIUM_LOGO_SIZE
    );
    const config = {
        logoSize: CONFIRMED_V2_MEDIUM_LOGO_SIZE,
        marginRight: CONFIRMED_V2_MEDIUM_MARGIN,
        marginBottom: CONFIRMED_V2_MEDIUM_MARGIN,
        alphaVariant: 'v2'
    };
    const position = {
        x: originalImageData.width - config.marginRight - config.logoSize,
        y: originalImageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };
    const trial = evaluateRestorationCandidate({
        originalImageData,
        alphaMap,
        position,
        source: 'standard+confirmed-v2-medium-rescue',
        config,
        baselineNearBlackRatio: calculateNearBlackRatio(
            originalImageData,
            position
        ),
        alphaGain: 1,
        provenance: {
            catalogVariant: true,
            fixedVariant: true,
            alphaVariant: 'v2',
            catalogFamily: 'confirmed-v2-medium-rescue',
            catalogEvidenceGate: 'medium',
            confirmedV2MediumRescue: true,
            rescueReason: hasV2SmallPrior
                ? 'replace-confirmed-v2-small-geometry'
                : 'recover-strong-unconfirmed-v2-medium'
        },
        includeImageData: false
    });
    if (!trial?.accepted) return null;

    // A strong 36px V2 prior is independent geometry evidence. Do not require
    // its 48px replacement to pass the initial texture-damage heuristic here:
    // the top-N executor still repairs, scores, and ranks the completed output.
    // The confirmed bottle case begins with a false texture hard-reject but
    // finishes without a damage warning after the normal repair pipeline.
    if (
        !hasV2SmallPrior &&
        (
            Number(trial.originalSpatialScore) <
                CONFIRMED_V2_MEDIUM_MIN_RESCUE_SPATIAL ||
            Number(trial.originalGradientScore) <
                CONFIRMED_V2_MEDIUM_MIN_RESCUE_GRADIENT ||
            trial.damage?.safe !== true
        )
    ) {
        return null;
    }

    return trial;
}

function createExact48R96SourceWitnessRescueTrial({
    originalImageData,
    alpha48,
    config,
    catalogPriorConfig
}) {
    if (!originalImageData || !alpha48) return null;

    const catalogEntry = resolveGeminiWatermarkSearchCatalogEntries(
        originalImageData.width,
        originalImageData.height,
        catalogPriorConfig ?? config
    ).find((entry) => (
        entry?.metadata?.family === 'known-current-variant' &&
        entry.metadata.evidenceGate === 'required' &&
        entry.config?.logoSize === 48 &&
        entry.config.marginRight === 96 &&
        entry.config.marginBottom === 96 &&
        entry.config.alphaVariant == null
    ));
    if (!catalogEntry) return null;

    const sourceTrial = {
        source: 'standard+catalog',
        config: catalogEntry.config,
        position: {
            x: originalImageData.width - 96 - 48,
            y: originalImageData.height - 96 - 48,
            width: 48,
            height: 48
        },
        alphaMap: alpha48,
        alphaGain: 1,
        provenance: {
            catalogVariant: true,
            catalogFamily: catalogEntry.metadata.family,
            catalogSourcePriority: catalogEntry.metadata.sourcePriority,
            catalogEvidenceGate: catalogEntry.metadata.evidenceGate
        }
    };
    const sourceLocalization = measureOutputResidualLocalization({
        imageData: originalImageData,
        alphaMap: sourceTrial.alphaMap,
        position: sourceTrial.position,
        decoyShifts: EXACT_48_R96_SOURCE_WITNESS_DECOY_SHIFTS
    });
    const spatialSignal = Number(sourceLocalization.spatialSignedTarget);
    const gradientSignal = Number(sourceLocalization.gradientSignedTarget);
    const primarySignal = Math.max(spatialSignal, gradientSignal);
    if (
        !Number.isFinite(spatialSignal) ||
        spatialSignal <= 0 ||
        !Number.isFinite(primarySignal) ||
        primarySignal < EXACT_48_R96_SOURCE_WITNESS_MIN_PRIMARY ||
        Number(sourceLocalization.twoSidedEdgeProminence) <
            EXACT_48_R96_SOURCE_WITNESS_MIN_EDGE_PROMINENCE ||
        Number(sourceLocalization.gradientPercentile) <
            EXACT_48_R96_SOURCE_WITNESS_MIN_GRADIENT_PERCENTILE
    ) {
        return null;
    }

    const rescueTrial = evaluateRestorationCandidate({
        originalImageData,
        alphaMap: sourceTrial.alphaMap,
        position: sourceTrial.position,
        source: `${sourceTrial.source ?? 'standard+catalog'}+source-witness-rescue`,
        config: sourceTrial.config,
        baselineNearBlackRatio: calculateNearBlackRatio(
            originalImageData,
            sourceTrial.position
        ),
        alphaGain: EXACT_48_R96_SOURCE_WITNESS_GAIN,
        provenance: {
            ...sourceTrial.provenance,
            sourceWitnessRescue: true,
            sourceWitnessReason: EXACT_48_R96_SOURCE_WITNESS_REASON,
            sourceWitnessGate: {
                primarySignal,
                spatialSignedTarget: spatialSignal,
                gradientSignedTarget: gradientSignal,
                twoSidedEdgeProminence:
                    sourceLocalization.twoSidedEdgeProminence,
                gradientPercentile:
                    sourceLocalization.gradientPercentile
            }
        },
        includeImageData: false
    });
    return measurePresenceLocalization(
        originalImageData,
        rescueTrial
    ).repeatedTemplateCollision
        ? null
        : rescueTrial;
}

function createExact96R192SourceWitnessRescueTrial({
    originalImageData,
    alpha96Variants,
    config,
    catalogPriorConfig,
    fixedSelection,
    automaticSelection
}) {
    const alphaMap = alpha96Variants?.['20260520'];
    if (
        !originalImageData ||
        !alphaMap ||
        alphaMap.length !== 96 * 96
    ) {
        return null;
    }

    const catalogEntry = resolveGeminiWatermarkSearchCatalogEntries(
        originalImageData.width,
        originalImageData.height,
        catalogPriorConfig ?? config
    ).find((entry) => (
        entry?.metadata?.evidenceGate === 'required' &&
        entry.config?.logoSize === 96 &&
        entry.config.marginRight === 192 &&
        entry.config.marginBottom === 192 &&
        entry.config.alphaVariant === '20260520'
    ));
    if (!catalogEntry) return null;

    const position = {
        x: originalImageData.width - 192 - 96,
        y: originalImageData.height - 192 - 96,
        width: 96,
        height: 96
    };
    const acceptedEligibleTrials = [
        fixedSelection?.selectedTrial,
        automaticSelection?.selectedTrial
    ].filter((trial, index, trials) => (
        trial?.accepted === true &&
        trial.evaluation?.eligible === true &&
        trials.indexOf(trial) === index
    ));
    const hasDriftedDarkPolaritySelection = acceptedEligibleTrials.some(
        (trial) => (
            trial.provenance?.darkPolarity === true &&
            (
                trial.position?.x !== position.x ||
                trial.position?.y !== position.y ||
                trial.position?.width !== position.width ||
                trial.position?.height !== position.height
            )
        )
    );
    const sourceLocalization = measureOutputResidualLocalization({
        imageData: originalImageData,
        alphaMap,
        position,
        decoyShifts: EXACT_96_R192_SOURCE_WITNESS_DECOY_SHIFTS
    });
    const spatialSignal = Number(sourceLocalization.spatialSignedTarget);
    const spatialPercentile = Number(sourceLocalization.spatialPercentile);
    const gradientSignal = Number(sourceLocalization.gradientSignedTarget);
    // White inverse removal needs positive signed evidence. Preserve the
    // structured-content exception only when a separate drifted dark trial
    // exists and the exact anchor still has strong localized spatial support;
    // otherwise unsigned edges alone can reproduce the Issue #123 dark hole.
    const hasSupportedSpatialPolarity = spatialSignal > 0 || (
        hasDriftedDarkPolaritySelection &&
        Math.abs(spatialSignal) >=
            EXACT_96_R192_SOURCE_WITNESS_MIN_INVERSE_SPATIAL &&
        spatialPercentile >=
            EXACT_96_R192_SOURCE_WITNESS_MIN_INVERSE_SPATIAL_PERCENTILE
    );
    if (
        !Number.isFinite(spatialSignal) ||
        !Number.isFinite(spatialPercentile) ||
        !hasSupportedSpatialPolarity ||
        !Number.isFinite(gradientSignal) ||
        gradientSignal < EXACT_96_R192_SOURCE_WITNESS_MIN_GRADIENT ||
        Number(sourceLocalization.twoSidedEdgeProminence) <
            EXACT_96_R192_SOURCE_WITNESS_MIN_EDGE_PROMINENCE ||
        Number(sourceLocalization.twoSidedEdgePercentile) <
            EXACT_96_R192_SOURCE_WITNESS_MIN_EDGE_PERCENTILE
    ) {
        return null;
    }

    const baselineNearBlackRatio = calculateNearBlackRatio(
        originalImageData,
        position
    );
    const provenance = {
        catalogVariant: true,
        alphaVariant: '20260520',
        catalogFamily: catalogEntry.metadata.family,
        catalogSourcePriority: catalogEntry.metadata.sourcePriority,
        catalogEvidenceGate: catalogEntry.metadata.evidenceGate,
        sourceWitnessRescue: true,
        sourceWitnessReason: EXACT_96_R192_SOURCE_WITNESS_REASON,
        sourceWitnessGate: {
            spatialSignedTarget: spatialSignal,
            spatialPercentile,
            gradientSignedTarget: gradientSignal,
            twoSidedEdgeProminence:
                sourceLocalization.twoSidedEdgeProminence,
            twoSidedEdgePercentile:
                sourceLocalization.twoSidedEdgePercentile
        }
    };
    const createRescueTrial = (alphaGain) => evaluateRestorationCandidate({
        originalImageData,
        alphaMap,
        position,
        source: 'standard+catalog+source-witness-rescue',
        config: catalogEntry.config,
        baselineNearBlackRatio,
        alphaGain,
        provenance,
        includeImageData: false
    });
    const conservativeTrial = createRescueTrial(EXACT_96_R192_SOURCE_WITNESS_GAIN);
    const fullStrengthTrial = spatialSignal > 0 ? createRescueTrial(1) : null;
    const rescueTrial = fullStrengthTrial &&
        shouldPreferFullStrengthNewMarginVariant(fullStrengthTrial, conservativeTrial)
        ? fullStrengthTrial
        : conservativeTrial;
    if (
        acceptedEligibleTrials.length > 0 &&
        !hasDriftedDarkPolaritySelection &&
        rescueTrial !== fullStrengthTrial
    ) {
        return null;
    }
    return measurePresenceLocalization(
        originalImageData,
        rescueTrial
    ).repeatedTemplateCollision
        ? null
        : rescueTrial;
}

function getPositiveSourceEvidenceScore(trial) {
    const spatial = Number(trial?.originalSpatialScore);
    const gradient = Number(trial?.originalGradientScore);
    return Math.max(
        Number.isFinite(spatial) ? spatial : Number.NEGATIVE_INFINITY,
        Number.isFinite(gradient) ? gradient : Number.NEGATIVE_INFINITY
    );
}

function findCanonical96CatalogPriorTrial({
    fixedSelection,
    automaticSelection,
    catalogPriorConfig
}) {
    if (
        catalogPriorConfig?.logoSize !== 96 ||
        catalogPriorConfig.marginRight !== 64 ||
        catalogPriorConfig.marginBottom !== 64
    ) {
        return null;
    }

    const trials = [fixedSelection, automaticSelection]
        .flatMap((selection) => [
            ...(selection?.candidatePool ?? []),
            selection?.selectedTrial
        ])
        .filter(Boolean);
    const canonicalTrial = trials.find((trial) => (
        trial.config?.logoSize === 96 &&
        trial.config.marginRight === 64 &&
        trial.config.marginBottom === 64 &&
        !trial.config.alphaVariant &&
        trial.provenance?.darkPolarity !== true &&
        trial.alphaGain === 1
    ));
    if (!canonicalTrial) return null;

    return {
        ...canonicalTrial,
        source: `${canonicalTrial.source ?? 'standard'}+catalog-prior-best-effort`,
        provenance: {
            ...canonicalTrial.provenance,
            sourceWitnessRescue: true,
            sourceWitnessReason: 'canonical-96-prior-over-weaker-r192',
            catalogPriorBestEffort: true
        }
    };
}

function selectExact96SourceWitnessTrial({
    r192Trial,
    fixedSelection,
    automaticSelection,
    catalogPriorConfig
}) {
    if (!r192Trial) return null;
    const canonicalTrial = findCanonical96CatalogPriorTrial({
        fixedSelection,
        automaticSelection,
        catalogPriorConfig
    });
    if (
        !canonicalTrial ||
        getPositiveSourceEvidenceScore(canonicalTrial) <=
            getPositiveSourceEvidenceScore(r192Trial)
    ) {
        return r192Trial;
    }
    return canonicalTrial;
}

function isSafeAggressiveFallbackSelection(selection) {
    const trial = selection?.selectedTrial;
    const spatial = Number(trial?.processedSpatialScore);
    return Boolean(trial) &&
        Number.isFinite(spatial) &&
        Math.abs(spatial) <= AGGRESSIVE_FALLBACK_MAX_ABS_SPATIAL &&
        trial.damage?.safe === true &&
        Number(trial.nearBlackIncrease ?? 0) <= AGGRESSIVE_FALLBACK_MAX_NEAR_BLACK_INCREASE &&
        Number(trial.nearWhiteIncrease ?? 0) <= AGGRESSIVE_FALLBACK_MAX_NEAR_WHITE_INCREASE;
}

function createSelectorRequest(input) {
    return {
        originalImageData: input.originalImageData,
        config: input.config,
        catalogPriorConfig: input.catalogPriorConfig,
        position: input.position,
        alpha48: input.alpha48,
        alpha96: input.alpha96,
        alpha96Variants: input.alpha96Variants,
        getAlphaMap: input.getAlphaMap,
        allowAdaptiveSearch: input.allowAdaptiveSearch,
        alphaGainCandidates: input.alphaGainCandidates,
        alphaPriorityGains: input.alphaPriorityGains
    };
}

function createConservativeTopNTrial(originalImageData, selection, maximumAllowedGain, origin) {
    const trial = selection?.selectedTrial;
    if (!trial?.alphaMap || !trial?.position || !trial?.config) return null;
    const baselineNearBlackRatio = calculateNearBlackRatio(originalImageData, trial.position);
    const maximumGain = Math.min(maximumAllowedGain, Number(trial.alphaGain ?? 1));
    const gains = [0.5, 0.35, 0.25, 0.15, 0.1]
        .filter((gain) => gain <= maximumGain + 0.0001);
    const candidates = gains.map((alphaGain) => evaluateRestorationCandidate({
        originalImageData,
        alphaMap: trial.alphaMap,
        position: trial.position,
        source: `${trial.source ?? selection.source ?? 'standard'}+top-n-conservative`,
        config: trial.config,
        baselineNearBlackRatio,
        adaptiveConfidence: trial.adaptiveConfidence ?? selection.adaptiveConfidence ?? null,
        alphaGain,
        provenance: {
            ...(trial.provenance ?? {}),
            topNConservative: true,
            topNOrigin: origin
        },
        includeImageData: false,
        sourcePriority: trial.sourcePriority ?? null,
        alphaPriorityIndex: trial.alphaPriorityIndex ?? null
    })).filter(Boolean);
    return candidates.find((candidate) => (
        Number(candidate.nearBlackIncrease ?? Infinity) < 0.04 &&
        Number(candidate.nearWhiteIncrease ?? Infinity) < 0.04
    )) ?? candidates.at(-1) ?? null;
}

function sameTrialIdentity(left, right) {
    if (!left || !right) return false;
    const leftPosition = left.position;
    const rightPosition = right.position;
    return left.alphaMap === right.alphaMap &&
        Math.abs(Number(left.alphaGain ?? 1) - Number(right.alphaGain ?? 1)) < 0.0001 &&
        leftPosition?.x === rightPosition?.x &&
        leftPosition?.y === rightPosition?.y &&
        leftPosition?.width === rightPosition?.width &&
        leftPosition?.height === rightPosition?.height;
}

function hasCompleteBestEffortTrial(trial, originalImageData) {
    const position = trial?.position;
    const config = trial?.config;
    const alphaMap = trial?.alphaMap;
    const alphaGain = Number(trial?.alphaGain ?? 1);
    const coordinates = [
        position?.x,
        position?.y,
        position?.width,
        position?.height
    ];
    if (
        !originalImageData?.data ||
        !coordinates.every(Number.isInteger) ||
        position.width <= 0 ||
        position.height <= 0 ||
        position.x < 0 ||
        position.y < 0 ||
        position.x + position.width > originalImageData.width ||
        position.y + position.height > originalImageData.height ||
        !Number.isFinite(config?.logoSize) ||
        config.logoSize !== position.width ||
        position.width !== position.height ||
        !alphaMap ||
        alphaMap.length !== position.width * position.height ||
        !Number.isFinite(alphaGain) ||
        alphaGain <= 0
    ) {
        return false;
    }

    let hasNonZeroAlpha = false;
    for (const alpha of alphaMap) {
        if (!Number.isFinite(alpha)) return false;
        if (alpha !== 0) hasNonZeroAlpha = true;
    }
    return hasNonZeroAlpha;
}

function hasMeasurableRestorationEffect(trial) {
    const scorePairs = [
        [trial?.originalSpatialScore, trial?.processedSpatialScore],
        [trial?.originalGradientScore, trial?.processedGradientScore]
    ];
    let comparableScoreCount = 0;
    for (const [beforeValue, afterValue] of scorePairs) {
        const before = Number(beforeValue);
        const after = Number(afterValue);
        if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
        comparableScoreCount++;
        if (Math.abs(before - after) > 1e-8) return true;
    }

    // Preserve compatibility with legacy/injected selectors that do not
    // expose paired restoration scores. When scores are present, an exact
    // no-op must not count as a best-effort output.
    return comparableScoreCount === 0;
}

function hasNonlocalizedSpatialCollision(trial, originalImageData) {
    const originalSpatial = Number(trial?.originalSpatialScore);
    const originalGradient = Number(trial?.originalGradientScore);
    if (
        !Number.isFinite(originalSpatial) ||
        !Number.isFinite(originalGradient)
    ) {
        return false;
    }

    const localization = measurePresenceLocalization(originalImageData, trial);
    // Repeated watermark-shaped textures can create a prominent target peak
    // while still matching several neighboring tiles. Restoration success is
    // not independent evidence in that case because inverse compositing can
    // erase any matching content patch.
    if (localization.repeatedTemplateCollision) {
        return true;
    }
    if (originalSpatial < BEST_EFFORT_SPATIAL_COLLISION_MIN_SCORE) {
        return false;
    }
    return (
        (
            !localization.localized &&
            originalGradient < BEST_EFFORT_NONLOCAL_GRADIENT_EXCEPTION_MIN_SCORE
        )
    );
}

function isSafeSelectorBestEffortSelection(selection, originalImageData) {
    const trial = selection?.selectedTrial;
    const isSmallV2 =
        trial?.config?.alphaVariant === 'v2' ||
        trial?.provenance?.alphaVariant === 'v2';
    const catalogScopeAllowed = !isSmallV2 ||
        trial?.provenance?.catalogFamily === 'gemini-v2-small';
    return Boolean(
        trial &&
        selection.source !== 'skipped' &&
        (
            selection.decisionTier === 'direct-match' ||
            selection.decisionTier === 'validated-match'
        ) &&
        trial.accepted === true &&
        trial.evaluation?.eligible === true &&
        trial.damage?.safe === true &&
        catalogScopeAllowed &&
        !hasNonlocalizedSpatialCollision(trial, originalImageData) &&
        hasMeasurableRestorationEffect(trial) &&
        hasCompleteBestEffortTrial(trial, originalImageData)
    );
}

function hasStrongRestorationEvidence(trial) {
    if (
        trial?.residual?.cleared === true ||
        trial?.evaluation?.postResidual?.cleared === true
    ) {
        return true;
    }
    const originalGradient = Number(trial?.originalGradientScore);
    const processedGradient = Math.abs(Number(trial?.processedGradientScore));
    if (
        Number.isFinite(originalGradient) &&
        Number.isFinite(processedGradient) &&
        originalGradient - processedGradient >= MIN_VALIDATED_GRADIENT_IMPROVEMENT
    ) {
        return true;
    }
    return false;
}

function hasValidatedRestorationEvidence(trial) {
    if (hasStrongRestorationEvidence(trial)) {
        return true;
    }
    const originalSpatial = Number(trial?.originalSpatialScore);
    const processedSpatial = Math.abs(Number(trial?.processedSpatialScore));
    return Number.isFinite(originalSpatial) &&
        Number.isFinite(processedSpatial) &&
        originalSpatial >= MIN_VALIDATED_SPATIAL_SCORE &&
        originalSpatial - processedSpatial >= MIN_VALIDATED_SPATIAL_SUPPRESSION;
}

function hasEvidenceGatedSmallV2CatalogPresence(trial) {
    if (
        trial?.provenance?.alphaVariant !== 'v2' ||
        trial?.provenance?.catalogFamily !== 'gemini-v2-small' ||
        trial?.damage?.safe !== true
    ) {
        return false;
    }
    const originalSpatial = Number(trial.originalSpatialScore);
    const processedSpatial = Math.abs(Number(trial.processedSpatialScore));
    return Number.isFinite(originalSpatial) &&
        Number.isFinite(processedSpatial) &&
        originalSpatial >= SMALL_V2_MIN_SPATIAL_SCORE &&
        processedSpatial <= SMALL_V2_MAX_ABS_SPATIAL_RESIDUAL &&
        originalSpatial - processedSpatial >= SMALL_V2_MIN_SPATIAL_SUPPRESSION;
}

function measurePresenceLocalization(originalImageData, trial) {
    const position = trial?.position;
    const alphaMap = trial?.alphaMap;
    const width = Number(position?.width);
    const height = Number(position?.height);
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (
        !originalImageData?.data ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        width <= 0 ||
        height <= 0 ||
        !alphaMap ||
        alphaMap.length !== width * height
    ) {
        // Preserve compatibility with injected/legacy selectors that do not
        // expose enough geometry to validate a localized peak.
        return {
            localized: true,
            repeatedTemplateCollision: false
        };
    }

    const controlScores = [];
    const controlScoresByOffset = new Map();
    for (const [offsetX, offsetY] of LOCALIZATION_CONTROL_OFFSETS) {
        const controlRegion = {
            x: x + offsetX * width,
            y: y + offsetY * height,
            width,
            height
        };
        if (
            controlRegion.x < 0 ||
            controlRegion.y < 0 ||
            controlRegion.x + width > originalImageData.width ||
            controlRegion.y + height > originalImageData.height
        ) {
            continue;
        }
        const controlScore = computeRegionSpatialCorrelation({
            imageData: originalImageData,
            alphaMap,
            region: controlRegion
        });
        controlScores.push(controlScore);
        controlScoresByOffset.set(`${offsetX},${offsetY}`, controlScore);
    }
    if (controlScores.length === 0) {
        return {
            localized: true,
            repeatedTemplateCollision: false
        };
    }

    const reportedSpatial = Number(trial.originalSpatialScore);
    const candidateSpatial = Number.isFinite(reportedSpatial)
        ? reportedSpatial
        : computeRegionSpatialCorrelation({
            imageData: originalImageData,
            alphaMap,
            region: position
        });
    const maximumControlScore = Math.max(...controlScores);
    const repeatedTemplateCollision = REPEATED_TEMPLATE_CONTROL_SQUARES.some(
        (square) => square.every(([offsetX, offsetY]) => {
            const score = controlScoresByOffset.get(`${offsetX},${offsetY}`);
            return Number.isFinite(score) &&
                score >= REPEATED_TEMPLATE_CONTROL_MIN_SPATIAL_SCORE;
        })
    );
    return {
        localized: Number.isFinite(candidateSpatial) &&
            Number.isFinite(maximumControlScore) &&
            candidateSpatial - maximumControlScore >= MIN_LOCALIZED_PEAK_PROMINENCE,
        repeatedTemplateCollision
    };
}

function hasSelectorConfirmedTarget(selection, originalImageData) {
    const trial = selection?.selectedTrial;
    if (
        !trial ||
        selection.source === 'skipped' ||
        selection.decisionTier === 'insufficient'
    ) {
        return false;
    }
    const directMatch = hasReliableStandardWatermarkSignal({
        spatialScore: trial.originalSpatialScore,
        gradientScore: trial.originalGradientScore
    });
    const localization = measurePresenceLocalization(originalImageData, trial);
    if (localization.repeatedTemplateCollision) {
        return false;
    }
    const localizedPresence = localization.localized;
    const hasCompleteRestorationDecision =
        trial.accepted === true &&
        trial.evaluation?.eligible === true;
    if (directMatch) {
        return localizedPresence ||
            (
                hasCompleteRestorationDecision &&
                (
                    hasStrongRestorationEvidence(trial) ||
                    hasEvidenceGatedSmallV2CatalogPresence(trial)
                )
            );
    }
    if (trial.accepted === false || trial.evaluation?.eligible === false) {
        return false;
    }
    if (!hasCompleteRestorationDecision) {
        return true;
    }
    return hasStrongRestorationEvidence(trial) ||
        hasEvidenceGatedSmallV2CatalogPresence(trial) ||
        (
            localizedPresence &&
            hasValidatedRestorationEvidence(trial)
        );
}

function findEligiblePresenceTrial(selection, originalImageData) {
    return (selection?.candidatePool ?? []).find((trial) => {
        if (trial?.accepted !== true || trial.evaluation?.eligible !== true) {
            return false;
        }
        const directMatch = hasReliableStandardWatermarkSignal({
                spatialScore: trial.originalSpatialScore,
                gradientScore: trial.originalGradientScore
        });
        const localization = measurePresenceLocalization(originalImageData, trial);
        if (localization.repeatedTemplateCollision) {
            return false;
        }
        const localizedPresence = localization.localized;
        return hasStrongRestorationEvidence(trial) ||
            hasEvidenceGatedSmallV2CatalogPresence(trial) || (
            localizedPresence &&
            (directMatch || hasValidatedRestorationEvidence(trial))
        );
    });
}

function findConfirmedPoolPresenceTrial(selection, originalImageData) {
    return (selection?.candidatePool ?? []).find((trial) => (
        trial &&
        trial !== selection?.selectedTrial &&
        // A selected adaptive/catalog trial can hide the canonical candidate.
        // Keep this recovery narrow so preview/content collisions in the wider
        // diagnostic pool cannot confirm presence on their own.
        trial.provenance?.catalogFamily === 'default-standard' &&
        hasSelectorConfirmedTarget({
            ...selection,
            selectedTrial: trial,
            source: trial.source ?? 'candidate-pool',
            decisionTier: null
        }, originalImageData)
    ));
}

function isStrongLocalizedGeometryTrial(trial, originalImageData) {
    const spatialScore = Number(trial?.originalSpatialScore);
    const gradientScore = Number(trial?.originalGradientScore);
    if (
        !Number.isFinite(spatialScore) ||
        !Number.isFinite(gradientScore) ||
        spatialScore < STRONG_GEOMETRY_MIN_SPATIAL_SCORE ||
        gradientScore < STRONG_GEOMETRY_MIN_GRADIENT_SCORE ||
        !hasReliableStandardWatermarkSignal({
            spatialScore,
            gradientScore
        })
    ) {
        return false;
    }
    const localization = measurePresenceLocalization(originalImageData, trial);
    return localization.localized && !localization.repeatedTemplateCollision;
}

function findStrongLocalizedGeometryTrial(selection, originalImageData) {
    const trials = [
        selection?.selectedTrial,
        ...(selection?.candidatePool ?? [])
    ];
    let bestTrial = null;
    let bestScore = -Infinity;
    for (const trial of trials) {
        if (!isStrongLocalizedGeometryTrial(trial, originalImageData)) {
            continue;
        }
        const score = Number(trial.originalSpatialScore) +
            Number(trial.originalGradientScore);
        if (score > bestScore) {
            bestTrial = trial;
            bestScore = score;
        }
    }
    return bestTrial;
}

function isGeometryCompatibleWithLock(trial, geometryLockTrial) {
    if (!geometryLockTrial) return true;
    const trialPosition = trial?.position;
    const lockPosition = geometryLockTrial?.position;
    const trialWidth = Number(trialPosition?.width);
    const trialHeight = Number(trialPosition?.height);
    const lockWidth = Number(lockPosition?.width);
    const lockHeight = Number(lockPosition?.height);
    if (
        ![trialPosition?.x, trialPosition?.y, trialWidth, trialHeight,
            lockPosition?.x, lockPosition?.y, lockWidth, lockHeight]
            .every(Number.isFinite) ||
        trialWidth <= 0 ||
        trialHeight <= 0 ||
        lockWidth <= 0 ||
        lockHeight <= 0
    ) {
        return false;
    }

    const widthRatio = Math.min(trialWidth, lockWidth) /
        Math.max(trialWidth, lockWidth);
    const heightRatio = Math.min(trialHeight, lockHeight) /
        Math.max(trialHeight, lockHeight);
    if (
        widthRatio < GEOMETRY_LOCK_MIN_SIZE_RATIO ||
        heightRatio < GEOMETRY_LOCK_MIN_SIZE_RATIO
    ) {
        return false;
    }

    const intersectionWidth = Math.max(0, Math.min(
        trialPosition.x + trialWidth,
        lockPosition.x + lockWidth
    ) - Math.max(trialPosition.x, lockPosition.x));
    const intersectionHeight = Math.max(0, Math.min(
        trialPosition.y + trialHeight,
        lockPosition.y + lockHeight
    ) - Math.max(trialPosition.y, lockPosition.y));
    const intersectionArea = intersectionWidth * intersectionHeight;
    const minimumArea = Math.min(
        trialWidth * trialHeight,
        lockWidth * lockHeight
    );
    return intersectionArea / minimumArea >= GEOMETRY_LOCK_MIN_OVERLAP_RATIO;
}

function findWatermarkPresenceWitness(selection, originalImageData) {
    if (hasSelectorConfirmedTarget(selection, originalImageData)) {
        return selection.selectedTrial;
    }
    return findConfirmedPoolPresenceTrial(selection, originalImageData) ??
        findStrongLocalizedGeometryTrial(selection, originalImageData) ??
        findEligiblePresenceTrial(selection, originalImageData) ??
        null;
}

export function collectInitialWatermarkCandidates(input = {}) {
    const selectCandidate = input.selectCandidate ?? selectInitialCandidate;
    const fixedSelection = selectCandidate({
        ...createSelectorRequest(input),
        allowAutomaticSearch: false,
        allowAggressiveStrongLocated: false
    });
    const automaticSelection = input.allowAdaptiveSearch === false
        ? fixedSelection
        : selectCandidate({
            ...createSelectorRequest(input),
            allowAutomaticSearch: true,
            allowAggressiveStrongLocated: true
        });
    const potentialV2MediumRescueTrial =
        createConfirmedV2MediumRescueTrial({
            originalImageData: input.originalImageData,
            getAlphaMap: input.getAlphaMap,
            fixedSelection,
            automaticSelection
        });
    const fixedPresenceWitness = findWatermarkPresenceWitness(
        fixedSelection,
        input.originalImageData
    );
    const automaticPresenceWitness = findWatermarkPresenceWitness(
        automaticSelection,
        input.originalImageData
    );
    const normalPresenceConfirmed = Boolean(
        fixedPresenceWitness || automaticPresenceWitness
    );
    const confirmedV2MediumRescueTrial =
        (
            potentialV2MediumRescueTrial?.provenance?.rescueReason ===
                'replace-confirmed-v2-small-geometry' ||
            !normalPresenceConfirmed
        )
            ? potentialV2MediumRescueTrial
            : null;
    const geometryLockWitness =
        findStrongLocalizedGeometryTrial(
            fixedSelection,
            input.originalImageData
        ) ??
        findStrongLocalizedGeometryTrial(
            automaticSelection,
            input.originalImageData
        );
    const presenceConfirmed = Boolean(
        normalPresenceConfirmed || confirmedV2MediumRescueTrial
    );
    const exact48R96SourceWitnessRescueTrial = presenceConfirmed
        ? null
        : createExact48R96SourceWitnessRescueTrial({
            originalImageData: input.originalImageData,
            alpha48: input.alpha48,
            config: input.config,
            catalogPriorConfig: input.catalogPriorConfig
        });
    const exact96R192SourceWitnessRescueTrial =
        exact48R96SourceWitnessRescueTrial
            ? null
            : createExact96R192SourceWitnessRescueTrial({
                originalImageData: input.originalImageData,
                alpha96Variants: input.alpha96Variants,
                config: input.config,
                catalogPriorConfig: input.catalogPriorConfig,
                fixedSelection,
                automaticSelection
            });
    const exact96SourceWitnessTrial = selectExact96SourceWitnessTrial({
        r192Trial: exact96R192SourceWitnessRescueTrial,
        fixedSelection,
        automaticSelection,
        catalogPriorConfig: input.catalogPriorConfig
    });
    const sourceWitnessRescueTrial =
        exact48R96SourceWitnessRescueTrial ??
        exact96SourceWitnessTrial;
    const bestEffortSelections = presenceConfirmed ||
        sourceWitnessRescueTrial
        ? []
        : [fixedSelection, automaticSelection]
            .filter((selection, index, values) => (
                values.indexOf(selection) === index &&
                isSafeSelectorBestEffortSelection(
                    selection,
                    input.originalImageData
                )
            ));
    const bestEffortFallback = !presenceConfirmed && Boolean(
        sourceWitnessRescueTrial ||
        bestEffortSelections.length > 0
    );
    if (!presenceConfirmed && !bestEffortFallback) {
        return {
            hypotheses: [],
            presenceConfirmed: false,
            bestEffortFallback: false,
            bestEffortReason: null,
            fixedSelection,
            automaticSelection
        };
    }
    const repeatedTemplateCollisionCache = new Map();
    const keepNonRepeatedTrial = (trial) => {
        if (!trial) return false;
        if (!repeatedTemplateCollisionCache.has(trial)) {
            repeatedTemplateCollisionCache.set(
                trial,
                measurePresenceLocalization(
                    input.originalImageData,
                    trial
                ).repeatedTemplateCollision
            );
        }
        return repeatedTemplateCollisionCache.get(trial) !== true;
    };

    const includeFixedSelection = (
        presenceConfirmed ||
        bestEffortSelections.includes(fixedSelection)
    ) && isGeometryCompatibleWithLock(
        fixedSelection?.selectedTrial,
        geometryLockWitness
    );
    const includeAutomaticSelection = (
        presenceConfirmed ||
        bestEffortSelections.includes(automaticSelection)
    ) && isGeometryCompatibleWithLock(
        automaticSelection?.selectedTrial,
        geometryLockWitness
    );
    const fixedConservativeOrigin = fixedPresenceWitness ??
        fixedSelection?.selectedTrial;
    const automaticConservativeOrigin = automaticPresenceWitness ??
        automaticSelection?.selectedTrial;
    const includeFixedConservative = (
        presenceConfirmed ||
        bestEffortSelections.includes(fixedSelection)
    ) && isGeometryCompatibleWithLock(
        fixedConservativeOrigin,
        geometryLockWitness
    );
    const includeAutomaticConservative = (
        presenceConfirmed ||
        bestEffortSelections.includes(automaticSelection)
    ) && isGeometryCompatibleWithLock(
        automaticConservativeOrigin,
        geometryLockWitness
    );
    const conservativeTrials = [
        includeFixedConservative
            ? createConservativeTopNTrial(
                input.originalImageData,
                {
                    ...fixedSelection,
                    selectedTrial: fixedConservativeOrigin
                },
                0.5,
                'fixed'
            )
            : null,
        includeAutomaticConservative
            ? createConservativeTopNTrial(
                input.originalImageData,
                {
                    ...automaticSelection,
                    selectedTrial: automaticConservativeOrigin
                },
                0.25,
                'automatic'
            )
            : null
    ]
        .filter((trial) => (
            trial &&
            (
                !bestEffortFallback ||
                (
                    trial.damage?.safe === true &&
                    trial.hardReject !== true &&
                    Number(trial.nearBlackIncrease ?? Infinity) < 0.04 &&
                    Number(trial.nearWhiteIncrease ?? Infinity) < 0.04 &&
                    hasMeasurableRestorationEffect(trial)
                )
            )
        ));
    const trials = (
        bestEffortFallback
            ? sourceWitnessRescueTrial
                ? [sourceWitnessRescueTrial]
                : [
                includeFixedSelection ? fixedSelection?.selectedTrial : null,
                includeAutomaticSelection ? automaticSelection?.selectedTrial : null,
                ...conservativeTrials
                ]
            : [
                ...(fixedSelection?.candidatePool ?? []),
                fixedSelection?.selectedTrial,
                ...(automaticSelection?.candidatePool ?? []),
                automaticSelection?.selectedTrial,
                confirmedV2MediumRescueTrial,
                ...conservativeTrials
            ]
    ).filter((trial) => (
        keepNonRepeatedTrial(trial) &&
        isGeometryCompatibleWithLock(trial, geometryLockWitness)
    ));

    const diverseHypotheses = selectDiverseCandidateHypotheses(trials, { limit: 5 });
    const fixedSelectedHypothesis = createCandidateHypothesis(
        includeFixedSelection &&
            keepNonRepeatedTrial(fixedSelection?.selectedTrial)
            ? fixedSelection?.selectedTrial
            : null,
        1000
    );
    const automaticSelectedHypothesis = createCandidateHypothesis(
        includeAutomaticSelection &&
            keepNonRepeatedTrial(automaticSelection?.selectedTrial)
            ? automaticSelection?.selectedTrial
            : null,
        1001
    );
    const fixedPresenceHypothesis = createCandidateHypothesis(
        keepNonRepeatedTrial(fixedPresenceWitness) &&
            isGeometryCompatibleWithLock(
                fixedPresenceWitness,
                geometryLockWitness
            )
            ? fixedPresenceWitness
            : null,
        1002
    );
    const automaticPresenceHypothesis = createCandidateHypothesis(
        keepNonRepeatedTrial(automaticPresenceWitness) &&
            isGeometryCompatibleWithLock(
                automaticPresenceWitness,
                geometryLockWitness
            )
            ? automaticPresenceWitness
            : null,
        1003
    );
    const confirmedV2MediumRescueHypothesis = createCandidateHypothesis(
        keepNonRepeatedTrial(confirmedV2MediumRescueTrial) &&
            isGeometryCompatibleWithLock(
                confirmedV2MediumRescueTrial,
                geometryLockWitness
            )
            ? confirmedV2MediumRescueTrial
            : null,
        1004
    );
    const sourceWitnessRescueHypothesis =
        createCandidateHypothesis(
            keepNonRepeatedTrial(sourceWitnessRescueTrial) &&
                isGeometryCompatibleWithLock(
                    sourceWitnessRescueTrial,
                    geometryLockWitness
                )
                ? sourceWitnessRescueTrial
                : null,
            1005
        );
    const preferredHypotheses = [
        fixedSelectedHypothesis,
        automaticSelectedHypothesis,
        sourceWitnessRescueHypothesis,
        fixedPresenceHypothesis,
        automaticPresenceHypothesis,
        confirmedV2MediumRescueHypothesis
    ].filter((hypothesis, index, values) => (
        hypothesis &&
        values.findIndex((candidate) => sameTrialIdentity(
            candidate?.trial,
            hypothesis.trial
        )) === index
    ));
    const retainedAlternatives = diverseHypotheses
        .filter((hypothesis) => !preferredHypotheses.some((preferred) => (
            sameTrialIdentity(preferred.trial, hypothesis.trial)
        )))
        .slice(0, Math.max(0, 5 - preferredHypotheses.length));
    const hypotheses = [...preferredHypotheses, ...retainedAlternatives]
        .map((hypothesis) => ({
            ...hypothesis,
            presenceStatus: !presenceConfirmed && sourceWitnessRescueTrial
                ? 'source-witness'
                : bestEffortFallback
                ? 'selector-only'
                : 'confirmed',
            discoveryRole:
                hypothesis.trial?.provenance?.sourceWitnessRescue === true
                ? 'source-witness-rescue'
                : bestEffortFallback &&
                hypothesis.trial?.provenance?.topNConservative !== true
                ? 'discovered-alternative'
                : hypothesis.trial?.provenance?.topNConservative === true
                ? 'conservative-derived'
                : hypothesis.trial?.provenance?.confirmedV2MediumRescue === true
                    ? 'confirmed-rescue'
                : sameTrialIdentity(hypothesis.trial, fixedSelection?.selectedTrial)
                    ? 'fixed-selected'
                    : sameTrialIdentity(hypothesis.trial, automaticSelection?.selectedTrial)
                        ? 'automatic-selected'
                        : automaticSelectedHypothesis?.family === 'aggressive'
                            ? 'aggressive-fallback-alternative'
                        : 'discovered-alternative'
        }));

    return {
        hypotheses,
        presenceConfirmed,
        bestEffortFallback,
        bestEffortReason: bestEffortFallback && sourceWitnessRescueTrial
            ? sourceWitnessRescueTrial.provenance?.sourceWitnessReason ??
                'source-witness'
            : bestEffortFallback
            ? 'presence-witness-unconfirmed'
            : null,
        fixedSelection,
        automaticSelection
    };
}

export function selectInitialWatermarkCandidate({
    originalImageData,
    config,
    position,
    alpha48,
    alpha96,
    alpha96Variants = null,
    getAlphaMap = null,
    allowAdaptiveSearch = true,
    aggressiveLocatedFallback = true,
    alphaGainCandidates,
    alphaPriorityGains,
    selectCandidate = selectInitialCandidate
} = {}) {
    let initialSelection = selectCandidate({
        originalImageData,
        config,
        position,
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap,
        allowAdaptiveSearch,
        allowAutomaticSearch: false,
        alphaGainCandidates,
        alphaPriorityGains
    });

    if (
        !initialSelection.selectedTrial &&
        aggressiveLocatedFallback !== false
    ) {
        const aggressiveSelection = selectCandidate({
            originalImageData,
            config,
            position,
            alpha48,
            alpha96,
            alpha96Variants,
            getAlphaMap,
            allowAdaptiveSearch,
            allowAutomaticSearch: true,
            allowAggressiveStrongLocated: true,
            alphaGainCandidates,
            alphaPriorityGains
        });
        if (isSafeAggressiveFallbackSelection(aggressiveSelection)) {
            initialSelection = {
                ...aggressiveSelection,
                source: aggressiveSelection.source.includes('aggressive-located')
                    ? aggressiveSelection.source
                    : `${aggressiveSelection.source}+aggressive-located`,
                decisionTier: aggressiveSelection.decisionTier || 'direct-match'
            };
        }
    }

    return initialSelection;
}

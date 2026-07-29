import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation
} from '../src/core/adaptiveDetector.js';

function transformAlphaMap(alphaMap, exponent) {
    return Float32Array.from(alphaMap, (value) => (
        Math.sign(value) * Math.pow(Math.abs(value), exponent)
    ));
}

function enumerateShifts(radius) {
    const shifts = [];
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            shifts.push({ dx, dy });
        }
    }
    return shifts;
}

export function summarizeResidualProfileTrials(trials) {
    let bestSpatial = null;
    let bestGradient = null;
    let bestJoint = null;
    let bestUnderSpatial = null;
    let bestOverSpatial = null;
    let bestUnderJoint = null;
    let bestOverJoint = null;
    for (const trial of trials) {
        if (
            !bestSpatial ||
            Math.abs(trial.spatial) > Math.abs(bestSpatial.spatial)
        ) {
            bestSpatial = trial;
        }
        if (!bestGradient || trial.gradient > bestGradient.gradient) {
            bestGradient = trial;
        }
        if (
            trial.spatial > 0 &&
            (!bestUnderSpatial ||
                trial.spatial > bestUnderSpatial.spatial)
        ) {
            bestUnderSpatial = trial;
        }
        if (
            trial.spatial < 0 &&
            (!bestOverSpatial || trial.spatial < bestOverSpatial.spatial)
        ) {
            bestOverSpatial = trial;
        }
        const jointEvidence = Math.sqrt(
            Math.abs(trial.spatial) * Math.max(0, trial.gradient)
        );
        if (!bestJoint || jointEvidence > bestJoint.jointEvidence) {
            bestJoint = { ...trial, jointEvidence };
        }
        if (trial.spatial > 0 && trial.gradient > 0) {
            const underJointEvidence = Math.sqrt(
                trial.spatial * trial.gradient
            );
            if (
                !bestUnderJoint ||
                underJointEvidence > bestUnderJoint.jointEvidence
            ) {
                bestUnderJoint = {
                    ...trial,
                    jointEvidence: underJointEvidence
                };
            }
        }
        if (trial.spatial < 0 && trial.gradient > 0) {
            const overJointEvidence = Math.sqrt(
                -trial.spatial * trial.gradient
            );
            if (
                !bestOverJoint ||
                overJointEvidence > bestOverJoint.jointEvidence
            ) {
                bestOverJoint = {
                    ...trial,
                    jointEvidence: overJointEvidence
                };
            }
        }
    }
    const maxAbsSpatial = Math.abs(bestSpatial?.spatial ?? 0);
    const maxPositiveGradient = Math.max(0, bestGradient?.gradient ?? 0);
    return {
        maxAbsSpatial,
        maxPositiveGradient,
        marginalJointEvidence: Math.sqrt(
            maxAbsSpatial * maxPositiveGradient
        ),
        bestJointEvidence: bestJoint?.jointEvidence ?? 0,
        bestSpatial: bestSpatial
            ? {
                score: bestSpatial.spatial,
                profile: bestSpatial.profile,
                exponent: bestSpatial.exponent,
                dx: bestSpatial.dx,
                dy: bestSpatial.dy
            }
            : null,
        bestGradient: bestGradient
            ? {
                score: bestGradient.gradient,
                profile: bestGradient.profile,
                exponent: bestGradient.exponent,
                dx: bestGradient.dx,
                dy: bestGradient.dy
            }
            : null,
        bestJoint,
        directionalEvidence: {
            underRemoval: {
                maxPositiveSpatial: Math.max(
                    0,
                    bestUnderSpatial?.spatial ?? 0
                ),
                bestSpatial: bestUnderSpatial
                    ? {
                        score: bestUnderSpatial.spatial,
                        profile: bestUnderSpatial.profile,
                        exponent: bestUnderSpatial.exponent,
                        dx: bestUnderSpatial.dx,
                        dy: bestUnderSpatial.dy
                    }
                    : null,
                bestJointEvidence:
                    bestUnderJoint?.jointEvidence ?? 0,
                bestJoint: bestUnderJoint
            },
            overRemoval: {
                maxNegativeSpatialMagnitude: Math.max(
                    0,
                    -(bestOverSpatial?.spatial ?? 0)
                ),
                bestSpatial: bestOverSpatial
                    ? {
                        score: bestOverSpatial.spatial,
                        profile: bestOverSpatial.profile,
                        exponent: bestOverSpatial.exponent,
                        dx: bestOverSpatial.dx,
                        dy: bestOverSpatial.dy
                    }
                    : null,
                bestJointEvidence:
                    bestOverJoint?.jointEvidence ?? 0,
                bestJoint: bestOverJoint
            }
        }
    };
}

export function evaluateResidualProfileEvidence({
    imageData,
    position,
    profiles,
    powerExponents = [1],
    shiftRadius = 0
}) {
    const size = position?.width;
    const searchSpace = {
        profileCount: Array.isArray(profiles) ? profiles.length : 0,
        powerExponents: [...powerExponents],
        shiftRadius
    };
    if (
        !imageData ||
        !Number.isInteger(size) ||
        size <= 0 ||
        position.height !== size
    ) {
        return {
            residualProfile: null,
            searchSpace,
            evidenceQuality: {
                status: 'unavailable',
                reason: 'unsupported-geometry',
                expectedTrialCount: 0,
                evaluatedTrialCount: 0
            }
        };
    }
    const shifts = enumerateShifts(shiftRadius);
    const expectedTrialCount =
        profiles.length * powerExponents.length * shifts.length;
    let evaluatedTrialCount = 0;
    const trials = [];

    for (const profile of profiles) {
        if (profile.alphaMap.length !== size * size) {
            throw new RangeError(
                `Profile ${profile.name} does not match ${size}x${size}`
            );
        }
        for (const exponent of powerExponents) {
            const alphaMap = transformAlphaMap(
                profile.alphaMap,
                exponent
            );
            for (const { dx, dy } of shifts) {
                const region = {
                    x: position.x + dx,
                    y: position.y + dy,
                    size
                };
                if (
                    region.x < 0 ||
                    region.y < 0 ||
                    region.x + size > imageData.width ||
                    region.y + size > imageData.height
                ) {
                    continue;
                }
                evaluatedTrialCount++;
                const spatial = computeRegionSpatialCorrelation({
                    imageData,
                    alphaMap,
                    region
                });
                const gradient = computeRegionGradientCorrelation({
                    imageData,
                    alphaMap,
                    region
                });
                trials.push({
                    profile: profile.name,
                    exponent,
                    dx,
                    dy,
                    spatial,
                    gradient
                });
            }
        }
    }

    return {
        residualProfile: summarizeResidualProfileTrials(trials),
        searchSpace,
        evidenceQuality: {
            status: evaluatedTrialCount === expectedTrialCount
                ? 'complete'
                : evaluatedTrialCount > 0
                    ? 'partial'
                    : 'unavailable',
            expectedTrialCount,
            evaluatedTrialCount
        }
    };
}

export function createResidualProfileShadowObservation({
    currentResidualVisibility,
    evidence
}) {
    const rawVisible = typeof currentResidualVisibility?.rawVisible ===
        'boolean'
        ? currentResidualVisibility.rawVisible
        : null;
    const calibratedVisible = typeof
    currentResidualVisibility?.calibratedVisible === 'boolean'
        ? currentResidualVisibility.calibratedVisible
        : null;
    const currentDecision = {
        rawVisible,
        calibratedVisible,
        metricRisk: currentResidualVisibility?.metricRisk ?? null
    };
    const profile = evidence?.residualProfile ?? null;
    const underRemoval =
        profile?.directionalEvidence?.underRemoval ?? null;
    const overRemoval =
        profile?.directionalEvidence?.overRemoval ?? null;
    const bestSpatial = profile?.bestSpatial ?? null;
    const bestGradient = profile?.bestGradient ?? null;
    const winner = (entry) => entry
        ? {
            profile: entry.profile,
            exponent: entry.exponent,
            dx: entry.dx,
            dy: entry.dy
        }
        : null;
    const shiftRadius = evidence?.searchSpace?.shiftRadius;
    const powerExponents = Array.isArray(
        evidence?.searchSpace?.powerExponents
    )
        ? evidence.searchSpace.powerExponents
        : [];
    const isShiftBoundary = (entry) => Boolean(
        entry &&
        Number.isFinite(shiftRadius) &&
        shiftRadius > 0 &&
        (
            Math.abs(entry.dx) === shiftRadius ||
            Math.abs(entry.dy) === shiftRadius
        )
    );
    const isExponentEndpoint = (entry) => {
        if (!entry || powerExponents.length < 2) return false;
        const minimum = Math.min(...powerExponents);
        const maximum = Math.max(...powerExponents);
        return (
            entry.exponent === minimum ||
            entry.exponent === maximum
        );
    };
    const sameHeadWinner = Boolean(
        bestSpatial &&
        bestGradient &&
        bestSpatial.profile === bestGradient.profile &&
        bestSpatial.exponent === bestGradient.exponent &&
        bestSpatial.dx === bestGradient.dx &&
        bestSpatial.dy === bestGradient.dy
    );
    const rawSpatial = currentResidualVisibility?.spatialResidual ??
        currentResidualVisibility?.rawSpatialScore;
    const rawGradient = currentResidualVisibility?.gradientResidual ??
        currentResidualVisibility?.rawGradientScore;
    const absSpatial = Number.isFinite(rawSpatial)
        ? Math.abs(rawSpatial)
        : null;
    const positiveGradient = Number.isFinite(rawGradient)
        ? Math.max(0, rawGradient)
        : null;
    const subtract = (left, right) => (
        Number.isFinite(left) && Number.isFinite(right)
            ? Number((left - right).toFixed(12))
            : null
    );
    const calibrationEvidenceLevel =
        rawVisible !== null && calibratedVisible !== null
            ? 'full'
            : rawVisible !== null || calibratedVisible !== null
                ? 'partial'
                : 'unavailable';
    const evidenceQuality = evidence?.evidenceQuality ?? {
        status: 'unavailable',
        expectedTrialCount: 0,
        evaluatedTrialCount: 0
    };
    const rProfile = profile
        ? {
            spatial: {
                signedAtMaxAbs: bestSpatial?.score ?? 0,
                maxAbs: profile.maxAbsSpatial,
                winner: winner(bestSpatial)
            },
            gradient: {
                maxSigned: bestGradient?.score ?? 0,
                maxPositive: profile.maxPositiveGradient,
                winner: winner(bestGradient)
            },
            marginalJointEvidence:
                profile.marginalJointEvidence ?? null,
            bestJointEvidence: profile.bestJointEvidence ?? null
        }
        : null;
    const rUnder = underRemoval
        ? {
            maxPositiveSpatial:
                underRemoval.maxPositiveSpatial ?? 0,
            bestJointEvidence:
                underRemoval.bestJointEvidence ?? 0,
            spatialWinner: winner(underRemoval.bestSpatial),
            jointWinner: winner(underRemoval.bestJoint)
        }
        : null;
    const dOver = overRemoval
        ? {
            maxNegativeSpatialMagnitude:
                overRemoval.maxNegativeSpatialMagnitude ?? 0,
            bestJointEvidence:
                overRemoval.bestJointEvidence ?? 0,
            spatialWinner: winner(overRemoval.bestSpatial),
            jointWinner: winner(overRemoval.bestJoint)
        }
        : null;
    return {
        shadowReviewEligible:
            rawVisible === true &&
            calibratedVisible === false &&
            evidenceQuality.status !== 'unavailable',
        currentDecision,
        rProfile,
        rUnder,
        dOver,
        currentCalibratedDisagreement: {
            evidenceLevel: calibrationEvidenceLevel,
            current: {
                qualityStatus:
                    currentResidualVisibility?.qualityStatus ?? null,
                rawVisible,
                calibratedVisible,
                metricRisk: currentDecision.metricRisk,
                absSpatial,
                positiveGradient
            },
            existingRawVsCalibrated: {
                known: calibrationEvidenceLevel === 'full',
                disagrees:
                    calibrationEvidenceLevel === 'full'
                        ? rawVisible !== calibratedVisible
                        : null,
                direction:
                    rawVisible === true && calibratedVisible === false
                        ? 'raw-visible-calibrated-suppressed'
                        : rawVisible === false &&
                            calibratedVisible === true
                            ? 'raw-clear-calibrated-visible'
                            : calibrationEvidenceLevel === 'full'
                                ? 'same'
                                : 'unknown'
            },
            rProfileDelta: {
                absSpatial: subtract(
                    profile?.maxAbsSpatial,
                    absSpatial
                ),
                positiveGradient: subtract(
                    profile?.maxPositiveGradient,
                    positiveGradient
                )
            },
            profileVerdict: null
        },
        q: {
            evidenceAvailability: evidenceQuality.status,
            attemptedTrialCount:
                evidenceQuality.expectedTrialCount ?? 0,
            validTrialCount:
                evidenceQuality.evaluatedTrialCount ?? 0,
            inBoundsTrialCount:
                evidenceQuality.evaluatedTrialCount ?? 0,
            coverage:
                evidenceQuality.expectedTrialCount > 0
                    ? evidenceQuality.evaluatedTrialCount /
                        evidenceQuality.expectedTrialCount
                    : 0,
            sameHeadWinner,
            currentCalibrationEvidence: calibrationEvidenceLevel,
            directionalWinnerRisk: {
                under: {
                    shiftBoundary: isShiftBoundary(
                        underRemoval?.bestJoint
                    ),
                    exponentEndpoint: isExponentEndpoint(
                        underRemoval?.bestJoint
                    )
                },
                over: {
                    shiftBoundary: isShiftBoundary(
                        overRemoval?.bestJoint
                    ),
                    exponentEndpoint: isExponentEndpoint(
                        overRemoval?.bestJoint
                    )
                }
            }
        },
        productionDecisionChanged: false,
        productionCalibratedVisible: calibratedVisible
    };
}

function hasCompleteVisibilityDecision(value) {
    return (
        typeof value?.rawVisible === 'boolean' &&
        typeof value?.calibratedVisible === 'boolean'
    );
}

export function resolveHistoricalResidualVisibility(record) {
    const candidates = [
        ['residualVisibility', record?.residualVisibility],
        ['qualitySignals.visibility', record?.qualitySignals?.visibility],
        ['production', record?.production]
    ];
    for (const [source, visibility] of candidates) {
        if (hasCompleteVisibilityDecision(visibility)) {
            return { source, visibility };
        }
    }
    return null;
}

export function selectShadowResidualProfileRecords(reports) {
    const records = [];
    const firstOccurrenceByFilePath = new Map();
    const duplicateByFilePath = new Map();
    let scannedResultCount = 0;
    let eligibleBeforeDedupCount = 0;
    let duplicateRecordCount = 0;

    for (const report of reports) {
        const results = Array.isArray(report?.results)
            ? report.results
            : [];
        scannedResultCount += results.length;
        for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
            const record = results[resultIndex];
            const resolved = resolveHistoricalResidualVisibility(record);
            if (
                !resolved ||
                resolved.visibility.rawVisible !== true ||
                resolved.visibility.calibratedVisible !== false
            ) {
                continue;
            }
            eligibleBeforeDedupCount++;
            const occurrence = {
                sourceReport: report?.sourceReport ?? null,
                resultIndex
            };
            const filePath = record?.filePath;
            if (
                typeof filePath === 'string' &&
                firstOccurrenceByFilePath.has(filePath)
            ) {
                duplicateRecordCount++;
                let duplicate = duplicateByFilePath.get(filePath);
                if (!duplicate) {
                    duplicate = {
                        filePath,
                        kept: firstOccurrenceByFilePath.get(filePath),
                        dropped: []
                    };
                    duplicateByFilePath.set(filePath, duplicate);
                }
                duplicate.dropped.push(occurrence);
                continue;
            }
            if (typeof filePath === 'string') {
                firstOccurrenceByFilePath.set(filePath, occurrence);
            }
            records.push({
                ...record,
                sourceReport: occurrence.sourceReport,
                resultIndex,
                historicalVisibilitySource: resolved.source,
                historicalResidualVisibility: resolved.visibility
            });
        }
    }

    return {
        records,
        audit: {
            reportCount: reports.length,
            scannedResultCount,
            eligibleBeforeDedupCount,
            selectedUniqueFileCount: records.length,
            duplicateRecordCount,
            duplicates: [...duplicateByFilePath.values()]
        }
    };
}

function nearestRank(values, percentile) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const rank = Math.max(1, Math.ceil(sorted.length * percentile));
    return sorted[rank - 1];
}

function summarizeContinuous(values) {
    const finiteValues = values.filter(Number.isFinite);
    return {
        count: finiteValues.length,
        p50: nearestRank(finiteValues, 0.5),
        p90: nearestRank(finiteValues, 0.9),
        p95: nearestRank(finiteValues, 0.95)
    };
}

function finiteOrZero(value) {
    return Number.isFinite(value) ? value : 0;
}

export function summarizeShadowResidualProfileRecords(records) {
    const availability = {
        complete: 0,
        partial: 0,
        unavailable: 0
    };
    let attemptedTrialCount = 0;
    let validTrialCount = 0;
    let inBoundsTrialCount = 0;
    let comparableRecords = 0;
    let rawVisibleChanges = 0;
    let calibratedVisibleChanges = 0;
    let anyDecisionChanges = 0;

    for (const record of records) {
        const status = record?.q?.evidenceAvailability;
        if (status === 'complete' || status === 'partial') {
            availability[status]++;
        } else {
            availability.unavailable++;
        }
        attemptedTrialCount += finiteOrZero(
            record?.q?.attemptedTrialCount
        );
        validTrialCount += finiteOrZero(record?.q?.validTrialCount);
        inBoundsTrialCount += finiteOrZero(
            record?.q?.inBoundsTrialCount
        );

        const drift = record?.replay?.decisionDrift;
        if (drift?.comparable === true) {
            comparableRecords++;
            if (drift.rawVisibleChanged === true) rawVisibleChanges++;
            if (drift.calibratedVisibleChanged === true) {
                calibratedVisibleChanges++;
            }
            if (drift.anyDecisionChanged === true) anyDecisionChanges++;
        }
    }

    return {
        decisionSemantics: 'none',
        totalRecords: records.length,
        productionDecisionChanges: 0,
        continuousEvidence: {
            maxAbsSpatial: summarizeContinuous(
                records.map((record) => record?.rProfile?.spatial?.maxAbs)
            ),
            maxPositiveGradient: summarizeContinuous(
                records.map(
                    (record) => record?.rProfile?.gradient?.maxPositive
                )
            ),
            ...(records.some(
                (record) =>
                    Number.isFinite(record?.rUnder?.bestJointEvidence) ||
                    Number.isFinite(record?.dOver?.bestJointEvidence)
            )
                ? {
                    underRemovalBestJoint: summarizeContinuous(
                        records.map(
                            (record) =>
                                record?.rUnder?.bestJointEvidence
                        )
                    ),
                    overRemovalBestJoint: summarizeContinuous(
                        records.map(
                            (record) =>
                                record?.dOver?.bestJointEvidence
                        )
                    )
                }
                : {})
        },
        evidenceCoverage: {
            ...availability,
            attemptedTrialCount,
            validTrialCount,
            inBoundsTrialCount,
            trialCoverage: attemptedTrialCount > 0
                ? inBoundsTrialCount / attemptedTrialCount
                : 0
        },
        replayDrift: {
            comparableRecords,
            rawVisibleChanges,
            calibratedVisibleChanges,
            anyDecisionChanges
        }
    };
}

import assert from 'node:assert/strict';
import test from 'node:test';

let runnerModule = null;
try {
    runnerModule = await import(
        '../../scripts/run-shadow-residual-profile-ensemble.js'
    );
} catch {
    // RED: the offline shadow runner does not exist yet.
}

function requireExport(name) {
    assert.equal(
        typeof runnerModule?.[name],
        'function',
        `expected runner to export ${name}()`
    );
    return runnerModule[name];
}

test('resolves the first visibility source that has both boolean decisions', () => {
    const resolveHistoricalResidualVisibility = requireExport(
        'resolveHistoricalResidualVisibility'
    );
    const qualitySignalsVisibility = {
        rawVisible: true,
        calibratedVisible: false,
        metricRisk: 'quality-signals-risk'
    };
    const productionVisibility = {
        rawVisible: false,
        calibratedVisible: true,
        metricRisk: 'production-risk'
    };

    assert.deepEqual(
        resolveHistoricalResidualVisibility({
            residualVisibility: {
                rawVisible: true,
                calibratedVisible: 'false'
            },
            qualitySignals: {
                visibility: qualitySignalsVisibility
            },
            production: productionVisibility
        }),
        {
            source: 'qualitySignals.visibility',
            visibility: qualitySignalsVisibility
        }
    );

    const residualVisibility = {
        rawVisible: false,
        calibratedVisible: false,
        metricRisk: 'first-complete-source-wins'
    };
    assert.deepEqual(
        resolveHistoricalResidualVisibility({
            residualVisibility,
            qualitySignals: {
                visibility: qualitySignalsVisibility
            },
            production: productionVisibility
        }),
        {
            source: 'residualVisibility',
            visibility: residualVisibility
        }
    );

    assert.deepEqual(
        resolveHistoricalResidualVisibility({
            production: productionVisibility
        }),
        {
            source: 'production',
            visibility: productionVisibility
        }
    );
    assert.equal(
        resolveHistoricalResidualVisibility({
            residualVisibility: {
                rawVisible: 1,
                calibratedVisible: false
            }
        }),
        null
    );
});

test('selects only strict raw-visible calibrated-suppressed results', () => {
    const selectShadowResidualProfileRecords = requireExport(
        'selectShadowResidualProfileRecords'
    );
    const selection = selectShadowResidualProfileRecords([
        {
            sourceReport: 'report-a.json',
            records: [{
                filePath: 'ignored-records-array.png',
                residualVisibility: {
                    rawVisible: true,
                    calibratedVisible: false
                }
            }],
            results: [
                {
                    filePath: 'direct.png',
                    residualVisibility: {
                        rawVisible: true,
                        calibratedVisible: false
                    }
                },
                {
                    filePath: 'quality-signals.png',
                    residualVisibility: {
                        rawVisible: true
                    },
                    qualitySignals: {
                        visibility: {
                            rawVisible: true,
                            calibratedVisible: false
                        }
                    }
                },
                {
                    filePath: 'production.png',
                    production: {
                        rawVisible: true,
                        calibratedVisible: false
                    }
                },
                {
                    filePath: 'raw-clear.png',
                    residualVisibility: {
                        rawVisible: false,
                        calibratedVisible: false
                    }
                },
                {
                    filePath: 'calibrated-visible.png',
                    residualVisibility: {
                        rawVisible: true,
                        calibratedVisible: true
                    }
                },
                {
                    filePath: 'truthy-strings.png',
                    residualVisibility: {
                        rawVisible: 'true',
                        calibratedVisible: 'false'
                    }
                }
            ]
        }
    ]);

    assert.deepEqual(
        selection.records.map((record) => ({
            filePath: record.filePath,
            visibilitySource: record.historicalVisibilitySource
        })),
        [
            {
                filePath: 'direct.png',
                visibilitySource: 'residualVisibility'
            },
            {
                filePath: 'quality-signals.png',
                visibilitySource: 'qualitySignals.visibility'
            },
            {
                filePath: 'production.png',
                visibilitySource: 'production'
            }
        ]
    );
    assert.deepEqual(selection.audit, {
        reportCount: 1,
        scannedResultCount: 6,
        eligibleBeforeDedupCount: 3,
        selectedUniqueFileCount: 3,
        duplicateRecordCount: 0,
        duplicates: []
    });
});

test('deduplicates repeated file paths while preserving an auditable occurrence list', () => {
    const selectShadowResidualProfileRecords = requireExport(
        'selectShadowResidualProfileRecords'
    );
    const visibleSuppressed = {
        rawVisible: true,
        calibratedVisible: false
    };
    const selection = selectShadowResidualProfileRecords([
        {
            sourceReport: 'report-a.json',
            results: [
                {
                    filePath: 'shared.png',
                    residualVisibility: visibleSuppressed
                },
                {
                    filePath: 'only-a.png',
                    residualVisibility: visibleSuppressed
                }
            ]
        },
        {
            sourceReport: 'report-b.json',
            results: [
                {
                    filePath: 'shared.png',
                    qualitySignals: {
                        visibility: visibleSuppressed
                    }
                }
            ]
        }
    ]);

    assert.deepEqual(
        selection.records.map((record) => record.filePath),
        ['shared.png', 'only-a.png']
    );
    assert.deepEqual(selection.audit, {
        reportCount: 2,
        scannedResultCount: 3,
        eligibleBeforeDedupCount: 3,
        selectedUniqueFileCount: 2,
        duplicateRecordCount: 1,
        duplicates: [
            {
                filePath: 'shared.png',
                kept: {
                    sourceReport: 'report-a.json',
                    resultIndex: 0
                },
                dropped: [
                    {
                        sourceReport: 'report-b.json',
                        resultIndex: 0
                    }
                ]
            }
        ]
    });
});

test('summarizes only continuous evidence coverage and replay drift without a verdict', () => {
    const summarizeShadowResidualProfileRecords = requireExport(
        'summarizeShadowResidualProfileRecords'
    );
    const records = [
        {
            rProfile: {
                spatial: { maxAbs: 0.01 },
                gradient: { maxPositive: 0.02 }
            },
            q: {
                evidenceAvailability: 'complete',
                attemptedTrialCount: 10,
                validTrialCount: 10,
                inBoundsTrialCount: 10
            },
            replay: {
                decisionDrift: {
                    comparable: true,
                    rawVisibleChanged: false,
                    calibratedVisibleChanged: false,
                    anyDecisionChanged: false
                }
            },
            productionDecisionChanged: false,
            currentCalibratedDisagreement: {
                profileVerdict: null
            }
        },
        {
            rProfile: {
                spatial: { maxAbs: 0.04 },
                gradient: { maxPositive: 0.03 }
            },
            q: {
                evidenceAvailability: 'partial',
                attemptedTrialCount: 10,
                validTrialCount: 8,
                inBoundsTrialCount: 7
            },
            replay: {
                decisionDrift: {
                    comparable: true,
                    rawVisibleChanged: true,
                    calibratedVisibleChanged: false,
                    anyDecisionChanged: true
                }
            },
            productionDecisionChanged: false
        },
        {
            rProfile: {
                spatial: { maxAbs: 0.09 },
                gradient: { maxPositive: 0.12 }
            },
            q: {
                evidenceAvailability: 'complete',
                attemptedTrialCount: 10,
                validTrialCount: 10,
                inBoundsTrialCount: 10
            },
            replay: {
                decisionDrift: {
                    comparable: true,
                    rawVisibleChanged: false,
                    calibratedVisibleChanged: true,
                    anyDecisionChanged: true
                }
            },
            productionDecisionChanged: false
        },
        {
            rProfile: null,
            q: {
                evidenceAvailability: 'unavailable',
                attemptedTrialCount: 0,
                validTrialCount: 0,
                inBoundsTrialCount: 0
            },
            replay: {
                decisionDrift: {
                    comparable: false,
                    rawVisibleChanged: null,
                    calibratedVisibleChanged: null,
                    anyDecisionChanged: null
                }
            },
            productionDecisionChanged: false
        }
    ];

    const summary = summarizeShadowResidualProfileRecords(records);

    assert.deepEqual(summary, {
        decisionSemantics: 'none',
        totalRecords: 4,
        productionDecisionChanges: 0,
        continuousEvidence: {
            maxAbsSpatial: {
                count: 3,
                p50: 0.04,
                p90: 0.09,
                p95: 0.09
            },
            maxPositiveGradient: {
                count: 3,
                p50: 0.03,
                p90: 0.12,
                p95: 0.12
            }
        },
        evidenceCoverage: {
            complete: 2,
            partial: 1,
            unavailable: 1,
            attemptedTrialCount: 30,
            validTrialCount: 28,
            inBoundsTrialCount: 27,
            trialCoverage: 0.9
        },
        replayDrift: {
            comparableRecords: 3,
            rawVisibleChanges: 1,
            calibratedVisibleChanges: 1,
            anyDecisionChanges: 2
        }
    });

    const forbiddenKeys = new Set([
        'hits',
        'misses',
        'hitRate',
        'pass',
        'fail',
        'profileVerdict'
    ]);
    const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            assert.equal(
                forbiddenKeys.has(key),
                false,
                `summary must not contain decision field ${key}`
            );
            visit(child);
        }
    };
    visit(summary);
});

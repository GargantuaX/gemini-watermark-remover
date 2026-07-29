import { createPipelineStateCommit } from './pipelineState.js';
import { applyPipelinePassOutcome } from './pipelinePassState.js';
import { createTailDebugTimings } from './pipelineTimings.js';

export function runCurrentAlphaTrialStage({
    stage,
    strategy,
    createTrial,
    acceptCurrentAlphaTrialResult,
    source,
    stageExtras,
    eventExtras,
    debugTimings = null,
    timingKey = null,
    nowMs = Date.now
} = {}) {
    const startedAt = nowMs();
    const result = typeof createTrial === 'function' ? createTrial() : null;

    if (result && typeof acceptCurrentAlphaTrialResult === 'function') {
        const acceptedTrial = {
            stage,
            strategy,
            result,
            source: typeof source === 'function' ? source(result) : source
        };
        if (stageExtras !== undefined) {
            acceptedTrial.stageExtras = resolveStageValue(stageExtras, result) ?? {};
        }
        if (eventExtras !== undefined) {
            acceptedTrial.eventExtras = resolveStageValue(eventExtras, result) ?? {};
        }
        acceptCurrentAlphaTrialResult(acceptedTrial);
    }

    if (debugTimings && timingKey) {
        debugTimings[timingKey] = nowMs() - startedAt;
    }

    return result;
}

export function runCurrentAlphaTrialSequence({
    stages = []
} = {}) {
    const results = [];
    for (const stage of stages) {
        results.push(runCurrentAlphaTrialStage(stage));
    }
    return results;
}

export function runCurrentAlphaTrialSpecPhase({
    createSpecs
} = {}) {
    return runCurrentAlphaTrialSequence({
        stages: typeof createSpecs === 'function' ? createSpecs() : []
    });
}

function resolveStageValue(value, result) {
    return typeof value === 'function' ? value(result) : value;
}

export function runCurrentAlphaStage({
    stage,
    strategy = null,
    createStage,
    acceptCurrentAlphaStageResult,
    source,
    suppressionGain,
    stageExtras
} = {}) {
    const result = typeof createStage === 'function' ? createStage() : null;

    if (result && typeof acceptCurrentAlphaStageResult === 'function') {
        acceptCurrentAlphaStageResult({
            stage,
            strategy,
            result,
            source: resolveStageValue(source, result),
            suppressionGain: resolveStageValue(suppressionGain, result),
            stageExtras: resolveStageValue(stageExtras, result)
        });
    }

    return result;
}

export function runCurrentAlphaStageSequence({
    stages = []
} = {}) {
    const results = [];
    for (const stage of stages) {
        results.push(runCurrentAlphaStage(stage));
    }
    return results;
}

export function runCurrentAlphaStageSpecPhase({
    createSpecs
} = {}) {
    return runCurrentAlphaStageSequence({
        stages: typeof createSpecs === 'function' ? createSpecs() : []
    });
}

export function runCurrentRepairStage({
    stage,
    strategy,
    createStage,
    acceptCurrentRepairTrialResult,
    source,
    suppressionGain,
    deriveSuppressionGainFromOriginalSpatial = false,
    stageExtras
} = {}) {
    const result = typeof createStage === 'function' ? createStage() : null;

    if (result && typeof acceptCurrentRepairTrialResult === 'function') {
        acceptCurrentRepairTrialResult({
            stage,
            strategy,
            result,
            source: resolveStageValue(source, result),
            suppressionGain: resolveStageValue(suppressionGain, result),
            deriveSuppressionGainFromOriginalSpatial,
            stageExtras: resolveStageValue(stageExtras, result)
        });
    }

    return result;
}

export function runCurrentRepairStageSequence({
    stages = []
} = {}) {
    const results = [];
    for (const stage of stages) {
        if (typeof stage?.beforeStage === 'function') {
            stage.beforeStage(stage);
        }
        results.push(runCurrentRepairStage(stage));
    }
    return results;
}

export function runCurrentRepairStageSpecPhase({
    createSpecs
} = {}) {
    return runCurrentRepairStageSequence({
        stages: typeof createSpecs === 'function' ? createSpecs() : []
    });
}

export function runRepairCleanupSpecPhase({
    createSpecs
} = {}) {
    const specs = typeof createSpecs === 'function' ? createSpecs() : {};
    let previewEdgeCleanupElapsedMs = 0;

    if (specs.edgeCleanup) {
        const outcome = runRepeatedCurrentRepairStage(specs.edgeCleanup);
        previewEdgeCleanupElapsedMs = outcome.elapsedMs;
    }

    if (specs.known48FlatFill) {
        runRepeatedCurrentRepairStage(specs.known48FlatFill);
    }

    if (specs.known48LumaEdge) {
        runCurrentRepairStage(specs.known48LumaEdge);
    }

    if (specs.newMargin96FlatFill) {
        runCurrentRepairStage(specs.newMargin96FlatFill);
    }

    return {
        previewEdgeCleanupElapsedMs
    };
}

export function runRepeatedCurrentRepairStage({
    maxPasses = 1,
    createStage,
    acceptCurrentRepairTrialResult,
    stage,
    strategy,
    source,
    suppressionGain,
    deriveSuppressionGainFromOriginalSpatial = false,
    stageExtras,
    nowMs = null
} = {}) {
    let passCount = 0;
    let elapsedMs = 0;
    const shouldMeasure = typeof nowMs === 'function';

    while (passCount < maxPasses) {
        const startedAt = shouldMeasure ? nowMs() : 0;
        const result = typeof createStage === 'function' ? createStage(passCount) : null;
        if (shouldMeasure) {
            elapsedMs += nowMs() - startedAt;
        }

        if (!result) {
            break;
        }

        if (typeof acceptCurrentRepairTrialResult === 'function') {
            acceptCurrentRepairTrialResult({
                stage: resolveStageValue(stage, result),
                strategy: resolveStageValue(strategy, result),
                result,
                source: resolveStageValue(source, result),
                suppressionGain: resolveStageValue(suppressionGain, result),
                deriveSuppressionGainFromOriginalSpatial,
                stageExtras: resolveStageValue(stageExtras, result)
            });
        }
        passCount++;
    }

    return {
        passCount,
        elapsedMs
    };
}

export function runPreviewBackgroundCleanupStage({
    createCleanup,
    acceptPreviewBackgroundCleanupResult,
    debugTimings = null,
    timingKey = null,
    nowMs = Date.now
} = {}) {
    const startedAt = nowMs();
    const cleanup = typeof createCleanup === 'function' ? createCleanup() : null;

    if (cleanup && typeof acceptPreviewBackgroundCleanupResult === 'function') {
        acceptPreviewBackgroundCleanupResult(cleanup);
    }

    if (debugTimings && timingKey) {
        debugTimings[timingKey] = nowMs() - startedAt;
    }

    return cleanup;
}

export function runRecalibrationStage({
    shouldRun = true,
    createRecalibration,
    computeGradientScore,
    acceptRecalibrationStageResult,
    debugTimings = null,
    timingKey = null,
    nowMs = Date.now
} = {}) {
    const startedAt = nowMs();
    const result = shouldRun && typeof createRecalibration === 'function'
        ? createRecalibration()
        : null;

    if (result && typeof acceptRecalibrationStageResult === 'function') {
        acceptRecalibrationStageResult({
            result,
            gradientScore: typeof computeGradientScore === 'function'
                ? computeGradientScore(result)
                : undefined
        });
    }

    if (debugTimings && timingKey) {
        debugTimings[timingKey] = nowMs() - startedAt;
    }

    return result;
}

export function runLocatedAggressiveStage({
    shouldRun = true,
    createStage,
    recordAlphaTrialEvent,
    acceptLocatedAggressiveResult,
    currentPassState,
    source,
    fromAlphaGain,
    beforeSpatialScore,
    beforeGradientScore,
    originalSpatialScore
} = {}) {
    if (!shouldRun) {
        return {
            result: null,
            passState: currentPassState
        };
    }

    const result = typeof createStage === 'function'
        ? createStage({
            onRejected: (event) => {
                if (typeof recordAlphaTrialEvent === 'function') {
                    recordAlphaTrialEvent({
                        ...event,
                        decision: 'reject'
                    });
                }
            }
        })
        : null;

    if (!result || typeof acceptLocatedAggressiveResult !== 'function') {
        return {
            result,
            passState: currentPassState
        };
    }

    const aggressiveOutcome = acceptLocatedAggressiveResult({
        result,
        source: resolveStageValue(source, result),
        fromAlphaGain,
        beforeSpatialScore,
        beforeGradientScore,
        originalSpatialScore,
        passes: currentPassState?.passes
    });

    return {
        result,
        outcome: aggressiveOutcome,
        passState: applyPipelinePassOutcome({
            current: currentPassState,
            outcome: aggressiveOutcome
        })
    };
}

export function createAlphaRepairPipelineRuntime({
    traceRecorder,
    readState,
    applyState,
    debugTimings = null
} = {}) {
    const recordAlphaAdjustmentStage = traceRecorder?.recordAlphaAdjustmentStage;
    const recordAlphaTrialEvent = traceRecorder?.recordAlphaTrialEvent;
    const safeRecordAlphaAdjustmentStage =
        typeof recordAlphaAdjustmentStage === 'function'
            ? recordAlphaAdjustmentStage
            : () => {};
    const safeRecordAlphaTrialEvent =
        typeof recordAlphaTrialEvent === 'function'
            ? recordAlphaTrialEvent
            : () => {};
    const commitPipelineResult = ({ result, source } = {}) => {
        const committedState = createPipelineStateCommit({
            current: readState(),
            result,
            source
        });
        applyState(committedState);
        return committedState;
    };

    return {
        alphaAdjustmentStages: traceRecorder?.alphaAdjustmentStages ?? [],
        alphaTrialEvents: traceRecorder?.alphaTrialEvents ?? [],
        recordAlphaAdjustmentStage: safeRecordAlphaAdjustmentStage,
        recordAlphaTrialEvent: safeRecordAlphaTrialEvent,
        commitPipelineResult,
        acceptCurrentAlphaStageResult({
            stage,
            strategy = null,
            result,
            source,
            suppressionGain = result?.suppressionGain,
            stageExtras = {}
        } = {}) {
            const current = readState();
            safeRecordAlphaAdjustmentStage({
                stage,
                fromAlphaGain: current?.alphaGain,
                toAlphaGain: result?.alphaGain,
                beforeSpatialScore: current?.finalProcessedSpatialScore,
                beforeGradientScore: current?.finalProcessedGradientScore,
                afterSpatialScore: result?.spatialScore,
                afterGradientScore: result?.gradientScore,
                suppressionGain,
                cost: result?.cost,
                alphaStrategy: strategy,
                ...stageExtras
            });
            return commitPipelineResult({ result, source });
        },
        acceptCurrentRepairTrialResult({
            stage,
            strategy,
            result,
            source,
            suppressionGain = result?.suppressionGain,
            deriveSuppressionGainFromOriginalSpatial = false,
            stageExtras = {}
        } = {}) {
            const current = readState();
            const resolvedSuppressionGain = deriveSuppressionGainFromOriginalSpatial
                ? current?.originalSpatialScore - result?.spatialScore
                : suppressionGain;
            safeRecordAlphaAdjustmentStage({
                stage,
                fromAlphaGain: current?.alphaGain,
                toAlphaGain: result?.alphaGain ?? current?.alphaGain,
                beforeSpatialScore: current?.finalProcessedSpatialScore,
                beforeGradientScore: current?.finalProcessedGradientScore,
                afterSpatialScore: result?.spatialScore,
                afterGradientScore: result?.gradientScore,
                suppressionGain: resolvedSuppressionGain,
                cost: result?.cost,
                repairStrategy: strategy,
                allowSameAlphaGain: true,
                ...stageExtras
            });
            return commitPipelineResult({ result, source });
        },
        acceptRecalibrationStageResult({
            result,
            gradientScore
        } = {}) {
            const current = readState();
            const committedResult = {
                ...result,
                gradientScore
            };
            safeRecordAlphaAdjustmentStage({
                stage: 'recalibration',
                fromAlphaGain: current?.alphaGain,
                toAlphaGain: result?.alphaGain,
                beforeSpatialScore: current?.finalProcessedSpatialScore,
                beforeGradientScore: current?.finalProcessedGradientScore,
                afterSpatialScore: result?.processedSpatialScore,
                afterGradientScore: gradientScore,
                suppressionGain: result?.suppressionGain,
                cost: result?.cost,
                alphaStrategy: null
            });
            return commitPipelineResult({
                result: committedResult,
                source: current?.source === 'adaptive'
                    ? 'adaptive+gain'
                    : `${current?.source}+gain`
            });
        },
        acceptCurrentAlphaTrialResult({
            stage,
            strategy,
            result,
            source,
            suppressionGain = result?.suppressionGain,
            stageExtras = {},
            eventExtras = {}
        } = {}) {
            const current = readState();
            const toAlphaGain = result?.alphaGain;
            const alphaEvent = {
                stage,
                strategy,
                decision: 'accept',
                fromAlphaGain: current?.alphaGain,
                toAlphaGain,
                alphaGain: toAlphaGain,
                beforeSpatialScore: current?.finalProcessedSpatialScore,
                beforeGradientScore: current?.finalProcessedGradientScore,
                afterSpatialScore: result?.spatialScore,
                afterGradientScore: result?.gradientScore,
                suppressionGain,
                cost: result?.cost,
                ...eventExtras
            };
            const alphaStage = {
                stage,
                fromAlphaGain: current?.alphaGain,
                toAlphaGain,
                beforeSpatialScore: current?.finalProcessedSpatialScore,
                beforeGradientScore: current?.finalProcessedGradientScore,
                afterSpatialScore: result?.spatialScore,
                afterGradientScore: result?.gradientScore,
                suppressionGain,
                cost: result?.cost,
                alphaStrategy: strategy,
                ...stageExtras
            };

            safeRecordAlphaAdjustmentStage(alphaStage);
            safeRecordAlphaTrialEvent(alphaEvent);
            return commitPipelineResult({ result, source });
        },
        acceptAlphaTrialResult({
            stage,
            strategy,
            result,
            source,
            fromAlphaGain,
            beforeSpatialScore,
            beforeGradientScore,
            afterSpatialScore = result?.spatialScore,
            afterGradientScore = result?.gradientScore,
            suppressionGain = result?.suppressionGain,
            cost = result?.cost,
            stageExtras = {},
            eventExtras = {}
        } = {}) {
            const toAlphaGain = result?.alphaGain;
            const alphaEvent = {
                stage,
                strategy,
                decision: 'accept',
                fromAlphaGain,
                toAlphaGain,
                alphaGain: toAlphaGain,
                beforeSpatialScore,
                beforeGradientScore,
                afterSpatialScore,
                afterGradientScore,
                suppressionGain,
                cost,
                ...eventExtras
            };
            const alphaStage = {
                stage,
                fromAlphaGain,
                toAlphaGain,
                beforeSpatialScore,
                beforeGradientScore,
                afterSpatialScore,
                afterGradientScore,
                suppressionGain,
                cost,
                alphaStrategy: strategy,
                ...stageExtras
            };

            safeRecordAlphaAdjustmentStage(alphaStage);
            safeRecordAlphaTrialEvent(alphaEvent);
            return commitPipelineResult({ result, source });
        },
        acceptAlphaStageResult({
            stage,
            strategy = null,
            result,
            source,
            fromAlphaGain,
            toAlphaGain = result?.alphaGain,
            beforeSpatialScore,
            beforeGradientScore,
            afterSpatialScore = result?.spatialScore,
            afterGradientScore = result?.gradientScore,
            suppressionGain = result?.suppressionGain,
            cost = result?.cost,
            stageExtras = {}
        } = {}) {
            safeRecordAlphaAdjustmentStage({
                stage,
                fromAlphaGain,
                toAlphaGain,
                beforeSpatialScore,
                beforeGradientScore,
                afterSpatialScore,
                afterGradientScore,
                suppressionGain,
                cost,
                alphaStrategy: strategy,
                ...stageExtras
            });
            return commitPipelineResult({ result, source });
        },
        acceptRepairTrialResult({
            stage,
            strategy,
            result,
            source,
            fromAlphaGain,
            toAlphaGain = result?.alphaGain ?? fromAlphaGain,
            beforeSpatialScore,
            beforeGradientScore,
            afterSpatialScore = result?.spatialScore,
            afterGradientScore = result?.gradientScore,
            suppressionGain = result?.suppressionGain,
            cost = result?.cost,
            stageExtras = {}
        } = {}) {
            safeRecordAlphaAdjustmentStage({
                stage,
                fromAlphaGain,
                toAlphaGain,
                beforeSpatialScore,
                beforeGradientScore,
                afterSpatialScore,
                afterGradientScore,
                suppressionGain,
                cost,
                repairStrategy: strategy,
                allowSameAlphaGain: true,
                ...stageExtras
            });
            return commitPipelineResult({ result, source });
        },
        acceptLocatedAggressiveResult({
            result,
            source,
            fromAlphaGain,
            beforeSpatialScore,
            beforeGradientScore,
            originalSpatialScore,
            passes
        } = {}) {
            const suppressionGain = originalSpatialScore - result.spatialScore;
            safeRecordAlphaAdjustmentStage({
                stage: 'located-aggressive-removal',
                fromAlphaGain,
                toAlphaGain: result.alphaGain,
                beforeSpatialScore,
                beforeGradientScore,
                afterSpatialScore: result.spatialScore,
                afterGradientScore: result.gradientScore,
                suppressionGain,
                cost: result.cost,
                alphaStrategy: 'located-aggressive-alpha',
                allowSameAlphaGain: true
            });
            safeRecordAlphaTrialEvent({
                strategy: 'located-aggressive-alpha',
                decision: 'accept',
                blockedGate: null,
                beforeSpatialScore,
                beforeGradientScore,
                afterSpatialScore: result.spatialScore,
                afterGradientScore: result.gradientScore,
                suppressionGain,
                alphaGain: result.alphaGain,
                repeatCount: result.repeatCount,
                edgeCleanup: result.edgeCleanup === true,
                cost: result.cost
            });
            if (Array.isArray(passes)) {
                passes.push({
                    index: passes.length + 1,
                    beforeSpatialScore,
                    beforeGradientScore,
                    afterSpatialScore: result.spatialScore,
                    afterGradientScore: result.gradientScore,
                    improvement: Math.abs(beforeSpatialScore) - Math.abs(result.spatialScore),
                    gradientDelta: result.gradientScore - beforeGradientScore,
                    nearBlackRatio: result.nearBlackRatio
                });
            }

            return {
                committedState: commitPipelineResult({ result, source }),
                passIncrement: Math.max(1, result.repeatCount || 1),
                passStopReason: result.edgeCleanup
                    ? 'located-aggressive-edge-cleanup'
                    : 'located-aggressive-alpha'
            };
        },
        acceptPreviewBackgroundCleanupResult({
            cleanedImageData,
            source,
            cleanedSpatialScore,
            cleanedGradientScore,
            cleanedNearBlackRatio,
            currentNearBlackRatio,
            baselineSpatialScore,
            maxNearBlackRatioIncrease
        } = {}) {
            const current = readState();
            if (
                Math.abs(cleanedSpatialScore) > Math.abs(baselineSpatialScore) ||
                cleanedNearBlackRatio > currentNearBlackRatio + maxNearBlackRatioIncrease
            ) {
                return null;
            }

            safeRecordAlphaAdjustmentStage({
                stage: 'preview-background-cleanup',
                fromAlphaGain: current?.alphaGain,
                toAlphaGain: current?.alphaGain,
                beforeSpatialScore: current?.finalProcessedSpatialScore,
                beforeGradientScore: current?.finalProcessedGradientScore,
                afterSpatialScore: cleanedSpatialScore,
                afterGradientScore: cleanedGradientScore,
                repairStrategy: 'preview-background-cleanup',
                allowSameAlphaGain: true
            });
            return commitPipelineResult({
                result: {
                    imageData: cleanedImageData,
                    spatialScore: cleanedSpatialScore,
                    gradientScore: cleanedGradientScore
                },
                source
            });
        },
        assignTailDebugTimings(timingInput = {}) {
            if (!debugTimings) return null;
            Object.assign(debugTimings, createTailDebugTimings(timingInput));
            return debugTimings;
        }
    };
}

import { createInitialPipelineContext } from './pipelineInitialContext.js';
import { collectInitialWatermarkCandidates } from './pipelineInitialSelection.js';
import { runCandidateHypothesis } from './pipelineCandidateRunner.js';
import {
    createCandidateQualitySignals,
    createCandidateSummaries,
    rankCompletedCandidates
} from './pipelineCandidateQuality.js';
import { attachTopNSelectionMeta } from './pipelineMeta.js';
import { createRejectedPipelineResult } from './pipelineResult.js';
import { runAcceptedAlphaRepairPipeline } from './pipelineAcceptedExecutor.js';
import { createAcceptedPipelineFinalResult } from './pipelineFinalization.js';
import { interpolateAlphaMap, resizeAlphaMapArea } from './adaptiveDetector.js';

const NATIVE_ALPHA_SIZES = new Set([48, 96]);
// Below this the sharper area-averaged edge over-removed on small preview
// anchors (issue99 fixture, 24px dark-halo fixtures) in the sample batch.
const AREA_ALPHA_MIN_SIZE = 32;

function createSelectedCandidate(best) {
    const hypothesis = best?.hypothesis ?? {};
    const trial = hypothesis.trial ?? {};
    const meta = best?.result?.meta ?? {};
    return {
        id: hypothesis.id ?? null,
        family: hypothesis.family ?? null,
        rank: best?.rank ?? 1,
        source: meta.source ?? trial.source ?? null,
        config: meta.config ?? hypothesis.config ?? trial.config ?? null,
        position: meta.position ?? hypothesis.position ?? trial.position ?? null,
        alphaProfile: hypothesis.alphaProfile ?? null,
        polarity: hypothesis.polarity ?? null
    };
}

function findDarkBackgroundSupportConvergence(meta = {}) {
    const stages = Array.isArray(meta.alphaAdjustmentStages)
        ? meta.alphaAdjustmentStages
        : [];
    const convergence = stages.at(-1)?.darkBackgroundSupportConvergence;
    return convergence?.accepted === true ? convergence : null;
}

function createRuntimeFailureResult({
    createRejectedResult,
    originalImageData,
    debugTimings
}) {
    return createRejectedResult({
        imageData: originalImageData,
        debugTimings,
        reason: 'candidate-execution-failed',
        source: 'top-n-runtime-failure',
        decisionTier: 'runtime-failure',
        selectionDebug: null
    });
}

function createNoWatermarkResult({
    createRejectedResult,
    originalImageData,
    collection,
    debugTimings
}) {
    const selection = collection?.automaticSelection ?? collection?.fixedSelection ?? {};
    return createRejectedResult({
        imageData: originalImageData,
        debugTimings,
        reason: 'no-watermark-detected',
        adaptiveConfidence: selection.adaptiveConfidence ?? null,
        originalSpatialScore: selection.standardSpatialScore ?? null,
        originalGradientScore: selection.standardGradientScore ?? null,
        source: 'skipped',
        decisionTier: selection.decisionTier ?? 'insufficient',
        selectionDebug: null
    });
}

function notifyCandidateCompleted({ options, candidate, debugTimings }) {
    if (typeof options?.onCandidateCompleted !== 'function') return;

    try {
        options.onCandidateCompleted(candidate);
    } catch {
        if (debugTimings) {
            debugTimings.candidateDiagnosticErrorCount =
                (debugTimings.candidateDiagnosticErrorCount ?? 0) + 1;
        }
    }
}

function appendUniqueRiskFlag(flags, flag) {
    const normalized = Array.isArray(flags) ? flags : [];
    return normalized.includes(flag) ? normalized : [...normalized, flag];
}

function attachPresenceBestEffortMeta(meta, collection) {
    if (collection?.bestEffortFallback !== true) return meta;

    const riskFlag = 'unconfirmed-watermark-presence';
    const decisionPath = meta?.decisionPath && typeof meta.decisionPath === 'object'
        ? {
            ...meta.decisionPath,
            riskFlags: appendUniqueRiskFlag(meta.decisionPath.riskFlags, riskFlag),
            evaluation: meta.decisionPath.evaluation &&
                typeof meta.decisionPath.evaluation === 'object'
                ? {
                    ...meta.decisionPath.evaluation,
                    riskFlags: appendUniqueRiskFlag(
                        meta.decisionPath.evaluation.riskFlags,
                        riskFlag
                    )
                }
                : meta.decisionPath.evaluation
        }
        : meta?.decisionPath;

    return {
        ...meta,
        presenceConfirmed: false,
        bestEffortReason:
            collection.bestEffortReason ?? 'presence-witness-unconfirmed',
        decisionPath
    };
}

function sameAlphaMap(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

function samePosition(left, right) {
    return Boolean(left && right) &&
        left.x === right.x &&
        left.y === right.y &&
        left.width === right.width &&
        left.height === right.height;
}

// Bilinear corner-aligned downsampling of the 96px template blurs the star
// edge at non-native sizes and leaves a visible outline (issue #165). Detection
// and ranking keep the interpolated map; only the selected winner is re-run
// with an area-averaged map, and only when its geometry stays the same.
function createAreaAlphaHypothesis(best, alpha96) {
    const hypothesis = best?.hypothesis;
    const trial = hypothesis?.trial;
    const position = trial?.position;
    const size = position?.width;
    if (
        !alpha96 ||
        !trial?.alphaMap ||
        !Number.isInteger(size) ||
        size !== position.height ||
        size < AREA_ALPHA_MIN_SIZE ||
        size >= 96 ||
        NATIVE_ALPHA_SIZES.has(size) ||
        trial.templateWarp ||
        hypothesis.alphaProfile !== 'default' ||
        hypothesis.polarity !== 'light' ||
        best.result?.meta?.applied !== true ||
        best.result.meta.subpixelShift ||
        !samePosition(best.result.meta.position, position) ||
        !sameAlphaMap(trial.alphaMap, interpolateAlphaMap(alpha96, 96, size))
    ) {
        return null;
    }

    const alphaMap = resizeAlphaMapArea(alpha96, 96, size);
    return {
        ...hypothesis,
        alphaMap,
        trial: { ...trial, alphaMap }
    };
}

function rerunWithAreaAlpha({
    best,
    alpha96,
    runCandidateWithHypothesis,
    measureRerunCandidate
}) {
    const hypothesis = createAreaAlphaHypothesis(best, alpha96);
    if (!hypothesis) return best;

    try {
        const rerun = runCandidateWithHypothesis(hypothesis);
        const meta = rerun?.result?.meta;
        if (
            !rerun?.result?.imageData ||
            meta?.applied !== true ||
            meta.size !== best.result.meta.size ||
            !samePosition(meta.position, best.result.meta.position)
        ) {
            return best;
        }

        return {
            ...best,
            result: {
                ...rerun.result,
                meta: { ...meta, finalAlphaResample: 'area' }
            },
            pipelineState: rerun.pipelineState,
            passState: rerun.passState,
            traceState: rerun.traceState,
            qualitySignals: measureRerunCandidate(rerun, hypothesis)
        };
    } catch {
        return best;
    }
}

export function runImageWatermarkPipeline({
    imageData,
    options = {},
    nowMs,
    cloneImageData,
    alphaGainCandidates,
    alphaPriorityGains,
    createAcceptedPipelineDependencies,
    cleanupConfig,
    visualPostProcessingEnabled = false,
    selectCandidate,
    collectCandidates = collectInitialWatermarkCandidates,
    runCandidate = runCandidateHypothesis,
    measureCandidate = createCandidateQualitySignals,
    rankCandidates = rankCompletedCandidates,
    createSummaries = createCandidateSummaries,
    attachSelectionMeta = attachTopNSelectionMeta,
    runAcceptedPipeline = runAcceptedAlphaRepairPipeline,
    createRejectedResult = createRejectedPipelineResult,
    createAcceptedFinalResult = createAcceptedPipelineFinalResult
} = {}) {
    const totalStartedAt = nowMs();
    const debugTimingsEnabled = options.debugTimings === true;
    const debugTimings = debugTimingsEnabled ? {} : null;
    const {
        originalImageData,
        alpha48,
        alpha96,
        alphaGainCandidates: resolvedAlphaGainCandidates,
        alphaPriorityGains: resolvedAlphaPriorityGains,
        allowAdaptiveSearch,
        defaultConfig,
        resolvedConfig,
        position
    } = createInitialPipelineContext({
        imageData,
        options,
        cloneImageData,
        alphaGainCandidates,
        alphaPriorityGains
    });

    const discoveryStartedAt = nowMs();
    const collection = collectCandidates({
        originalImageData,
        config: resolvedConfig,
        catalogPriorConfig: defaultConfig,
        position,
        alpha48,
        alpha96,
        alpha96Variants: options.alpha96Variants ?? null,
        getAlphaMap: options.getAlphaMap,
        allowAdaptiveSearch,
        alphaGainCandidates: resolvedAlphaGainCandidates,
        alphaPriorityGains: resolvedAlphaPriorityGains,
        selectCandidate
    });
    const hypotheses = Array.isArray(collection?.hypotheses)
        ? collection.hypotheses.slice(0, collection.hasSupplementalSourceWitness ? 6 : 5)
        : [];
    if (debugTimingsEnabled) {
        debugTimings.candidateDiscoveryMs = nowMs() - discoveryStartedAt;
        debugTimings.initialSelectionMs = debugTimings.candidateDiscoveryMs;
        debugTimings.generatedCandidateCount = hypotheses.length;
        debugTimings.earlyExitReason = null;
    }
    if (
        collection?.presenceConfirmed === false &&
        collection?.bestEffortFallback !== true
    ) {
        if (debugTimingsEnabled) {
            debugTimings.candidateExecutionMs = 0;
            debugTimings.executedCandidateCount = 0;
            debugTimings.completedCandidateCount = 0;
            debugTimings.failedCandidateCount = 0;
            debugTimings.candidateRankingMs = 0;
            debugTimings.earlyExitReason = 'no-watermark-detected';
            debugTimings.totalMs = nowMs() - totalStartedAt;
        }
        return createNoWatermarkResult({
            createRejectedResult,
            originalImageData,
            collection,
            debugTimings
        });
    }

    const completed = [];
    const failures = [];
    const executionStartedAt = nowMs();
    const runCandidateWithHypothesis = (hypothesis) => runCandidate({
        hypothesis,
        originalImageData,
        resolvedConfig,
        options,
        nowMs,
        alpha96,
        debugTimingsEnabled,
        visualPostProcessingEnabled,
        cleanupConfig,
        createAcceptedPipelineDependencies: () => (
            createAcceptedPipelineDependencies(hypothesis)
        ),
        runAcceptedPipeline,
        createAcceptedFinalResult
    });
    const measureCompletedCandidate = (completedCandidate, hypothesis) => measureCandidate({
        originalImageData,
        candidateImageData: completedCandidate.result.imageData,
        hypothesis,
        finalCandidate: {
            position: completedCandidate.pipelineState?.position,
            alphaMap: completedCandidate.pipelineState?.alphaMap,
            alphaGain: completedCandidate.pipelineState?.alphaGain,
            darkBackgroundSupportConvergence:
                findDarkBackgroundSupportConvergence(
                    completedCandidate.result.meta
                )
        }
    });
    for (const hypothesis of hypotheses) {
        try {
            const completedCandidate = runCandidateWithHypothesis(hypothesis);
            if (!completedCandidate?.result?.imageData) {
                throw new Error(`Candidate ${hypothesis.id ?? 'unknown'} returned no pixels`);
            }
            const candidate = {
                ...completedCandidate,
                hypothesis,
                qualitySignals: measureCompletedCandidate(completedCandidate, hypothesis)
            };
            completed.push(candidate);
            notifyCandidateCompleted({ options, candidate, debugTimings });
        } catch (error) {
            failures.push({ hypothesis, error });
        }
    }
    if (debugTimingsEnabled) {
        debugTimings.candidateExecutionMs = nowMs() - executionStartedAt;
        debugTimings.executedCandidateCount = hypotheses.length;
        debugTimings.completedCandidateCount = completed.length;
        debugTimings.failedCandidateCount = failures.length;
    }

    if (completed.length === 0) {
        if (debugTimingsEnabled) {
            debugTimings.candidateRankingMs = 0;
            debugTimings.totalMs = nowMs() - totalStartedAt;
        }
        const result = createRuntimeFailureResult({
            createRejectedResult,
            originalImageData,
            debugTimings
        });
        return {
            ...result,
            meta: attachPresenceBestEffortMeta(result.meta, collection)
        };
    }

    const rankingStartedAt = nowMs();
    const ranked = rankCandidates(completed);
    const best = rerunWithAreaAlpha({
        best: ranked[0],
        alpha96,
        runCandidateWithHypothesis,
        measureRerunCandidate: measureCompletedCandidate
    });
    if (!best?.result?.imageData) {
        failures.push({
            hypothesis: null,
            error: new Error('Candidate ranking returned no valid result')
        });
        if (debugTimingsEnabled) {
            debugTimings.candidateRankingMs = nowMs() - rankingStartedAt;
            debugTimings.failedCandidateCount = failures.length;
            debugTimings.totalMs = nowMs() - totalStartedAt;
        }
        const result = createRuntimeFailureResult({
            createRejectedResult,
            originalImageData,
            debugTimings
        });
        return {
            ...result,
            meta: attachPresenceBestEffortMeta(result.meta, collection)
        };
    }

    if (best !== ranked[0]) {
        notifyCandidateCompleted({ options, candidate: best, debugTimings });
    }
    const candidateSummaries = createSummaries(
        best === ranked[0] ? ranked : [best, ...ranked.slice(1)],
        failures
    );
    const selectionMeta = attachSelectionMeta(best.result.meta, {
        qualityStatus: best.qualitySignals?.qualityStatus,
        selectionConfidence: best.selectionConfidence,
        selectedCandidate: createSelectedCandidate(best),
        qualitySignals: best.qualitySignals,
        candidateSummaries
    });
    const meta = attachPresenceBestEffortMeta(selectionMeta, collection);
    if (debugTimingsEnabled) {
        debugTimings.candidateRankingMs = nowMs() - rankingStartedAt;
        debugTimings.totalMs = nowMs() - totalStartedAt;
    }

    const combinedDebugTimings = debugTimingsEnabled
        ? {
            ...(best.result.debugTimings ?? {}),
            ...debugTimings
        }
        : best.result.debugTimings;

    return {
        ...best.result,
        meta,
        debugTimings: combinedDebugTimings
    };
}

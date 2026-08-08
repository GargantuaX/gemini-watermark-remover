import { materializeCandidateTrial } from './candidateSelector.js';
import { runAcceptedAlphaRepairPipeline } from './pipelineAcceptedExecutor.js';
import { createAcceptedPipelineExecutorRequest } from './pipelineAcceptedExecutorRequest.js';
import { createAcceptedPipelineFinalizationRequest } from './pipelineAcceptedFinalizationRequest.js';
import { createAcceptedPipelineFinalResult } from './pipelineFinalization.js';
import { createAcceptedPipelineRuntimeBootstrap } from './pipelineRuntimeBootstrap.js';
import { createAcceptedPipelineState } from './pipelineState.js';
import { createPipelineTraceRecorder } from './pipelineTrace.js';

export function runCandidateHypothesis({
    hypothesis,
    originalImageData,
    resolvedConfig,
    options = {},
    nowMs = Date.now,
    alpha96 = null,
    debugTimingsEnabled = false,
    visualPostProcessingEnabled = false,
    cleanupConfig = {},
    createAcceptedPipelineDependencies,
    materializeCandidate = materializeCandidateTrial,
    runAcceptedPipeline = runAcceptedAlphaRepairPipeline,
    createAcceptedFinalResult = createAcceptedPipelineFinalResult
} = {}) {
    if (!hypothesis?.trial) {
        throw new Error('Candidate hypothesis is missing its trial');
    }
    if (typeof createAcceptedPipelineDependencies !== 'function') {
        throw new Error('Candidate runner requires accepted pipeline dependencies');
    }

    const startedAt = nowMs();
    const selectedTrial = materializeCandidate(hypothesis.trial, originalImageData);
    if (!selectedTrial?.imageData) {
        throw new Error(`Candidate ${hypothesis.id ?? 'unknown'} could not materialize pixels`);
    }
    const debugTimings = debugTimingsEnabled ? {} : null;
    const initialSelection = {
        selectedTrial,
        source: selectedTrial.source ?? hypothesis.trial.source ?? 'best-effort',
        alphaMap: selectedTrial.alphaMap,
        position: selectedTrial.position,
        config: selectedTrial.config,
        adaptiveConfidence: selectedTrial.adaptiveConfidence ?? null,
        templateWarp: selectedTrial.templateWarp ?? null,
        alphaGain: selectedTrial.alphaGain ?? 1,
        decisionTier: selectedTrial.decisionTier ?? 'validated-match'
    };
    const acceptedPipelineState = createAcceptedPipelineState({ initialSelection });
    if (!acceptedPipelineState) {
        throw new Error(`Candidate ${hypothesis.id ?? 'unknown'} could not initialize pipeline state`);
    }
    const runtimeBootstrap = createAcceptedPipelineRuntimeBootstrap({
        nowMs,
        acceptedPipelineState,
        selectedTrial,
        debugTimings,
        debugTimingsEnabled,
        cleanupConfig
    });
    const pipelineTraceRecorder = createPipelineTraceRecorder();
    const acceptedPipelineDependencies = createAcceptedPipelineDependencies();
    const acceptedPipelineRun = runAcceptedPipeline(createAcceptedPipelineExecutorRequest({
        nowMs,
        options,
        totalStartedAt: startedAt,
        runtimeBootstrap,
        pipelineTraceRecorder,
        originalImageData,
        alpha96,
        debugTimings,
        debugTimingsEnabled,
        visualPostProcessingEnabled,
        templateWarp: acceptedPipelineState.templateWarp,
        subpixelShift: acceptedPipelineState.subpixelShift,
        freezeSelectedTrial:
            selectedTrial.provenance?.sourceWitnessRescue === true,
        acceptedPipelineDependencies
    }));
    const finalizationRequest = createAcceptedPipelineFinalizationRequest({
        acceptedPipelineRun,
        pipelineTraceRecorder,
        resultContext: {
            debugTimings,
            selectedTrial,
            selectionSource: initialSelection.source,
            adaptiveConfidence: acceptedPipelineState.adaptiveConfidence,
            templateWarp: acceptedPipelineState.templateWarp,
            decisionTier: acceptedPipelineState.decisionTier,
            subpixelShift: acceptedPipelineRun.subpixelShift
        },
        originalImageData,
        initialSelection,
        resolvedConfig
    });
    const result = createAcceptedFinalResult({
        ...finalizationRequest,
        allowFailClosed: false
    });

    return {
        hypothesis,
        result,
        pipelineState: finalizationRequest.pipelineState,
        passState: finalizationRequest.passState,
        traceState: finalizationRequest.traceState,
        elapsedMs: nowMs() - startedAt
    };
}

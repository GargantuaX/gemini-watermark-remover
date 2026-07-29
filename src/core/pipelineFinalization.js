import { assessCalibratedWatermarkResidualVisibility } from './restorationMetrics.js';
import { createSelectionDebugSummary } from './selectionDebug.js';
import { calculateWatermarkPosition } from './watermarkConfig.js';
import {
    shouldFailClosedForUnsafeWeakShiftedCandidate,
    shouldFailClosedForVisibleResidualUnsafeDamage
} from './candidateEvaluation.js';
import {
    createAcceptedPipelineResultFromState,
    createFailClosedPipelineResultFromState
} from './pipelineResult.js';

export function createAcceptedPipelineFinalResult({
    pipelineState = {},
    passState = {},
    traceState = {},
    resultContext = {},
    originalImageData = null,
    initialSelection = null,
    resolvedConfig = null,
    allowFailClosed = true
} = {}) {
    const residualVisibility = assessCalibratedWatermarkResidualVisibility({
        imageData: pipelineState.finalImageData,
        originalImageData,
        position: pipelineState.position,
        alphaMap: pipelineState.alphaMap,
        alphaGain: pipelineState.alphaGain
    });
    const safetyResidualVisibility = residualVisibility
        ? {
            ...residualVisibility,
            visible: residualVisibility.rawVisible ?? residualVisibility.visible
        }
        : null;
    const selectionSource = resultContext.selectionSource ?? initialSelection?.source ?? null;
    const initialPosition = originalImageData && resolvedConfig
        ? calculateWatermarkPosition(
            originalImageData.width,
            originalImageData.height,
            resolvedConfig
        )
        : null;
    const selectionDebug = createSelectionDebugSummary({
        selectedTrial: resultContext.selectedTrial,
        selectionSource,
        initialConfig: resolvedConfig,
        initialPosition
    });

    if (allowFailClosed && shouldFailClosedForVisibleResidualUnsafeDamage({
        selectedTrial: resultContext.selectedTrial,
        residualVisibility: safetyResidualVisibility
    })) {
        return createFailClosedPipelineResultFromState({
            originalImageData,
            pipelineState,
            passState,
            traceState,
            resultContext: {
                ...resultContext,
                selectionSource
            },
            residualVisibility,
            selectionDebug
        });
    }

    if (allowFailClosed && shouldFailClosedForUnsafeWeakShiftedCandidate({
        selectedTrial: resultContext.selectedTrial
    })) {
        return createFailClosedPipelineResultFromState({
            originalImageData,
            pipelineState,
            passState,
            traceState,
            resultContext: {
                ...resultContext,
                selectionSource
            },
            residualVisibility,
            selectionDebug,
            reason: 'unsafe-weak-shifted-candidate',
            evidenceClass: 'unsafe-weak-shifted-candidate'
        });
    }

    return createAcceptedPipelineResultFromState({
        pipelineState,
        passState,
        traceState,
        resultContext: {
            ...resultContext,
            selectionSource
        },
        residualVisibility,
        selectionDebug
    });
}

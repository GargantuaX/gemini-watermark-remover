export function createAcceptedPipelineExecutorRequest({
    nowMs,
    options = {},
    totalStartedAt,
    runtimeBootstrap,
    pipelineTraceRecorder,
    originalImageData,
    alpha96,
    debugTimings,
    debugTimingsEnabled,
    visualPostProcessingEnabled,
    templateWarp,
    subpixelShift,
    freezeSelectedTrial = false,
    acceptedPipelineDependencies
} = {}) {
    const {
        metrics,
        gates,
        config: executorConfig,
        refiners
    } = acceptedPipelineDependencies;

    return {
        nowMs,
        totalStartedAt,
        runtimeBootstrap,
        pipelineTraceRecorder,
        originalImageData,
        alpha96,
        getAlphaMap: options.getAlphaMap,
        alpha96Variants: options.alpha96Variants ?? null,
        locatedAggressiveRemoval: options.locatedAggressiveRemoval,
        debugTimings,
        debugTimingsEnabled,
        visualPostProcessingEnabled,
        templateWarp,
        passState: runtimeBootstrap.passState,
        subpixelShift,
        freezeSelectedTrial,
        metrics,
        gates,
        config: executorConfig,
        refiners
    };
}

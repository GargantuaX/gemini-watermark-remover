import {
    classifyAdaptiveWatermarkSignal,
    classifyStandardWatermarkSignal
} from './watermarkDecisionPolicy.js';

export function hasReliableStandardWatermarkSignal(scores) {
    if (!scores) return false;
    const { spatialScore, gradientScore } = scores;
    return classifyStandardWatermarkSignal({ spatialScore, gradientScore }).tier === 'direct-match';
}

export function hasReliableAdaptiveWatermarkSignal(adaptiveResult) {
    return classifyAdaptiveWatermarkSignal(adaptiveResult).tier === 'direct-match';
}

import {
    classifyAdaptiveWatermarkSignal,
    classifyStandardWatermarkSignal
} from './watermarkDecisionPolicy.js';

export function hasReliableStandardWatermarkSignal({ spatialScore, gradientScore }) {
    return classifyStandardWatermarkSignal({ spatialScore, gradientScore }).tier === 'direct-match';
}

export function hasReliableAdaptiveWatermarkSignal(adaptiveResult) {
    return classifyAdaptiveWatermarkSignal(adaptiveResult).tier === 'direct-match';
}

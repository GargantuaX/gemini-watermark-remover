import { interpolateAlphaMap } from '../core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../core/embeddedAlphaMaps.js';
import {
    WatermarkEngine,
    calculateWatermarkPosition,
    detectWatermarkConfig,
    removeRepeatedWatermarkLayers
} from '../core/watermarkEngine.js';
import { processWatermarkImageData } from '../core/watermarkProcessor.js';

export async function createWatermarkEngine() {
    return WatermarkEngine.create();
}

function buildEmbeddedGetAlphaMap(alpha48, alpha96, alpha36V2) {
    return (size) => {
        if (size === 48) return alpha48;
        if (size === 96) return alpha96;
        if (size === '36-v2') return alpha36V2;
        return interpolateAlphaMap(alpha96, 96, size);
    };
}

export function removeWatermarkFromImageDataSync(imageData, options = {}) {
    const alpha48 = options.alpha48 || getEmbeddedAlphaMap(48);
    const alpha96 = options.alpha96 || getEmbeddedAlphaMap(96);
    const alpha36V2 = options.alpha36V2 || getEmbeddedAlphaMap('36-v2');
    const alpha96Variants = options.alpha96Variants || {
        '20260520': getEmbeddedAlphaMap('96-20260520'),
        'outline-light': getEmbeddedAlphaMap('96-outline-light'),
        'outline-dark': getEmbeddedAlphaMap('96-outline-dark')
    };

    return processWatermarkImageData(imageData, {
        ...options,
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap: options.getAlphaMap || buildEmbeddedGetAlphaMap(
            alpha48,
            alpha96,
            alpha36V2
        )
    });
}

export async function removeWatermarkFromImageData(imageData, options = {}) {
    const engine = options.engine instanceof WatermarkEngine
        ? options.engine
        : await createWatermarkEngine();
    const alpha48 = await engine.getAlphaMap(48);
    const alpha96 = await engine.getAlphaMap(96);
    const alpha36V2 = options.alpha36V2 || await engine.getAlphaMap('36-v2');
    const alpha96Variants = options.alpha96Variants || {
        '20260520': await engine.getAlphaMap('96-20260520'),
        'outline-light': await engine.getAlphaMap('96-outline-light'),
        'outline-dark': await engine.getAlphaMap('96-outline-dark')
    };

    return processWatermarkImageData(imageData, {
        ...options,
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap: options.getAlphaMap || buildEmbeddedGetAlphaMap(
            alpha48,
            alpha96,
            alpha36V2
        )
    });
}

export {
    WatermarkEngine,
    calculateWatermarkPosition,
    detectWatermarkConfig,
    removeRepeatedWatermarkLayers
};

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

function buildEmbeddedGetAlphaMap(alpha48, alpha96) {
    return (size) => {
        if (size === 48) return alpha48;
        if (size === 96) return alpha96;
        return interpolateAlphaMap(alpha96, 96, size);
    };
}

export function removeWatermarkFromImageDataSync(imageData, options = {}) {
    const alpha48 = options.alpha48 || getEmbeddedAlphaMap(48);
    const alpha96 = options.alpha96 || getEmbeddedAlphaMap(96);

    return processWatermarkImageData(imageData, {
        ...options,
        alpha48,
        alpha96,
        getAlphaMap: options.getAlphaMap || buildEmbeddedGetAlphaMap(alpha48, alpha96)
    });
}

export async function removeWatermarkFromImageData(imageData, options = {}) {
    const engine = options.engine instanceof WatermarkEngine
        ? options.engine
        : await createWatermarkEngine();
    const alpha48 = await engine.getAlphaMap(48);
    const alpha96 = await engine.getAlphaMap(96);

    return processWatermarkImageData(imageData, {
        ...options,
        alpha48,
        alpha96,
        getAlphaMap: options.getAlphaMap || buildEmbeddedGetAlphaMap(alpha48, alpha96)
    });
}

export {
    WatermarkEngine,
    calculateWatermarkPosition,
    detectWatermarkConfig,
    removeRepeatedWatermarkLayers
};

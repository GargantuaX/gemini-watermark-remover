import {
    WatermarkEngine,
    calculateWatermarkPosition,
    detectWatermarkConfig,
    removeRepeatedWatermarkLayers
} from '../core/watermarkEngine.js';

export async function createWatermarkEngine() {
    return WatermarkEngine.create();
}

export async function removeWatermarkFromImage(image, options = {}) {
    const engine = options.engine instanceof WatermarkEngine
        ? options.engine
        : await createWatermarkEngine();
    const canvas = await engine.removeWatermarkFromImage(image, options);

    return {
        canvas,
        meta: canvas.__watermarkMeta || null
    };
}

export {
    WatermarkEngine,
    calculateWatermarkPosition,
    detectWatermarkConfig,
    removeRepeatedWatermarkLayers
};

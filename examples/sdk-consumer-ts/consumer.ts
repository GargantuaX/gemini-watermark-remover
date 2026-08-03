import {
    createWatermarkEngine,
    removeWatermarkFromImageDataSync,
    type ImageDataLike,
    type WatermarkMeta
} from '@pilio/gemini-watermark-remover';
import {
    inferMimeTypeFromPath,
    type NodeBufferRemovalOptions
} from '@pilio/gemini-watermark-remover/node';
import { createBrowserRuntimeProcessor } from '@pilio/gemini-watermark-remover/runtime-browser';
import { createUserscriptRuntimeProcessor } from '@pilio/gemini-watermark-remover/runtime-userscript';

const imageData: ImageDataLike = {
    width: 64,
    height: 64,
    data: new Uint8ClampedArray(64 * 64 * 4)
};

const enginePromise = createWatermarkEngine();
const result = removeWatermarkFromImageDataSync(imageData, {
    adaptiveMode: 'never'
});
const processingContract = {
    presenceConfirmed: result.meta.presenceConfirmed,
    bestEffort: result.meta.bestEffort,
    bestEffortReason: result.meta.bestEffortReason,
    retryRecommended: result.meta.retryRecommended,
    decisionPathRiskFlags: result.meta.decisionPath?.riskFlags
};
const manualMeta: WatermarkMeta = {
    applied: false,
    skipReason: 'manual-check',
    size: null,
    position: null,
    config: null,
    detection: {
        adaptiveConfidence: null,
        originalSpatialScore: null,
        originalGradientScore: null,
        processedSpatialScore: null,
        processedGradientScore: null,
        suppressionGain: null
    },
    source: 'skipped',
    decisionTier: 'insufficient',
    alphaGain: 1,
    passCount: 0,
    attemptedPassCount: 0,
    passStopReason: null
};
const mimeType = inferMimeTypeFromPath('demo.png');
const browserRuntime = createBrowserRuntimeProcessor({
    logger: console
});
const userscriptRuntime = createUserscriptRuntimeProcessor({
    logger: console
});

const options: NodeBufferRemovalOptions = {
    mimeType,
    decodeImageData() {
        return imageData;
    },
    encodeImageData() {
        return Buffer.from([]);
    }
};

void enginePromise;
void result.meta;
void processingContract;
void manualMeta;
void options;
void browserRuntime.processWatermarkBlob;
void userscriptRuntime.processWatermarkBlob;
void userscriptRuntime.initialize;

import {
    createWatermarkEngine,
    removeWatermarkFromImageDataSync,
    type ImageDataLike,
    type WatermarkMeta
} from 'gemini-watermark-remover';
import {
    inferMimeTypeFromPath,
    type NodeBufferRemovalOptions
} from 'gemini-watermark-remover/node';

const imageData: ImageDataLike = {
    width: 64,
    height: 64,
    data: new Uint8ClampedArray(64 * 64 * 4)
};

const enginePromise = createWatermarkEngine();
const result = removeWatermarkFromImageDataSync(imageData, {
    adaptiveMode: 'never',
    maxPasses: 1
});
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
void manualMeta;
void options;

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createVideoExportEncodingConfig,
    resolveExportAllenkFdncnnPadding,
    VIDEO_DENOISE_BACKENDS
} from '../../src/video/videoExport.js';
import * as videoExportModule from '../../src/video/videoExport.js';
import { getVideoAlphaMap } from '../../src/video/videoWatermarkDetector.js';

function createImageContext(width, height, value = 90) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
        const idx = pixel * 4;
        data[idx] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
        data[idx + 3] = 255;
    }

    return {
        canvas: { width, height },
        data,
        getImageData(x, y, roiWidth, roiHeight) {
            const roi = new Uint8ClampedArray(roiWidth * roiHeight * 4);
            for (let row = 0; row < roiHeight; row++) {
                for (let col = 0; col < roiWidth; col++) {
                    const sourceIdx = (((y + row) * width) + x + col) * 4;
                    const targetIdx = ((row * roiWidth) + col) * 4;
                    roi.set(data.subarray(sourceIdx, sourceIdx + 4), targetIdx);
                }
            }
            return { width: roiWidth, height: roiHeight, data: roi };
        },
        putImageData(imageData, x, y) {
            for (let row = 0; row < imageData.height; row++) {
                for (let col = 0; col < imageData.width; col++) {
                    const sourceIdx = ((row * imageData.width) + col) * 4;
                    const targetIdx = (((y + row) * width) + x + col) * 4;
                    data.set(imageData.data.subarray(sourceIdx, sourceIdx + 4), targetIdx);
                }
            }
        }
    };
}

function applyWhiteWatermark(ctx, alphaMap, position) {
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            const idx = (((position.y + row) * ctx.canvas.width) + position.x + col) * 4;
            for (let channel = 0; channel < 3; channel++) {
                ctx.data[idx + channel] = Math.round(alpha * 255 + (1 - alpha) * ctx.data[idx + channel]);
            }
        }
    }
}

test('resolveExportAllenkFdncnnPadding should keep explicit Allenk padding', () => {
    const padding = resolveExportAllenkFdncnnPadding({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        allenkFdncnnPadding: 7
    }, {
        position: { width: 48, height: 48 }
    });

    assert.equal(padding, 7);
});

test('resolveExportAllenkFdncnnPadding should derive missing Allenk padding from detection size', () => {
    const compactPadding = resolveExportAllenkFdncnnPadding({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE
    }, {
        position: { width: 48, height: 48 }
    });
    const standardPadding = resolveExportAllenkFdncnnPadding({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE
    }, {
        position: { width: 72, height: 72 }
    });

    assert.equal(compactPadding, 28);
    assert.equal(standardPadding, 64);
});

test('resolveExportAllenkFdncnnPadding should leave non-Allenk cleanup without padding', () => {
    const padding = resolveExportAllenkFdncnnPadding({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_DENOISE
    }, {
        position: { width: 48, height: 48 }
    });

    assert.equal(padding, undefined);
});

test('createVideoExportEncodingConfig should prefer compatibility-safe high-quality AVC settings', () => {
    const config = createVideoExportEncodingConfig(9_000_000);
    assert.equal(typeof config.onEncodedPacket, 'function');

    const { onEncodedPacket, ...serializableConfig } = config;
    assert.deepEqual(serializableConfig, {
        codec: 'avc',
        bitrate: 9_000_000,
        alpha: 'discard',
        keyFrameInterval: 2,
        latencyMode: 'quality',
        bitrateMode: 'constant',
        hardwareAcceleration: 'no-preference',
        contentHint: 'detail'
    });
});

test('createVideoExportEncodingConfig should default to a high bitrate for full-video re-encoding', () => {
    assert.equal(createVideoExportEncodingConfig(null).bitrate, 12_000_000);
});

test('createVideoExportEncodingConfig should force BT.709 limited-range decoder metadata', () => {
    const config = createVideoExportEncodingConfig(9_000_000);
    const meta = {
        decoderConfig: {
            codec: 'avc1.64001f',
            codedWidth: 1280,
            codedHeight: 720,
            colorSpace: {
                primaries: 'smpte170m',
                transfer: 'smpte170m',
                matrix: 'smpte170m',
                fullRange: false
            }
        }
    };

    config.onEncodedPacket(null, meta);

    assert.deepEqual(meta.decoderConfig.colorSpace, {
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false
    });
});

test('processVideoWatermarkFrame should process only the active watermark track', async () => {
    const ctx = createImageContext(96, 64);
    const relocated = {
        candidate: { id: 'relocated-16' },
        position: { x: 4, y: 4, width: 16, height: 16 },
        alphaMap: getVideoAlphaMap(16),
        alphaSeed: { seedGain: 1 },
        meanConfidence: 0.4
    };
    const standard = {
        candidate: { id: 'standard-12' },
        position: { x: 76, y: 48, width: 12, height: 12 },
        alphaMap: getVideoAlphaMap(12),
        alphaSeed: { seedGain: 1 },
        meanConfidence: 0.15
    };
    applyWhiteWatermark(ctx, standard.alphaMap, standard.position);
    const relocatedBefore = ctx.getImageData(4, 4, 16, 16).data;

    const result = await videoExportModule.processVideoWatermarkFrame?.(
        ctx,
        { ...relocated, detections: [relocated, standard] },
        new Map(),
        {
            adaptiveAlpha: false,
            residualCleanupStrength: 0,
            highQualityCleanup: false,
            denoiseBackend: VIDEO_DENOISE_BACKENDS.NONE,
            edgeDenoiseStrength: 0,
            textureRepair: false,
            textureRepairStrength: 0,
            highConfidenceThreshold: 0.14,
            lowConfidenceThreshold: 0.035
        }
    );

    assert.equal(result?.selectedDetection.candidate.id, 'standard-12');
    assert.deepEqual(ctx.getImageData(4, 4, 16, 16).data, relocatedBefore);
    assert.ok(ctx.getImageData(76, 48, 12, 12).data.some((value, index) => (
        index % 4 !== 3 && value < 100
    )));
});

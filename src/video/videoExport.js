import {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    CanvasSource,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    Input,
    Mp4OutputFormat,
    Output,
    VideoSampleSink,
    canEncodeVideo
} from 'mediabunny';
import { removeWatermark } from '../core/blendModes.js';
import {
    detectVideoWatermarkFromFramesAsync,
    scoreVideoWatermarkFrame
} from './videoWatermarkDetector.js';
import { resolveVideoWatermarkCandidates } from './videoWatermarkCatalog.js';
import {
    DEFAULT_DENOISE_BACKEND,
    DEFAULT_EDGE_DENOISE_STRENGTH,
    DEFAULT_HIGH_QUALITY_CLEANUP,
    DEFAULT_RESIDUAL_CLEANUP_STRENGTH,
    DEFAULT_TEXTURE_REPAIR,
    DEFAULT_TEXTURE_REPAIR_STRENGTH,
    VIDEO_DENOISE_BACKENDS,
    applyVideoResidualCleanup,
    applyVideoResidualCleanupAsync,
    normalizeVideoCleanupOptions
} from './videoCleanupBackends.js';
import { resolveAllenkFdncnnRuntimeProfile } from './videoDenoiseRuntimePolicy.js';

const DEFAULT_SAMPLE_COUNT = 12;
const DEFAULT_ALPHA_GAIN = 1;
const DEFAULT_ADAPTIVE_ALPHA = false;
const DEFAULT_VIDEO_BITRATE = 12_000_000;
const DEFAULT_VIDEO_KEY_FRAME_INTERVAL = 2;
const DEFAULT_AVC_HARDWARE_ACCELERATION = 'no-preference';
const DEFAULT_VIDEO_LATENCY_MODE = 'quality';
const DEFAULT_VIDEO_BITRATE_MODE = 'constant';
const DEFAULT_VIDEO_CONTENT_HINT = 'detail';
const ALPHA_REFINEMENT_ROUNDS = 5;
const ALPHA_FRAME_STEP_CAP = 0.05;
const FRAME_HIGH_CONFIDENCE = 0.14;
const FRAME_LOW_CONFIDENCE = 0.035;
const AUDIO_COPY_DISABLED = Object.freeze({
    copied: false,
    packetCount: 0,
    codec: null,
    skipReason: 'disabled'
});

function createRuntimeCanvas(width, height) {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height);
    }
    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }
    throw new Error('当前环境没有可用 Canvas');
}

function get2dContext(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        throw new Error('无法创建 2D Canvas 上下文');
    }
    return ctx;
}

function createInput(file) {
    return new Input({
        source: new BlobSource(file),
        formats: ALL_FORMATS
    });
}

async function getVideoContext(file) {
    const input = createInput(file);
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
        input.dispose();
        throw new Error('文件中没有可处理的视频轨');
    }
    return { input, videoTrack };
}

async function resolveVideoMetadata(input, videoTrack) {
    const [width, height, firstTimestamp, codec, durationFromMetadata, packetStats] = await Promise.all([
        videoTrack.getDisplayWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getFirstTimestamp().catch(() => 0),
        videoTrack.getCodec().catch(() => null),
        input.getDurationFromMetadata([videoTrack], { skipLiveWait: true }).catch(() => null),
        videoTrack.computePacketStats(90, { skipLiveWait: true }).catch(() => null)
    ]);

    const duration = Number.isFinite(durationFromMetadata) && durationFromMetadata > 0
        ? durationFromMetadata
        : await videoTrack.computeDuration({ skipLiveWait: true }).catch(() => null);
    const frameRate = packetStats?.averagePacketRate && Number.isFinite(packetStats.averagePacketRate)
        ? packetStats.averagePacketRate
        : 30;

    return {
        width,
        height,
        firstTimestamp: Number.isFinite(firstTimestamp) ? firstTimestamp : 0,
        duration: Number.isFinite(duration) ? duration : null,
        codec,
        frameRate,
        frameCountEstimate: packetStats?.packetCount || (duration ? Math.round(duration * frameRate) : null),
        averageBitrate: packetStats?.averageBitrate || null
    };
}

function getSampleTargetTimestamps({ firstTimestamp, duration, sampleCount }) {
    const count = Math.max(1, Math.round(sampleCount || DEFAULT_SAMPLE_COUNT));
    if (!Number.isFinite(duration) || duration <= 0) {
        return [firstTimestamp];
    }
    const start = Math.max(0, firstTimestamp);
    const interval = duration / (count + 1);
    return Array.from({ length: count }, (_, index) => start + interval * (index + 1));
}

function resolveVideoBitrate(value) {
    const bitrate = Number(value);
    return Number.isFinite(bitrate) && bitrate > 0 ? bitrate : DEFAULT_VIDEO_BITRATE;
}

export function createVideoExportEncodingConfig(videoBitrate) {
    return {
        codec: 'avc',
        bitrate: resolveVideoBitrate(videoBitrate),
        alpha: 'discard',
        keyFrameInterval: DEFAULT_VIDEO_KEY_FRAME_INTERVAL,
        latencyMode: DEFAULT_VIDEO_LATENCY_MODE,
        bitrateMode: DEFAULT_VIDEO_BITRATE_MODE,
        hardwareAcceleration: DEFAULT_AVC_HARDWARE_ACCELERATION,
        contentHint: DEFAULT_VIDEO_CONTENT_HINT
    };
}

function normalizePacketTimestamp(packet, startTimestamp) {
    const shiftedTimestamp = packet.timestamp - startTimestamp;
    if (shiftedTimestamp >= 0) {
        return packet;
    }
    if (packet.timestamp + packet.duration <= startTimestamp) {
        return null;
    }
    return packet.clone({
        timestamp: 0,
        duration: Math.max(0, packet.duration + shiftedTimestamp)
    });
}

function canCopyAudioCodecToMp4(format, codec) {
    return Boolean(codec && format.getSupportedAudioCodecs().includes(codec));
}

async function prepareAudioPacketCopy({ input, output, format, startTimestamp, preserveAudio }) {
    if (preserveAudio === false) {
        return {
            source: null,
            track: null,
            meta: null,
            result: AUDIO_COPY_DISABLED
        };
    }

    const audioTrack = await input.getPrimaryAudioTrack().catch(() => null);
    if (!audioTrack) {
        return {
            source: null,
            track: null,
            meta: null,
            result: {
                copied: false,
                packetCount: 0,
                codec: null,
                skipReason: 'no-audio-track'
            }
        };
    }

    const codec = await audioTrack.getCodec().catch(() => null);
    if (!canCopyAudioCodecToMp4(format, codec)) {
        return {
            source: null,
            track: audioTrack,
            meta: null,
            result: {
                copied: false,
                packetCount: 0,
                codec,
                skipReason: 'unsupported-audio-codec'
            }
        };
    }

    const source = new EncodedAudioPacketSource(codec);
    output.addAudioTrack(source);
    const decoderConfig = await audioTrack.getDecoderConfig().catch(() => null);
    return {
        source,
        track: audioTrack,
        meta: { decoderConfig: decoderConfig ?? undefined },
        result: {
            copied: false,
            packetCount: 0,
            codec,
            skipReason: null
        },
        startTimestamp
    };
}

async function copyAudioPackets(audioCopy) {
    if (!audioCopy?.source || !audioCopy.track) {
        return audioCopy?.result || AUDIO_COPY_DISABLED;
    }

    const sink = new EncodedPacketSink(audioCopy.track);
    let packetCount = 0;

    try {
        for await (const packet of sink.packets()) {
            const normalized = normalizePacketTimestamp(packet, audioCopy.startTimestamp || 0);
            if (!normalized) continue;
            await audioCopy.source.add(normalized, audioCopy.meta);
            packetCount++;
        }
        audioCopy.source.close();
        return {
            copied: packetCount > 0,
            packetCount,
            codec: audioCopy.result.codec,
            skipReason: packetCount > 0 ? null : 'no-audio-packets'
        };
    } catch (error) {
        audioCopy.source.close();
        throw error;
    }
}

export async function inspectGeminiVideoFile(file) {
    const { input, videoTrack } = await getVideoContext(file);
    try {
        const metadata = await resolveVideoMetadata(input, videoTrack);
        return {
            ...metadata,
            candidates: resolveVideoWatermarkCandidates(metadata.width, metadata.height)
        };
    } finally {
        input.dispose();
    }
}

export async function detectGeminiVideoWatermark(file, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const yieldToMainThread = typeof options.yieldToMainThread === 'function'
        ? options.yieldToMainThread
        : async () => {};
    const { input, videoTrack } = await getVideoContext(file);
    try {
        const metadata = await resolveVideoMetadata(input, videoTrack);
        onProgress({
            phase: 'detect',
            step: 'metadata',
            progress: 0.04,
            metadata
        });
        await yieldToMainThread();
        const canvas = createRuntimeCanvas(metadata.width, metadata.height);
        const ctx = get2dContext(canvas);
        const sink = new VideoSampleSink(videoTrack);
        const targets = getSampleTargetTimestamps({
            firstTimestamp: metadata.firstTimestamp,
            duration: metadata.duration,
            sampleCount: options.sampleCount ?? DEFAULT_SAMPLE_COUNT
        });
        const frames = [];
        let targetIndex = 0;

        for await (const sample of sink.samples()) {
            try {
                if (targetIndex >= targets.length) break;
                if (sample.timestamp < targets[targetIndex] && frames.length > 0) continue;

                sample.draw(ctx, 0, 0, metadata.width, metadata.height);
                frames.push({
                    timestamp: sample.timestamp,
                    imageData: ctx.getImageData(0, 0, metadata.width, metadata.height)
                });
                targetIndex++;
                onProgress({
                    phase: 'detect',
                    step: 'sample',
                    progress: 0.06 + 0.54 * Math.min(1, frames.length / targets.length),
                    metadata,
                    sampledFrames: frames.length,
                    sampleCount: targets.length
                });
                await yieldToMainThread();
            } finally {
                sample.close();
            }
        }

        if (!frames.length) {
            throw new Error('无法从视频中抽取检测帧');
        }

        onProgress({
            phase: 'detect',
            step: 'score',
            progress: 0.65,
            metadata,
            sampledFrames: frames.length,
            sampleCount: targets.length
        });
        await yieldToMainThread();

        const detection = await detectVideoWatermarkFromFramesAsync({
            frames,
            width: metadata.width,
            height: metadata.height,
            candidates: options.candidates,
            minConfidence: options.minConfidence,
            alphaMapOptions: {
                profile: options.alphaProfile,
                lowAlphaScale: options.alphaLowScale,
                bodyAlphaScale: options.alphaBodyScale,
                edgeBoost: options.alphaEdgeBoost,
                localRegion: options.alphaLocalRegion,
                localLowAlphaScale: options.alphaLocalLowScale,
                localBodyAlphaScale: options.alphaLocalBodyScale
            },
            yieldToMainThread
        });
        onProgress({
            phase: 'detect',
            step: 'done',
            progress: 1,
            metadata,
            detection
        });

        return {
            metadata,
            detection
        };
    } finally {
        input.dispose();
    }
}

function cloneImageData(imageData) {
    const data = new Uint8ClampedArray(imageData.data);
    if (typeof ImageData !== 'undefined') {
        return new ImageData(data, imageData.width, imageData.height);
    }
    return { width: imageData.width, height: imageData.height, data };
}

function lumaAt(data, idx) {
    return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
}

function computeBackgroundStats(ctx, position, alphaMap, padding = 18) {
    const padX = Math.max(0, position.x - padding);
    const padY = Math.max(0, position.y - padding);
    const padRight = Math.min(ctx.canvas.width, position.x + position.width + padding);
    const padBottom = Math.min(ctx.canvas.height, position.y + position.height + padding);
    const padded = ctx.getImageData(padX, padY, padRight - padX, padBottom - padY);

    let sum = 0;
    let weightSum = 0;
    const lowAlphaThreshold = 0.015;

    for (let y = 0; y < padded.height; y++) {
        for (let x = 0; x < padded.width; x++) {
            const imageX = padX + x;
            const imageY = padY + y;
            const inRoi =
                imageX >= position.x &&
                imageX < position.x + position.width &&
                imageY >= position.y &&
                imageY < position.y + position.height;

            let weight = inRoi ? 0 : 1;
            if (inRoi) {
                const rx = imageX - position.x;
                const ry = imageY - position.y;
                const alpha = alphaMap[ry * position.width + rx] || 0;
                if (alpha <= lowAlphaThreshold) weight = 0.35;
            }
            if (weight <= 0) continue;

            const idx = (y * padded.width + x) * 4;
            sum += lumaAt(padded.data, idx) * weight;
            weightSum += weight;
        }
    }

    return {
        mean: weightSum > 0 ? sum / weightSum : null,
        padded
    };
}

function scoreRestoredRoiAgainstBackground(roi, alphaMap, backgroundMean) {
    if (!Number.isFinite(backgroundMean)) return 0;

    let sum = 0;
    let weightSum = 0;
    for (let y = 0; y < roi.height; y++) {
        for (let x = 0; x < roi.width; x++) {
            const alpha = alphaMap[y * roi.width + x] || 0;
            if (alpha <= 0.025) continue;
            const weight = Math.min(1, Math.max(0, alpha * 8));
            const idx = (y * roi.width + x) * 4;
            sum += lumaAt(roi.data, idx) * weight;
            weightSum += weight;
        }
    }
    if (weightSum <= 0) return 0;
    return sum / weightSum - backgroundMean;
}

function smoothstep(edge0, edge1, value) {
    if (edge0 === edge1) return value >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function applyRoiRemoval(originalRoi, alphaMap, gain) {
    const candidate = cloneImageData(originalRoi);
    removeWatermark(candidate, alphaMap, {
        x: 0,
        y: 0,
        width: originalRoi.width,
        height: originalRoi.height
    }, { alphaGain: gain });
    return candidate;
}

function applyTemporalRoiStabilization(ctx, position, alphaMap, previousRoi, { strength = DEFAULT_EDGE_DENOISE_STRENGTH } = {}) {
    const current = ctx.getImageData(position.x, position.y, position.width, position.height);
    if (
        !previousRoi ||
        previousRoi.width !== current.width ||
        previousRoi.height !== current.height ||
        !Number.isFinite(strength) ||
        strength <= 0
    ) {
        return current;
    }

    const safeStrength = Math.max(0, Math.min(1, strength));
    const output = new Uint8ClampedArray(current.data);
    let changed = false;

    for (let y = 0; y < current.height; y++) {
        for (let x = 0; x < current.width; x++) {
            const pixel = y * current.width + x;
            const alpha = alphaMap[pixel] || 0;
            if (alpha <= 0.025) continue;

            const idx = pixel * 4;
            const currentLuma = lumaAt(current.data, idx);
            const previousLuma = lumaAt(previousRoi.data, idx);
            const lumaDelta = Math.abs(currentLuma - previousLuma);
            const motionGate = 1 - smoothstep(5, 22, lumaDelta);
            const alphaGate = smoothstep(0.035, 0.24, alpha);
            const blendWeight = Math.min(0.26, safeStrength * alphaGate * motionGate * 0.32);
            if (blendWeight <= 0.012) continue;

            for (let c = 0; c < 3; c++) {
                output[idx + c] = Math.round(
                    current.data[idx + c] * (1 - blendWeight) + previousRoi.data[idx + c] * blendWeight
                );
            }
            changed = true;
        }
    }

    if (!changed) return current;

    const stabilized = typeof ImageData !== 'undefined'
        ? new ImageData(output, current.width, current.height)
        : { width: current.width, height: current.height, data: output };
    ctx.putImageData(stabilized, position.x, position.y);
    return stabilized;
}

function applyTemporalDeltaStabilization(ctx, position, alphaMap, originalRoi, previousFrame, { strength = DEFAULT_EDGE_DENOISE_STRENGTH } = {}) {
    const processed = ctx.getImageData(position.x, position.y, position.width, position.height);
    if (
        !previousFrame?.originalRoi ||
        !previousFrame?.processedRoi ||
        previousFrame.originalRoi.width !== processed.width ||
        previousFrame.originalRoi.height !== processed.height ||
        previousFrame.processedRoi.width !== processed.width ||
        previousFrame.processedRoi.height !== processed.height ||
        !Number.isFinite(strength) ||
        strength <= 0
    ) {
        return { originalRoi, processedRoi: processed };
    }

    const safeStrength = Math.max(0, Math.min(1, strength));
    const output = new Uint8ClampedArray(processed.data);
    let changed = false;

    for (let y = 0; y < processed.height; y++) {
        for (let x = 0; x < processed.width; x++) {
            const pixel = y * processed.width + x;
            const alpha = alphaMap[pixel] || 0;
            if (alpha <= 0.025) continue;

            const idx = pixel * 4;
            const currentOriginalLuma = lumaAt(originalRoi.data, idx);
            const previousOriginalLuma = lumaAt(previousFrame.originalRoi.data, idx);
            const originalMotion = Math.abs(currentOriginalLuma - previousOriginalLuma);
            const currentDeltaLuma = lumaAt(processed.data, idx) - currentOriginalLuma;
            const previousDeltaLuma = lumaAt(previousFrame.processedRoi.data, idx) - previousOriginalLuma;
            const deltaJitter = Math.abs(currentDeltaLuma - previousDeltaLuma);
            const motionGate = 1 - smoothstep(4, 20, originalMotion);
            const jitterGate = smoothstep(1.5, 10, deltaJitter);
            const alphaGate = smoothstep(0.035, 0.24, alpha);
            const blendWeight = Math.min(0.34, safeStrength * motionGate * jitterGate * alphaGate * 0.42);
            if (blendWeight <= 0.012) continue;

            for (let c = 0; c < 3; c++) {
                const currentDelta = processed.data[idx + c] - originalRoi.data[idx + c];
                const previousDelta = previousFrame.processedRoi.data[idx + c] - previousFrame.originalRoi.data[idx + c];
                const mixedDelta = currentDelta * (1 - blendWeight) + previousDelta * blendWeight;
                output[idx + c] = Math.max(0, Math.min(255, Math.round(originalRoi.data[idx + c] + mixedDelta)));
            }
            changed = true;
        }
    }

    if (!changed) {
        return { originalRoi, processedRoi: processed };
    }

    const stabilized = typeof ImageData !== 'undefined'
        ? new ImageData(output, processed.width, processed.height)
        : { width: processed.width, height: processed.height, data: output };
    ctx.putImageData(stabilized, position.x, position.y);
    return { originalRoi, processedRoi: stabilized };
}

function buildRoiLumaMap(imageData) {
    const luma = new Float32Array(imageData.width * imageData.height);
    for (let i = 0; i < luma.length; i++) {
        luma[i] = lumaAt(imageData.data, i * 4);
    }
    return luma;
}

function scorePatchLumaDelta(currentLuma, previousLuma, width, height, x, y, dx, dy) {
    let sum = 0;
    let count = 0;
    for (let py = -1; py <= 1; py++) {
        const cy = y + py;
        const sy = y + dy + py;
        if (cy < 0 || cy >= height || sy < 0 || sy >= height) continue;
        for (let px = -1; px <= 1; px++) {
            const cx = x + px;
            const sx = x + dx + px;
            if (cx < 0 || cx >= width || sx < 0 || sx >= width) continue;
            sum += Math.abs(currentLuma[cy * width + cx] - previousLuma[sy * width + sx]);
            count++;
        }
    }
    return count > 0 ? sum / count : Number.POSITIVE_INFINITY;
}

function applyTemporalMatchedDeltaStabilization(ctx, position, alphaMap, originalRoi, previousFrame, { strength = DEFAULT_EDGE_DENOISE_STRENGTH } = {}) {
    const processed = ctx.getImageData(position.x, position.y, position.width, position.height);
    if (
        !previousFrame?.originalRoi ||
        !previousFrame?.processedRoi ||
        previousFrame.originalRoi.width !== processed.width ||
        previousFrame.originalRoi.height !== processed.height ||
        previousFrame.processedRoi.width !== processed.width ||
        previousFrame.processedRoi.height !== processed.height ||
        !Number.isFinite(strength) ||
        strength <= 0
    ) {
        return { originalRoi, processedRoi: processed };
    }

    const safeStrength = Math.max(0, Math.min(1, strength));
    const width = processed.width;
    const height = processed.height;
    const currentLuma = buildRoiLumaMap(originalRoi);
    const previousLuma = buildRoiLumaMap(previousFrame.originalRoi);
    const output = new Uint8ClampedArray(processed.data);
    let changed = false;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const alpha = alphaMap[pixel] || 0;
            if (alpha <= 0.025) continue;

            let bestDx = 0;
            let bestDy = 0;
            let bestCost = Number.POSITIVE_INFINITY;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const sx = x + dx;
                    const sy = y + dy;
                    if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
                    const cost = scorePatchLumaDelta(currentLuma, previousLuma, width, height, x, y, dx, dy);
                    if (cost < bestCost) {
                        bestCost = cost;
                        bestDx = dx;
                        bestDy = dy;
                    }
                }
            }

            const sourcePixel = (y + bestDy) * width + x + bestDx;
            const idx = pixel * 4;
            const sourceIdx = sourcePixel * 4;
            const currentDeltaLuma = lumaAt(processed.data, idx) - currentLuma[pixel];
            const sameDeltaLuma = lumaAt(previousFrame.processedRoi.data, idx) - previousLuma[pixel];
            const previousDeltaLuma = lumaAt(previousFrame.processedRoi.data, sourceIdx) - previousLuma[sourcePixel];
            const deltaJitter = Math.abs(currentDeltaLuma - previousDeltaLuma);
            const sameDeltaJitter = Math.abs(currentDeltaLuma - sameDeltaLuma);
            const matchedAdvantage = sameDeltaJitter - deltaJitter;
            if (matchedAdvantage <= 0.5 || bestCost > 8) continue;

            const matchGate = 1 - smoothstep(2.5, 8, bestCost);
            const advantageGate = smoothstep(0.5, 5, matchedAdvantage);
            const jitterGate = smoothstep(1.5, 10, deltaJitter);
            const alphaGate = smoothstep(0.035, 0.24, alpha);
            const blendWeight = Math.min(0.24, safeStrength * matchGate * advantageGate * jitterGate * alphaGate * 0.36);
            if (blendWeight <= 0.012) continue;

            for (let c = 0; c < 3; c++) {
                const currentDelta = processed.data[idx + c] - originalRoi.data[idx + c];
                const previousDelta = previousFrame.processedRoi.data[sourceIdx + c] - previousFrame.originalRoi.data[sourceIdx + c];
                const mixedDelta = currentDelta * (1 - blendWeight) + previousDelta * blendWeight;
                output[idx + c] = Math.max(0, Math.min(255, Math.round(originalRoi.data[idx + c] + mixedDelta)));
            }
            changed = true;
        }
    }

    if (!changed) {
        return { originalRoi, processedRoi: processed };
    }

    const stabilized = typeof ImageData !== 'undefined'
        ? new ImageData(output, processed.width, processed.height)
        : { width: processed.width, height: processed.height, data: output };
    ctx.putImageData(stabilized, position.x, position.y);
    return { originalRoi, processedRoi: stabilized };
}

function shouldApplyTemporalMatchedDelta(ctx, position) {
    const marginRight = ctx.canvas.width - position.x - position.width;
    const marginBottom = ctx.canvas.height - position.y - position.height;
    const relocatedMargin = Math.round(position.width * 1.8);

    return marginRight >= relocatedMargin || marginBottom >= relocatedMargin;
}

function refineAlphaGain({
    ctx,
    originalRoi,
    position,
    alphaMap,
    seedGain,
    previousGain
}) {
    const background = computeBackgroundStats(ctx, position, alphaMap);
    if (!Number.isFinite(background.mean)) {
        return seedGain;
    }

    let lo = Math.max(0.2, seedGain - 0.3);
    let hi = Math.min(1.15, seedGain + 0.3);
    let bestGain = seedGain;
    let bestAbsDelta = Number.POSITIVE_INFINITY;

    for (let i = 0; i < ALPHA_REFINEMENT_ROUNDS; i++) {
        const gain = (lo + hi) / 2;
        const restored = applyRoiRemoval(originalRoi, alphaMap, gain);
        const delta = scoreRestoredRoiAgainstBackground(restored, alphaMap, background.mean);
        const absDelta = Math.abs(delta);

        if (absDelta < bestAbsDelta) {
            bestAbsDelta = absDelta;
            bestGain = gain;
        }

        if (delta > 0) {
            lo = gain;
        } else {
            hi = gain;
        }
    }

    if (Number.isFinite(previousGain)) {
        bestGain = Math.max(
            previousGain - ALPHA_FRAME_STEP_CAP,
            Math.min(previousGain + ALPHA_FRAME_STEP_CAP, bestGain)
        );
    }

    return bestGain;
}

function processWatermarkRoi(ctx, detection, options) {
    const { position, alphaMap } = detection;
    const frameScore = scoreVideoWatermarkFrame(
        ctx.getImageData(position.x, position.y, position.width, position.height),
        { x: 0, y: 0, width: position.width, height: position.height },
        alphaMap
    );
    const shouldSkip = frameScore.confidence < options.lowConfidenceThreshold;

    if (shouldSkip) {
        return {
            alphaGain: options.previousAlphaGain ?? options.seedAlphaGain,
            frameScore,
            skipped: true,
            mode: 'skip'
        };
    }

    const roi = ctx.getImageData(position.x, position.y, position.width, position.height);
    const useAdaptiveAlpha = options.adaptiveAlpha && frameScore.confidence >= options.highConfidenceThreshold;
    const alphaGain = useAdaptiveAlpha
        ? refineAlphaGain({
            ctx,
            originalRoi: roi,
            position,
            alphaMap,
            seedGain: options.seedAlphaGain,
            previousGain: options.previousAlphaGain
        })
        : options.seedAlphaGain;
    const processed = applyRoiRemoval(roi, alphaMap, alphaGain);
    ctx.putImageData(processed, position.x, position.y);
    applyVideoResidualCleanup(ctx, position, alphaMap, {
        residualCleanupStrength: options.residualCleanupStrength,
        highQualityCleanup: options.highQualityCleanup,
        denoiseBackend: options.denoiseBackend,
        edgeDenoiseStrength: options.edgeDenoiseStrength,
        allenkFdncnnRuntime: options.allenkFdncnnRuntime,
        allenkFdncnnSigma: options.allenkFdncnnSigma,
        textureRepair: options.textureRepair,
        textureRepairStrength: options.textureRepairStrength
    });
    const temporalRoi = options.denoiseBackend === VIDEO_DENOISE_BACKENDS.CANVAS_TEMPORAL_STABILIZE
        ? applyTemporalRoiStabilization(ctx, position, alphaMap, options.previousTemporalRoi, {
            strength: options.edgeDenoiseStrength
        })
        : null;
    const temporalDeltaFrame = options.denoiseBackend === VIDEO_DENOISE_BACKENDS.CANVAS_TEMPORAL_DELTA_STABILIZE
        ? applyTemporalDeltaStabilization(ctx, position, alphaMap, roi, options.previousTemporalDeltaFrame, {
            strength: options.edgeDenoiseStrength
        })
        : null;
    const temporalMatchDeltaFrame = options.denoiseBackend === VIDEO_DENOISE_BACKENDS.CANVAS_TEMPORAL_MATCH_DELTA_STABILIZE &&
        shouldApplyTemporalMatchedDelta(ctx, position)
        ? applyTemporalMatchedDeltaStabilization(ctx, position, alphaMap, roi, options.previousTemporalMatchDeltaFrame, {
            strength: options.edgeDenoiseStrength
        })
        : null;
    return {
        alphaGain,
        frameScore,
        skipped: false,
        mode: useAdaptiveAlpha ? 'adaptive' : 'seed',
        temporalRoi,
        temporalDeltaFrame,
        temporalMatchDeltaFrame
    };
}

async function processWatermarkRoiAsync(ctx, detection, options) {
    const shouldUseAsyncCleanup = options.denoiseBackend === VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE &&
        options.allenkFdncnnRuntime;
    if (!shouldUseAsyncCleanup) {
        return processWatermarkRoi(ctx, detection, options);
    }

    const { position, alphaMap } = detection;
    const frameScore = scoreVideoWatermarkFrame(
        ctx.getImageData(position.x, position.y, position.width, position.height),
        { x: 0, y: 0, width: position.width, height: position.height },
        alphaMap
    );
    const shouldSkip = frameScore.confidence < options.lowConfidenceThreshold;

    if (shouldSkip) {
        return {
            alphaGain: options.previousAlphaGain ?? options.seedAlphaGain,
            frameScore,
            skipped: true,
            mode: 'skip'
        };
    }

    const roi = ctx.getImageData(position.x, position.y, position.width, position.height);
    const useAdaptiveAlpha = options.adaptiveAlpha && frameScore.confidence >= options.highConfidenceThreshold;
    const alphaGain = useAdaptiveAlpha
        ? refineAlphaGain({
            ctx,
            originalRoi: roi,
            position,
            alphaMap,
            seedGain: options.seedAlphaGain,
            previousGain: options.previousAlphaGain
        })
        : options.seedAlphaGain;
    const processed = applyRoiRemoval(roi, alphaMap, alphaGain);
    ctx.putImageData(processed, position.x, position.y);
    const cleanupResult = await applyVideoResidualCleanupAsync(ctx, position, alphaMap, {
        residualCleanupStrength: options.residualCleanupStrength,
        highQualityCleanup: options.highQualityCleanup,
        denoiseBackend: options.denoiseBackend,
        edgeDenoiseStrength: options.edgeDenoiseStrength,
        allenkFdncnnRuntime: options.allenkFdncnnRuntime,
        allenkFdncnnSigma: options.allenkFdncnnSigma,
        allenkFdncnnPadding: options.allenkFdncnnPadding,
        allenkFdncnnTemporalReuse: options.allenkFdncnnTemporalReuse,
        allenkFdncnnFrameCache: options.allenkFdncnnFrameCache,
        textureRepair: options.textureRepair,
        textureRepairStrength: options.textureRepairStrength
    });

    return {
        alphaGain,
        frameScore,
        skipped: false,
        mode: useAdaptiveAlpha ? 'adaptive' : 'seed',
        temporalRoi: null,
        temporalDeltaFrame: null,
        temporalMatchDeltaFrame: null,
        cleanupResult
    };
}

export async function removeGeminiVideoWatermark(file, options = {}) {
    const requestedAlphaGain = Number.isFinite(options.alphaGain) && options.alphaGain > 0
        ? options.alphaGain
        : DEFAULT_ALPHA_GAIN;
    const adaptiveAlpha = options.adaptiveAlpha === true || (
        options.adaptiveAlpha !== false && DEFAULT_ADAPTIVE_ALPHA
    );
    const cleanupOptions = normalizeVideoCleanupOptions(options);
    const {
        residualCleanupStrength,
        highQualityCleanup,
        denoiseBackend,
        edgeDenoiseStrength,
        textureRepair,
        textureRepairStrength
    } = cleanupOptions;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const videoBitrate = resolveVideoBitrate(options.videoBitrate);

    onProgress({ phase: 'detect', progress: 0 });
    const detected = options.detection || await detectGeminiVideoWatermark(file, {
        sampleCount: options.sampleCount,
        minConfidence: options.minConfidence,
        candidates: options.candidates,
        alphaProfile: options.alphaProfile,
        alphaLowScale: options.alphaLowScale,
        alphaBodyScale: options.alphaBodyScale,
        alphaEdgeBoost: options.alphaEdgeBoost,
        alphaLocalRegion: options.alphaLocalRegion,
        alphaLocalLowScale: options.alphaLocalLowScale,
        alphaLocalBodyScale: options.alphaLocalBodyScale,
        onProgress,
        yieldToMainThread: options.yieldToMainThread
    });
    const { metadata, detection } = detected;
    const allenkFdncnnPadding = resolveExportAllenkFdncnnPadding(cleanupOptions, detection);
    const detectedSeedGain = detection?.alphaSeed?.seedGain;
    const alphaGain = (
        Number.isFinite(detectedSeedGain) &&
        Math.abs(requestedAlphaGain - DEFAULT_ALPHA_GAIN) < 0.0001
    )
        ? detectedSeedGain
        : requestedAlphaGain;
    onProgress({ phase: 'detect', progress: 1, metadata, detection });

    if (!detection.isConfident && options.allowLowConfidence !== true) {
        throw new Error('视频水印检测置信度偏低，已停止导出。可打开低置信导出后重试。');
    }

    const videoEncodingConfig = createVideoExportEncodingConfig(videoBitrate);
    const canEncodeAvc = await canEncodeVideo('avc', {
        width: metadata.width,
        height: metadata.height,
        bitrate: videoEncodingConfig.bitrate,
        latencyMode: videoEncodingConfig.latencyMode,
        bitrateMode: videoEncodingConfig.bitrateMode,
        hardwareAcceleration: videoEncodingConfig.hardwareAcceleration,
        contentHint: videoEncodingConfig.contentHint
    });
    if (!canEncodeAvc) {
        throw new Error('当前浏览器不支持 WebCodecs H.264/AVC 编码，请使用新版 Chrome 或 Edge。');
    }

    const { input, videoTrack } = await getVideoContext(file);
    const canvas = createRuntimeCanvas(metadata.width, metadata.height);
    const ctx = get2dContext(canvas);
    const target = new BufferTarget();
    const format = new Mp4OutputFormat({ fastStart: 'in-memory' });
    const output = new Output({
        format,
        target
    });
    const source = new CanvasSource(canvas, videoEncodingConfig);

    output.addVideoTrack(source, {
        frameRate: metadata.frameRate
    });
    const audioCopy = await prepareAudioPacketCopy({
        input,
        output,
        format,
        startTimestamp: metadata.firstTimestamp,
        preserveAudio: options.preserveAudio
    });

    let processedFrames = 0;
    let skippedFrames = 0;
    let adaptiveFrames = 0;
    let seedFrames = 0;
    let aiDenoiseFrames = 0;
    let aiReuseFrames = 0;
    let lastTimestamp = -Infinity;
    let previousAlphaGain = null;
    let previousTemporalRoi = null;
    let previousTemporalDeltaFrame = null;
    let previousTemporalMatchDeltaFrame = null;
    const allenkFdncnnFrameCache = denoiseBackend === VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE
        ? {}
        : null;
    const fallbackDuration = metadata.frameRate > 0 ? 1 / metadata.frameRate : 1 / 30;

    try {
        await output.start();
        const audioCopyPromise = copyAudioPackets(audioCopy);
        const sink = new VideoSampleSink(videoTrack);

        for await (const sample of sink.samples()) {
            let timestamp = Math.max(0, sample.timestamp - metadata.firstTimestamp);
            if (timestamp < lastTimestamp) {
                timestamp = lastTimestamp + fallbackDuration;
            }
            const duration = Number.isFinite(sample.duration) && sample.duration > 0
                ? sample.duration
                : fallbackDuration;

            try {
                sample.draw(ctx, 0, 0, metadata.width, metadata.height);
                const frameResult = await processWatermarkRoiAsync(ctx, detection, {
                    seedAlphaGain: alphaGain,
                    previousAlphaGain,
                    adaptiveAlpha,
                    residualCleanupStrength,
                    highQualityCleanup,
                    denoiseBackend,
                    edgeDenoiseStrength,
                    textureRepair,
                    textureRepairStrength,
                    allenkFdncnnRuntime: options.allenkFdncnnRuntime,
                    allenkFdncnnSigma: options.allenkFdncnnSigma,
                    allenkFdncnnPadding,
                    allenkFdncnnTemporalReuse: options.allenkFdncnnTemporalReuse,
                    allenkFdncnnFrameCache,
                    previousTemporalRoi,
                    previousTemporalDeltaFrame,
                    previousTemporalMatchDeltaFrame,
                    highConfidenceThreshold: options.highConfidenceThreshold ?? FRAME_HIGH_CONFIDENCE,
                    lowConfidenceThreshold: options.lowConfidenceThreshold ?? FRAME_LOW_CONFIDENCE
                });
                previousAlphaGain = frameResult.alphaGain;
                const denoiseStatus = frameResult.cleanupResult?.denoiseRuntimeStatus;
                if (denoiseStatus === 'applied') {
                    aiDenoiseFrames++;
                } else if (denoiseStatus === 'reused') {
                    aiReuseFrames++;
                }
                if (frameResult.skipped) {
                    skippedFrames++;
                    previousTemporalRoi = null;
                    previousTemporalDeltaFrame = null;
                    previousTemporalMatchDeltaFrame = null;
                } else if (frameResult.mode === 'adaptive') {
                    adaptiveFrames++;
                    previousTemporalRoi = frameResult.temporalRoi || null;
                    previousTemporalDeltaFrame = frameResult.temporalDeltaFrame || null;
                    previousTemporalMatchDeltaFrame = frameResult.temporalMatchDeltaFrame || null;
                } else {
                    seedFrames++;
                    previousTemporalRoi = frameResult.temporalRoi || null;
                    previousTemporalDeltaFrame = frameResult.temporalDeltaFrame || null;
                    previousTemporalMatchDeltaFrame = frameResult.temporalMatchDeltaFrame || null;
                }
            } finally {
                sample.close();
            }

            await source.add(timestamp, duration);
            lastTimestamp = timestamp;
            processedFrames++;

            const frameEstimate = metadata.frameCountEstimate || Math.max(1, Math.round((metadata.duration || 0) * metadata.frameRate));
            const elapsedSeconds = timestamp + duration;
            const timeProgress = Number.isFinite(metadata.duration) && metadata.duration > 0
                ? Math.max(0, Math.min(1, elapsedSeconds / metadata.duration))
                : null;
            onProgress({
                phase: 'export',
                progress: timeProgress ?? (frameEstimate ? Math.min(1, processedFrames / frameEstimate) : 0),
                processedFrames,
                frameEstimate,
                elapsedSeconds,
                metadata,
                detection,
                skippedFrames,
                adaptiveFrames,
                seedFrames,
                aiDenoiseFrames,
                aiReuseFrames,
                alphaGain
            });
        }

        source.close();
        const audioResult = await audioCopyPromise;
        await output.finalize();

        if (!target.buffer) {
            throw new Error('视频导出失败，输出为空');
        }

        return {
            blob: new Blob([target.buffer], { type: 'video/mp4' }),
            metadata,
            detection,
            alphaGain,
            adaptiveAlpha,
            highQualityCleanup,
            denoiseBackend,
            edgeDenoiseStrength,
            allenkFdncnnPadding,
            textureRepair,
            textureRepairStrength,
            residualCleanupStrength,
            videoBitrate,
            preserveAudio: options.preserveAudio !== false,
            audioCopied: audioResult.copied,
            audioPacketCount: audioResult.packetCount,
            audioCodec: audioResult.codec,
            audioSkipReason: audioResult.skipReason,
            processedFrames,
            skippedFrames,
            adaptiveFrames,
            seedFrames,
            aiDenoiseFrames,
            aiReuseFrames
        };
    } catch (error) {
        if (output.state !== 'finalized' && output.state !== 'canceled') {
            await output.cancel().catch(() => {});
        }
        throw error;
    } finally {
        input.dispose();
    }
}

export function resolveExportAllenkFdncnnPadding(cleanupOptions = {}, detection = null) {
    if (Number.isFinite(cleanupOptions.allenkFdncnnPadding)) {
        return cleanupOptions.allenkFdncnnPadding;
    }
    if (cleanupOptions.denoiseBackend !== VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE) {
        return cleanupOptions.allenkFdncnnPadding;
    }
    return resolveAllenkFdncnnRuntimeProfile(detection?.position).padding;
}

export {
    DEFAULT_ADAPTIVE_ALPHA,
    DEFAULT_ALPHA_GAIN,
    DEFAULT_DENOISE_BACKEND,
    DEFAULT_EDGE_DENOISE_STRENGTH,
    DEFAULT_HIGH_QUALITY_CLEANUP,
    DEFAULT_RESIDUAL_CLEANUP_STRENGTH,
    DEFAULT_TEXTURE_REPAIR,
    DEFAULT_TEXTURE_REPAIR_STRENGTH,
    DEFAULT_VIDEO_BITRATE,
    VIDEO_DENOISE_BACKENDS,
    DEFAULT_SAMPLE_COUNT,
    canCopyAudioCodecToMp4,
    normalizePacketTimestamp
};

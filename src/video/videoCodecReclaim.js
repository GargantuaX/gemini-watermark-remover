import { CustomVideoEncoder, EncodedPacket, registerEncoder } from 'mediabunny';

const DEFAULT_MAX_CODEC_RECLAIM_RECOVERIES = 3;
const MAX_ENCODE_QUEUE_SIZE = 4;

// Chrome closes codecs that sit idle in a background tab: QuotaExceededError "Codec reclaimed due to inactivity."
export function isCodecReclaimedError(error) {
    if (!error) return false;
    return error.name === 'QuotaExceededError' || /codec reclaimed/i.test(String(error.message || ''));
}

/** One budget shared by the decoder and the encoder of an export. */
export function createCodecReclaimStats(maxRecoveries = DEFAULT_MAX_CODEC_RECLAIM_RECOVERIES) {
    return { recoveries: 0, maxRecoveries };
}

export function tryConsumeCodecReclaimRecovery(stats, error) {
    if (!stats || !isCodecReclaimedError(error) || stats.recoveries >= stats.maxRecoveries) return false;
    stats.recoveries++;
    return true;
}

function toBytes(description) {
    if (!description) return null;
    if (description instanceof ArrayBuffer) return new Uint8Array(description);
    return new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
}

function sameBytes(a, b) {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Builds the reclaim-aware AVC encoder on top of mediabunny's custom encoder API. mediabunny is passed in so tests
 * can supply stubs; exports use the instance below.
 */
export function createReclaimableVideoEncoding({ CustomVideoEncoder, EncodedPacket, registerEncoder }) {
    let activeReclaimStats = null;

    /**
     * Wraps the native VideoEncoder. When Chrome reclaims it, a fresh encoder is configured and every frame the
     * old one had not emitted yet is encoded again, starting with a key frame, so the output continues without a
     * gap. The MP4 track keeps the first encoder's avcC. A rebuilt encoder with different parameter sets (for
     * example a software fallback) would make the rest of the track undecodable, so that case fails the export.
     * Only the rebuilt encoder's first description is compared: some hardware encoders re-emit a slightly
     * different avcC mid-stream, which the muxer has always ignored.
     */
    class ReclaimableVideoEncoder extends CustomVideoEncoder {
        static supports(codec) {
            return codec === 'avc' && activeReclaimStats !== null && typeof VideoEncoder === 'function';
        }

        async init() {
            const { width, height } = this.config;
            if (width % 2 === 1 || height % 2 === 1) {
                throw new Error(`The dimensions ${width}x${height} are not supported for codec 'avc'; both width and height must be even numbers.`);
            }
            this.reclaimStats = activeReclaimStats;
            this.pendingFrames = [];
            this.error = null;
            this.trackDescription = null;
            this.checkRebuiltDescription = false;
            this.startEncoder();
        }

        startEncoder() {
            const current = { encoder: null, failed: null, markFailed: null };
            current.failed = new Promise((resolve) => { current.markFailed = resolve; });
            current.encoder = new VideoEncoder({
                output: (chunk, meta) => {
                    if (this.current === current) this.handleOutput(chunk, meta);
                },
                error: (error) => {
                    if (this.current === current) this.handleError(error);
                    current.markFailed();
                }
            });
            current.encoder.configure({ ...this.config, alpha: 'discard' });
            this.current = current;
        }

        handleError(error) {
            if (!tryConsumeCodecReclaimRecovery(this.reclaimStats, error)) {
                this.error ??= error;
                return;
            }
            try {
                this.startEncoder();
                this.checkRebuiltDescription = true;
                this.pendingFrames.forEach((frame, index) => {
                    this.current.encoder.encode(frame, { keyFrame: index === 0 });
                });
                this.forceKeyFrame = this.pendingFrames.length === 0;
            } catch (rebuildError) {
                this.error ??= rebuildError;
            }
        }

        handleOutput(chunk, meta) {
            if (this.error) return;
            while (this.pendingFrames.length > 0 && this.pendingFrames[0].timestamp <= chunk.timestamp) {
                this.pendingFrames.shift().close();
            }

            const description = toBytes(meta?.decoderConfig?.description);
            if (description) {
                const rebuiltDescriptionChanged = this.checkRebuiltDescription
                    && this.trackDescription
                    && !sameBytes(this.trackDescription, description);
                this.checkRebuiltDescription = false;
                if (!this.trackDescription) {
                    this.trackDescription = description.slice();
                } else if (rebuiltDescriptionChanged) {
                    this.error = new Error('Codec reclaimed due to inactivity; the rebuilt encoder changed the stream parameters.');
                    this.error.name = 'QuotaExceededError';
                    // close() does not run the error callback, so release anything waiting on this encoder.
                    this.current.encoder.close();
                    this.current.markFailed();
                    return;
                }
            }

            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            const packet = new EncodedPacket(data, chunk.type, chunk.timestamp / 1e6, (chunk.duration ?? 0) / 1e6);
            this.onPacket(packet, meta);
        }

        // A reclaimed encoder is already 'closed' before its error callback runs; wait for the rebuild.
        async waitForUsableEncoder() {
            while (!this.error && this.current.encoder.state === 'closed') {
                await this.current.failed;
            }
            if (this.error) throw this.error;
        }

        async encode(videoSample, options) {
            await this.waitForUsableEncoder();
            const frame = videoSample.toVideoFrame();
            const keyFrame = Boolean(options?.keyFrame || this.forceKeyFrame);
            this.forceKeyFrame = false;
            this.pendingFrames.push(frame);
            this.current.encoder.encode(frame, { ...options, keyFrame });

            while (this.current.encoder.state === 'configured' && this.current.encoder.encodeQueueSize >= MAX_ENCODE_QUEUE_SIZE) {
                const { encoder, failed } = this.current;
                await Promise.race([
                    new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true })),
                    failed
                ]);
            }
        }

        async flush() {
            while (true) {
                await this.waitForUsableEncoder();
                const current = this.current;
                try {
                    await current.encoder.flush();
                } catch (error) {
                    if (current.encoder.state !== 'closed') throw error;
                    await current.failed;
                    continue;
                }
                if (this.current === current) break;
            }
            if (this.error) throw this.error;
        }

        close() {
            if (this.current && this.current.encoder.state !== 'closed') this.current.encoder.close();
            for (const frame of this.pendingFrames ?? []) frame.close();
            this.pendingFrames = [];
        }
    }

    let encoderRegistered = false;

    /**
     * Routes AVC encoding through the reclaim-aware encoder until the returned function is called.
     * Exports run one at a time, so a single active budget is enough.
     */
    function beginReclaimableVideoEncoding(stats) {
        if (!encoderRegistered) {
            registerEncoder(ReclaimableVideoEncoder);
            encoderRegistered = true;
        }
        activeReclaimStats = stats;
        return () => {
            if (activeReclaimStats === stats) activeReclaimStats = null;
        };
    }

    return { ReclaimableVideoEncoder, beginReclaimableVideoEncoding };
}

export const { ReclaimableVideoEncoder, beginReclaimableVideoEncoding } = createReclaimableVideoEncoding({
    CustomVideoEncoder,
    EncodedPacket,
    registerEncoder
});

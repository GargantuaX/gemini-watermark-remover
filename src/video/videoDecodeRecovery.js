import { tryConsumeCodecReclaimRecovery } from './videoCodecReclaim.js';

const DEFAULT_MAX_DECODER_RECOVERIES = 2;

// WebKit reports "Decoder failure"; Chromium reports "Decoding error." or "Decoding task did not complete".
export function isRecoverableVideoDecodeError(error) {
    if (!error || error.name === 'AbortError') return false;
    return /\bdecod/i.test(String(error.message || ''));
}

export function createVideoDecodeStats() {
    return { recoveries: 0, lastTimestamp: null };
}

/**
 * Yields decoded samples like `sink.samples()`, but when the decoder fails mid-stream it opens a fresh sink
 * and resumes after the last sample it yielded. Hardware decoders (notably on iOS) can fail transiently;
 * a stream that fails again at the same point still throws once `maxRecoveries` is used up.
 * A decoder that Chrome reclaimed in a background tab resumes the same way, drawing on `codecReclaimStats`.
 */
export async function* iterateVideoSamplesWithDecoderRecovery(createSink, {
    stats = createVideoDecodeStats(),
    maxRecoveries = DEFAULT_MAX_DECODER_RECOVERIES,
    signal = null,
    onRecovery = null,
    codecReclaimStats = null
} = {}) {
    while (true) {
        const resumeAfter = stats.lastTimestamp;
        const sink = createSink();
        try {
            for await (const sample of sink.samples(resumeAfter ?? undefined)) {
                if (resumeAfter !== null && sample.timestamp <= resumeAfter) {
                    sample.close();
                    continue;
                }
                stats.lastTimestamp = sample.timestamp;
                yield sample;
            }
            return;
        } catch (error) {
            signal?.throwIfAborted();
            if (tryConsumeCodecReclaimRecovery(codecReclaimStats, error)) continue;
            if (!isRecoverableVideoDecodeError(error) || stats.recoveries >= maxRecoveries) {
                throw error;
            }
            stats.recoveries++;
            onRecovery?.({ recoveries: stats.recoveries, resumeAfter: stats.lastTimestamp, error });
        }
    }
}

export function attachVideoDecodeDiagnostics(error, stats, metadata) {
    if (!isRecoverableVideoDecodeError(error)) return error;
    const firstTimestamp = metadata?.firstTimestamp || 0;
    const diagnostics = {
        decoderRecoveries: stats.recoveries,
        decodeFailedAtSeconds: stats.lastTimestamp === null
            ? 0
            : Math.max(0, stats.lastTimestamp - firstTimestamp),
        videoCodec: metadata?.codec ?? null,
        videoWidth: metadata?.width ?? null,
        videoHeight: metadata?.height ?? null,
        videoAverageBitrate: metadata?.averageBitrate ?? null
    };
    try {
        Object.assign(error, diagnostics);
    } catch {
        // Some host errors are not extensible; the diagnostics are best-effort.
    }
    return error;
}

export { DEFAULT_MAX_DECODER_RECOVERIES };

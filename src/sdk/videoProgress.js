const DEFAULT_VIDEO_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_VIDEO_PROGRESS_POLL_INTERVAL_MS = 1000;
const DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS = 30_000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readVideoProgressSnapshot(page) {
    return page.evaluate(() => {
        const status = document.getElementById('status');
        const progressBar = document.getElementById('progressBar');
        const progressText = document.getElementById('progressText');
        const rawProgress = Number.parseFloat(progressBar?.style?.width || '');
        const runtimeProgress = globalThis.__gwrVideoCliProgress;

        return {
            tone: status?.dataset?.tone || '',
            status: status?.textContent || '',
            progressText: progressText?.textContent || '',
            progress: Number.isFinite(runtimeProgress?.progress)
                ? Math.max(0, Math.min(1, runtimeProgress.progress))
                : Number.isFinite(rawProgress)
                    ? Math.max(0, Math.min(1, rawProgress / 100))
                    : null,
            phase: runtimeProgress?.phase || null,
            processedFrames: Number.isFinite(runtimeProgress?.processedFrames)
                ? runtimeProgress.processedFrames
                : null,
            frameEstimate: Number.isFinite(runtimeProgress?.frameEstimate)
                ? runtimeProgress.frameEstimate
                : null,
            aiDenoiseFrames: Number.isFinite(runtimeProgress?.aiDenoiseFrames)
                ? runtimeProgress.aiDenoiseFrames
                : null,
            aiReuseFrames: Number.isFinite(runtimeProgress?.aiReuseFrames)
                ? runtimeProgress.aiReuseFrames
                : null
        };
    });
}

function describeProgress(snapshot) {
    return [snapshot?.progressText, snapshot?.status]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(' - ');
}

function configureVideoPageTimeouts(page) {
    page.setDefaultTimeout(DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS);
}

async function waitForVideoProcessing(page, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_VIDEO_TIMEOUT_MS;
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs >= 0
        ? options.pollIntervalMs
        : DEFAULT_VIDEO_PROGRESS_POLL_INTERVAL_MS;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const sleep = typeof options.sleep === 'function' ? options.sleep : delay;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const startedAt = now();
    let lastActivityAt = startedAt;
    let lastSnapshotKey = null;

    while (true) {
        const snapshot = await readVideoProgressSnapshot(page);
        const elapsedMs = Math.max(0, now() - startedAt);
        const result = { ...snapshot, elapsedMs };
        const snapshotKey = JSON.stringify(snapshot);
        if (snapshotKey !== lastSnapshotKey) {
            lastActivityAt = now();
            lastSnapshotKey = snapshotKey;
            onProgress(result);
        }

        if (snapshot.tone === 'success' || snapshot.tone === 'error') {
            return result;
        }

        const inactiveMs = Math.max(0, now() - lastActivityAt);
        if (inactiveMs >= timeoutMs) {
            const detail = describeProgress(snapshot);
            const timeoutLabel = timeoutMs < 1000
                ? `${Math.round(timeoutMs)} ms`
                : `${Math.round(timeoutMs / 1000)} seconds`;
            throw new Error(
                `Video processing made no progress for ${timeoutLabel}${detail ? ` at ${detail}` : ''}. ` +
                'Increase --video-timeout-ms for unusually long files.'
            );
        }

        await sleep(Math.min(pollIntervalMs, Math.max(0, timeoutMs - inactiveMs)));
    }
}

export {
    DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS,
    DEFAULT_VIDEO_PROGRESS_POLL_INTERVAL_MS,
    DEFAULT_VIDEO_TIMEOUT_MS,
    configureVideoPageTimeouts,
    describeProgress,
    waitForVideoProcessing
};

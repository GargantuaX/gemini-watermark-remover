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
    const sampledFrameRate = Number.isFinite(packetStats?.averagePacketRate)
        && packetStats.averagePacketRate > 0
        ? packetStats.averagePacketRate
        : null;
    const frameRate = sampledFrameRate || 30;
    const frameCountEstimate = Number.isFinite(duration) && duration > 0 && sampledFrameRate
        ? Math.max(1, Math.round(duration * sampledFrameRate))
        : null;

    return {
        width,
        height,
        firstTimestamp: Number.isFinite(firstTimestamp) ? firstTimestamp : 0,
        duration: Number.isFinite(duration) ? duration : null,
        codec,
        frameRate,
        frameCountEstimate,
        averageBitrate: packetStats?.averageBitrate || null
    };
}

export { resolveVideoMetadata };

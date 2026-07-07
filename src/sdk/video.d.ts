export interface VideoRemovalMeta {
    status?: string;
    denoiseBackend?: string;
    actualDenoiseBackend?: string;
    actualControls?: Record<string, unknown>;
    pagePath?: string;
    [key: string]: unknown;
}

export interface VideoFileProcessorContext {
    outputPath?: string | null;
    mimeType: string;
    filePath: string;
    pagePath?: string;
    denoiseBackend?: string;
    allowLowConfidence?: boolean;
    timeoutMs?: number;
    edgeDenoiseStrength?: number;
    residualCleanupStrength?: number;
    videoBitrate?: number;
    adaptiveAlpha?: boolean;
    alphaGain?: number;
    alphaProfile?: string;
}

export interface VideoBufferProcessorContext extends Omit<VideoFileProcessorContext, 'filePath'> {
    filePath?: string;
}

export interface VideoProcessorResult {
    buffer?: Buffer | Uint8Array | ArrayBuffer;
    meta?: VideoRemovalMeta | null;
}

export interface VideoFileRemovalOptions {
    outputPath?: string | null;
    mimeType?: string;
    pagePath?: string;
    denoiseBackend?: string;
    allowLowConfidence?: boolean;
    timeoutMs?: number;
    edgeDenoiseStrength?: number;
    residualCleanupStrength?: number;
    videoBitrate?: number;
    adaptiveAlpha?: boolean;
    alphaGain?: number;
    alphaProfile?: string;
    processVideoFile?: (
        inputPath: string,
        context: VideoFileProcessorContext
    ) => Promise<VideoProcessorResult> | VideoProcessorResult;
}

export interface VideoBufferRemovalOptions extends VideoBufferProcessorContext {
    processVideoBuffer: (
        inputBuffer: Buffer,
        context: VideoBufferProcessorContext
    ) => Promise<VideoProcessorResult> | VideoProcessorResult;
}

export interface VideoFileRemovalResult {
    buffer: Buffer;
    outputPath: string | null;
    mimeType: string;
    meta: VideoRemovalMeta | null;
}

export interface VideoBufferRemovalResult {
    buffer: Buffer;
    mimeType: string;
    meta: VideoRemovalMeta | null;
}

export function inferVideoMimeTypeFromPath(filePath: string): string;
export function isVideoMimeType(mimeType: string): boolean;
export function resolveDefaultVideoPreviewPage(options?: {
    moduleUrl?: string | URL;
}): string;
export function withLocalVideoPreviewPage<T>(
    pagePath: string,
    callback: (
        pageUrl: string,
        context: {
            served: boolean;
            server: unknown | null;
        }
    ) => Promise<T> | T
): Promise<T>;
export function removeVideoWatermarkFromFile(
    inputPath: string,
    options?: VideoFileRemovalOptions
): Promise<VideoFileRemovalResult>;
export function removeVideoWatermarkFromBuffer(
    inputBuffer: Buffer | Uint8Array | ArrayBuffer,
    options: VideoBufferRemovalOptions
): Promise<VideoBufferRemovalResult>;

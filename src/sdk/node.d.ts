import type { ImageDataRemovalResult, RemoveOptions, WatermarkMeta } from './index.js';

export interface NodeCodecContext {
    mimeType: string;
    filePath?: string;
    meta?: WatermarkMeta;
}

export interface NodeBufferRemovalOptions extends Omit<RemoveOptions, 'engine'> {
    mimeType?: string;
    filePath?: string;
    decodeImageData: (
        input: Buffer | Uint8Array | ArrayBuffer,
        context: NodeCodecContext
    ) => Promise<ImageDataRemovalResult['imageData']> | ImageDataRemovalResult['imageData'];
    encodeImageData: (
        imageData: ImageDataRemovalResult['imageData'],
        context: NodeCodecContext
    ) => Promise<Buffer | Uint8Array | ArrayBuffer> | Buffer | Uint8Array | ArrayBuffer;
}

export interface NodeFileRemovalOptions extends NodeBufferRemovalOptions {
    outputPath?: string | null;
}

export interface NodeBufferRemovalResult extends ImageDataRemovalResult {
    buffer: Buffer;
}

export interface NodeFileRemovalResult extends NodeBufferRemovalResult {
    outputPath: string | null;
}

export function inferMimeTypeFromPath(filePath: string): string;
export function removeWatermarkFromBuffer(
    inputBuffer: Buffer | Uint8Array | ArrayBuffer,
    options: NodeBufferRemovalOptions
): Promise<NodeBufferRemovalResult>;
export function removeWatermarkFromFile(
    inputPath: string,
    options: NodeFileRemovalOptions
): Promise<NodeFileRemovalResult>;

export interface WatermarkPosition {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WatermarkConfig {
    logoSize: number;
    marginRight: number;
    marginBottom: number;
}

export interface WatermarkDetectionMeta {
    adaptiveConfidence: number | null;
    originalSpatialScore: number | null;
    originalGradientScore: number | null;
    processedSpatialScore: number | null;
    processedGradientScore: number | null;
    suppressionGain: number | null;
}

export interface WatermarkMeta {
    applied: boolean;
    skipReason: string | null;
    size: number | null;
    position: WatermarkPosition | null;
    config: WatermarkConfig | null;
    detection: WatermarkDetectionMeta;
    source: string;
    decisionTier: string | null;
    alphaGain: number;
    passCount: number;
    attemptedPassCount: number;
    passStopReason: string | null;
}

export interface RemoveOptions {
    adaptiveMode?: 'auto' | 'always' | 'never' | 'off';
    maxPasses?: number;
    engine?: WatermarkEngine;
    alpha48?: Float32Array;
    alpha96?: Float32Array;
    getAlphaMap?: (size: number) => Float32Array;
}

export interface ImageDataRemovalResult {
    imageData: ImageData | {
        width: number;
        height: number;
        data: Uint8ClampedArray;
    };
    meta: WatermarkMeta;
}

export interface ImageRemovalResult {
    canvas: OffscreenCanvas | HTMLCanvasElement;
    meta: WatermarkMeta | null;
}

export class WatermarkEngine {
    static create(): Promise<WatermarkEngine>;
    getAlphaMap(size: number): Promise<Float32Array>;
    removeWatermarkFromImage(
        image: HTMLImageElement | HTMLCanvasElement,
        options?: Omit<RemoveOptions, 'engine'>
    ): Promise<OffscreenCanvas | HTMLCanvasElement>;
    getWatermarkInfo(imageWidth: number, imageHeight: number): {
        size: number;
        position: WatermarkPosition;
        config: WatermarkConfig;
    };
}

export function createWatermarkEngine(): Promise<WatermarkEngine>;
export function removeWatermarkFromImage(
    image: HTMLImageElement | HTMLCanvasElement,
    options?: RemoveOptions
): Promise<ImageRemovalResult>;
export function removeWatermarkFromImageData(
    imageData: ImageData | { width: number; height: number; data: Uint8ClampedArray },
    options?: RemoveOptions
): Promise<ImageDataRemovalResult>;
export function removeWatermarkFromImageDataSync(
    imageData: ImageData | { width: number; height: number; data: Uint8ClampedArray },
    options?: Omit<RemoveOptions, 'engine'>
): ImageDataRemovalResult;
export function detectWatermarkConfig(imageWidth: number, imageHeight: number): WatermarkConfig;
export function calculateWatermarkPosition(
    imageWidth: number,
    imageHeight: number,
    config: WatermarkConfig
): WatermarkPosition;
export function removeRepeatedWatermarkLayers(...args: unknown[]): unknown;

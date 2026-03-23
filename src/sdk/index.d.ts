export interface WatermarkPosition {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ImageDataLike {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

export interface BrowserImageLike {
    width: number;
    height: number;
}

export interface BrowserCanvasLike extends BrowserImageLike {
    getContext(contextId: string, options?: unknown): unknown;
}

type GlobalHtmlImageElementLike = typeof globalThis extends {
    HTMLImageElement: { prototype: infer TPrototype }
}
    ? TPrototype
    : BrowserImageLike;

type GlobalHtmlCanvasElementLike = typeof globalThis extends {
    HTMLCanvasElement: { prototype: infer TPrototype }
}
    ? TPrototype
    : BrowserCanvasLike;

type GlobalOffscreenCanvasLike = typeof globalThis extends {
    OffscreenCanvas: { prototype: infer TPrototype }
}
    ? TPrototype
    : BrowserCanvasLike;

export type BrowserImageInput = GlobalHtmlImageElementLike | GlobalHtmlCanvasElementLike;
export type BrowserCanvasOutput = GlobalOffscreenCanvasLike | GlobalHtmlCanvasElementLike;

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

export interface WatermarkSelectionDebug {
    candidateSource: string | null;
    texturePenalty: number | null;
    tooDark: boolean;
    tooFlat: boolean;
    hardReject: boolean;
    usedSizeJitter: boolean;
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
    selectionDebug?: WatermarkSelectionDebug | null;
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
    imageData: ImageDataLike;
    meta: WatermarkMeta;
}

export interface ImageRemovalResult {
    canvas: BrowserCanvasOutput;
    meta: WatermarkMeta | null;
}

export class WatermarkEngine {
    static create(): Promise<WatermarkEngine>;
    getAlphaMap(size: number): Promise<Float32Array>;
    removeWatermarkFromImage(
        image: BrowserImageInput,
        options?: Omit<RemoveOptions, 'engine'>
    ): Promise<BrowserCanvasOutput>;
    getWatermarkInfo(imageWidth: number, imageHeight: number): {
        size: number;
        position: WatermarkPosition;
        config: WatermarkConfig;
    };
}

export function createWatermarkEngine(): Promise<WatermarkEngine>;
export function removeWatermarkFromImage(
    image: BrowserImageInput,
    options?: RemoveOptions
): Promise<ImageRemovalResult>;
export function removeWatermarkFromImageData(
    imageData: ImageDataLike,
    options?: RemoveOptions
): Promise<ImageDataRemovalResult>;
export function removeWatermarkFromImageDataSync(
    imageData: ImageDataLike,
    options?: Omit<RemoveOptions, 'engine'>
): ImageDataRemovalResult;
export function detectWatermarkConfig(imageWidth: number, imageHeight: number): WatermarkConfig;
export function calculateWatermarkPosition(
    imageWidth: number,
    imageHeight: number,
    config: WatermarkConfig
): WatermarkPosition;
export function removeRepeatedWatermarkLayers(...args: unknown[]): unknown;

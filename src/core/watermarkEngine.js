/**
 * Watermark engine main module
 * Coordinate watermark detection, alpha map calculation, and removal operations
 */

import { calculateAlphaMap } from './alphaMap.js';
import { removeWatermark } from './blendModes.js';
import {
    detectAdaptiveWatermarkRegion,
    interpolateAlphaMap,
    shouldAttemptAdaptiveFallback
} from './adaptiveDetector.js';
import BG_48_PATH from '../assets/bg_48.png';
import BG_96_PATH from '../assets/bg_96.png';

/**
 * Detect watermark configuration based on image size
 * @param {number} imageWidth - Image width
 * @param {number} imageHeight - Image height
 * @returns {Object} Watermark configuration {logoSize, marginRight, marginBottom}
 */
export function detectWatermarkConfig(imageWidth, imageHeight) {
    // Gemini's watermark rules:
    // If both image width and height are greater than 1024, use 96×96 watermark
    // Otherwise, use 48×48 watermark
    if (imageWidth > 1024 && imageHeight > 1024) {
        return {
            logoSize: 96,
            marginRight: 64,
            marginBottom: 64
        };
    } else {
        return {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        };
    }
}

/**
 * Calculate watermark position in image based on image size and watermark configuration
 * @param {number} imageWidth - Image width
 * @param {number} imageHeight - Image height
 * @param {Object} config - Watermark configuration {logoSize, marginRight, marginBottom}
 * @returns {Object} Watermark position {x, y, width, height}
 */
export function calculateWatermarkPosition(imageWidth, imageHeight, config) {
    const { logoSize, marginRight, marginBottom } = config;

    return {
        x: imageWidth - marginRight - logoSize,
        y: imageHeight - marginBottom - logoSize,
        width: logoSize,
        height: logoSize
    };
}

/**
 * Watermark engine class
 * Coordinate watermark detection, alpha map calculation, and removal operations
 */
export class WatermarkEngine {
    constructor(bgCaptures) {
        this.bgCaptures = bgCaptures;
        this.alphaMaps = {};
    }

    static async create() {
        const bg48 = new Image();
        const bg96 = new Image();

        await Promise.all([
            new Promise((resolve, reject) => {
                bg48.onload = resolve;
                bg48.onerror = reject;
                bg48.src = BG_48_PATH;
            }),
            new Promise((resolve, reject) => {
                bg96.onload = resolve;
                bg96.onerror = reject;
                bg96.src = BG_96_PATH;
            })
        ]);

        return new WatermarkEngine({ bg48, bg96 });
    }

    /**
     * Get alpha map from background captured image based on watermark size
     * @param {number} size - Watermark size (48 or 96)
     * @returns {Promise<Float32Array>} Alpha map
     */
    async getAlphaMap(size) {
        // For non-standard watermark size, interpolate from 96x96 alpha map.
        if (size !== 48 && size !== 96) {
            if (this.alphaMaps[size]) return this.alphaMaps[size];
            const alpha96 = await this.getAlphaMap(96);
            const interpolated = interpolateAlphaMap(alpha96, 96, size);
            this.alphaMaps[size] = interpolated;
            return interpolated;
        }

        // If cached, return directly
        if (this.alphaMaps[size]) {
            return this.alphaMaps[size];
        }

        // Select corresponding background capture based on watermark size
        const bgImage = size === 48 ? this.bgCaptures.bg48 : this.bgCaptures.bg96;

        // Create temporary canvas to extract ImageData
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bgImage, 0, 0);

        const imageData = ctx.getImageData(0, 0, size, size);

        // Calculate alpha map
        const alphaMap = calculateAlphaMap(imageData);

        // Cache result
        this.alphaMaps[size] = alphaMap;

        return alphaMap;
    }

    /**
     * Remove watermark from image based on watermark size
     * @param {HTMLImageElement|HTMLCanvasElement} image - Input image
     * @returns {Promise<HTMLCanvasElement>} Processed canvas
     */
    async removeWatermarkFromImage(image, options = {}) {
        const adaptiveMode = options.adaptiveMode || 'auto';

        // Create canvas to process image
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');

        // Draw original image onto canvas
        ctx.drawImage(image, 0, 0);

        // Get image data
        const originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Detect watermark configuration
        const config = detectWatermarkConfig(canvas.width, canvas.height);
        let position = calculateWatermarkPosition(canvas.width, canvas.height, config);
        let alphaMap = await this.getAlphaMap(config.logoSize);

        // First pass: keep the fast fixed-rule path.
        const fixedImageData = new ImageData(
            new Uint8ClampedArray(originalImageData.data),
            originalImageData.width,
            originalImageData.height
        );
        removeWatermark(fixedImageData, alphaMap, position);

        let finalImageData = fixedImageData;
        const shouldFallback = adaptiveMode === 'always'
            ? true
            : shouldAttemptAdaptiveFallback({
                processedImageData: fixedImageData,
                alphaMap,
                position,
                originalImageData,
                originalSpatialMismatchThreshold: 0
            });

        // Fallback: run adaptive search only when residual signal remains high.
        if (shouldFallback) {
            const alpha96 = await this.getAlphaMap(96);
            const adaptive = detectAdaptiveWatermarkRegion({
                imageData: originalImageData,
                alpha96,
                defaultConfig: config
            });

            if (adaptive.found) {
                const size = adaptive.region.size;
                const adaptivePosition = {
                    x: adaptive.region.x,
                    y: adaptive.region.y,
                    width: size,
                    height: size
                };
                const positionDelta =
                    Math.abs(adaptivePosition.x - position.x) +
                    Math.abs(adaptivePosition.y - position.y) +
                    Math.abs(adaptivePosition.width - position.width);

                // Re-run on original pixels only when adaptive result differs materially.
                if (positionDelta >= 4) {
                    position = adaptivePosition;
                    alphaMap = await this.getAlphaMap(size);
                    const adaptiveImageData = new ImageData(
                        new Uint8ClampedArray(originalImageData.data),
                        originalImageData.width,
                        originalImageData.height
                    );
                    removeWatermark(adaptiveImageData, alphaMap, position);
                    finalImageData = adaptiveImageData;
                }
            }
        }

        // Write processed image data back to canvas
        ctx.putImageData(finalImageData, 0, 0);

        return canvas;
    }

    /**
     * Get watermark information (for display)
     * @param {number} imageWidth - Image width
     * @param {number} imageHeight - Image height
     * @returns {Object} Watermark information {size, position, config}
     */
    getWatermarkInfo(imageWidth, imageHeight) {
        const config = detectWatermarkConfig(imageWidth, imageHeight);
        const position = calculateWatermarkPosition(imageWidth, imageHeight, config);

        return {
            size: config.logoSize,
            position: position,
            config: config
        };
    }
}

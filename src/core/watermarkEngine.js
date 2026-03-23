/**
 * Watermark engine main module
 * Coordinate watermark detection, alpha map calculation, and removal operations
 */

import { getEmbeddedAlphaMap } from './embeddedAlphaMaps.js';
import { removeRepeatedWatermarkLayers } from './multiPassRemoval.js';
import { processWatermarkImageData } from './watermarkProcessor.js';
import {
    interpolateAlphaMap,
} from './adaptiveDetector.js';
import {
    detectWatermarkConfig,
    calculateWatermarkPosition,
} from './watermarkConfig.js';
export { detectWatermarkConfig, calculateWatermarkPosition } from './watermarkConfig.js';

function createRuntimeCanvas(width, height) {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height);
    }

/**
 * Detect watermark configuration based on image size
 * @param {number} imageWidth - Image width
 * @param {number} imageHeight - Image height
 * @returns {Object} Watermark configuration {logoSize, marginRight, marginBottom}
 */
function detectWatermarkConfig(imageWidth, imageHeight) {
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

    throw new Error('Canvas runtime not available');
}

/**
 * Calculate watermark position in image based on image size and watermark configuration
 * @param {number} imageWidth - Image width
 * @param {number} imageHeight - Image height
 * @param {Object} config - Watermark configuration {logoSize, marginRight, marginBottom}
 * @returns {Object} Watermark position {x, y, width, height}
 */
function calculateWatermarkPosition(imageWidth, imageHeight, config) {
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
    constructor() {
        this.alphaMaps = {};
    }

    static async create() {
        return new WatermarkEngine();
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

        const alphaMap = getEmbeddedAlphaMap(size);
        if (!alphaMap) {
            throw new Error(`Missing embedded alpha map for size ${size}`);
        }

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
        const canvas = createRuntimeCanvas(image.width, image.height);
        const ctx = getCanvasContext2D(canvas);
        ctx.drawImage(image, 0, 0);
        const originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const alpha48 = await this.getAlphaMap(48);
        const alpha96 = await this.getAlphaMap(96);
        const result = processWatermarkImageData(originalImageData, {
            alpha48,
            alpha96,
            adaptiveMode: options.adaptiveMode,
            maxPasses: options.maxPasses,
            getAlphaMap: (size) => this.alphaMaps[size] || interpolateAlphaMap(alpha96, 96, size)
        });
        ctx.putImageData(result.imageData, 0, 0);
        canvas.__watermarkMeta = result.meta;

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

export { removeRepeatedWatermarkLayers } from './multiPassRemoval.js';

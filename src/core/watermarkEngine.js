/**
 * Watermark engine main module
 * Coordinate watermark detection, alpha map calculation, and removal operations
 */

import { calculateAlphaMap } from './alphaMap.js';
import { removeWatermark } from './blendModes.js';
import BG_48_PATH from '../assets/bg_48.png';
import BG_96_PATH from '../assets/bg_96.png';

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
    async removeWatermarkFromImage(image) {
        // Create canvas to process image
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');

        // Draw original image onto canvas
        ctx.drawImage(image, 0, 0);

        // Get image data
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Detect watermark configuration
        const config = detectWatermarkConfig(canvas.width, canvas.height);
        const position = calculateWatermarkPosition(canvas.width, canvas.height, config);

        // Get alpha map for watermark size
        const alphaMap = await this.getAlphaMap(config.logoSize);

        // Remove watermark from image data
        removeWatermark(imageData, alphaMap, position);

        // Write processed image data back to canvas
        ctx.putImageData(imageData, 0, 0);

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

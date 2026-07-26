/**
 * Reverse alpha blending module
 * Core algorithm for removing watermarks
 */

// Constants definition
// Constants definition
const ALPHA_NOISE_FLOOR = 0; // Process all low-level quantization alpha map values
const ALPHA_THRESHOLD = 0.00001; // Denoised alpha activation threshold
const MAX_ALPHA = 0.99;            // Avoid division by near-zero values
const LOGO_VALUE = 255;            // Color value for white watermark

function applyHybridInpainting(imageData, position, logoSize, alphaMap) {
    try {
        if (!imageData || !imageData.data || !position || typeof position.width !== 'number' || typeof position.height !== 'number' || position.width <= 0 || position.height <= 0) return;
        const w = imageData.width;
        const h = imageData.height;
        if (!w || !h) return;
        const maskW = Math.floor(position.width);
        const maskH = Math.floor(position.height);
        if (maskW <= 0 || maskH <= 0 || !alphaMap || alphaMap.length < maskW * maskH) return;

        const edgeMask = new Float32Array(maskW * maskH);
        const pad = logoSize >= 96 ? 3 : 2;

        for (let y = 1; y < maskH - 1; y++) {
            for (let x = 1; x < maskW - 1; x++) {
                const idx = y * maskW + x;
                const val = Math.abs(alphaMap[idx]);
                const nUp = Math.abs(alphaMap[(y - 1) * maskW + x]);
                const nDown = Math.abs(alphaMap[(y + 1) * maskW + x]);
                const nLeft = Math.abs(alphaMap[y * maskW + (x - 1)]);
                const nRight = Math.abs(alphaMap[y * maskW + (x + 1)]);
                const diff = Math.max(Math.abs(val - nUp), Math.abs(val - nDown), Math.abs(val - nLeft), Math.abs(val - nRight));

                if ((diff >= 0.005 || (val >= 0.008 && val <= 0.65))) {
                    edgeMask[idx] = Math.max(diff * 2.5, val * 0.85);
                }
            }
        }

        const dilMask = new Float32Array(maskW * maskH);
        for (let y = 0; y < maskH; y++) {
            for (let x = 0; x < maskW; x++) {
                let maxVal = 0;
                for (let dy = -pad; dy <= pad; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= maskH) continue;
                    for (let dx = -pad; dx <= pad; dx++) {
                        const nx = x + dx;
                        if (nx < 0 || nx >= maskW) continue;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist <= pad) {
                            const v = edgeMask[ny * maskW + nx];
                            if (v > maxVal) maxVal = v;
                        }
                    }
                }
                dilMask[y * maskW + x] = maxVal;
            }
        }

        const changes = [];
        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
        for (let y = 0; y < maskH; y++) {
            const iy = position.y + y;
            if (iy < 0 || iy >= h) continue;
            for (let x = 0; x < maskW; x++) {
                const ix = position.x + x;
                if (ix < 0 || ix >= w) continue;
                const edgeVal = dilMask[y * maskW + x];
                if (edgeVal <= 0.005) continue;

                const idx = (iy * w + ix) * 4;
                const blend = Math.min(0.85, edgeVal * 1.5);

                let rSum = 0;
                let gSum = 0;
                let bSum = 0;
                let wSum = 0;
                for (let d = 0; d < dirs.length; d++) {
                    const stepX = dirs[d][0];
                    const stepY = dirs[d][1];
                    const sampleX = ix + stepX * 2;
                    const sampleY = iy + stepY * 2;
                    if (sampleX >= 0 && sampleX < w && sampleY >= 0 && sampleY < h) {
                        const localY = sampleY - position.y;
                        const localX = sampleX - position.x;
                        const isEdge = (localX >= 0 && localX < maskW && localY >= 0 && localY < maskH) ? (dilMask[localY * maskW + localX] > 0.005) : false;
                        if (!isEdge) {
                            const sIdx = (sampleY * w + sampleX) * 4;
                            const weight = 1.0;
                            rSum += imageData.data[sIdx] * weight;
                            gSum += imageData.data[sIdx + 1] * weight;
                            bSum += imageData.data[sIdx + 2] * weight;
                            wSum += weight;
                        }
                    }
                }

                if (wSum > 0) {
                    const inpR = rSum / wSum;
                    const inpG = gSum / wSum;
                    const inpB = bSum / wSum;
                    changes.push({
                        idx,
                        r: Math.round(imageData.data[idx] * (1 - blend) + inpR * blend),
                        g: Math.round(imageData.data[idx + 1] * (1 - blend) + inpG * blend),
                        b: Math.round(imageData.data[idx + 2] * (1 - blend) + inpB * blend)
                    });
                }
            }
        }
        for (let i = 0; i < changes.length; i++) {
            const change = changes[i];
            imageData.data[change.idx] = change.r;
            imageData.data[change.idx + 1] = change.g;
            imageData.data[change.idx + 2] = change.b;
        }
    } catch (err) {
        // Fail-safe: prevent processing error from breaking the extension
    }
}

/**
 * Remove watermark using reverse alpha blending
 *
 * Principle:
 * Gemini adds watermark: watermarked = α × logo + (1 - α) × original
 * Reverse solve: original = (watermarked - α × logo) / (1 - α)
 *
 * @param {ImageData} imageData - Image data to process (will be modified in place)
 * @param {Float32Array} alphaMap - Alpha channel data
 * @param {Object} position - Watermark position {x, y, width, height}
 * @param {Object} [options] - Optional settings
 * @param {number} [options.alphaGain=1] - Gain multiplier for alpha map strength
 */
export function removeWatermark(imageData, alphaMap, position, options = {}) {
    const { x, y, width, height } = position;
    const alphaGain = Number.isFinite(options.alphaGain) && options.alphaGain > 0
        ? options.alphaGain
        : 1;

    // Process each pixel in the watermark area
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            // Calculate index in original image (RGBA format, 4 bytes per pixel)
            const imgIdx = ((y + row) * imageData.width + (x + col)) * 4;

            // Calculate index in alpha map
            const alphaIdx = row * width + col;

            // Get alpha value. A negative alpha map marks a dark-polarity
            // watermark: same opacity mask, black logo value.
            const rawAlpha = alphaMap[alphaIdx];
            const alphaMagnitude = Math.abs(rawAlpha);
            const logoValue = Number.isFinite(options.logoValue)
                ? options.logoValue
                : (rawAlpha < 0 ? 0 : LOGO_VALUE);

            // Remove low-level alpha noise from compressed background capture.
            const signalAlpha = Math.max(0, alphaMagnitude - ALPHA_NOISE_FLOOR) * alphaGain;

            // Skip very small alpha values (noise)
            if (signalAlpha < ALPHA_THRESHOLD) {
                continue;
            }

            // Use original alpha for inverse solve; use denoised alpha as activation signal.
            const alpha = Math.min(alphaMagnitude * alphaGain, MAX_ALPHA);
            const oneMinusAlpha = 1.0 - alpha;

            // Apply reverse alpha blending to each RGB channel
            for (let c = 0; c < 3; c++) {
                const watermarked = imageData.data[imgIdx + c];

                // Reverse alpha blending formula
                const original = (watermarked - alpha * logoValue) / oneMinusAlpha;

                // Clip to [0, 255] range
                imageData.data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
            }

            // Alpha channel remains unchanged
            // imageData.data[imgIdx + 3] does not need modification
        }
    }

    // Apply edge-only texture smoothing along the watermark perimeter to eliminate residual fringe lines
    applyHybridInpainting(imageData, position, position.width, alphaMap);
}

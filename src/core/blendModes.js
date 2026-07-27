/**
 * Reverse alpha blending module
 * Core algorithm for removing watermarks
 */

// Constants definition
// Constants definition
const ALPHA_NOISE_FLOOR = 3 / 255; // Remove low-level quantization noise from alpha map
const ALPHA_THRESHOLD = 0.002;     // Ignore very small alpha values after noise floor removaleshold
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

        // Step 1: Find boundary pixels - the transition zone where the watermark fades out.
        // These are pixels with low-to-moderate alpha that sit near a sharp alpha transition.
        const boundaryStrength = new Float32Array(maskW * maskH);

        for (let y = 1; y < maskH - 1; y++) {
            for (let x = 1; x < maskW - 1; x++) {
                const idx = y * maskW + x;
                const val = Math.abs(alphaMap[idx]);

                // Skip completely unaffected pixels and well-corrected interior pixels
                if (val < 0.001 || val > 0.15) continue;

                // Compute gradient: how much alpha changes across neighbors
                let maxNeighbor = 0;
                let minNeighbor = 1.0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const ny = y + dy;
                        const nx = x + dx;
                        if (ny >= 0 && ny < maskH && nx >= 0 && nx < maskW) {
                            const na = Math.abs(alphaMap[ny * maskW + nx]);
                            if (na > maxNeighbor) maxNeighbor = na;
                            if (na < minNeighbor) minNeighbor = na;
                        }
                    }
                }

                // Boundary condition: significant gradient OR low alpha near high-alpha region
                const gradient = maxNeighbor - minNeighbor;
                const nearStrongEdge = maxNeighbor >= 0.04 && val < 0.12;
                const hasGradient = gradient >= 0.01;

                if (nearStrongEdge || hasGradient) {
                    // Stronger correction for pixels closer to zero-alpha (more residue)
                    const strength = Math.min(1.0, val * 12.0 + gradient * 6.0);
                    boundaryStrength[idx] = strength;
                }
            }
        }

        // Step 2: Dilate by 3px with distance falloff
        const dilMask = new Float32Array(maskW * maskH);
        const pad = 3;
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
                            const v = boundaryStrength[ny * maskW + nx];
                            const falloff = 1.0 - (dist / (pad + 1));
                            const scaled = v * falloff;
                            if (scaled > maxVal) maxVal = scaled;
                        }
                    }
                }
                dilMask[y * maskW + x] = maxVal;
            }
        }

        // Step 3: Two-pass inpainting from clean neighbors
        for (let pass = 0; pass < 2; pass++) {
            const changes = [];
            const baseDist = 4 + pass;
            const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

            for (let y = 0; y < maskH; y++) {
                const iy = position.y + y;
                if (iy < 0 || iy >= h) continue;
                for (let x = 0; x < maskW; x++) {
                    const ix = position.x + x;
                    if (ix < 0 || ix >= w) continue;
                    const edgeVal = dilMask[y * maskW + x];
                    if (edgeVal <= 0.01) continue;

                    const pixIdx = (iy * w + ix) * 4;
                    const blend = Math.min(0.92, edgeVal * 2.0);

                    let rSum = 0;
                    let gSum = 0;
                    let bSum = 0;
                    let wSum = 0;
                    for (let d = 0; d < dirs.length; d++) {
                        const stepX = dirs[d][0];
                        const stepY = dirs[d][1];
                        for (let dist = baseDist; dist <= baseDist + 2; dist++) {
                            const sx = ix + stepX * dist;
                            const sy = iy + stepY * dist;
                            if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
                                const localY = sy - position.y;
                                const localX = sx - position.x;
                                const sampleAlpha = (localX >= 0 && localX < maskW && localY >= 0 && localY < maskH) ? Math.abs(alphaMap[localY * maskW + localX]) : 0;
                                const sampleEdge = (localX >= 0 && localX < maskW && localY >= 0 && localY < maskH) ? dilMask[localY * maskW + localX] : 0;
                                // Only sample from truly clean pixels
                                if (sampleAlpha < 0.003 && sampleEdge < 0.01) {
                                    const sIdx = (sy * w + sx) * 4;
                                    const weight = 1.0 / dist;
                                    rSum += imageData.data[sIdx] * weight;
                                    gSum += imageData.data[sIdx + 1] * weight;
                                    bSum += imageData.data[sIdx + 2] * weight;
                                    wSum += weight;
                                }
                            }
                        }
                    }

                    if (wSum > 0) {
                        const inpR = rSum / wSum;
                        const inpG = gSum / wSum;
                        const inpB = bSum / wSum;
                        changes.push({
                            idx: pixIdx,
                            r: Math.round(imageData.data[pixIdx] * (1 - blend) + inpR * blend),
                            g: Math.round(imageData.data[pixIdx + 1] * (1 - blend) + inpG * blend),
                            b: Math.round(imageData.data[pixIdx + 2] * (1 - blend) + inpB * blend)
                        });
                    }
                }
            }
            for (let i = 0; i < changes.length; i++) {
                const c = changes[i];
                imageData.data[c.idx] = c.r;
                imageData.data[c.idx + 1] = c.g;
                imageData.data[c.idx + 2] = c.b;
            }
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
}

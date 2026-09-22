import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';
import { loadLocalEnv } from './local-env.js';

import { removeWatermark } from '../src/core/blendModes.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import {
    getVideoAlphaMap,
    resizeAlphaMapArea
} from '../src/video/videoWatermarkDetector.js';

loadLocalEnv();

const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-alpha-shape-fit');
const VIDEO_ALPHA_PROFILE = '96-20260520';
const LOGO_VALUE = 255;
const VIDEO_SAMPLE_ROOT = path.resolve(process.env.GWR_VIDEO_SAMPLE_ROOT || 'src/assets/video-samples');

const USER_FLAW_CASE_TEMPLATES = Object.freeze({
    'deaee69b-headlight': {
        originalPath: path.join(VIDEO_SAMPLE_ROOT, 'deaee69b-bd2f-481d-ba4d-bca20a1b4c8e.mp4'),
        referencePath: '.artifacts\\allenk-video\\deaee69b-allenk-v062.mp4',
        candidate: {
            x: 1704,
            y: 864,
            size: 72,
            marginRight: 144,
            marginBottom: 144
        },
        focusCrop: {
            x: 1485,
            y: 645,
            width: 435,
            height: 435
        }
    },
    'e1997e6e-rail': {
        originalPath: path.join(VIDEO_SAMPLE_ROOT, 'e1997e6e-45d5-4895-ae81-a7361c05bc37.mp4'),
        referencePath: '.artifacts\\allenk-video\\e1997e6e-allenk-v062.mp4',
        candidate: {
            x: 1704,
            y: 864,
            size: 72,
            marginRight: 144,
            marginBottom: 144
        },
        focusCrop: {
            x: 1626,
            y: 798,
            width: 258,
            height: 213
        }
    }
});

function createUserFlawCase(templateId, timestamp) {
    const template = USER_FLAW_CASE_TEMPLATES[templateId];
    if (!template) throw new Error(`Unknown user flaw case template: ${templateId}`);
    return {
        id: `${templateId}-t${formatTimestampSuffix(timestamp)}`,
        timestamp,
        ...template
    };
}

const DEFAULT_CASES = Object.freeze([
    createUserFlawCase('deaee69b-headlight', 3),
    createUserFlawCase('e1997e6e-rail', 4)
]);

const CASE_PRESETS = Object.freeze({
    'user-flaw': DEFAULT_CASES,
    'user-flaw-multiframe': Object.freeze([
        createUserFlawCase('deaee69b-headlight', 2),
        createUserFlawCase('deaee69b-headlight', 3),
        createUserFlawCase('deaee69b-headlight', 4),
        createUserFlawCase('e1997e6e-rail', 3),
        createUserFlawCase('e1997e6e-rail', 4),
        createUserFlawCase('e1997e6e-rail', 5)
    ])
});

const VARIANT_LIMIT = 80;
const EDGE_BOOSTS = Object.freeze([0.025, 0.03, 0.035, 0.04, 0.045]);
const BODY_SCALES = Object.freeze([0.94, 1, 1.06, 1.12]);
const LOW_SCALES = Object.freeze([0.92, 1, 1.08]);
const SHAPE_SCALES = Object.freeze([0.985, 1, 1.015]);
const OFFSETS = Object.freeze([-0.4, 0, 0.4]);
const LOCAL_REGIONS = Object.freeze([
    'top',
    'bottom',
    'left',
    'right',
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right'
]);

function runProcess(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
            }
        });
    });
}

function formatTimestampSuffix(timestamp) {
    return String(timestamp).replace(/[^0-9A-Za-z]+/g, '_');
}

async function extractFrame(videoPath, timestamp, outputPath) {
    await runProcess('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', String(timestamp),
        '-i', videoPath,
        '-frames:v', '1',
        outputPath
    ]);
}

async function decodeImageData(filePath) {
    const { data, info } = await sharp(filePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function lumaAt(data, idx) {
    return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
}

function clampAlpha(value) {
    return Math.max(0, Math.min(0.99, value));
}

function buildBaseVideoAlphaMap(size) {
    const alpha96 = getEmbeddedAlphaMap(VIDEO_ALPHA_PROFILE) || getEmbeddedAlphaMap(96);
    if (!alpha96) throw new Error('缺少视频 alpha profile');
    return size === 96 ? new Float32Array(alpha96) : resizeAlphaMapArea(alpha96, 96, size);
}

function enhanceAlphaEdges(alphaMap, size, strength) {
    if (!Number.isFinite(strength) || strength <= 0 || size <= 2) {
        return new Float32Array(alphaMap);
    }

    const gradient = new Float32Array(alphaMap.length);
    let maxGradient = 0;
    for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
            const i = y * size + x;
            const gx =
                -alphaMap[i - size - 1] - 2 * alphaMap[i - 1] - alphaMap[i + size - 1] +
                alphaMap[i - size + 1] + 2 * alphaMap[i + 1] + alphaMap[i + size + 1];
            const gy =
                -alphaMap[i - size - 1] - 2 * alphaMap[i - size] - alphaMap[i - size + 1] +
                alphaMap[i + size - 1] + 2 * alphaMap[i + size] + alphaMap[i + size + 1];
            const value = Math.sqrt(gx * gx + gy * gy);
            gradient[i] = value;
            if (value > maxGradient) maxGradient = value;
        }
    }

    if (maxGradient <= 0) return new Float32Array(alphaMap);
    const out = new Float32Array(alphaMap.length);
    for (let i = 0; i < alphaMap.length; i++) {
        const edge = Math.sqrt(gradient[i] / maxGradient);
        out[i] = clampAlpha(alphaMap[i] + edge * strength);
    }
    return out;
}

function sampleAlpha(alphaMap, size, x, y) {
    if (x < 0 || y < 0 || x > size - 1 || y > size - 1) return 0;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(size - 1, x0 + 1);
    const y1 = Math.min(size - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const a00 = alphaMap[y0 * size + x0] || 0;
    const a10 = alphaMap[y0 * size + x1] || 0;
    const a01 = alphaMap[y1 * size + x0] || 0;
    const a11 = alphaMap[y1 * size + x1] || 0;
    const top = a00 * (1 - tx) + a10 * tx;
    const bottom = a01 * (1 - tx) + a11 * tx;
    return top * (1 - ty) + bottom * ty;
}

function transformShape(alphaMap, size, {
    scale = 1,
    dx = 0,
    dy = 0,
    lowScale = 1,
    bodyScale = 1,
    region = 'all'
} = {}) {
    const out = new Float32Array(size * size);
    const center = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sx = center + (x - center - dx) / scale;
            const sy = center + (y - center - dy) / scale;
            const alpha = sampleAlpha(alphaMap, size, sx, sy);
            const inRegion = matchesLocalRegion(x, y, size, region);
            const shaped = inRegion
                ? alpha < 0.12
                    ? alpha * lowScale
                    : alpha * bodyScale
                : alpha;
            out[y * size + x] = clampAlpha(shaped);
        }
    }
    return out;
}

function matchesLocalRegion(x, y, size, region) {
    if (!region || region === 'all') return true;
    const center = (size - 1) / 2;
    if (region === 'top') return y < center;
    if (region === 'bottom') return y >= center;
    if (region === 'left') return x < center;
    if (region === 'right') return x >= center;
    if (region === 'top-left') return y < center && x < center;
    if (region === 'top-right') return y < center && x >= center;
    if (region === 'bottom-left') return y >= center && x < center;
    if (region === 'bottom-right') return y >= center && x >= center;
    return true;
}

function buildAlphaGradientMap(alphaMap, size) {
    const gradient = new Float32Array(size * size);
    let maxGradient = 0;
    for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
            const i = y * size + x;
            const gx =
                -alphaMap[i - size - 1] - 2 * alphaMap[i - 1] - alphaMap[i + size - 1] +
                alphaMap[i - size + 1] + 2 * alphaMap[i + 1] + alphaMap[i + size + 1];
            const gy =
                -alphaMap[i - size - 1] - 2 * alphaMap[i - size] - alphaMap[i - size + 1] +
                alphaMap[i + size - 1] + 2 * alphaMap[i + size] + alphaMap[i + size + 1];
            const value = Math.sqrt(gx * gx + gy * gy);
            gradient[i] = value;
            if (value > maxGradient) maxGradient = value;
        }
    }
    if (maxGradient <= 0) return gradient;
    for (let i = 0; i < gradient.length; i++) {
        gradient[i] /= maxGradient;
    }
    return gradient;
}

function alphaBand(alpha) {
    if (alpha < 0.035) return 'near-zero';
    if (alpha < 0.12) return 'low';
    if (alpha < 0.22) return 'mid';
    return 'high';
}

function gradientBand(gradient) {
    if (gradient >= 0.18) return 'edge';
    return 'body';
}

function quadrantName(x, y, size) {
    const center = (size - 1) / 2;
    if (y < center && x < center) return 'top-left';
    if (y < center && x >= center) return 'top-right';
    if (y >= center && x < center) return 'bottom-left';
    return 'bottom-right';
}

function createSegmentAccumulator() {
    return {
        n: 0,
        alphaDelta: 0,
        alphaAbs: 0
    };
}

function addSegmentSample(accumulator, delta) {
    accumulator.n++;
    accumulator.alphaDelta += delta;
    accumulator.alphaAbs += Math.abs(delta);
}

function finalizeSegmentAccumulator(accumulator) {
    return {
        n: accumulator.n,
        meanDelta: accumulator.n > 0 ? accumulator.alphaDelta / accumulator.n : 0,
        meanAbs: accumulator.n > 0 ? accumulator.alphaAbs / accumulator.n : 0
    };
}

function summarizeAlphaSegments(currentAlphaMap, observedAlpha, mask, size) {
    const gradient = buildAlphaGradientMap(currentAlphaMap, size);
    const segmentMap = new Map();
    const add = (key, delta) => {
        if (!segmentMap.has(key)) segmentMap.set(key, createSegmentAccumulator());
        addSegmentSample(segmentMap.get(key), delta);
    };

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = y * size + x;
            if (!mask[i]) continue;
            const current = currentAlphaMap[i] || 0;
            const observed = observedAlpha[i] || 0;
            const delta = observed - current;
            const q = quadrantName(x, y, size);
            const a = alphaBand(current);
            const g = gradientBand(gradient[i] || 0);
            add(`alpha:${a}`, delta);
            add(`gradient:${g}`, delta);
            add(`quadrant:${q}`, delta);
            add(`alpha:${a}|gradient:${g}`, delta);
            add(`alpha:${a}|quadrant:${q}`, delta);
            add(`gradient:${g}|quadrant:${q}`, delta);
            add(`alpha:${a}|gradient:${g}|quadrant:${q}`, delta);
        }
    }

    return [...segmentMap.entries()]
        .map(([segment, accumulator]) => ({
            segment,
            ...finalizeSegmentAccumulator(accumulator)
        }))
        .filter((item) => item.n >= 12)
        .sort((a, b) => b.meanAbs - a.meanAbs)
        .slice(0, 40);
}

function estimateObservedAlpha(originalImage, referenceImage, position) {
    const observed = new Float32Array(position.width * position.height);
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            const idx = ((position.y + y) * originalImage.width + position.x + x) * 4;
            const originalLuma = lumaAt(originalImage.data, idx);
            const referenceLuma = lumaAt(referenceImage.data, idx);
            const denominator = Math.max(1, LOGO_VALUE - referenceLuma);
            observed[y * position.width + x] = clampAlpha((originalLuma - referenceLuma) / denominator);
        }
    }
    return observed;
}

function buildActiveMask(alphaMap, observedAlpha, size) {
    const mask = new Uint8Array(size * size);
    for (let i = 0; i < mask.length; i++) {
        if ((alphaMap[i] || 0) >= 0.025 || (observedAlpha[i] || 0) >= 0.025) {
            mask[i] = 1;
        }
    }
    return mask;
}

function scoreAlphaFit(alphaMap, observedAlpha, mask) {
    let n = 0;
    let alphaAbs = 0;
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        n++;
        alphaAbs += Math.abs((alphaMap[i] || 0) - (observedAlpha[i] || 0));
    }
    return {
        n,
        alphaMeanAbs: n > 0 ? alphaAbs / n : 0
    };
}

function scoreRemovalFit(originalImage, referenceImage, position, alphaMap) {
    const candidateImage = cloneImageData(originalImage);
    removeWatermark(candidateImage, alphaMap, position, { alphaGain: 1 });
    let n = 0;
    let meanAbs = 0;
    let roiMeanAbs = 0;
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            const alpha = alphaMap[y * position.width + x] || 0;
            if (alpha < 0.025) continue;
            const idx = ((position.y + y) * originalImage.width + position.x + x) * 4;
            const diff =
                Math.abs(candidateImage.data[idx] - referenceImage.data[idx]) +
                Math.abs(candidateImage.data[idx + 1] - referenceImage.data[idx + 1]) +
                Math.abs(candidateImage.data[idx + 2] - referenceImage.data[idx + 2]);
            n++;
            meanAbs += diff / 3;
        }
    }

    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            const idx = ((position.y + y) * originalImage.width + position.x + x) * 4;
            const diff =
                Math.abs(candidateImage.data[idx] - referenceImage.data[idx]) +
                Math.abs(candidateImage.data[idx + 1] - referenceImage.data[idx + 1]) +
                Math.abs(candidateImage.data[idx + 2] - referenceImage.data[idx + 2]);
            roiMeanAbs += diff / 3;
        }
    }

    return {
        activeMeanAbs: n > 0 ? meanAbs / n : 0,
        roiMeanAbs: roiMeanAbs / (position.width * position.height)
    };
}

function cropImageData(imageData, crop) {
    const out = new Uint8ClampedArray(crop.width * crop.height * 4);
    for (let y = 0; y < crop.height; y++) {
        for (let x = 0; x < crop.width; x++) {
            const sourceX = crop.x + x;
            const sourceY = crop.y + y;
            const targetIdx = (y * crop.width + x) * 4;
            if (sourceX < 0 || sourceY < 0 || sourceX >= imageData.width || sourceY >= imageData.height) {
                out[targetIdx + 3] = 255;
                continue;
            }
            const sourceIdx = (sourceY * imageData.width + sourceX) * 4;
            out[targetIdx] = imageData.data[sourceIdx];
            out[targetIdx + 1] = imageData.data[sourceIdx + 1];
            out[targetIdx + 2] = imageData.data[sourceIdx + 2];
            out[targetIdx + 3] = 255;
        }
    }
    return {
        width: crop.width,
        height: crop.height,
        data: out
    };
}

function diffImageData(a, b, amplify = 10) {
    const out = new Uint8ClampedArray(a.width * a.height * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = Math.min(255, Math.abs(a.data[i] - b.data[i]) * amplify);
        out[i + 1] = Math.min(255, Math.abs(a.data[i + 1] - b.data[i + 1]) * amplify);
        out[i + 2] = Math.min(255, Math.abs(a.data[i + 2] - b.data[i + 2]) * amplify);
        out[i + 3] = 255;
    }
    return {
        width: a.width,
        height: a.height,
        data: out
    };
}

async function renderPanel(imageData, label) {
    const labelHeight = 34;
    const svgLabel = Buffer.from(`
<svg width="${imageData.width}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="black" fill-opacity="0.75"/>
  <text x="10" y="24" font-family="Arial, sans-serif" font-size="22" fill="white">${label}</text>
</svg>`);
    return sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .composite([{ input: svgLabel, left: 0, top: 0 }])
        .png()
        .toBuffer();
}

async function renderComparisonSheet({
    originalImage,
    referenceImage,
    position,
    currentAlphaMap,
    bestAlphaMap,
    focusCrop,
    outputPath
}) {
    const currentImage = cloneImageData(originalImage);
    const bestImage = cloneImageData(originalImage);
    removeWatermark(currentImage, currentAlphaMap, position, { alphaGain: 1 });
    removeWatermark(bestImage, bestAlphaMap, position, { alphaGain: 1 });

    const crop = focusCrop || {
        x: Math.max(0, position.x - Math.round(position.width * 1.2)),
        y: Math.max(0, position.y - Math.round(position.height * 1.2)),
        width: Math.min(originalImage.width, position.width * 3),
        height: Math.min(originalImage.height, position.height * 3)
    };
    const panels = [
        ['original', cropImageData(originalImage, crop)],
        ['current', cropImageData(currentImage, crop)],
        ['best-fit', cropImageData(bestImage, crop)],
        ['reference', cropImageData(referenceImage, crop)]
    ];
    const currentCrop = panels[1][1];
    const bestCrop = panels[2][1];
    panels.push(['diff best/current x10', diffImageData(bestCrop, currentCrop, 10)]);

    const panelBuffers = await Promise.all(panels.map(([label, imageData]) => renderPanel(imageData, label)));
    const metadata = await sharp(panelBuffers[0]).metadata();
    const width = metadata.width || crop.width;
    const height = metadata.height || crop.height;
    await sharp({
        create: {
            width: width * panelBuffers.length,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 1 }
        }
    })
        .composite(panelBuffers.map((input, index) => ({
            input,
            left: index * width,
            top: 0
        })))
        .png()
        .toFile(outputPath);
}

function buildVariants(baseAlphaMap, currentAlphaMap, size) {
    const variants = [{
        name: 'current-policy035',
        params: { current: true },
        alphaMap: currentAlphaMap
    }];

    for (const edgeBoost of EDGE_BOOSTS) {
        const edgeAlpha = enhanceAlphaEdges(baseAlphaMap, size, edgeBoost);
        for (const scale of SHAPE_SCALES) {
            for (const dx of OFFSETS) {
                for (const dy of OFFSETS) {
                    for (const bodyScale of BODY_SCALES) {
                        for (const lowScale of LOW_SCALES) {
                            variants.push({
                                name: [
                                    `edge${String(edgeBoost).replace('.', '')}`,
                                    `shape${scale.toFixed(3)}`,
                                    `dx${dx}`,
                                    `dy${dy}`,
                                    `body${bodyScale}`,
                                    `low${lowScale}`
                                ].join('-'),
                                params: { edgeBoost, scale, dx, dy, bodyScale, lowScale },
                                alphaMap: transformShape(edgeAlpha, size, {
                                    scale,
                                    dx,
                                    dy,
                                    bodyScale,
                                    lowScale
                                })
                            });
                        }
                    }
                }
            }
        }
    }
    for (const edgeBoost of [0.025, 0.035, 0.045]) {
        const edgeAlpha = enhanceAlphaEdges(baseAlphaMap, size, edgeBoost);
        for (const region of LOCAL_REGIONS) {
            for (const lowScale of [0.92, 1.08]) {
                variants.push({
                    name: [
                        `local-${region}`,
                        `edge${String(edgeBoost).replace('.', '')}`,
                        `low${lowScale}`
                    ].join('-'),
                    params: { edgeBoost, scale: 1, dx: 0, dy: 0, bodyScale: 1, lowScale, region },
                    alphaMap: transformShape(edgeAlpha, size, {
                        scale: 1,
                        dx: 0,
                        dy: 0,
                        bodyScale: 1,
                        lowScale,
                        region
                    })
                });
            }
            for (const bodyScale of [0.94, 1.06]) {
                variants.push({
                    name: [
                        `local-${region}`,
                        `edge${String(edgeBoost).replace('.', '')}`,
                        `body${bodyScale}`
                    ].join('-'),
                    params: { edgeBoost, scale: 1, dx: 0, dy: 0, bodyScale, lowScale: 1, region },
                    alphaMap: transformShape(edgeAlpha, size, {
                        scale: 1,
                        dx: 0,
                        dy: 0,
                        bodyScale,
                        lowScale: 1,
                        region
                    })
                });
            }
        }
    }
    return variants;
}

async function runCase(caseItem, outputDir) {
    const caseDir = path.join(outputDir, caseItem.id);
    const frameDir = path.join(caseDir, 'frames');
    await rm(frameDir, { recursive: true, force: true });
    await mkdir(frameDir, { recursive: true });

    const suffix = formatTimestampSuffix(caseItem.timestamp);
    const originalFramePath = path.join(frameDir, `original-${suffix}.png`);
    const referenceFramePath = path.join(frameDir, `reference-${suffix}.png`);
    await extractFrame(path.resolve(caseItem.originalPath), caseItem.timestamp, originalFramePath);
    await extractFrame(path.resolve(caseItem.referencePath), caseItem.timestamp, referenceFramePath);

    const originalImage = await decodeImageData(originalFramePath);
    const referenceImage = await decodeImageData(referenceFramePath);
    const position = {
        x: caseItem.candidate.x,
        y: caseItem.candidate.y,
        width: caseItem.candidate.size,
        height: caseItem.candidate.size
    };
    const candidate = {
        ...caseItem.candidate,
        width: caseItem.candidate.size,
        height: caseItem.candidate.size
    };
    const size = position.width;
    const baseAlphaMap = buildBaseVideoAlphaMap(size);
    const currentAlphaMap = getVideoAlphaMap(size, { candidate });
    const observedAlpha = estimateObservedAlpha(originalImage, referenceImage, position);
    const mask = buildActiveMask(currentAlphaMap, observedAlpha, size);
    const segmentStats = summarizeAlphaSegments(currentAlphaMap, observedAlpha, mask, size);
    const variants = buildVariants(baseAlphaMap, currentAlphaMap, size);
    const results = variants.map((variant) => {
        const alphaFit = scoreAlphaFit(variant.alphaMap, observedAlpha, mask);
        const removalFit = scoreRemovalFit(originalImage, referenceImage, position, variant.alphaMap);
        return {
            name: variant.name,
            params: variant.params,
            ...alphaFit,
            ...removalFit
        };
    }).sort((a, b) => {
        if (a.activeMeanAbs !== b.activeMeanAbs) return a.activeMeanAbs - b.activeMeanAbs;
        return a.alphaMeanAbs - b.alphaMeanAbs;
    });

    const current = results.find((item) => item.name === 'current-policy035');
    const top = results.slice(0, VARIANT_LIMIT);
    const bestVariant = variants.find((variant) => variant.name === top[0].name) || variants[0];
    const sheetPath = path.join(caseDir, 'best-fit-sheet.png');
    const allResultsPath = path.join(caseDir, 'all-results.json');
    await writeFile(allResultsPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    await renderComparisonSheet({
        originalImage,
        referenceImage,
        position,
        currentAlphaMap,
        bestAlphaMap: bestVariant.alphaMap,
        focusCrop: caseItem.focusCrop,
        outputPath: sheetPath
    });
    const report = {
        id: caseItem.id,
        timestamp: caseItem.timestamp,
        position,
        current,
        best: top[0],
        top,
        segmentStats,
        totalVariants: results.length,
        allResultsPath,
        sheetPath,
        frameDir
    };

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
}

export async function runVideoAlphaShapeFit({
    outputDir = DEFAULT_OUTPUT_DIR,
    preset = 'user-flaw',
    cases = null
} = {}) {
    const resolvedOutputDir = path.resolve(outputDir);
    const selectedCases = cases || CASE_PRESETS[preset] || DEFAULT_CASES;
    await mkdir(resolvedOutputDir, { recursive: true });
    const reports = [];
    for (const caseItem of selectedCases) {
        reports.push(await runCase(caseItem, resolvedOutputDir));
    }
    const summary = {
        generatedAt: new Date().toISOString(),
        outputDir: resolvedOutputDir,
        preset,
        reports
    };
    await writeFile(path.join(resolvedOutputDir, 'latest-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return summary;
}

function printSummary(summary) {
    for (const report of summary.reports) {
        const current = report.current;
        const best = report.best;
        const activeDelta = best.activeMeanAbs - current.activeMeanAbs;
        const alphaDelta = best.alphaMeanAbs - current.alphaMeanAbs;
        console.log([
            report.id,
            `best=${best.name}`,
            `active=${best.activeMeanAbs.toFixed(4)} (${activeDelta >= 0 ? '+' : ''}${activeDelta.toFixed(4)})`,
            `alpha=${best.alphaMeanAbs.toFixed(5)} (${alphaDelta >= 0 ? '+' : ''}${alphaDelta.toFixed(5)})`
        ].join(' | '));
    }
    console.log(`summary: ${path.join(summary.outputDir, 'latest-summary.json')}`);
}

function parseArgs(argv) {
    const parsed = {
        outputDir: DEFAULT_OUTPUT_DIR,
        preset: 'user-flaw'
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--output-dir') {
            parsed.outputDir = argv[++i] || parsed.outputDir;
        } else if (arg === '--preset') {
            parsed.preset = argv[++i] || parsed.preset;
            if (!CASE_PRESETS[parsed.preset]) {
                throw new Error(`未知 preset: ${parsed.preset}`);
            }
        } else if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }
    return parsed;
}

function printHelp() {
    console.log(`Usage:
  node scripts/fit-video-alpha-shape.js [--output-dir <dir>] [--preset user-flaw|user-flaw-multiframe]
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    runVideoAlphaShapeFit(args)
        .then(printSummary)
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}

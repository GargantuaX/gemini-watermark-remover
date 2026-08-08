import path from 'node:path';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation
} from '../src/core/adaptiveDetector.js';
import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import {
    assessAlphaBandHalo,
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import {
    decodeImageDataInNode,
    listBenchmarkSampleAssets
} from './sample-benchmark.js';
import { buildAlphaProfileAdmission } from './alpha-profile-admission.js';

const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/gemini-alpha-profile-diagnosis/latest');
const SHEET_PANEL_SIZE = 190;
const SHEET_LABEL_HEIGHT = 58;
const SHEET_GAP = 12;
const SHEET_BACKGROUND = '#171717';

const DEFAULT_SAMPLES = Object.freeze([
    {
        id: 'v2-36-fixture',
        filePath: path.resolve('tests/fixtures/gemini-v2-36-small-watermark.png')
    },
    {
        id: 'sample-4-3',
        filePath: path.resolve('src/assets/samples/4-3.png')
    },
    {
        id: 'sample-9-16',
        filePath: path.resolve('src/assets/samples/9-16.png')
    }
]);

const PROFILE_VARIANTS = Object.freeze([
    { name: 'base', type: 'identity' },
    { name: 'edge-dampen-0.88', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 0.88 },
    { name: 'edge-boost-1.12', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 1.12 },
    { name: 'edge-boost-1.24', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 1.24 },
    { name: 'mid-dampen-0.92', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 0.92 },
    { name: 'mid-boost-1.08', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.08 },
    { name: 'mid-boost-1.16', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.16 },
    { name: 'mid-boost-1.24', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.24 },
    { name: 'core-dampen-0.92', type: 'band-scale', minAlpha: 0.24, maxAlpha: 0.78, scale: 0.92 },
    { name: 'core-boost-1.08', type: 'band-scale', minAlpha: 0.24, maxAlpha: 0.78, scale: 1.08 },
    { name: 'core-boost-1.16', type: 'band-scale', minAlpha: 0.24, maxAlpha: 0.78, scale: 1.16 },
    { name: 'power-0.88', type: 'power', exponent: 0.88 },
    { name: 'power-0.94', type: 'power', exponent: 0.94 },
    { name: 'power-1.08', type: 'power', exponent: 1.08 },
    { name: 'blur-mix-0.25', type: 'blur-mix', mix: 0.25 },
    { name: 'sharpen-0.20', type: 'sharpen', amount: 0.2 }
]);

const ALPHA_BANDS = Object.freeze([
    { name: 'edge', minAlpha: 0.02, maxAlpha: 0.12 },
    { name: 'mid-core', minAlpha: 0.18, maxAlpha: 0.35 },
    { name: 'high-core', minAlpha: 0.35, maxAlpha: 0.78 }
]);

const POST_CORRECTION_VARIANTS = Object.freeze([
    { name: 'mid-core-bias-0.25', type: 'band-bias', strength: 0.25, innerMinAlpha: 0.18, innerMaxAlpha: 0.35, outerMinAlpha: 0.12, outerMaxAlpha: 0.42 },
    { name: 'mid-core-bias-0.50', type: 'band-bias', strength: 0.5, innerMinAlpha: 0.18, innerMaxAlpha: 0.35, outerMinAlpha: 0.12, outerMaxAlpha: 0.42 },
    { name: 'mid-core-bias-0.75', type: 'band-bias', strength: 0.75, innerMinAlpha: 0.18, innerMaxAlpha: 0.35, outerMinAlpha: 0.12, outerMaxAlpha: 0.42 },
    { name: 'broad-core-bias-0.35', type: 'band-bias', strength: 0.35, innerMinAlpha: 0.18, innerMaxAlpha: 0.78, outerMinAlpha: 0.12, outerMaxAlpha: 0.86 }
]);

function parseArgs(argv) {
    const parsed = {
        outputDir: DEFAULT_OUTPUT_DIR,
        samplePaths: [],
        sampleDir: null
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
            continue;
        }
        if (arg === '--sample') {
            parsed.samplePaths.push(path.resolve(args.shift() || '.'));
            continue;
        }
        if (arg === '--sample-dir') {
            parsed.sampleDir = path.resolve(args.shift() || 'src/assets/samples');
        }
    }

    return parsed;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function round(value, digits = 6) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function escapeSvgText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function clampAlpha(value) {
    return Math.max(0, Math.min(0.99, value));
}

function blurAlphaMap(alphaMap, width, height) {
    const blurred = new Float32Array(alphaMap.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            let count = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const sy = y + dy;
                if (sy < 0 || sy >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const sx = x + dx;
                    if (sx < 0 || sx >= width) continue;
                    sum += alphaMap[sy * width + sx];
                    count++;
                }
            }
            blurred[y * width + x] = count > 0 ? sum / count : alphaMap[y * width + x];
        }
    }
    return blurred;
}

function transformAlphaMap(alphaMap, width, height, variant) {
    if (!variant || variant.type === 'identity') return alphaMap;
    const transformed = new Float32Array(alphaMap.length);
    if (variant.type === 'band-scale') {
        for (let index = 0; index < alphaMap.length; index++) {
            const alpha = alphaMap[index];
            transformed[index] = alpha >= variant.minAlpha && alpha <= variant.maxAlpha
                ? clampAlpha(alpha * variant.scale)
                : alpha;
        }
        return transformed;
    }
    if (variant.type === 'power') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(Math.pow(alphaMap[index], variant.exponent));
        }
        return transformed;
    }

    const blurred = blurAlphaMap(alphaMap, width, height);
    if (variant.type === 'blur-mix') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(alphaMap[index] * (1 - variant.mix) + blurred[index] * variant.mix);
        }
        return transformed;
    }
    if (variant.type === 'sharpen') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(alphaMap[index] + (alphaMap[index] - blurred[index]) * variant.amount);
        }
        return transformed;
    }
    return alphaMap;
}

function smoothstep(edge0, edge1, value) {
    if (edge0 === edge1) return value >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function bandBiasWeight(alpha, variant) {
    if (alpha < variant.outerMinAlpha || alpha > variant.outerMaxAlpha) return 0;
    if (alpha >= variant.innerMinAlpha && alpha <= variant.innerMaxAlpha) return 1;
    if (alpha < variant.innerMinAlpha) {
        return smoothstep(variant.outerMinAlpha, variant.innerMinAlpha, alpha);
    }
    return 1 - smoothstep(variant.innerMaxAlpha, variant.outerMaxAlpha, alpha);
}

function applyPostCorrection({ currentImageData, alphaMap, position, current, variant }) {
    if (variant.type !== 'band-bias') return null;
    const bias = Math.max(0, current.positiveHaloLum ?? 0) * variant.strength;
    const corrected = cloneImageData(currentImageData);
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = alphaMap[localIndex] ?? 0;
            const weight = bandBiasWeight(alpha, variant);
            if (weight <= 0) continue;
            const offset = ((position.y + row) * corrected.width + position.x + col) * 4;
            const delta = bias * weight;
            corrected.data[offset] = Math.max(0, Math.min(255, Math.round(corrected.data[offset] - delta)));
            corrected.data[offset + 1] = Math.max(0, Math.min(255, Math.round(corrected.data[offset + 1] - delta)));
            corrected.data[offset + 2] = Math.max(0, Math.min(255, Math.round(corrected.data[offset + 2] - delta)));
        }
    }
    return corrected;
}

async function createFloorOnlyRuntime(outputDir) {
    const runtimeRoot = path.join(outputDir, 'runtime-floor-only');
    const runtimeSrc = path.join(runtimeRoot, 'src');
    await rm(runtimeRoot, { recursive: true, force: true });
    await mkdir(runtimeRoot, { recursive: true });
    await cp(path.resolve('src'), runtimeSrc, { recursive: true });
    await writeFile(
        path.join(runtimeSrc, 'core/alphaGradientMask.js'),
        [
            'function clamp(value, min, max) {',
            '    return Math.max(min, Math.min(max, value));',
            '}',
            '',
            'export function createAlphaGradientMask({ alphaMap, width, height = width }) {',
            '    if (!alphaMap || width <= 0 || height <= 0 || alphaMap.length < width * height) {',
            '        return new Float32Array(0);',
            '    }',
            '    return new Float32Array(width * height);',
            '}',
            '',
            'export function getAlphaGradientWeight(mask, index, floor = 0.35) {',
            '    if (!mask || index < 0 || index >= mask.length) {',
            '        return clamp(floor, 0, 1);',
            '    }',
            '    return Math.max(clamp(floor, 0, 1), clamp(mask[index], 0, 1));',
            '}',
            ''
        ].join('\n'),
        'utf8'
    );

    const processorUrl = pathToFileURL(path.join(runtimeSrc, 'core/watermarkProcessor.js')).href;
    return await import(`${processorUrl}?floorOnly=${Date.now()}`);
}

async function loadAlphaMaps() {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    const alpha36V2 = getEmbeddedAlphaMap('36-v2');

    const resolve = (configOrSize) => {
        const size = typeof configOrSize === 'object'
            ? configOrSize.logoSize ?? configOrSize.size
            : configOrSize;
        const alphaVariant = typeof configOrSize === 'object'
            ? configOrSize.alphaVariant
            : null;
        if (size === 36 && alphaVariant === 'v2') return alpha36V2;
        if (size === '36-v2') return alpha36V2;
        if (size === 48) return alpha48;
        if (size === 96 && alphaVariant === '20260520') return alpha96NewMargin;
        if (size === 96) return alpha96;
        return interpolateAlphaMap(alpha96, 96, size);
    };

    return {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        resolve
    };
}

function resolvePosition(meta, imageData) {
    if (meta?.position && Number.isFinite(meta.position.x) && Number.isFinite(meta.position.y)) {
        return {
            x: meta.position.x,
            y: meta.position.y,
            width: meta.position.width,
            height: meta.position.height
        };
    }
    const config = meta?.config;
    const size = config?.logoSize ?? config?.size;
    if (config && Number.isFinite(size) && Number.isFinite(config.marginRight) && Number.isFinite(config.marginBottom)) {
        return {
            x: imageData.width - config.marginRight - size,
            y: imageData.height - config.marginBottom - size,
            width: size,
            height: size
        };
    }
    return null;
}

function scoreCandidate({ label, imageData, originalImageData, alphaMapForScoring, alphaMapForDiff, position, alphaGain, source }) {
    const spatial = computeRegionSpatialCorrelation({
        imageData,
        alphaMap: alphaMapForScoring,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const gradient = computeRegionGradientCorrelation({
        imageData,
        alphaMap: alphaMapForScoring,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData,
        alphaMap: alphaMapForScoring,
        position
    });
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: imageData,
        alphaMap: alphaMapForDiff,
        position,
        alphaGain
    });

    return {
        label,
        source,
        alphaGain: round(alphaGain, 4),
        spatial: round(spatial, 6),
        gradient: round(gradient, 6),
        visible: residualVisibility?.visible === true,
        visiblePositiveHalo: residualVisibility?.visiblePositiveHalo === true,
        positiveHaloLum: round(residualVisibility?.positiveHaloLum, 6),
        haloVisibility: round(residualVisibility?.haloVisibility, 6),
        visualArtifactCost: round(artifacts?.visualArtifactCost, 6),
        newlyClippedRatio: round(artifacts?.newlyClippedRatio, 6),
        diffGradientCorrelation: round(artifacts?.diffGradientCorrelation, 6),
        diffTemplateCorrelation: round(artifacts?.diffTemplateCorrelation, 6),
        bandProfile: buildBandProfile({ imageData, alphaMap: alphaMapForScoring, position }),
        imageData
    };
}

function summarizeBandHalo(halo) {
    return {
        bandCount: halo.bandCount,
        outerCount: halo.outerCount,
        bandMeanLum: round(halo.bandMeanLum, 4),
        outerMeanLum: round(halo.outerMeanLum, 4),
        deltaLum: round(halo.deltaLum, 4),
        positiveDeltaLum: round(halo.positiveDeltaLum, 4),
        visibility: round(halo.visibility, 6)
    };
}

function buildBandProfile({ imageData, alphaMap, position }) {
    const profile = {};
    for (const band of ALPHA_BANDS) {
        profile[band.name] = summarizeBandHalo(assessAlphaBandHalo({
            imageData,
            position,
            alphaMap,
            minAlpha: band.minAlpha,
            maxAlpha: band.maxAlpha,
            outsideAlphaMax: 0.012,
            outerMargin: 4
        }));
    }
    return profile;
}

function bandPositiveDelta(candidate, bandName) {
    return candidate.bandProfile?.[bandName]?.positiveDeltaLum ?? null;
}

function bandDeltaReduction(before, after, bandName) {
    const beforeValue = bandPositiveDelta(before, bandName);
    const afterValue = bandPositiveDelta(after, bandName);
    if (!Number.isFinite(beforeValue) || !Number.isFinite(afterValue)) return null;
    return round(beforeValue - afterValue, 6);
}

function buildSampleDiagnosis({ before, current, floorOnly, profileTrials, postCorrectionTrials }) {
    const haloLoweringTrials = profileTrials.filter((trial) =>
        Number.isFinite(trial.positiveHaloLum) &&
        Number.isFinite(current.positiveHaloLum) &&
        trial.positiveHaloLum < current.positiveHaloLum - 0.5
    );
    const safeHaloLoweringTrials = haloLoweringTrials.filter((trial) => trial.admission.productionCandidate);
    const safePostCorrectionTrials = postCorrectionTrials.filter((trial) => trial.admission.productionCandidate);
    const bestHaloTrial = haloLoweringTrials
        .slice()
        .sort((left, right) => (left.positiveHaloLum ?? 999) - (right.positiveHaloLum ?? 999))[0] ?? null;
    const currentMidCore = current.bandProfile?.['mid-core'];
    const currentHighCore = current.bandProfile?.['high-core'];
    const currentEdge = current.bandProfile?.edge;

    const dominantBand = [
        { name: 'edge', value: currentEdge?.positiveDeltaLum ?? 0 },
        { name: 'mid-core', value: currentMidCore?.positiveDeltaLum ?? 0 },
        { name: 'high-core', value: currentHighCore?.positiveDeltaLum ?? 0 }
    ].sort((left, right) => right.value - left.value)[0]?.name ?? 'unknown';

    return {
        dominantPositiveHaloBand: dominantBand,
        currentBandDeltas: {
            edge: currentEdge?.positiveDeltaLum ?? null,
            midCore: currentMidCore?.positiveDeltaLum ?? null,
            highCore: currentHighCore?.positiveDeltaLum ?? null
        },
        beforeToCurrentBandReduction: {
            edge: bandDeltaReduction(before, current, 'edge'),
            midCore: bandDeltaReduction(before, current, 'mid-core'),
            highCore: bandDeltaReduction(before, current, 'high-core')
        },
        beforeToFloorOnlyBandReduction: {
            edge: bandDeltaReduction(before, floorOnly, 'edge'),
            midCore: bandDeltaReduction(before, floorOnly, 'mid-core'),
            highCore: bandDeltaReduction(before, floorOnly, 'high-core')
        },
        floorOnlyTradeoff: {
            gradientDelta: round(floorOnly.gradient - current.gradient, 6),
            artifactDelta: round(floorOnly.visualArtifactCost - current.visualArtifactCost, 6),
            haloDelta: round(floorOnly.positiveHaloLum - current.positiveHaloLum, 6)
        },
        haloLoweringTrialCount: haloLoweringTrials.length,
        safeHaloLoweringTrialCount: safeHaloLoweringTrials.length,
        safePostCorrectionTrialCount: safePostCorrectionTrials.length,
        safePostCorrectionTrials: safePostCorrectionTrials.map(stripImageData),
        bestHaloTrial: bestHaloTrial ? stripImageData(bestHaloTrial) : null,
        conclusion: safeHaloLoweringTrials.length > 0
            ? 'found-safe-profile-candidate'
            : (safePostCorrectionTrials.length > 0
                ? 'found-report-only-post-correction-candidate'
                : 'simple-alpha-profile-lowers-halo-only-by-increasing-gradient-or-artifact-cost')
    };
}

function stripImageData(trial) {
    const { imageData, ...rest } = trial;
    return rest;
}

async function toPanel(imageData, cropBox, label) {
    const crop = await sharp(Buffer.from(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .extract(cropBox)
        .resize({
            width: SHEET_PANEL_SIZE,
            height: SHEET_PANEL_SIZE,
            fit: 'contain',
            kernel: 'nearest',
            background: '#000000'
        })
        .png()
        .toBuffer();
    const svg = Buffer.from(
        `<svg width="${SHEET_PANEL_SIZE}" height="${SHEET_LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        '<rect width="100%" height="100%" fill="#111"/>' +
        `<text x="8" y="18" font-family="Arial" font-size="13" fill="#fff">${escapeSvgText(label.line1)}</text>` +
        `<text x="8" y="38" font-family="Arial" font-size="12" fill="#ddd">${escapeSvgText(label.line2)}</text>` +
        '</svg>'
    );
    const out = await sharp({
        create: {
            width: SHEET_PANEL_SIZE,
            height: SHEET_PANEL_SIZE + SHEET_LABEL_HEIGHT,
            channels: 4,
            background: '#000000'
        }
    })
        .composite([
            { input: svg, left: 0, top: 0 },
            { input: crop, left: 0, top: SHEET_LABEL_HEIGHT }
        ])
        .png()
        .toBuffer();
    return {
        input: out,
        width: SHEET_PANEL_SIZE,
        height: SHEET_PANEL_SIZE + SHEET_LABEL_HEIGHT
    };
}

function cropBoxFor(position, imageData) {
    const pad = Math.max(14, Math.round(position.width * 0.45));
    const left = Math.max(0, position.x - pad);
    const top = Math.max(0, position.y - pad);
    const right = Math.min(imageData.width, position.x + position.width + pad);
    const bottom = Math.min(imageData.height, position.y + position.height + pad);
    return {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
    };
}

async function renderSheet({ samples, outputPath }) {
    const rows = [];
    for (const sample of samples) {
        const cropBox = cropBoxFor(sample.position, sample.originalImageData);
        const topProfileTrials = sample.profileTrials
            .slice()
            .sort((left, right) => {
                const leftHalo = Number.isFinite(left.positiveHaloLum) ? left.positiveHaloLum : 999;
                const rightHalo = Number.isFinite(right.positiveHaloLum) ? right.positiveHaloLum : 999;
                return leftHalo - rightHalo;
            })
            .slice(0, 3);
        const topPostCorrectionTrials = sample.postCorrectionTrials
            .slice()
            .sort((left, right) => {
                const leftHalo = Number.isFinite(left.positiveHaloLum) ? left.positiveHaloLum : 999;
                const rightHalo = Number.isFinite(right.positiveHaloLum) ? right.positiveHaloLum : 999;
                return leftHalo - rightHalo;
            })
            .slice(0, 2);
        const panels = [
            await toPanel(sample.originalImageData, cropBox, { line1: `${sample.id} before`, line2: '' }),
            await toPanel(sample.current.imageData, cropBox, {
                line1: 'current',
                line2: `g=${formatNumber(sample.current.gradient)} h=${formatNumber(sample.current.positiveHaloLum)} a=${formatNumber(sample.current.visualArtifactCost)}`
            }),
            await toPanel(sample.floorOnly.imageData, cropBox, {
                line1: 'floor-only',
                line2: `g=${formatNumber(sample.floorOnly.gradient)} h=${formatNumber(sample.floorOnly.positiveHaloLum)} a=${formatNumber(sample.floorOnly.visualArtifactCost)}`
            })
        ];
        for (const trial of topProfileTrials) {
            panels.push(await toPanel(trial.imageData, cropBox, {
                line1: trial.label,
                line2: `g=${formatNumber(trial.gradient)} h=${formatNumber(trial.positiveHaloLum)} a=${formatNumber(trial.visualArtifactCost)}`
            }));
        }
        for (const trial of topPostCorrectionTrials) {
            panels.push(await toPanel(trial.imageData, cropBox, {
                line1: trial.label,
                line2: `g=${formatNumber(trial.gradient)} h=${formatNumber(trial.positiveHaloLum)} a=${formatNumber(trial.visualArtifactCost)}`
            }));
        }
        rows.push(panels);
    }

    const panelWidth = SHEET_PANEL_SIZE;
    const panelHeight = SHEET_PANEL_SIZE + SHEET_LABEL_HEIGHT;
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0) * panelWidth +
        SHEET_GAP * (rows.reduce((max, row) => Math.max(max, row.length), 0) + 1);
    const height = rows.length * panelHeight + SHEET_GAP * (rows.length + 1);
    const composites = [];
    let y = SHEET_GAP;
    for (const row of rows) {
        let x = SHEET_GAP;
        for (const panel of row) {
            composites.push({ input: panel.input, left: x, top: y });
            x += panelWidth + SHEET_GAP;
        }
        y += panelHeight + SHEET_GAP;
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: SHEET_BACKGROUND
        }
    })
        .composite(composites)
        .png()
        .toFile(outputPath);
}

async function buildSamples({ samplePaths, sampleDir }) {
    if (sampleDir) {
        const items = await listBenchmarkSampleAssets(sampleDir);
        return items.map((item) => ({
            id: item.fileName,
            filePath: path.join(sampleDir, item.fileName)
        }));
    }
    if (samplePaths.length === 0) return DEFAULT_SAMPLES;
    return samplePaths.map((filePath, index) => ({
        id: path.basename(filePath, path.extname(filePath)) || `sample-${index + 1}`,
        filePath
    }));
}

async function run() {
    const args = parseArgs(process.argv.slice(2));
    await mkdir(args.outputDir, { recursive: true });
    const floorRuntime = await createFloorOnlyRuntime(args.outputDir);
    const alphaMaps = await loadAlphaMaps();
    const sampleSpecs = await buildSamples({
        samplePaths: args.samplePaths,
        sampleDir: args.sampleDir
    });
    const samples = [];

    for (const spec of sampleSpecs) {
        const originalImageData = await decodeImageDataInNode(spec.filePath);
        const processOptions = {
            alpha48: alphaMaps.alpha48,
            alpha96: alphaMaps.alpha96,
            alpha96Variants: alphaMaps.alpha96Variants,
            getAlphaMap: (size) => alphaMaps.resolve(size)
        };
        const currentResult = processWatermarkImageData(cloneImageData(originalImageData), processOptions);
        const floorResult = floorRuntime.processWatermarkImageData(cloneImageData(originalImageData), processOptions);
        const position = resolvePosition(currentResult.meta, originalImageData);
        const baseAlphaMap = alphaMaps.resolve(currentResult.meta.config);
        const alphaGain = Number.isFinite(currentResult.meta.alphaGain) ? currentResult.meta.alphaGain : 1;
        const current = scoreCandidate({
            label: 'current',
            source: currentResult.meta.source,
            imageData: currentResult.imageData,
            originalImageData,
            alphaMapForScoring: baseAlphaMap,
            alphaMapForDiff: baseAlphaMap,
            position,
            alphaGain
        });
        const before = scoreCandidate({
            label: 'before',
            source: 'source',
            imageData: originalImageData,
            originalImageData,
            alphaMapForScoring: baseAlphaMap,
            alphaMapForDiff: baseAlphaMap,
            position,
            alphaGain
        });
        const floorOnly = scoreCandidate({
            label: 'floor-only',
            source: floorResult.meta.source,
            imageData: floorResult.imageData,
            originalImageData,
            alphaMapForScoring: baseAlphaMap,
            alphaMapForDiff: baseAlphaMap,
            position,
            alphaGain
        });
        const profileTrials = [];
        for (const variant of PROFILE_VARIANTS) {
            const alphaMap = transformAlphaMap(baseAlphaMap, position.width, position.height, variant);
            const candidate = cloneImageData(originalImageData);
            removeWatermark(candidate, alphaMap, position, { alphaGain });
            const trial = scoreCandidate({
                label: variant.name,
                source: `profile:${variant.name}`,
                imageData: candidate,
                originalImageData,
                alphaMapForScoring: baseAlphaMap,
                alphaMapForDiff: alphaMap,
                position,
                alphaGain
            });
            profileTrials.push({
                ...trial,
                admission: buildAlphaProfileAdmission({ current, trial })
            });
        }
        const productionCandidates = profileTrials
            .filter((trial) => trial.admission.productionCandidate)
            .map(stripImageData);
        const postCorrectionTrials = [];
        for (const variant of POST_CORRECTION_VARIANTS) {
            const candidate = applyPostCorrection({
                currentImageData: currentResult.imageData,
                alphaMap: baseAlphaMap,
                position,
                current,
                variant
            });
            if (!candidate) continue;
            const trial = scoreCandidate({
                label: variant.name,
                source: `post-correction:${variant.name}`,
                imageData: candidate,
                originalImageData,
                alphaMapForScoring: baseAlphaMap,
                alphaMapForDiff: baseAlphaMap,
                position,
                alphaGain
            });
            postCorrectionTrials.push({
                ...trial,
                admission: buildAlphaProfileAdmission({ current, trial })
            });
        }
        const postCorrectionCandidates = postCorrectionTrials
            .filter((trial) => trial.admission.productionCandidate)
            .map(stripImageData);
        const diagnosis = buildSampleDiagnosis({
            before,
            current,
            floorOnly,
            profileTrials,
            postCorrectionTrials
        });

        samples.push({
            id: spec.id,
            filePath: spec.filePath,
            originalImageData,
            position,
            config: currentResult.meta.config,
            alphaGain,
            before,
            current,
            floorOnly,
            profileTrials,
            postCorrectionTrials,
            productionCandidates,
            postCorrectionCandidates,
            diagnosis
        });
    }

    const sheetPath = path.join(args.outputDir, 'alpha-profile-diagnosis-sheet.png');
    await renderSheet({ samples, outputPath: sheetPath });

    const report = {
        generatedAt: new Date().toISOString(),
        policy: {
            reportOnly: true,
            scriptWritesProductionCode: false,
            admissionRule: 'A profile variant is only a production candidate when halo improves by >0.5, gradient/spatial/artifact metrics stay within tolerance, residual visibility is false, and every measured alpha band has positive delta <= 0.5 luma.'
        },
        outputDir: args.outputDir,
        sheetPath,
        profileVariants: PROFILE_VARIANTS,
        samples: samples.map((sample) => ({
            id: sample.id,
            filePath: sample.filePath,
            position: sample.position,
            config: sample.config,
            alphaGain: sample.alphaGain,
            before: stripImageData(sample.before),
            current: stripImageData(sample.current),
            floorOnly: stripImageData(sample.floorOnly),
            profileTrials: sample.profileTrials.map(stripImageData),
            postCorrectionTrials: sample.postCorrectionTrials.map(stripImageData),
            productionCandidates: sample.productionCandidates,
            postCorrectionCandidates: sample.postCorrectionCandidates,
            diagnosis: sample.diagnosis
        })),
        summary: {
            sampleCount: samples.length,
            productionCandidateCount: samples.reduce((sum, sample) => sum + sample.productionCandidates.length, 0),
            postCorrectionCandidateCount: samples.reduce((sum, sample) => sum + sample.postCorrectionCandidates.length, 0),
            productionCurrentHitCount: samples.filter((sample) => sample.current.source.includes('mid-core-bias')).length,
            productionCurrentHits: samples
                .filter((sample) => sample.current.source.includes('mid-core-bias'))
                .map((sample) => ({
                    id: sample.id,
                    source: sample.current.source,
                    spatial: sample.current.spatial,
                    gradient: sample.current.gradient,
                    positiveHaloLum: sample.current.positiveHaloLum,
                    visualArtifactCost: sample.current.visualArtifactCost
                })),
            samplesWithProductionCandidate: samples
                .filter((sample) => sample.productionCandidates.length > 0)
                .map((sample) => sample.id),
            samplesWithPostCorrectionCandidate: samples
                .filter((sample) => sample.postCorrectionCandidates.length > 0)
                .map((sample) => sample.id),
            floorOnlyGradientWorseCount: samples.filter((sample) => sample.floorOnly.gradient > sample.current.gradient + 0.01).length,
            floorOnlyArtifactWorseCount: samples.filter((sample) => sample.floorOnly.visualArtifactCost > sample.current.visualArtifactCost + 0.001).length,
            dominantPositiveHaloBands: samples.reduce((counts, sample) => {
                const band = sample.diagnosis.dominantPositiveHaloBand;
                counts[band] = (counts[band] ?? 0) + 1;
                return counts;
            }, {}),
            diagnosisConclusions: samples.reduce((counts, sample) => {
                const conclusion = sample.diagnosis.conclusion;
                counts[conclusion] = (counts[conclusion] ?? 0) + 1;
                return counts;
            }, {})
        }
    };

    const reportPath = path.join(args.outputDir, 'alpha-profile-diagnosis-report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(`report: ${reportPath}`);
    console.log(`sheet: ${sheetPath}`);
    console.log(`samples=${report.summary.sampleCount} productionCandidates=${report.summary.productionCandidateCount}`);
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

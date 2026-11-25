import { computeRegionGradientCorrelation, computeRegionSpatialCorrelation, interpolateAlphaMap, warpAlphaMap } from './adaptiveDetector.js';
import { removeWatermark } from './blendModes.js';
import { getEmbeddedAlphaMap } from './embeddedAlphaMaps.js';
import { assessCalibratedWatermarkResidualVisibility } from './restorationMetrics.js';

const SIZE = 48;
const MARGIN = 73;
const CENTER = (SIZE - 1) / 2;
const LOCAL_REGION = { x: 0, y: 0, width: SIZE, height: SIZE };
const EDGE_MIXES = [0.25, 0.5, 0.75];
const ALIGN_SHIFTS = [-0.5, -0.25, 0, 0.25, 0.5];
const ALIGN_SCALES = [0.99, 1, 1.01];
const MIN_FIT_IMPROVEMENT = 0.05;
const BINOMIAL_KERNEL = [1, 4, 6, 4, 1];
const edgeReference = getEmbeddedAlphaMap(SIZE).map(value => value >= 4 / 255 ? value : 0);
const v2Witness = interpolateAlphaMap(getEmbeddedAlphaMap('36-v2'), 36, SIZE);
const referenceBody = bodyMedian(edgeReference);

const fitProbes = [];
for (let y = 2; y < SIZE - 2; y++) {
    for (let x = 2; x < SIZE - 2; x++) {
        const index = y * SIZE + x;
        const slope = Math.hypot(
            edgeReference[index + 1] - edgeReference[index - 1],
            edgeReference[index + SIZE] - edgeReference[index - SIZE]
        );
        if (slope <= 0.02) continue;
        const sector = Math.floor((Math.atan2(y - CENTER, x - CENTER) + Math.PI) * 4 / Math.PI);
        fitProbes.push({ index, group: sector % 2, weight: Math.min(3, 1 + slope * 6) });
    }
}

function bodyMedian(alpha) {
    const cutoff = Math.max(...alpha) * 0.85;
    const body = alpha.filter(value => value > cutoff).sort();
    return body[Math.floor((body.length - 1) / 2)];
}

function highPass(values) {
    const filtered = new Float32Array(values.length);
    for (let y = 2; y < SIZE - 2; y++) {
        for (let x = 2; x < SIZE - 2; x++) {
            let smooth = 0;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    smooth += values[(y + dy) * SIZE + x + dx] *
                        BINOMIAL_KERNEL[dy + 2] * BINOMIAL_KERNEL[dx + 2];
                }
            }
            const index = y * SIZE + x;
            filtered[index] = values[index] - smooth / 256;
        }
    }
    return filtered;
}

function estimateDeliveredAlpha(input, restored) {
    // Recover the effective white-overlay alpha from the shared pipeline output.
    return Float32Array.from({ length: SIZE * SIZE }, (_, index) => {
        const offset = index * 4;
        let cross = 0;
        let energy = 0;
        for (let channel = 0; channel < 3; channel++) {
            const output = restored[offset + channel];
            const headroom = 255 - output;
            if (headroom < 12 || output === 0) continue;
            cross += headroom * (input[offset + channel] - output);
            energy += headroom * headroom;
        }
        return energy > 0 ? Math.max(0, Math.min(0.9, cross / energy)) : 0;
    });
}

function measureFit(source, alpha) {
    const predicted = highPass(alpha.map(value => -Math.log(1 - value)));
    const totals = [0, 0];
    const weights = [0, 0];
    for (const { index, group, weight } of fitProbes) {
        const error = Math.abs(source[index] - predicted[index]);
        const loss = error < 0.055 ? error * error : 0.110 * error - 0.003025;
        totals[group] += loss * weight;
        weights[group] += weight;
    }
    return totals.map((total, index) => total / weights[index]);
}

function sourceEdges(input) {
    // For a white overlay, the background and alpha contribute additively in log headroom.
    return highPass(Float32Array.from({length: SIZE * SIZE}, (_, index) => {
        const offset = index * 4;
        const red = Math.log(Math.max(8, 255 - input[offset]));
        const green = Math.log(Math.max(8, 255 - input[offset + 1]));
        const blue = Math.log(Math.max(8, 255 - input[offset + 2]));
        return -(red + green + blue) / 3;
    }));
}

function fitEdge(input, alpha) {
    const body = bodyMedian(alpha);
    if (!(body > 0)) return null;

    const source = sourceEdges(input);
    const baseline = { loss: measureFit(source, alpha) };
    const candidates = EDGE_MIXES.map(mix => {
        const fittedAlpha = alpha.map((value, index) => {
            const target = edgeReference[index] * body / referenceBody;
            // Leave the shared body fixed and taper the blend from 70% to 92% of body opacity.
            const taper = Math.max(0, Math.min(1, (0.92 - Math.min(value, target) / body) / 0.22));
            return Math.min(0.9, value + (target - value) * mix * taper);
        });
        return { mix, alpha: fittedAlpha, loss: measureFit(source, fittedAlpha) };
    });
    return chooseFit(baseline, candidates);
}

function chooseFit(baseline, candidates) {
    const targets = baseline.loss.map(loss => loss * (1 - MIN_FIT_IMPROVEMENT));
    const bestInGroup = targets.map((_, group) => candidates.reduce((best, candidate) =>
        candidate.loss[group] < best.loss[group] ? candidate : best, baseline));
    if (bestInGroup.some((candidate, group) => candidate.loss[1 - group] >= targets[1 - group])) return null;

    let best = null;
    let bestScore = Infinity;
    for (const candidate of candidates) {
        if (!candidate.loss.every((loss, group) => loss < targets[group])) continue;
        const score = candidate.loss[0] / baseline.loss[0] + candidate.loss[1] / baseline.loss[1];
        if (score < bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best && { ...best, beforeLoss: baseline.loss };
}

function fitLocalAlignment(input, alphaMap, gain, deliveredShift) {
    const source = sourceEdges(input);
    const applyGain = alpha => alpha.map(value => Math.min(0.9, value * gain));
    const delivered = deliveredShift ? warpAlphaMap(alphaMap, SIZE, deliveredShift) : alphaMap;
    const baseline = {loss: measureFit(source, applyGain(delivered))};
    const candidates = [];
    for (const scale of ALIGN_SCALES) for (const dx of ALIGN_SHIFTS) for (const dy of ALIGN_SHIFTS) {
        const shift = {dx, dy, scale};
        const alpha = applyGain(warpAlphaMap(alphaMap, SIZE, shift));
        candidates.push({alpha, shift, loss: measureFit(source, alpha)});
    }
    return chooseFit(baseline, candidates);
}

function extractPixels(imageData, position) {
    const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
        const offset = ((position.y + y) * imageData.width + position.x) * 4;
        pixels.set(imageData.data.subarray(offset, offset + SIZE * 4), y * SIZE * 4);
    }
    return pixels;
}

export function refineV2MediumEdge(original, restored, meta, standardAlpha) {
    const position = meta?.position;
    if (
        !meta?.applied || meta.config?.alphaVariant !== 'v2' ||
        original.width !== 1376 || original.height !== 768 ||
        position?.width !== SIZE || position.height !== SIZE
    ) return;

    const exactMedium = meta.source?.includes('confirmed-v2-medium-rescue') &&
        position.x === original.width - SIZE - MARGIN && position.y === original.height - SIZE - MARGIN;
    const localMedium = meta.source?.includes('local-v2-verified-48') && standardAlpha?.length === SIZE * SIZE;
    if (!exactMedium && !localMedium) return;
    const pixels = extractPixels(original, position);
    const previous = extractPixels(restored, position);
    const fit = localMedium
        ? fitLocalAlignment(pixels, standardAlpha, meta.alphaGain, meta.templateWarp)
        : fitEdge(pixels, estimateDeliveredAlpha(pixels, previous));
    if (!fit) return;

    // Recompute from the source patch so the new alpha does not stack on old contour cleanup.
    removeWatermark({ width: SIZE, height: SIZE, data: pixels }, fit.alpha, LOCAL_REGION);
    let changedPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        if (localMedium) {
            // A shifted template must not extend the set of edited pixels.
            const offset = ((position.y + Math.floor(i / (SIZE * 4))) * original.width + position.x) * 4 + i % (SIZE * 4);
            if (previous[i] === original.data[offset] && previous[i + 1] === original.data[offset + 1] &&
                previous[i + 2] === original.data[offset + 2]) pixels.set(previous.subarray(i, i + 4), i);
        }
        if (pixels[i] !== previous[i] || pixels[i + 1] !== previous[i + 1] ||
            pixels[i + 2] !== previous[i + 2]) changedPixels++;
    }
    if (!changedPixels) return;

    for (let y = 0; y < SIZE; y++) {
        const offset = ((position.y + y) * restored.width + position.x) * 4;
        restored.data.set(pixels.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), offset);
    }
    const evidence = { imageData: restored, alphaMap: localMedium ? standardAlpha : v2Witness, region: position };
    const processedSpatialScore = computeRegionSpatialCorrelation(evidence);
    const processedGradientScore = computeRegionGradientCorrelation(evidence);
    if (localMedium) meta.templateWarp = fit.shift;
    else meta.edgeRefinement = {
        mix: fit.mix,
        changedPixels,
        beforeLoss: fit.beforeLoss,
        afterLoss: fit.loss,
        beforeSpatialScore: meta.detection.processedSpatialScore,
        beforeGradientScore: meta.detection.processedGradientScore,
        measurementProfile: 'v2-medium'
    };
    meta.detection = {
        ...meta.detection,
        processedSpatialScore,
        processedGradientScore,
        suppressionGain: meta.detection.originalSpatialScore - processedSpatialScore,
        residualVisibility: assessCalibratedWatermarkResidualVisibility({
            imageData: restored,
            originalImageData: original,
            position,
            alphaMap: fit.alpha,
            alphaGain: 1
        })
    };
    meta.source += localMedium ? '+v2-local-alignment' : '+v2-medium-edge-fit';
}

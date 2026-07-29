import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermarkFromImageDataSync } from '../src/sdk/image-data.js';
import { measureAlphaEdgeLocalizedError } from './alpha-edge-cleanliness.js';
import { decodeImageDataInNode } from './sample-benchmark.js';
import { compositeKnownWatermark } from './synthetic-residual-ground-truth.js';

const ROOT = path.resolve(
    '.artifacts/shadow-residual-profile-ensemble/directional-positive-spatial'
);
const LABELS_PATH = path.join(ROOT, 'visual-labels.json');
const SOURCE_PATH = path.join(ROOT, 'source-report.json');
const OUTPUT_PATH = path.join(ROOT, 'alpha-edge-cleanliness-exploration.json');
const DECOY_SHIFTS = Object.freeze([
    [-12, 0],
    [-8, 0],
    [-4, 0],
    [4, 0],
    [8, 0],
    [12, 0],
    [0, -12],
    [0, -8],
    [0, -4],
    [0, 4],
    [0, 8],
    [0, 12]
]);
const DECOY_BANKS = Object.freeze({
    near4: Object.freeze([
        [-4, 0],
        [4, 0],
        [0, -4],
        [0, 4],
        [-4, -4],
        [-4, 4],
        [4, -4],
        [4, 4]
    ]),
    mid8: Object.freeze([
        [-8, 0],
        [8, 0],
        [0, -8],
        [0, 8],
        [-8, -8],
        [-8, 8],
        [8, -8],
        [8, 8]
    ]),
    far12: Object.freeze([
        [-12, 0],
        [12, 0],
        [0, -12],
        [0, 12],
        [-12, -12],
        [-12, 12],
        [12, -12],
        [12, 12]
    ])
});
const GRID_DECOY_SHIFTS = Object.freeze(
    Array.from({ length: 13 }, (_, index) => -12 + index * 2)
        .flatMap((shiftY) =>
            Array.from({ length: 13 }, (_, index) => -12 + index * 2)
                .map((shiftX) => [shiftX, shiftY])
        )
        .filter(([shiftX, shiftY]) =>
            Math.hypot(shiftX, shiftY) >= 4
        )
);

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function alphaGradient(alphaMap, width, height) {
    const gx = new Float64Array(width * height);
    const gy = new Float64Array(width * height);
    const magnitude = new Float64Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const index = y * width + x;
            gx[index] =
                (alphaMap[index + 1] - alphaMap[index - 1]) / 2;
            gy[index] =
                (alphaMap[index + width] - alphaMap[index - width]) / 2;
            magnitude[index] = Math.hypot(gx[index], gy[index]);
        }
    }
    return { gx, gy, magnitude };
}

function shiftedIndex(x, y, width, height, shiftX, shiftY) {
    const sourceX = x - shiftX;
    const sourceY = y - shiftY;
    return sourceX >= 0 &&
        sourceY >= 0 &&
        sourceX < width &&
        sourceY < height
        ? sourceY * width + sourceX
        : -1;
}

function weightedMean(values, weights) {
    let total = 0;
    let weight = 0;
    for (let index = 0; index < values.length; index++) {
        total += values[index] * weights[index];
        weight += weights[index];
    }
    return weight > 0 ? total / weight : null;
}

function measureNormalFraction(
    orthogonal,
    gradient,
    width,
    height,
    shiftX = 0,
    shiftY = 0
) {
    let normalEnergy = 0;
    let tangentEnergy = 0;
    for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
            const gradientIndex = shiftedIndex(
                x,
                y,
                width,
                height,
                shiftX,
                shiftY
            );
            if (gradientIndex < 0) continue;
            const alphaMagnitude = gradient.magnitude[gradientIndex];
            if (alphaMagnitude <= Number.EPSILON) continue;
            const nx = gradient.gx[gradientIndex] / alphaMagnitude;
            const ny = gradient.gy[gradientIndex] / alphaMagnitude;
            const pixelIndex = y * width + x;
            for (let channel = 0; channel < 3; channel++) {
                const dx =
                    (
                        orthogonal[(pixelIndex + 1) * 3 + channel] -
                        orthogonal[(pixelIndex - 1) * 3 + channel]
                    ) / 2;
                const dy =
                    (
                        orthogonal[
                            (pixelIndex + width) * 3 + channel
                        ] -
                        orthogonal[
                            (pixelIndex - width) * 3 + channel
                        ]
                    ) / 2;
                const normal = dx * nx + dy * ny;
                const tangent = -dx * ny + dy * nx;
                normalEnergy += alphaMagnitude * normal * normal;
                tangentEnergy += alphaMagnitude * tangent * tangent;
            }
        }
    }
    const total = normalEnergy + tangentEnergy;
    return total > 0 ? normalEnergy / total : null;
}

function measureEdgeEvidence({
    originalImageData,
    candidateImageData,
    alphaMap,
    position,
    alphaGain
}) {
    const baseline = compositeKnownWatermark({
        truthImageData: originalImageData,
        alphaMap,
        position,
        alphaGain
    });
    const candidate = compositeKnownWatermark({
        truthImageData: candidateImageData,
        alphaMap,
        position,
        alphaGain
    });
    const pixelCount = position.width * position.height;
    const baselineVector = new Float64Array(pixelCount * 3);
    const candidateVector = new Float64Array(pixelCount * 3);
    let baselineEnergy = 0;
    let dot = 0;
    for (let localY = 0; localY < position.height; localY++) {
        for (let localX = 0; localX < position.width; localX++) {
            const localIndex = localY * position.width + localX;
            const globalIndex =
                (position.y + localY) * originalImageData.width +
                position.x +
                localX;
            for (let channel = 0; channel < 3; channel++) {
                const localOffset = localIndex * 3 + channel;
                const globalOffset = globalIndex * 4 + channel;
                const baselineError =
                    baseline.data[globalOffset] -
                    originalImageData.data[globalOffset];
                const candidateError =
                    candidate.data[globalOffset] -
                    originalImageData.data[globalOffset];
                baselineVector[localOffset] = baselineError;
                candidateVector[localOffset] = candidateError;
                baselineEnergy += baselineError * baselineError;
                dot += baselineError * candidateError;
            }
        }
    }
    const amplitude = baselineEnergy > 0 ? dot / baselineEnergy : 0;
    const orthogonal = new Float64Array(pixelCount * 3);
    const orthogonalPixelEnergy = new Float64Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        let energy = 0;
        for (let channel = 0; channel < 3; channel++) {
            const offset = pixelIndex * 3 + channel;
            const value =
                candidateVector[offset] -
                amplitude * baselineVector[offset];
            orthogonal[offset] = value;
            energy += value * value;
        }
        orthogonalPixelEnergy[pixelIndex] = energy / 3;
    }

    const gradient = alphaGradient(
        alphaMap,
        position.width,
        position.height
    );
    const alphaSquared = Float64Array.from(
        alphaMap,
        (alpha) => alpha * alpha
    );
    const support = Float64Array.from(
        alphaMap,
        (alpha) => alpha > 0.005 ? 1 : 0
    );
    const supportMean = weightedMean(orthogonalPixelEnergy, support);
    const alphaMean = weightedMean(
        orthogonalPixelEnergy,
        alphaSquared
    );
    const edgeLocalization = measureAlphaEdgeLocalizedError({
        errorVector: orthogonal,
        alphaMap,
        width: position.width,
        height: position.height,
        decoyShifts: DECOY_SHIFTS
    });
    const decoyBankRatios = Object.fromEntries(
        Object.entries(DECOY_BANKS).map(([name, decoyShifts]) => [
            name,
            measureAlphaEdgeLocalizedError({
                errorVector: orthogonal,
                alphaMap,
                width: position.width,
                height: position.height,
                decoyShifts
            }).edgeDecoyRatio
        ])
    );
    const gridLocalization = measureAlphaEdgeLocalizedError({
        errorVector: orthogonal,
        alphaMap,
        width: position.width,
        height: position.height,
        decoyShifts: GRID_DECOY_SHIFTS
    });
    const finiteGridDecoys = gridLocalization.decoyEdgeMeans.filter(
        Number.isFinite
    );
    const gridPercentile = finiteGridDecoys.length > 0
        ? finiteGridDecoys.filter(
            (value) => value <= gridLocalization.edgeWeightedMean
        ).length / finiteGridDecoys.length
        : null;
    const edgeMean = edgeLocalization.edgeWeightedMean;
    const normalFraction = measureNormalFraction(
        orthogonal,
        gradient,
        position.width,
        position.height
    );
    const decoyNormalFractions = DECOY_SHIFTS.map(([shiftX, shiftY]) =>
        measureNormalFraction(
            orthogonal,
            gradient,
            position.width,
            position.height,
            shiftX,
            shiftY
        )
    );
    const decoyEdgeMedian = edgeLocalization.decoyEdgeMedian;
    const decoyNormalMedian = median(decoyNormalFractions);
    return {
        signedTemplateAmplitude: amplitude,
        edgeMean,
        supportMean,
        alphaMean,
        edgeToSupportRatio:
            supportMean > 0 ? edgeMean / supportMean : null,
        edgeToAlphaRatio:
            alphaMean > 0 ? edgeMean / alphaMean : null,
        decoyEdgeMedian,
        edgeDecoyRatio: edgeLocalization.edgeDecoyRatio,
        edgeDecoyRatioNear4: decoyBankRatios.near4,
        edgeDecoyRatioMid8: decoyBankRatios.mid8,
        edgeDecoyRatioFar12: decoyBankRatios.far12,
        edgeDecoyGridRatio: gridLocalization.edgeDecoyRatio,
        edgeDecoyGridPercentile: gridPercentile,
        normalFraction,
        decoyNormalMedian,
        normalDecoyDelta:
            Number.isFinite(normalFraction) &&
            Number.isFinite(decoyNormalMedian)
                ? normalFraction - decoyNormalMedian
                : null
    };
}

function averagePrecision(records, field) {
    const sorted = records
        .filter((record) => Number.isFinite(record[field]))
        .sort((left, right) => right[field] - left[field]);
    const positives = sorted.filter((record) => record.label === 'dirty')
        .length;
    if (positives === 0) return null;
    let truePositives = 0;
    let precisionSum = 0;
    for (const [index, record] of sorted.entries()) {
        if (record.label !== 'dirty') continue;
        truePositives++;
        precisionSum += truePositives / (index + 1);
    }
    return precisionSum / positives;
}

function auc(records, field) {
    const dirty = records.filter(
        (record) =>
            record.label === 'dirty' && Number.isFinite(record[field])
    );
    const clean = records.filter(
        (record) =>
            record.label === 'clean' && Number.isFinite(record[field])
    );
    if (dirty.length === 0 || clean.length === 0) return null;
    let wins = 0;
    for (const positive of dirty) {
        for (const negative of clean) {
            wins += positive[field] > negative[field]
                ? 1
                : positive[field] === negative[field]
                    ? 0.5
                    : 0;
        }
    }
    return wins / (dirty.length * clean.length);
}

async function main() {
    const labels = JSON.parse(await readFile(LABELS_PATH, 'utf8'));
    const source = JSON.parse(await readFile(SOURCE_PATH, 'utf8'));
    const sourceByFileName = new Map(
        (source.results ?? []).map((record) => [record.fileName, record])
    );
    const selected = (labels.records ?? []).filter(
        (record) =>
            (record.label === 'dirty' || record.label === 'clean') &&
            record.size === 48
    );
    const alphaMap = getEmbeddedAlphaMap(48);
    const records = [];
    for (const [index, label] of selected.entries()) {
        console.log(
            `alpha edge exploration ${index + 1}/${selected.length}: ` +
            label.fileName
        );
        const sourceRecord = sourceByFileName.get(label.fileName);
        const originalImageData = await decodeImageDataInNode(
            sourceRecord.filePath
        );
        const processed = removeWatermarkFromImageDataSync(
            cloneImageData(originalImageData)
        );
        const position = processed.meta?.position ?? sourceRecord.position;
        const alphaGain = Number.isFinite(processed.meta?.alphaGain)
            ? processed.meta.alphaGain
            : 1;
        const evidence = measureEdgeEvidence({
            originalImageData,
            candidateImageData: processed.imageData,
            alphaMap,
            position,
            alphaGain
        });
        records.push({
            fileName: label.fileName,
            label: label.label,
            alphaGain,
            position,
            ...evidence
        });
    }
    const fields = [
        'edgeMean',
        'edgeToSupportRatio',
        'edgeToAlphaRatio',
        'edgeDecoyRatio',
        'edgeDecoyRatioNear4',
        'edgeDecoyRatioMid8',
        'edgeDecoyRatioFar12',
        'edgeDecoyGridRatio',
        'edgeDecoyGridPercentile',
        'normalFraction',
        'normalDecoyDelta'
    ];
    const ranking = Object.fromEntries(
        fields.map((field) => [
            field,
            {
                auc: auc(records, field),
                averagePrecision: averagePrecision(records, field)
            }
        ])
    );
    const report = {
        schema: 'alpha-edge-cleanliness-exploration/v1',
        generatedAt: new Date().toISOString(),
        mode: 'diagnostic-only',
        hypothesis:
            'visible cleanup halo concentrates orthogonal recomposition ' +
            'error and its gradient on the true alpha edge more than on ' +
            'translated decoy edges',
        selection: {
            size: 48,
            labels: ['dirty', 'clean'],
            count: records.length,
            dirty: records.filter((record) => record.label === 'dirty')
                .length,
            clean: records.filter((record) => record.label === 'clean')
                .length
        },
        ranking,
        records
    };
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ outputPath: OUTPUT_PATH, ranking }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

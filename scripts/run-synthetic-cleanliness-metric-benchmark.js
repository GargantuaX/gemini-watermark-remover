import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import {
    assessCalibratedWatermarkResidualVisibility,
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility,
    scoreRegion
} from '../src/core/restorationMetrics.js';
import { removeWatermarkFromImageDataSync } from '../src/sdk/image-data.js';
import {
    calculatePairwiseOrdering,
    createAmplitudeWeightedDirectionalEvidence,
    createDirectionalCandidate,
    createOrthogonalDamageCandidate,
    decomposeRecompositionError,
    measureRecompositionConsistency
} from './synthetic-cleanliness-benchmark.js';
import {
    compositeKnownWatermark,
    measureRestorationAgainstTruth
} from './synthetic-residual-ground-truth.js';
import { evaluateResidualProfileEvidence } from './shadow-residual-profile-ensemble.js';

const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const OUTPUT_DIRECTORY = path.join(
    ROOT,
    '.artifacts',
    'synthetic-cleanliness-metric-benchmark'
);
const IMAGE_SIZE = 512;
const WATERMARK_SIZE = 48;
const POSITION = {
    x: IMAGE_SIZE - WATERMARK_SIZE - 32,
    y: IMAGE_SIZE - WATERMARK_SIZE - 32,
    width: WATERMARK_SIZE,
    height: WATERMARK_SIZE
};
const CORE_CANDIDATE_NAMES = [
    'unchanged',
    'under-0.35',
    'clean',
    'over-0.35',
    'orthogonal-0.35'
];
const POWER_EXPONENTS = [0.65, 0.8, 0.9, 1, 1.1, 1.3, 1.55];

function clampByte(value) {
    return Math.min(255, Math.max(0, Math.round(value)));
}

function readOptionValue(name) {
    const index = process.argv.indexOf(name);
    if (index < 0) return null;
    const value = process.argv[index + 1];
    return value && !value.startsWith('--')
        ? value
        : null;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function createScene(sceneName, alphaMap) {
    const data = new Uint8ClampedArray(IMAGE_SIZE * IMAGE_SIZE * 4);
    for (let y = 0; y < IMAGE_SIZE; y++) {
        for (let x = 0; x < IMAGE_SIZE; x++) {
            const offset = (y * IMAGE_SIZE + x) * 4;
            let red;
            let green;
            let blue;
            if (sceneName === 'flat-mid') {
                red = 92;
                green = 104;
                blue = 116;
            } else if (sceneName === 'smooth-gradient') {
                red = 64 + (112 * x) / (IMAGE_SIZE - 1);
                green = 72 + (104 * y) / (IMAGE_SIZE - 1);
                blue = 88 + (72 * (x + y)) / (2 * (IMAGE_SIZE - 1));
            } else if (sceneName === 'deterministic-texture') {
                const hash = (
                    Math.imul(x + 17, 73856093) ^
                    Math.imul(y + 29, 19349663)
                ) >>> 0;
                const noise = (hash % 67) - 33;
                const wave =
                    18 * Math.sin(x * 0.19) +
                    14 * Math.cos(y * 0.23);
                red = 126 + noise * 0.65 + wave;
                green = 118 + noise * 0.45 - wave * 0.5;
                blue = 132 - noise * 0.4 + wave * 0.35;
            } else if (sceneName === 'strong-structure') {
                const localX = x - POSITION.x;
                const localY = y - POSITION.y;
                const inRoi =
                    localX >= 0 &&
                    localY >= 0 &&
                    localX < POSITION.width &&
                    localY < POSITION.height;
                const stripe =
                    inRoi &&
                    (
                        Math.abs(localX - localY) <= 2 ||
                        localX % 11 <= 2 ||
                        localY % 13 <= 2
                    );
                red = stripe ? 205 : 78 + ((x + y) % 23);
                green = stripe ? 58 : 112 + ((2 * x + y) % 19);
                blue = stripe ? 72 : 138 - ((x + 3 * y) % 17);
            } else if (sceneName === 'template-collision-control') {
                red = 104;
                green = 112;
                blue = 120;
                const localX = x - POSITION.x;
                const localY = y - POSITION.y;
                if (
                    localX >= 0 &&
                    localY >= 0 &&
                    localX < POSITION.width &&
                    localY < POSITION.height
                ) {
                    const alpha =
                        alphaMap[localY * POSITION.width + localX];
                    red += alpha * 105;
                    green += alpha * 92;
                    blue += alpha * 78;
                }
            } else {
                throw new Error(`Unknown synthetic scene: ${sceneName}`);
            }
            data[offset] = clampByte(red);
            data[offset + 1] = clampByte(green);
            data[offset + 2] = clampByte(blue);
            data[offset + 3] = 255;
        }
    }
    return { width: IMAGE_SIZE, height: IMAGE_SIZE, data };
}

function sampleBilinear(alphaMap, size, x, y) {
    if (x < 0 || y < 0 || x > size - 1 || y > size - 1) return 0;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(size - 1, x0 + 1);
    const y1 = Math.min(size - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const top =
        alphaMap[y0 * size + x0] * (1 - fx) +
        alphaMap[y0 * size + x1] * fx;
    const bottom =
        alphaMap[y1 * size + x0] * (1 - fx) +
        alphaMap[y1 * size + x1] * fx;
    return top * (1 - fy) + bottom * fy;
}

function independentlyDeformAlphaMap(alphaMap, size) {
    const blurred = new Float32Array(alphaMap.length);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let sum = 0;
            let weight = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const sourceX = x + dx;
                    const sourceY = y + dy;
                    if (
                        sourceX < 0 ||
                        sourceY < 0 ||
                        sourceX >= size ||
                        sourceY >= size
                    ) {
                        continue;
                    }
                    const kernelWeight =
                        dx === 0 && dy === 0
                            ? 4
                            : dx === 0 || dy === 0
                                ? 2
                                : 1;
                    sum +=
                        alphaMap[sourceY * size + sourceX] *
                        kernelWeight;
                    weight += kernelWeight;
                }
            }
            blurred[y * size + x] = sum / weight;
        }
    }

    const output = new Float32Array(alphaMap.length);
    const center = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sourceX =
                (x - center) / 1.025 + center - 0.43;
            const sourceY =
                (y - center) / 0.985 + center + 0.31;
            output[y * size + x] = sampleBilinear(
                blurred,
                size,
                sourceX,
                sourceY
            );
        }
    }
    return output;
}

function visibilityStrength(visibility) {
    if (!visibility) return 0;
    return Math.max(
        visibility.positiveHaloLum / 6,
        visibility.gradientResidual / 0.22,
        visibility.spatialResidual / 0.18
    );
}

function evaluateCandidate({
    scene,
    forwardVariant,
    candidateName,
    truthImageData,
    watermarkedImageData,
    calibrationOriginalImageData,
    candidateImageData,
    metricAlphaMap,
    pipelineMeta = null,
    candidateDiagnostics = null
}) {
    const truth = measureRestorationAgainstTruth({
        truthImageData,
        watermarkedImageData,
        candidateImageData,
        position: POSITION
    });
    const baseline = measureRestorationAgainstTruth({
        truthImageData,
        watermarkedImageData,
        candidateImageData: watermarkedImageData,
        position: POSITION
    });
    const rawVisibility = assessWatermarkResidualVisibility({
        imageData: candidateImageData,
        position: POSITION,
        alphaMap: metricAlphaMap
    });
    const calibratedVisibility =
        assessCalibratedWatermarkResidualVisibility({
            imageData: candidateImageData,
            originalImageData: calibrationOriginalImageData,
            position: POSITION,
            alphaMap: metricAlphaMap,
            alphaGain: 1
        });
    const scores = scoreRegion(
        candidateImageData,
        metricAlphaMap,
        POSITION
    );
    const shadow = evaluateResidualProfileEvidence({
        imageData: candidateImageData,
        position: POSITION,
        profiles: [
            {
                name: 'canonical-48',
                alphaMap: metricAlphaMap
            }
        ],
        powerExponents: POWER_EXPONENTS,
        shiftRadius: 2
    });
    const recomposition = measureRecompositionConsistency({
        originalImageData: watermarkedImageData,
        candidateImageData,
        alphaMap: metricAlphaMap,
        position: POSITION
    });
    const cycleProjection = decomposeRecompositionError({
        originalImageData: watermarkedImageData,
        candidateImageData,
        alphaMap: metricAlphaMap,
        position: POSITION
    });
    const profile = shadow.residualProfile;
    const existingArtifacts = assessRemovalDiffArtifacts({
        originalImageData: watermarkedImageData,
        candidateImageData,
        alphaMap: metricAlphaMap,
        position: POSITION,
        alphaGain: 1
    });
    const amplitudeWeighted =
        createAmplitudeWeightedDirectionalEvidence({
            spatialScore: scores.spatialScore,
            gradientScore: scores.gradientScore,
            weightedRecomposeError:
                existingArtifacts?.weightedRecomposeError ?? 0
        });

    return {
        scene,
        forwardVariant,
        candidateName,
        truth: {
            underAmplitude: truth.template.underAmplitude,
            overAmplitude: truth.template.overAmplitude,
            signedAmplitude: truth.template.signedAmplitude,
            templateRmse: truth.template.rmse,
            orthogonalRmse: truth.orthogonal.rmse,
            roiRmse: truth.roi.rmse,
            normalizedOrthogonalError:
                baseline.roi.rmse > 0
                    ? truth.orthogonal.rmse / baseline.roi.rmse
                    : null,
            normalizedTotalError:
                baseline.roi.rmse > 0
                    ? truth.roi.rmse / baseline.roi.rmse
                    : null
        },
        metric: {
            rawVisible: rawVisibility?.visible ?? null,
            calibratedVisible:
                calibratedVisibility?.calibratedVisible ?? null,
            metricRisk: calibratedVisibility?.metricRisk ?? null,
            visibilityStrength: visibilityStrength(rawVisibility),
            positiveHaloLum: rawVisibility?.positiveHaloLum ?? null,
            signedSpatial: scores.spatialScore,
            positiveSpatial: Math.max(0, scores.spatialScore),
            negativeSpatialMagnitude: Math.max(0, -scores.spatialScore),
            absoluteSpatial: Math.abs(scores.spatialScore),
            signedGradient: scores.gradientScore,
            legacyBestJoint: profile?.bestJointEvidence ?? null,
            recompositionRmse: recomposition.rmse,
            cycleSignedTemplateAmplitude:
                cycleProjection.signedTemplateAmplitude,
            cycleUnderRemoval: cycleProjection.underRemoval,
            cycleOverRemoval: cycleProjection.overRemoval,
            cycleNormalizedOrthogonalError:
                cycleProjection.normalizedOrthogonalError,
            cycleNormalizedTotalError:
                cycleProjection.normalizedTotalError,
            cycleProjectionStatus: cycleProjection.status,
            existingRecomposeError:
                existingArtifacts?.recomposeError ?? null,
            existingWeightedRecomposeError:
                existingArtifacts?.weightedRecomposeError ?? null,
            existingVisualArtifactCost:
                existingArtifacts?.visualArtifactCost ?? null,
            amplitudeWeightedTemplateArtifact:
                amplitudeWeighted.templateArtifact,
            amplitudeWeightedUnderRemoval:
                amplitudeWeighted.underRemoval,
            amplitudeWeightedOverRemoval:
                amplitudeWeighted.overRemoval,
            underBestJoint:
                profile?.directionalEvidence?.underRemoval
                    ?.bestJointEvidence ?? null,
            overBestJoint:
                profile?.directionalEvidence?.overRemoval
                    ?.bestJointEvidence ?? null,
            shadowEvidenceStatus: shadow.evidenceQuality.status
        },
        pipeline: pipelineMeta,
        candidateDiagnostics
    };
}

function selectPipelineMeta(meta) {
    return {
        applied: meta?.applied ?? null,
        skipReason: meta?.skipReason ?? null,
        source: meta?.source ?? null,
        alphaGain: meta?.alphaGain ?? null,
        selectedSize: meta?.position?.width ?? meta?.size ?? null,
        selectedPosition: meta?.position ?? null,
        qualityStatus: meta?.qualityStatus ?? null,
        rawVisible:
            meta?.detection?.residualVisibility?.rawVisible ?? null,
        calibratedVisible:
            meta?.detection?.residualVisibility?.calibratedVisible ??
            null
    };
}

function aggregatePairwise(
    records,
    truthKey,
    metricKey,
    truthTolerance = 0
) {
    const groups = new Map();
    for (const record of records) {
        if (!CORE_CANDIDATE_NAMES.includes(record.candidateName)) {
            continue;
        }
        const key = `${record.scene}:${record.forwardVariant}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    }

    let correct = 0;
    let compared = 0;
    let ties = 0;
    const byGroup = [];
    for (const [group, groupRecords] of groups) {
        const ordered = CORE_CANDIDATE_NAMES.map((candidateName) =>
            groupRecords.find(
                (record) => record.candidateName === candidateName
            )
        );
        if (ordered.some((record) => !record)) continue;
        const truthValues = ordered.map((record) => record.truth[truthKey]);
        const metricValues = ordered.map((record) => record.metric[metricKey]);
        const result = calculatePairwiseOrdering(
            truthValues,
            metricValues,
            { truthTolerance }
        );
        correct += result.correct;
        compared += result.compared;
        ties += result.ties;
        byGroup.push({ group, ...result });
    }
    return {
        accuracy: compared > 0 ? correct / compared : null,
        correct,
        compared,
        ties,
        byGroup
    };
}

function mean(values) {
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) return null;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function summarizeCandidates(records) {
    const summaries = [];
    const names = [...new Set(records.map((record) => record.candidateName))];
    for (const candidateName of names) {
        const selected = records.filter(
            (record) => record.candidateName === candidateName
        );
        summaries.push({
            candidateName,
            count: selected.length,
            truth: {
                underAmplitude: mean(
                    selected.map((record) => record.truth.underAmplitude)
                ),
                overAmplitude: mean(
                    selected.map((record) => record.truth.overAmplitude)
                ),
                orthogonalRmse: mean(
                    selected.map((record) => record.truth.orthogonalRmse)
                ),
                normalizedTotalError: mean(
                    selected.map(
                        (record) => record.truth.normalizedTotalError
                    )
                )
            },
            metric: {
                rawVisibleRate: mean(
                    selected.map((record) =>
                        record.metric.rawVisible === true ? 1 : 0
                    )
                ),
                calibratedVisibleRate: mean(
                    selected.map((record) =>
                        record.metric.calibratedVisible === true ? 1 : 0
                    )
                ),
                absoluteSpatial: mean(
                    selected.map((record) => record.metric.absoluteSpatial)
                ),
                underBestJoint: mean(
                    selected.map((record) => record.metric.underBestJoint)
                ),
                overBestJoint: mean(
                    selected.map((record) => record.metric.overBestJoint)
                ),
                recompositionRmse: mean(
                    selected.map((record) => record.metric.recompositionRmse)
                ),
                existingRecomposeError: mean(
                    selected.map(
                        (record) => record.metric.existingRecomposeError
                    )
                ),
                existingWeightedRecomposeError: mean(
                    selected.map(
                        (record) =>
                            record.metric.existingWeightedRecomposeError
                    )
                ),
                existingVisualArtifactCost: mean(
                    selected.map(
                        (record) => record.metric.existingVisualArtifactCost
                    )
                ),
                amplitudeWeightedTemplateArtifact: mean(
                    selected.map(
                        (record) =>
                            record.metric.amplitudeWeightedTemplateArtifact
                    )
                ),
                amplitudeWeightedUnderRemoval: mean(
                    selected.map(
                        (record) =>
                            record.metric.amplitudeWeightedUnderRemoval
                    )
                ),
                amplitudeWeightedOverRemoval: mean(
                    selected.map(
                        (record) =>
                            record.metric.amplitudeWeightedOverRemoval
                    )
                )
            }
        });
    }
    return summaries;
}

function formatNumber(value, digits = 4) {
    return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function createMarkdown(report) {
    const lines = [
        '# Synthetic cleanliness metric benchmark',
        '',
        `Generated: ${report.generatedAt}`,
        '',
        'This benchmark scores candidates against independent clean pixel truth. It does not set or tune production thresholds.',
        '',
        '## Pairwise ordering',
        '',
        '| Truth axis | Metric | Accuracy | Compared | Ties |',
        '|---|---|---:|---:|---:|'
    ];
    for (const entry of report.summary.pairwise) {
        lines.push(
            `| ${entry.truthAxis} | ${entry.metric} | ${formatNumber(
                entry.result.accuracy,
                3
            )} | ${entry.result.compared} | ${entry.result.ties} |`
        );
    }
    lines.push(
        '',
        '## Candidate means',
        '',
        '| Candidate | n | R-under | D-over | D-orth RMSE | Total / watermark | Raw visible | Calibrated visible | |spatial| | Shadow R | Shadow D | Cycle RMSE |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
    );
    for (const entry of report.summary.candidates) {
        lines.push(
            `| ${entry.candidateName} | ${entry.count} | ` +
                `${formatNumber(entry.truth.underAmplitude)} | ` +
                `${formatNumber(entry.truth.overAmplitude)} | ` +
                `${formatNumber(entry.truth.orthogonalRmse)} | ` +
                `${formatNumber(entry.truth.normalizedTotalError)} | ` +
                `${formatNumber(entry.metric.rawVisibleRate, 3)} | ` +
                `${formatNumber(
                    entry.metric.calibratedVisibleRate,
                    3
                )} | ` +
                `${formatNumber(entry.metric.absoluteSpatial)} | ` +
                `${formatNumber(entry.metric.underBestJoint)} | ` +
                `${formatNumber(entry.metric.overBestJoint)} | ` +
                `${formatNumber(entry.metric.recompositionRmse)} |`
        );
    }
    lines.push(
        '',
        '## Pipeline outputs',
        '',
        '| Scene | Forward | Applied | Skip | R-under | D-over | D-orth RMSE | Total / watermark | Raw visible | Calibrated visible |',
        '|---|---|---:|---|---:|---:|---:|---:|---:|---:|'
    );
    for (const record of report.records.filter((item) =>
        item.candidateName.startsWith('pipeline')
    )) {
        lines.push(
            `| ${record.scene} | ${record.forwardVariant} | ` +
                `${String(record.pipeline?.applied ?? 'n/a')} | ` +
                `${record.pipeline?.skipReason ?? ''} | ` +
                `${formatNumber(record.truth.underAmplitude)} | ` +
                `${formatNumber(record.truth.overAmplitude)} | ` +
                `${formatNumber(record.truth.orthogonalRmse)} | ` +
                `${formatNumber(record.truth.normalizedTotalError)} | ` +
                `${String(record.metric.rawVisible)} | ` +
                `${String(record.metric.calibratedVisible)} |`
        );
    }
    lines.push(
        '',
        '## Guardrails',
        '',
        '- Candidate truth uses the observed forward delta `W-C`, not the evaluated alpha profile.',
        '- Under, over, and orthogonal damage are separate axes; tied truth values are not forced into an arbitrary order.',
        '- The mismatch forward profile is independently blurred, anisotropically scaled, and subpixel shifted.',
        '- The template-collision scene is an explicit non-identifiability stress control and should be reported separately from ordinary scenes.',
        ''
    );
    return lines.join('\n');
}

async function main() {
    const skipPipeline = process.argv.includes('--skip-pipeline');
    const requestedScene = readOptionValue('--scene');
    const requestedForward = readOptionValue('--forward');
    const canonicalAlpha = getEmbeddedAlphaMap(48);
    if (!canonicalAlpha) {
        throw new Error('Embedded 48px alpha map is unavailable');
    }
    const mismatchAlpha = independentlyDeformAlphaMap(
        canonicalAlpha,
        WATERMARK_SIZE
    );
    let forwardVariants = [
        {
            name: 'canonical',
            alphaMap: canonicalAlpha,
            alphaGain: 1
        },
        {
            name: 'independent-mismatch',
            alphaMap: mismatchAlpha,
            alphaGain: 0.92
        }
    ];
    let scenes = [
        'flat-mid',
        'smooth-gradient',
        'deterministic-texture',
        'strong-structure',
        'template-collision-control'
    ];
    if (requestedScene) {
        scenes = scenes.filter((scene) => scene === requestedScene);
        if (scenes.length === 0) {
            throw new Error(`Unknown --scene value: ${requestedScene}`);
        }
    }
    if (requestedForward) {
        forwardVariants = forwardVariants.filter(
            (variant) => variant.name === requestedForward
        );
        if (forwardVariants.length === 0) {
            throw new Error(
                `Unknown --forward value: ${requestedForward}`
            );
        }
    }
    const records = [];

    for (const scene of scenes) {
        const truthImageData = createScene(scene, canonicalAlpha);
        for (const forwardVariant of forwardVariants) {
            const watermarkedImageData = compositeKnownWatermark({
                truthImageData,
                alphaMap: forwardVariant.alphaMap,
                alphaGain: forwardVariant.alphaGain,
                position: POSITION
            });
            const orthogonal = createOrthogonalDamageCandidate({
                truthImageData,
                watermarkedImageData,
                position: POSITION,
                targetFraction: 0.35
            });
            const candidates = [
                {
                    name: 'unchanged',
                    imageData: cloneImageData(watermarkedImageData)
                },
                {
                    name: 'under-0.35',
                    imageData: createDirectionalCandidate({
                        truthImageData,
                        watermarkedImageData,
                        position: POSITION,
                        factor: 0.35
                    })
                },
                {
                    name: 'clean',
                    imageData: cloneImageData(truthImageData)
                },
                {
                    name: 'over-0.35',
                    imageData: createDirectionalCandidate({
                        truthImageData,
                        watermarkedImageData,
                        position: POSITION,
                        factor: -0.35
                    })
                },
                {
                    name: 'orthogonal-0.35',
                    imageData: orthogonal.imageData,
                    diagnostics: orthogonal.diagnostics
                }
            ];
            for (const candidate of candidates) {
                records.push(
                    evaluateCandidate({
                        scene,
                        forwardVariant: forwardVariant.name,
                        candidateName: candidate.name,
                        truthImageData,
                        watermarkedImageData,
                        calibrationOriginalImageData: watermarkedImageData,
                        candidateImageData: candidate.imageData,
                        metricAlphaMap: canonicalAlpha,
                        candidateDiagnostics: candidate.diagnostics ?? null
                    })
                );
            }

            if (!skipPipeline) {
                const processed = removeWatermarkFromImageDataSync(
                    cloneImageData(watermarkedImageData)
                );
                records.push(
                    evaluateCandidate({
                        scene,
                        forwardVariant: forwardVariant.name,
                        candidateName: 'pipeline-watermarked',
                        truthImageData,
                        watermarkedImageData,
                        calibrationOriginalImageData: watermarkedImageData,
                        candidateImageData: processed.imageData,
                        metricAlphaMap: canonicalAlpha,
                        pipelineMeta: selectPipelineMeta(processed.meta)
                    })
                );

                if (forwardVariant.name === 'canonical') {
                    const cleanProcessed = removeWatermarkFromImageDataSync(
                        cloneImageData(truthImageData)
                    );
                    records.push(
                        evaluateCandidate({
                            scene,
                            forwardVariant: forwardVariant.name,
                            candidateName: 'pipeline-clean-control',
                            truthImageData,
                            watermarkedImageData,
                            calibrationOriginalImageData: truthImageData,
                            candidateImageData: cleanProcessed.imageData,
                            metricAlphaMap: canonicalAlpha,
                            pipelineMeta: selectPipelineMeta(
                                cleanProcessed.meta
                            )
                        })
                    );
                }
            }
        }
    }

    const pairwiseSpecs = [
        {
            truthAxis: 'R-under',
            truthKey: 'underAmplitude',
            metric: 'positive spatial',
            metricKey: 'positiveSpatial',
            truthTolerance: 0.01
        },
        {
            truthAxis: 'R-under',
            truthKey: 'underAmplitude',
            metric: 'shadow R best-joint',
            metricKey: 'underBestJoint',
            truthTolerance: 0.01
        },
        {
            truthAxis: 'R-under',
            truthKey: 'underAmplitude',
            metric: 'self-cycle projection R',
            metricKey: 'cycleUnderRemoval',
            truthTolerance: 0.01
        },
        {
            truthAxis: 'R-under',
            truthKey: 'underAmplitude',
            metric: 'amplitude-weighted selected gradient R',
            metricKey: 'amplitudeWeightedUnderRemoval',
            truthTolerance: 0.01
        },
        {
            truthAxis: 'D-over',
            truthKey: 'overAmplitude',
            metric: 'negative spatial magnitude',
            metricKey: 'negativeSpatialMagnitude',
            truthTolerance: 0.01
        },
        {
            truthAxis: 'D-over',
            truthKey: 'overAmplitude',
            metric: 'shadow D best-joint',
            metricKey: 'overBestJoint',
            truthTolerance: 0.01
        },
        {
            truthAxis: 'D-over',
            truthKey: 'overAmplitude',
            metric: 'self-cycle projection D',
            metricKey: 'cycleOverRemoval',
            truthTolerance: 0.01
        },
        {
            truthAxis: 'D-over',
            truthKey: 'overAmplitude',
            metric: 'amplitude-weighted selected gradient D',
            metricKey: 'amplitudeWeightedOverRemoval',
            truthTolerance: 0.01
        },
        {
            truthAxis: 'orthogonal ROI error',
            truthKey: 'normalizedOrthogonalError',
            metric: 'self-cycle orthogonal error',
            metricKey: 'cycleNormalizedOrthogonalError',
            truthTolerance: 0.02
        },
        {
            truthAxis: 'total ROI error',
            truthKey: 'normalizedTotalError',
            metric: 'self-cycle normalized total error',
            metricKey: 'cycleNormalizedTotalError',
            truthTolerance: 0.02
        },
        {
            truthAxis: 'total ROI error',
            truthKey: 'normalizedTotalError',
            metric: 'legacy visibility strength',
            metricKey: 'visibilityStrength',
            truthTolerance: 0.02
        },
        {
            truthAxis: 'total ROI error',
            truthKey: 'normalizedTotalError',
            metric: 'recomposition cycle RMSE',
            metricKey: 'recompositionRmse',
            truthTolerance: 0.02
        },
        {
            truthAxis: 'total ROI error',
            truthKey: 'normalizedTotalError',
            metric: 'existing recompose error',
            metricKey: 'existingRecomposeError',
            truthTolerance: 0.02
        },
        {
            truthAxis: 'total ROI error',
            truthKey: 'normalizedTotalError',
            metric: 'existing weighted recompose error',
            metricKey: 'existingWeightedRecomposeError',
            truthTolerance: 0.02
        },
        {
            truthAxis: 'total ROI error',
            truthKey: 'normalizedTotalError',
            metric: 'existing visual artifact cost',
            metricKey: 'existingVisualArtifactCost',
            truthTolerance: 0.02
        }
    ];
    const pairwise = pairwiseSpecs.map((spec) => ({
        truthAxis: spec.truthAxis,
        metric: spec.metric,
        truthTolerance: spec.truthTolerance,
        result: aggregatePairwise(
            records,
            spec.truthKey,
            spec.metricKey,
            spec.truthTolerance
        )
    }));
    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        experiment: {
            imageSize: IMAGE_SIZE,
            position: POSITION,
            scenes,
            forwardVariants: forwardVariants.map((variant) => ({
                name: variant.name,
                alphaGain: variant.alphaGain
            })),
            candidateNames: CORE_CANDIDATE_NAMES,
            targetDirectionalFraction: 0.35,
            metricProfiles: ['canonical-48'],
            powerExponents: POWER_EXPONENTS,
            shiftRadius: 2,
            skipPipeline
        },
        summary: {
            recordCount: records.length,
            pairwise,
            candidates: summarizeCandidates(records)
        },
        records
    };

    await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });
    const scopeSuffix = [
        requestedScene,
        requestedForward
    ].filter(Boolean).join('-');
    const outputStem = [
        skipPipeline ? 'latest-quick' : 'latest',
        scopeSuffix
    ].filter(Boolean).join('-');
    await Promise.all([
        fs.writeFile(
            path.join(OUTPUT_DIRECTORY, `${outputStem}.json`),
            `${JSON.stringify(report, null, 2)}\n`
        ),
        fs.writeFile(
            path.join(OUTPUT_DIRECTORY, `${outputStem}.md`),
            createMarkdown(report)
        )
    ]);
    console.log(
        JSON.stringify(
            {
                outputDirectory: OUTPUT_DIRECTORY,
                outputStem,
                recordCount: records.length,
                pairwise: pairwise.map((entry) => ({
                    truthAxis: entry.truthAxis,
                    metric: entry.metric,
                    accuracy: entry.result.accuracy,
                    compared: entry.result.compared,
                    ties: entry.result.ties
                })),
                candidates: report.summary.candidates
            },
            null,
            2
        )
    );
}

await main();

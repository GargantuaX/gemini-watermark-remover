import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermarkFromImageDataSync } from '../src/sdk/image-data.js';
import { measureAlphaEdgeRecompositionEvidence } from './alpha-edge-cleanliness.js';
import { decodeImageDataInNode } from './sample-benchmark.js';
import {
    createResidualProfileShadowObservation,
    evaluateResidualProfileEvidence
} from './shadow-residual-profile-ensemble.js';
import {
    selectShadowResidualProfileRecords,
    summarizeShadowResidualProfileRecords
} from './run-shadow-residual-profile-ensemble.js';
import {
    createAmplitudeWeightedDirectionalEvidence,
    evaluateRecompositionProfileBank
} from './synthetic-cleanliness-benchmark.js';

const DEFAULT_REPORT_PATHS = Object.freeze([
    '.artifacts/wrong-anchor-next/full-validation-hardened-history.json',
    '.artifacts/wrong-anchor-next/full-validation-hardened-recent-part1-a.json',
    '.artifacts/wrong-anchor-next/full-validation-hardened-recent-part1-b.json',
    '.artifacts/wrong-anchor-next/full-validation-hardened-recent-part2a.json',
    '.artifacts/wrong-anchor-next/full-validation-hardened-recent-part2b.json'
]);
const DEFAULT_OUTPUT_PATH =
    '.artifacts/shadow-residual-profile-ensemble/latest.json';
const POWER_EXPONENTS = Object.freeze([
    0.4,
    0.6,
    0.8,
    1,
    1.25,
    1.6,
    2.2
]);
const SHIFT_RADIUS = 2;
const ALPHA_EDGE_GRID_SHIFTS = Object.freeze(
    Array.from({ length: 13 }, (_, index) => -12 + index * 2)
        .flatMap((shiftY) =>
            Array.from({ length: 13 }, (_, index) => -12 + index * 2)
                .map((shiftX) => [shiftX, shiftY])
        )
        .filter(([shiftX, shiftY]) =>
            Math.hypot(shiftX, shiftY) >= 4
        )
);

function parsePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0
        ? parsed
        : fallback;
}

export function parseArgs(argv = process.argv.slice(2)) {
    const reportPaths = [];
    let outputPath = path.resolve(DEFAULT_OUTPUT_PATH);
    let offset = 0;
    let limit = Infinity;
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            const value = args.shift();
            if (value) reportPaths.push(path.resolve(value));
            continue;
        }
        if (arg === '--reports') {
            const value = args.shift();
            for (const item of value?.split(',') ?? []) {
                if (item.trim()) reportPaths.push(path.resolve(item.trim()));
            }
            continue;
        }
        if (arg === '--output') {
            outputPath = path.resolve(args.shift() ?? DEFAULT_OUTPUT_PATH);
            continue;
        }
        if (arg === '--offset') {
            offset = parsePositiveInteger(args.shift(), offset);
            continue;
        }
        if (arg === '--limit') {
            const parsed = parsePositiveInteger(args.shift(), limit);
            limit = parsed > 0 ? parsed : limit;
        }
    }
    return {
        reportPaths: reportPaths.length > 0
            ? reportPaths
            : DEFAULT_REPORT_PATHS.map((item) => path.resolve(item)),
        outputPath,
        offset,
        limit
    };
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function normalizePolarity(value) {
    if (
        value === 'white' ||
        value === 'light' ||
        value === 'positive' ||
        value === 1
    ) {
        return 'white';
    }
    if (
        value === 'dark' ||
        value === 'black' ||
        value === 'negative' ||
        value === -1
    ) {
        return 'dark';
    }
    return null;
}

function resolvePolarity(meta, historicalRecord) {
    const candidates = [
        meta?.decisionPath?.detectionCandidate?.polarityHint,
        meta?.selectedCandidate?.polarity,
        meta?.selectionDebug?.selected?.polarity,
        historicalRecord?.decisionPath?.detectionCandidate?.polarityHint,
        historicalRecord?.decisionPath?.alphaTrial?.artifacts?.alphaPolarity
    ];
    for (const candidate of candidates) {
        const polarity = normalizePolarity(candidate);
        if (polarity) return polarity;
    }
    return null;
}

function resolvePosition(meta, historicalRecord) {
    return (
        meta?.position ??
        meta?.decisionPath?.alphaTrial?.position ??
        historicalRecord?.position ??
        null
    );
}

function unavailableEvidence(reason) {
    return {
        residualProfile: null,
        evidenceQuality: {
            status: 'unavailable',
            reason,
            expectedTrialCount: 0,
            evaluatedTrialCount: 0
        }
    };
}

export function resolveProfileBank({ position, polarity }) {
    const width = position?.width;
    const height = position?.height;
    if (
        !Number.isInteger(width) ||
        width <= 0 ||
        height !== width ||
        (width !== 36 && width !== 48 && width !== 96)
    ) {
        return {
            geometrySupport: 'unsupported',
            polaritySupport: polarity === 'white'
                ? 'supported'
                : 'unsupported',
            reason: 'unsupported-geometry',
            profiles: []
        };
    }
    if (polarity !== 'white') {
        return {
            geometrySupport: 'supported',
            polaritySupport: 'unsupported',
            reason: 'unsupported-polarity',
            profiles: []
        };
    }
    const profiles = width === 36
        ? [{
            // A 36px preview is the evidenced 48px large-margin profile
            // projected from 1376x768 to 1024x576, not a new native family.
            name: '36-projected-48',
            alphaMap: interpolateAlphaMap(
                getEmbeddedAlphaMap(48),
                48,
                36
            )
        }]
        : width === 48
        ? [{
            name: '48-default',
            alphaMap: getEmbeddedAlphaMap(48)
        }]
        : [
            {
                name: '96-default',
                alphaMap: getEmbeddedAlphaMap(96)
            },
            {
                name: '96-20260520',
                alphaMap: getEmbeddedAlphaMap('96-20260520')
            }
        ];
    if (profiles.some((profile) => !profile.alphaMap)) {
        return {
            geometrySupport: 'supported',
            polaritySupport: 'supported',
            reason: 'profile-bank-unavailable',
            profiles: []
        };
    }
    return {
        geometrySupport: 'supported',
        polaritySupport: 'supported',
        reason: null,
        profiles
    };
}

function createDecisionDrift(historicalVisibility, currentVisibility) {
    const historicalComparable =
        typeof historicalVisibility?.rawVisible === 'boolean' &&
        typeof historicalVisibility?.calibratedVisible === 'boolean';
    const currentComparable =
        typeof currentVisibility?.rawVisible === 'boolean' &&
        typeof currentVisibility?.calibratedVisible === 'boolean';
    const comparable = historicalComparable && currentComparable;
    if (!comparable) {
        return {
            comparable: false,
            rawVisibleChanged: null,
            calibratedVisibleChanged: null,
            anyDecisionChanged: null
        };
    }
    const rawVisibleChanged =
        historicalVisibility.rawVisible !== currentVisibility.rawVisible;
    const calibratedVisibleChanged =
        historicalVisibility.calibratedVisible !==
        currentVisibility.calibratedVisible;
    return {
        comparable: true,
        rawVisibleChanged,
        calibratedVisibleChanged,
        anyDecisionChanged:
            rawVisibleChanged || calibratedVisibleChanged
    };
}

function compactPosition(position) {
    if (!position) return null;
    return {
        x: position.x ?? null,
        y: position.y ?? null,
        width: position.width ?? null,
        height: position.height ?? null
    };
}

function samePosition(left, right) {
    if (!left || !right) return null;
    return (
        left.x === right.x &&
        left.y === right.y &&
        left.width === right.width &&
        left.height === right.height
    );
}

function createBaseRecord(record) {
    return {
        sourceReport: record.sourceReport,
        resultIndex: record.resultIndex,
        fileName: record.fileName ?? path.basename(record.filePath),
        filePath: record.filePath,
        dimensions: {
            width: record.width ?? null,
            height: record.height ?? null
        },
        historical: {
            visibilitySource: record.historicalVisibilitySource,
            residualVisibility: record.historicalResidualVisibility,
            qualityStatus:
                record.qualityStatus ??
                record.qualitySignals?.qualityStatus ??
                null,
            position: compactPosition(record.position),
            polarity: resolvePolarity(null, record)
        }
    };
}

function unavailableAlphaEdgeEvidence(reason) {
    return {
        status: 'unavailable',
        reason,
        role: 'research-diagnostic-only',
        validationStatus: 'rejected-heldout',
        validationReason:
            'phase-shifted-heldout-auc-near-random',
        profile: null,
        alphaGain: null,
        signedTemplateAmplitude: null,
        normalizedTotalError: null,
        edgeWeightedMean: null,
        decoyEdgeMedian: null,
        edgeDecoyRatio: null,
        gridPercentile: null,
        productionDecisionChanged: false
    };
}

function createAlphaEdgeEvidence({
    originalImageData,
    candidateImageData,
    position,
    bank,
    alphaGain
}) {
    if (position?.width !== 48 || position?.height !== 48) {
        return unavailableAlphaEdgeEvidence(
            'alpha-edge-evidence-only-validated-for-48px'
        );
    }
    const profile = bank.profiles.find(
        (candidate) => candidate.name === '48-default'
    );
    if (!profile) {
        return unavailableAlphaEdgeEvidence(
            'alpha-edge-profile-unavailable'
        );
    }
    const evidence = measureAlphaEdgeRecompositionEvidence({
        originalImageData,
        candidateImageData,
        alphaMap: profile.alphaMap,
        position,
        alphaGain,
        decoyShifts: ALPHA_EDGE_GRID_SHIFTS
    });
    const finiteDecoys = evidence.decoyEdgeMeans.filter(Number.isFinite);
    const hasAbsoluteEvidence =
        Number.isFinite(evidence.edgeWeightedMean) &&
        evidence.edgeWeightedMean > Number.EPSILON &&
        Number.isFinite(evidence.decoyEdgeMedian) &&
        evidence.decoyEdgeMedian > Number.EPSILON;
    const gridPercentile =
        hasAbsoluteEvidence && finiteDecoys.length > 0
            ? finiteDecoys.filter(
                (value) => value <= evidence.edgeWeightedMean
            ).length / finiteDecoys.length
            : null;
    return {
        status: 'complete',
        reason: null,
        role: 'research-diagnostic-only',
        validationStatus: 'rejected-heldout',
        validationReason:
            'phase-shifted-heldout-auc-near-random',
        profile: profile.name,
        alphaGain,
        signedTemplateAmplitude:
            evidence.signedTemplateAmplitude,
        normalizedTotalError: evidence.normalizedTotalError,
        edgeWeightedMean: evidence.edgeWeightedMean,
        decoyEdgeMedian: evidence.decoyEdgeMedian,
        edgeDecoyRatio: evidence.edgeDecoyRatio,
        gridPercentile,
        productionDecisionChanged: false
    };
}

export async function processShadowResidualProfileRecord(
    record,
    {
        decodeImageData = decodeImageDataInNode,
        processImageData = removeWatermarkFromImageDataSync
    } = {}
) {
    const base = createBaseRecord(record);
    const startedAt = performance.now();
    try {
        const originalImageData = await decodeImageData(record.filePath);
        const processed = processImageData(cloneImageData(originalImageData));
        const currentMeta = processed.meta ?? {};
        const currentPosition = resolvePosition(currentMeta, record);
        const currentPolarity = resolvePolarity(currentMeta, record);
        const currentVisibility = currentMeta.detection?.residualVisibility ??
            currentMeta.qualitySignals?.visibility ??
            null;
        const visibilityForObservation = currentVisibility
            ? {
                ...currentVisibility,
                qualityStatus:
                    currentMeta.qualityStatus ??
                    currentMeta.qualitySignals?.qualityStatus ??
                    null
            }
            : null;
        const bank = resolveProfileBank({
            position: currentPosition,
            polarity: currentPolarity
        });
        const evidence = bank.reason
            ? unavailableEvidence(bank.reason)
            : evaluateResidualProfileEvidence({
                imageData: processed.imageData,
                position: currentPosition,
                profiles: bank.profiles,
                powerExponents: POWER_EXPONENTS,
                shiftRadius: SHIFT_RADIUS
            });
        const recomposition = bank.reason
            ? {
                status: 'unavailable',
                reason: bank.reason,
                best: null,
                trials: []
            }
            : evaluateRecompositionProfileBank({
                originalImageData,
                candidateImageData: processed.imageData,
                position: currentPosition,
                profiles: bank.profiles,
                alphaGain: Number.isFinite(currentMeta.alphaGain)
                    ? currentMeta.alphaGain
                    : 1
            });
        const alphaGain = Number.isFinite(currentMeta.alphaGain)
            ? currentMeta.alphaGain
            : 1;
        const alphaEdgeEvidence = bank.reason
            ? unavailableAlphaEdgeEvidence(bank.reason)
            : createAlphaEdgeEvidence({
                originalImageData,
                candidateImageData: processed.imageData,
                position: currentPosition,
                bank,
                alphaGain
            });
        const selectedArtifacts =
            currentMeta.decisionPath?.alphaTrial?.artifacts ??
            currentMeta.qualitySignals?.artifacts ??
            null;
        const selectedCandidateEvidence =
            Number.isFinite(selectedArtifacts?.spatialScore) &&
            Number.isFinite(selectedArtifacts?.gradientScore) &&
            Number.isFinite(selectedArtifacts?.weightedRecomposeError)
                ? {
                    ...createAmplitudeWeightedDirectionalEvidence({
                        spatialScore: selectedArtifacts.spatialScore,
                        gradientScore: selectedArtifacts.gradientScore,
                        weightedRecomposeError:
                            selectedArtifacts.weightedRecomposeError
                    }),
                    source: 'selected-alpha-trial-artifacts'
                }
                : null;
        const observation = createResidualProfileShadowObservation({
            currentResidualVisibility: visibilityForObservation,
            evidence
        });
        return {
            ...base,
            replay: {
                status: 'completed',
                processingMs: Number(
                    (performance.now() - startedAt).toFixed(3)
                ),
                applied: currentMeta.applied === true,
                skipReason: currentMeta.skipReason ?? null,
                source: currentMeta.source ?? null,
                qualityStatus:
                    currentMeta.qualityStatus ??
                    currentMeta.qualitySignals?.qualityStatus ??
                    null,
                position: compactPosition(currentPosition),
                positionSource: currentMeta.position
                    ? 'current'
                    : 'historical-fallback',
                positionChanged:
                    samePosition(record.position, currentPosition) === null
                        ? null
                        : !samePosition(record.position, currentPosition),
                polarity: currentPolarity,
                residualVisibility: currentVisibility,
                decisionDrift: createDecisionDrift(
                    record.historicalResidualVisibility,
                    currentVisibility
                )
            },
            recomposition,
            alphaEdgeEvidence,
            ...observation,
            selectedCandidateEvidence,
            q: {
                ...observation.q,
                geometrySupport: bank.geometrySupport,
                polaritySupport: bank.polaritySupport,
                unavailableReason:
                    evidence.evidenceQuality?.reason ?? bank.reason,
                profileCount: bank.profiles.length,
                powerExponentCount: POWER_EXPONENTS.length,
                shiftRadius: SHIFT_RADIUS
            }
        };
    } catch (error) {
        const evidence = unavailableEvidence('replay-error');
        const observation = createResidualProfileShadowObservation({
            currentResidualVisibility: null,
            evidence
        });
        return {
            ...base,
            replay: {
                status: 'error',
                processingMs: Number(
                    (performance.now() - startedAt).toFixed(3)
                ),
                error:
                    error instanceof Error
                        ? error.message
                        : String(error),
                decisionDrift: createDecisionDrift(
                    record.historicalResidualVisibility,
                    null
                )
            },
            ...observation,
            alphaEdgeEvidence: null,
            selectedCandidateEvidence: null,
            q: {
                ...observation.q,
                geometrySupport: 'unknown',
                polaritySupport: 'unknown',
                unavailableReason: 'replay-error',
                profileCount: 0,
                powerExponentCount: POWER_EXPONENTS.length,
                shiftRadius: SHIFT_RADIUS
            }
        };
    }
}

async function readSourceReport(reportPath) {
    const buffer = await readFile(reportPath);
    const report = JSON.parse(
        buffer.toString('utf8').replace(/^\uFEFF/, '')
    );
    return {
        sourceReport: path.resolve(reportPath),
        sha256: createHash('sha256').update(buffer).digest('hex'),
        generatedAt: report.generatedAt ?? null,
        results: Array.isArray(report.results) ? report.results : []
    };
}

export async function runShadowResidualProfileEnsemble({
    reportPaths = DEFAULT_REPORT_PATHS.map((item) => path.resolve(item)),
    outputPath = path.resolve(DEFAULT_OUTPUT_PATH),
    offset = 0,
    limit = Infinity,
    onProgress = ({ completed, total, record }) => {
        console.log(
            `shadow residual profile: ${completed}/${total} ` +
            `${record.fileName}`
        );
    }
} = {}) {
    const sources = await Promise.all(reportPaths.map(readSourceReport));
    const selection = selectShadowResidualProfileRecords(sources);
    const selectedRecords = selection.records.slice(
        offset,
        Number.isFinite(limit) ? offset + limit : undefined
    );
    const records = [];
    for (const [index, record] of selectedRecords.entries()) {
        console.log(
            `shadow residual profile start: ${index + 1}/` +
            `${selectedRecords.length} ${record.fileName}`
        );
        const processed = await processShadowResidualProfileRecord(record);
        records.push(processed);
        onProgress({
            completed: index + 1,
            total: selectedRecords.length,
            record: processed
        });
    }
    const report = {
        schema: 'shadow-residual-profile-ensemble/v1',
        generatedAt: new Date().toISOString(),
        mode: 'offline-shadow',
        productionIntegration: false,
        evaluator: {
            decisionSemantics: 'none',
            thresholds: null,
            supportedGeometry: [36, 48, 96],
            supportedPolarity: ['white'],
            profileBank: {
                36: ['36-projected-48'],
                48: ['48-default'],
                96: ['96-default', '96-20260520']
            },
            powerExponents: POWER_EXPONENTS,
            shiftRadius: SHIFT_RADIUS,
            alphaEdgeEvidence: {
                supportedGeometry: [48],
                decoyGrid:
                    '[-12,12] step 2, excluding shifts with radius below 4',
                role: 'research-diagnostic-only',
                validationStatus: 'rejected-heldout',
                decisionSemantics: 'none',
                phaseShiftedHoldout: {
                    reviewed: 48,
                    strict: 45,
                    dirty: 2,
                    clean: 43,
                    qCompleteClean: 42,
                    qAuc: 0.5119047619047619
                },
                note:
                    'Q is retained for research only after near-random ' +
                    'phase-shifted heldout ranking.'
            },
            note:
                'Continuous evidence only; maxima require size-conditioned ' +
                'noise-floor calibration before any decision use.'
        },
        sources: sources.map((source) => ({
            path: source.sourceReport,
            sha256: source.sha256,
            generatedAt: source.generatedAt,
            resultCount: source.results.length
        })),
        selection: {
            ...selection.audit,
            offset,
            requestedLimit: Number.isFinite(limit) ? limit : null,
            processedRecordCount: records.length
        },
        summary: summarizeShadowResidualProfileRecords(records),
        records
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    runShadowResidualProfileEnsemble(parseArgs())
        .then((report) => {
            console.log(JSON.stringify(report.summary, null, 2));
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}

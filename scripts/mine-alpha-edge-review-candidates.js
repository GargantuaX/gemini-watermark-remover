import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermarkFromImageDataSync } from '../src/sdk/image-data.js';
import { measureAlphaEdgeRecompositionEvidence } from './alpha-edge-cleanliness.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATHS = Object.freeze([
    '.artifacts/wrong-anchor-next/full-validation-hardened-recent-part2b.json',
    '.artifacts/wrong-anchor-next/full-validation-hardened-recent-part2a.json',
    '.artifacts/wrong-anchor-next/full-validation-hardened-recent-part1-b.json',
    '.artifacts/wrong-anchor-next/full-validation-hardened-recent-part1-a.json',
    '.artifacts/wrong-anchor-next/full-validation-hardened-history.json'
]);
const DEFAULT_OUTPUT_DIR =
    '.artifacts/shadow-residual-profile-ensemble/alpha-edge-blind-spot-review';
const DEVELOPMENT_SAMPLING_CUTOFF = 5.2e-6;
const PANEL_SIZE = 320;
const LABEL_HEIGHT = 74;
const GAP = 8;

function buildGridDecoyShifts() {
    return Array.from({ length: 13 }, (_, index) => -12 + index * 2)
        .flatMap((shiftY) =>
            Array.from({ length: 13 }, (_, index) => -12 + index * 2)
                .map((shiftX) => [shiftX, shiftY])
        )
        .filter(([shiftX, shiftY]) =>
            Math.hypot(shiftX, shiftY) >= 4
        );
}

const GRID_DECOY_SHIFTS = Object.freeze(buildGridDecoyShifts());

function parsePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseUnitInterval(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed < 1
        ? parsed
        : fallback;
}

export function parseArgs(argv = process.argv.slice(2)) {
    const parsed = {
        reportPaths: DEFAULT_REPORT_PATHS.map((item) => path.resolve(item)),
        excludeReportPaths: [],
        outputDir: path.resolve(DEFAULT_OUTPUT_DIR),
        candidateLimit: 16,
        reviewLimit: 10,
        samplingMode: 'top',
        stratumPhase: 0.5,
        blindLabels: false
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--reports') {
            parsed.reportPaths = (args.shift() ?? '')
                .split(',')
                .filter(Boolean)
                .map((item) => path.resolve(item));
        } else if (arg === '--exclude-reports') {
            parsed.excludeReportPaths = (args.shift() ?? '')
                .split(',')
                .filter(Boolean)
                .map((item) => path.resolve(item));
        } else if (arg === '--output-dir') {
            parsed.outputDir = path.resolve(
                args.shift() ?? DEFAULT_OUTPUT_DIR
            );
        } else if (arg === '--candidate-limit') {
            parsed.candidateLimit = parsePositiveInteger(
                args.shift(),
                parsed.candidateLimit
            );
        } else if (arg === '--review-limit') {
            parsed.reviewLimit = parsePositiveInteger(
                args.shift(),
                parsed.reviewLimit
            );
        } else if (arg === '--sampling-mode') {
            const mode = args.shift();
            if (mode === 'top' || mode === 'stratified') {
                parsed.samplingMode = mode;
            }
        } else if (arg === '--stratum-phase') {
            parsed.stratumPhase = parseUnitInterval(
                args.shift(),
                parsed.stratumPhase
            );
        } else if (arg === '--blind-labels') {
            parsed.blindLabels = true;
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

function resolveArtifacts(record) {
    return (
        record?.decisionPath?.alphaTrial?.artifacts ??
        record?.qualitySignals?.artifacts ??
        null
    );
}

function resolveVisibility(record) {
    return record?.residualVisibility ?? record?.qualitySignals?.visibility;
}

function resolvePosition(record) {
    return record?.decisionPath?.alphaTrial?.position ?? record?.position;
}

function templateArtifact(artifacts) {
    if (
        !Number.isFinite(artifacts?.gradientScore) ||
        !Number.isFinite(artifacts?.weightedRecomposeError)
    ) {
        return null;
    }
    return (
        Math.max(0, artifacts.gradientScore) *
        Math.max(0, artifacts.weightedRecomposeError)
    );
}

function selectHistoricalCandidates(reports) {
    const seen = new Set();
    const candidates = [];
    let scanned = 0;
    let applied48 = 0;
    let lowTemplateCleanDecision = 0;
    for (const report of reports) {
        for (const record of report.results ?? []) {
            scanned++;
            if (seen.has(record.fileName)) continue;
            seen.add(record.fileName);
            const artifacts = resolveArtifacts(record);
            const visibility = resolveVisibility(record);
            const position = resolvePosition(record);
            const t = templateArtifact(artifacts);
            if (
                record.applied !== true ||
                position?.width !== 48 ||
                position?.height !== 48 ||
                !artifacts ||
                !Number.isFinite(t)
            ) {
                continue;
            }
            applied48++;
            if (
                visibility?.rawVisible !== false ||
                t > DEVELOPMENT_SAMPLING_CUTOFF
            ) {
                continue;
            }
            lowTemplateCleanDecision++;
            candidates.push({
                fileName: record.fileName,
                filePath: record.filePath,
                historical: {
                    sourceReport: report.sourcePath,
                    position,
                    alphaGain: record.alphaGain ?? null,
                    templateArtifact: t,
                    recomposeError: artifacts.recomposeError ?? null,
                    visualArtifactCost:
                        artifacts.visualArtifactCost ?? null,
                    spatialScore: artifacts.spatialScore ?? null,
                    gradientScore: artifacts.gradientScore ?? null,
                    qualityStatus: record.qualityStatus ?? null,
                    visibility
                }
            });
        }
    }
    candidates.sort(
        (left, right) =>
            (right.historical.recomposeError ?? -Infinity) -
            (left.historical.recomposeError ?? -Infinity)
    );
    return {
        audit: {
            scanned,
            uniqueFileNames: seen.size,
            applied48,
            lowTemplateCleanDecision,
            samplingCutoff: DEVELOPMENT_SAMPLING_CUTOFF,
            ranking:
                'historical recomposeError descending; diagnostic sampling only'
        },
        candidates
    };
}

export function stratifiedCandidateOrder(
    candidates,
    count,
    phase = 0.5
) {
    if (count >= candidates.length) return [...candidates];
    const selectedIndices = new Set();
    for (let stratum = 0; stratum < count; stratum++) {
        selectedIndices.add(
            Math.min(
                candidates.length - 1,
                Math.floor(
                    (stratum + phase) * candidates.length / count
                )
            )
        );
    }
    const selected = [];
    const remainder = [];
    for (const [index, candidate] of candidates.entries()) {
        if (selectedIndices.has(index)) {
            selected.push(candidate);
        } else {
            remainder.push(candidate);
        }
    }
    return [...selected, ...remainder];
}

export async function selectUniqueCandidatesByContent(
    candidates,
    limit,
    excludedHashes = new Set()
) {
    const seenHashes = new Map();
    const selected = [];
    const duplicates = [];
    const excluded = [];
    for (const candidate of candidates) {
        const sourceBytes = await readFile(candidate.filePath);
        const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
        if (excludedHashes.has(sha256)) {
            excluded.push({
                fileName: candidate.fileName,
                sha256
            });
            continue;
        }
        const first = seenHashes.get(sha256);
        if (first) {
            duplicates.push({
                fileName: candidate.fileName,
                duplicateOf: first.fileName,
                sha256
            });
            continue;
        }
        const selectedCandidate = {
            ...candidate,
            sourceSha256: sha256
        };
        seenHashes.set(sha256, selectedCandidate);
        selected.push(selectedCandidate);
        if (selected.length >= limit) break;
    }
    return {
        candidates: selected,
        audit: {
            requestedUniqueCount: limit,
            selectedUniqueCount: selected.length,
            duplicateCountBeforeLimit: duplicates.length,
            duplicates,
            excludedCountBeforeLimit: excluded.length,
            excluded
        }
    };
}

function currentEvidence(processed) {
    const artifacts =
        processed.meta?.decisionPath?.alphaTrial?.artifacts ??
        processed.meta?.qualitySignals?.artifacts ??
        null;
    return {
        templateArtifact: templateArtifact(artifacts),
        spatialScore: artifacts?.spatialScore ?? null,
        gradientScore: artifacts?.gradientScore ?? null,
        weightedRecomposeError:
            artifacts?.weightedRecomposeError ?? null,
        recomposeError: artifacts?.recomposeError ?? null
    };
}

function gridPercentile(edgeEvidence) {
    const finite = edgeEvidence.decoyEdgeMeans.filter(Number.isFinite);
    if (
        finite.length === 0 ||
        !Number.isFinite(edgeEvidence.edgeWeightedMean) ||
        edgeEvidence.edgeWeightedMean <= Number.EPSILON ||
        !Number.isFinite(edgeEvidence.decoyEdgeMedian) ||
        edgeEvidence.decoyEdgeMedian <= Number.EPSILON
    ) {
        return null;
    }
    return finite.filter(
        (value) => value <= edgeEvidence.edgeWeightedMean
    ).length / finite.length;
}

async function replayCandidate(candidate, alphaMap) {
    const originalImageData = await decodeImageDataInNode(
        candidate.filePath
    );
    const processed = removeWatermarkFromImageDataSync(
        cloneImageData(originalImageData)
    );
    const position = processed.meta?.position;
    if (
        processed.meta?.applied !== true ||
        position?.width !== 48 ||
        position?.height !== 48
    ) {
        return {
            ...candidate,
            replay: {
                status: 'unavailable',
                reason:
                    processed.meta?.skipReason ??
                    'current-position-is-not-48px'
            }
        };
    }
    const alphaGain = Number.isFinite(processed.meta?.alphaGain)
        ? processed.meta.alphaGain
        : 1;
    const edgeEvidence = measureAlphaEdgeRecompositionEvidence({
        originalImageData,
        candidateImageData: processed.imageData,
        alphaMap,
        position,
        alphaGain,
        decoyShifts: GRID_DECOY_SHIFTS
    });
    return {
        ...candidate,
        replay: {
            status: 'complete',
            position,
            alphaGain,
            source: processed.meta?.source ?? null,
            qualityStatus: processed.meta?.qualityStatus ?? null,
            currentEvidence: currentEvidence(processed),
            edgeEvidence: {
                signedTemplateAmplitude:
                    edgeEvidence.signedTemplateAmplitude,
                normalizedTotalError:
                    edgeEvidence.normalizedTotalError,
                edgeWeightedMean: edgeEvidence.edgeWeightedMean,
                decoyEdgeMedian: edgeEvidence.decoyEdgeMedian,
                edgeDecoyRatio: edgeEvidence.edgeDecoyRatio,
                gridPercentile: gridPercentile(edgeEvidence)
            }
        },
        runtime: {
            originalImageData,
            candidateImageData: processed.imageData
        }
    };
}

function reviewComparator(left, right) {
    const leftEvidence = left.replay?.edgeEvidence;
    const rightEvidence = right.replay?.edgeEvidence;
    return (
        (rightEvidence?.gridPercentile ?? -Infinity) -
            (leftEvidence?.gridPercentile ?? -Infinity) ||
        (rightEvidence?.edgeDecoyRatio ?? -Infinity) -
            (leftEvidence?.edgeDecoyRatio ?? -Infinity) ||
        (rightEvidence?.edgeWeightedMean ?? -Infinity) -
            (leftEvidence?.edgeWeightedMean ?? -Infinity)
    );
}

function createCrop(position, imageData) {
    const padding = 48;
    const left = Math.max(0, position.x - padding);
    const top = Math.max(0, position.y - padding);
    return {
        left,
        top,
        width: Math.min(
            imageData.width - left,
            position.width + padding * 2
        ),
        height: Math.min(
            imageData.height - top,
            position.height + padding * 2
        )
    };
}

function cropImageData(imageData, crop) {
    const data = new Uint8ClampedArray(crop.width * crop.height * 4);
    for (let y = 0; y < crop.height; y++) {
        const sourceStart =
            ((crop.top + y) * imageData.width + crop.left) * 4;
        const targetStart = y * crop.width * 4;
        data.set(
            imageData.data.subarray(
                sourceStart,
                sourceStart + crop.width * 4
            ),
            targetStart
        );
    }
    return { width: crop.width, height: crop.height, data };
}

function createAmplifiedDiff(before, after, scale = 4) {
    const data = new Uint8ClampedArray(before.data.length);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = Math.min(
            255,
            Math.abs(before.data[index] - after.data[index]) * scale
        );
        data[index + 1] = Math.min(
            255,
            Math.abs(before.data[index + 1] - after.data[index + 1]) *
                scale
        );
        data[index + 2] = Math.min(
            255,
            Math.abs(before.data[index + 2] - after.data[index + 2]) *
                scale
        );
        data[index + 3] = 255;
    }
    return { width: before.width, height: before.height, data };
}

function sharpFromImageData(imageData) {
    return sharp(
        Buffer.from(
            imageData.data.buffer,
            imageData.data.byteOffset,
            imageData.data.byteLength
        ),
        {
            raw: {
                width: imageData.width,
                height: imageData.height,
                channels: 4
            }
        }
    );
}

async function createPanel(imageData) {
    return sharpFromImageData(imageData)
        .resize(PANEL_SIZE, PANEL_SIZE, {
            fit: 'contain',
            kernel: 'nearest',
            background: { r: 20, g: 20, b: 20, alpha: 1 }
        })
        .png()
        .toBuffer();
}

function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function shortNumber(value, digits = 4) {
    return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

async function renderReviewRecord(record, outputDir, { blindLabels }) {
    const { originalImageData, candidateImageData } = record.runtime;
    const position = record.replay.position;
    const crop = createCrop(position, originalImageData);
    const beforeCrop = cropImageData(originalImageData, crop);
    const afterCrop = cropImageData(candidateImageData, crop);
    const diffCrop = createAmplifiedDiff(beforeCrop, afterCrop);
    const panels = await Promise.all([
        createPanel(beforeCrop),
        createPanel(afterCrop),
        createPanel(diffCrop)
    ]);
    const edge = record.replay.edgeEvidence;
    const current = record.replay.currentEvidence;
    const width = PANEL_SIZE * 3 + GAP * 2;
    const label = Buffer.from(
        `<svg width="${width}" height="${LABEL_HEIGHT}" ` +
        'xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="100%" height="100%" fill="#111"/>' +
        `<text x="8" y="22" fill="#fff" font-size="14" ` +
        `font-family="sans-serif">${escapeXml(
            path.basename(record.fileName)
        )}</text>` +
        (
            blindLabels
                ? '<text x="8" y="45" fill="#ddd" font-size="13" ' +
                    'font-family="sans-serif">metrics hidden for blind ' +
                    'visual review</text>'
                : `<text x="8" y="45" fill="#ddd" font-size="13" ` +
                    `font-family="sans-serif">T=${shortNumber(
                        current.templateArtifact,
                        8
                    )} Qratio=${shortNumber(edge.edgeDecoyRatio)} ` +
                    `Qpct=${shortNumber(edge.gridPercentile)} ` +
                    `Eedge=${shortNumber(
                        edge.edgeWeightedMean,
                        2
                    )}</text>`
        ) +
        '<text x="8" y="66" fill="#999" font-size="12" ' +
        'font-family="sans-serif">source | current output | abs diff x4</text>' +
        '</svg>'
    );
    const row = await sharp({
        create: {
            width,
            height: LABEL_HEIGHT + PANEL_SIZE,
            channels: 4,
            background: { r: 18, g: 18, b: 18, alpha: 1 }
        }
    })
        .composite([
            { input: label, left: 0, top: 0 },
            ...panels.map((input, index) => ({
                input,
                left: index * (PANEL_SIZE + GAP),
                top: LABEL_HEIGHT
            }))
        ])
        .png()
        .toBuffer();
    const outputPath = path.join(
        outputDir,
        `${path.parse(record.fileName).name}.png`
    );
    await writeFile(outputPath, row);
    return {
        fileName: record.fileName,
        outputPath,
        crop,
        sha256: createHash('sha256').update(row).digest('hex')
    };
}

async function createContactSheet(rows, outputPath) {
    if (rows.length === 0) return null;
    const buffers = await Promise.all(
        rows.map((row) => readFile(row.outputPath))
    );
    const metadata = await sharp(buffers[0]).metadata();
    await sharp({
        create: {
            width: metadata.width,
            height:
                metadata.height * buffers.length +
                GAP * (buffers.length - 1),
            channels: 4,
            background: { r: 10, g: 10, b: 10, alpha: 1 }
        }
    })
        .composite(
            buffers.map((input, index) => ({
                input,
                left: 0,
                top: index * (metadata.height + GAP)
            }))
        )
        .png()
        .toFile(outputPath);
    return outputPath;
}

function serializeRecord(record) {
    const { runtime, ...serializable } = record;
    return serializable;
}

export async function runAlphaEdgeCandidateMining({
    reportPaths = DEFAULT_REPORT_PATHS.map((item) => path.resolve(item)),
    excludeReportPaths = [],
    outputDir = path.resolve(DEFAULT_OUTPUT_DIR),
    candidateLimit = 16,
    reviewLimit = 10,
    samplingMode = 'top',
    stratumPhase = 0.5,
    blindLabels = false
} = {}) {
    const reports = [];
    for (const reportPath of reportPaths) {
        const report = JSON.parse(await readFile(reportPath, 'utf8'));
        reports.push({
            ...report,
            sourcePath: reportPath
        });
    }
    const excludedHashes = new Set();
    for (const excludeReportPath of excludeReportPaths) {
        const exclusionReport = JSON.parse(
            await readFile(excludeReportPath, 'utf8')
        );
        for (const record of exclusionReport.records ?? []) {
            if (typeof record.sourceSha256 === 'string') {
                excludedHashes.add(record.sourceSha256);
            }
        }
    }
    const selection = selectHistoricalCandidates(reports);
    const orderedCandidates = samplingMode === 'stratified'
        ? stratifiedCandidateOrder(
            selection.candidates,
            candidateLimit,
            stratumPhase
        )
        : selection.candidates;
    const contentSelection = await selectUniqueCandidatesByContent(
        orderedCandidates,
        candidateLimit,
        excludedHashes
    );
    const alphaMap = getEmbeddedAlphaMap(48);
    const replayed = [];
    for (const [index, candidate] of contentSelection.candidates.entries()) {
        console.log(
            `alpha edge blind-spot replay ${index + 1}/` +
            `${contentSelection.candidates.length}: ${candidate.fileName}`
        );
        replayed.push(await replayCandidate(candidate, alphaMap));
    }
    const completeRecords = replayed.filter(
        (record) => record.replay?.status === 'complete'
    );
    const ranked = [...completeRecords].sort(reviewComparator);
    const reviewRecords = (
        samplingMode === 'stratified' ? completeRecords : ranked
    ).slice(0, reviewLimit);
    await mkdir(outputDir, { recursive: true });
    const rendered = [];
    for (const [index, record] of reviewRecords.entries()) {
        console.log(
            `alpha edge blind-spot render ${index + 1}/` +
            `${reviewRecords.length}: ${record.fileName}`
        );
        rendered.push(
            await renderReviewRecord(record, outputDir, { blindLabels })
        );
    }
    const sheetPath = await createContactSheet(
        rendered,
        path.join(outputDir, 'contact-sheet.png')
    );
    const report = {
        schema: 'alpha-edge-blind-spot-review/v1',
        generatedAt: new Date().toISOString(),
        mode: 'shadow-diagnostic',
        productionDecisionSemantics: 'none',
        hypothesis:
            'alpha-edge localization can surface non-template cleanup ' +
            'artifacts when template-shaped evidence is near zero',
        inputs: {
            reportPaths,
            candidateLimit,
            reviewLimit,
            samplingMode,
            stratumPhase,
            excludeReportPaths,
            blindLabels
        },
        selection: {
            ...selection.audit,
            exclusion: {
                reportPaths: excludeReportPaths,
                uniqueContentHashes: excludedHashes.size
            },
            contentDeduplication: contentSelection.audit
        },
        replay: {
            requested: contentSelection.candidates.length,
            complete: completeRecords.length,
            unavailable: replayed.filter(
                (record) => record.replay?.status !== 'complete'
            ).length
        },
        contactSheet: sheetPath,
        rendered,
        records: replayed.map(serializeRecord)
    };
    const reportPath = path.join(outputDir, 'report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return { report, reportPath };
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    runAlphaEdgeCandidateMining(parseArgs())
        .then(({ report, reportPath }) => {
            console.log(
                JSON.stringify(
                    {
                        reportPath,
                        contactSheet: report.contactSheet,
                        selection: report.selection,
                        replay: report.replay
                    },
                    null,
                    2
                )
            );
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}

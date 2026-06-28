import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseTimestampList } from './render-video-crop-sheet.js';
import { createVideoWatermarkCandidateScoreReport } from './score-video-watermark-candidates.js';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-output-residual/latest.json');
const DEFAULT_TIMESTAMPS = Object.freeze([1, 3, 5, 7, 9]);
const DEFAULT_MAX_ALLOWED_CONFIDENCE = 0.08;
const DEFAULT_MIN_REDUCTION_RATIO = 0.75;
const DEFAULT_MIN_ORIGINAL_CONFIDENCE = 0.18;

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 9) {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toFixed(digits));
}

export function findScoreByCandidateId(report, candidateId) {
    if (!report || !candidateId) return null;
    return (report.catalogScores || []).find((score) => score.candidateId === candidateId) || null;
}

function normalizeVeoTextScore(score) {
    if (!score?.candidateId) return null;
    return {
        candidateId: score.candidateId,
        watermarkKind: 'veo-text',
        templateId: score.templateId ?? null,
        meanConfidence: score.meanNcc ?? 0,
        meanNcc: score.meanNcc ?? 0,
        maxNcc: score.maxNcc ?? null,
        voteRatio: score.voteRatio ?? null,
        isConfident: score.isConfident === true
    };
}

function getVeoTextScores(report) {
    const detection = report?.selectedDetection || {};
    const scores = [];
    if (detection.watermarkKind === 'veo-text' && detection.best?.candidateId) {
        scores.push({
            ...detection.best,
            templateId: detection.templateId ?? detection.best.templateId,
            isConfident: detection.isConfident === true
        });
    }
    if (detection.alternatives?.veoText?.candidateId) {
        scores.push(detection.alternatives.veoText);
    }
    if (Array.isArray(detection.alternatives?.veoTextCandidates)) {
        scores.push(...detection.alternatives.veoTextCandidates);
    }
    return scores.map(normalizeVeoTextScore).filter(Boolean);
}

function scoreVeoTextSelection(report, candidateId = null) {
    const scores = getVeoTextScores(report);
    if (candidateId) {
        return scores.find((score) => score.candidateId === candidateId) || null;
    }
    return scores.find((score) => score.isConfident) || scores[0] || null;
}

function isVeoTextCandidateId(candidateId) {
    return typeof candidateId === 'string' && candidateId.startsWith('veo-text');
}

export function classifyOutputResidualGate({
    originalScore = null,
    currentScore = null,
    maxAllowedConfidence = DEFAULT_MAX_ALLOWED_CONFIDENCE,
    minReductionRatio = DEFAULT_MIN_REDUCTION_RATIO,
    minOriginalConfidence = DEFAULT_MIN_ORIGINAL_CONFIDENCE
} = {}) {
    const candidateId = originalScore?.candidateId || currentScore?.candidateId || null;
    const originalMeanConfidence = originalScore?.meanConfidence ?? 0;
    const currentMeanConfidence = currentScore?.meanConfidence ?? 0;
    const reductionRatio = originalMeanConfidence > 0
        ? roundNumber((originalMeanConfidence - currentMeanConfidence) / originalMeanConfidence)
        : 0;
    const base = {
        candidateId,
        originalMeanConfidence,
        currentMeanConfidence,
        reductionRatio,
        maxAllowedConfidence,
        minReductionRatio
    };

    if (!originalScore || !currentScore) {
        return {
            action: 'insufficient-data',
            reason: 'missing-fixed-anchor-score',
            ...base
        };
    }

    if (originalMeanConfidence < minOriginalConfidence) {
        return {
            action: 'needs-review',
            reason: 'original-fixed-anchor-weak',
            ...base
        };
    }

    if (
        currentMeanConfidence <= maxAllowedConfidence &&
        reductionRatio >= minReductionRatio
    ) {
        return {
            action: 'pass',
            reason: 'fixed-anchor-residual-low',
            ...base
        };
    }

    if (currentMeanConfidence >= originalMeanConfidence) {
        return {
            action: 'fail',
            reason: 'fixed-anchor-not-reduced',
            ...base
        };
    }

    return {
        action: 'needs-review',
        reason: 'fixed-anchor-residual-above-pass-threshold',
        ...base
    };
}

export function createOutputResidualGateReport({
    originalReport,
    currentReport,
    candidateId = null,
    thresholds = {}
} = {}) {
    const explicitVeoTextCandidate = isVeoTextCandidateId(candidateId);
    const originalVeoTextScore = scoreVeoTextSelection(originalReport, explicitVeoTextCandidate ? candidateId : null);
    const currentVeoTextScore = originalVeoTextScore
        ? scoreVeoTextSelection(currentReport, originalVeoTextScore.candidateId)
        : null;
    const useVeoTextAnchor = (
        explicitVeoTextCandidate ||
        (!candidateId && originalVeoTextScore?.isConfident)
    ) && originalVeoTextScore && currentVeoTextScore;
    const fixedCandidateId = candidateId || (useVeoTextAnchor
        ? originalVeoTextScore.candidateId
        : originalReport?.catalogScores?.[0]?.candidateId || null);
    const originalScore = useVeoTextAnchor
        ? originalVeoTextScore
        : findScoreByCandidateId(originalReport, fixedCandidateId);
    const currentScore = useVeoTextAnchor
        ? currentVeoTextScore
        : findScoreByCandidateId(currentReport, fixedCandidateId);
    const verdict = classifyOutputResidualGate({
        originalScore,
        currentScore,
        ...thresholds
    });

    return {
        generatedAt: new Date().toISOString(),
        originalInputPath: originalReport?.inputPath || null,
        currentInputPath: currentReport?.inputPath || null,
        fixedAnchor: {
            candidateId: fixedCandidateId,
            watermarkKind: useVeoTextAnchor ? 'veo-text' : 'diamond',
            originalScore,
            currentScore
        },
        verdict,
        originalBestCatalog: originalReport?.catalogScores?.[0] || null,
        currentBestCatalogIgnoredForVerdict: currentReport?.catalogScores?.[0] || null,
        currentBestGridIgnoredForVerdict: currentReport?.gridSearch?.topCandidates?.[0] || null,
        sourceReports: {
            original: originalReport?.outputPath || null,
            current: currentReport?.outputPath || null
        }
    };
}

export function resolveVideoOutputResidualExitCode(report, { failOnResidual = false } = {}) {
    if (failOnResidual && report?.verdict?.action !== 'pass') {
        return 1;
    }
    return 0;
}

function deriveReportPath(outputPath, suffix) {
    const parsed = path.parse(path.resolve(outputPath || DEFAULT_OUTPUT_PATH));
    return path.join(parsed.dir, `${parsed.name}-${suffix}.json`);
}

function deriveCropSheetPath(outputPath, suffix) {
    const parsed = path.parse(path.resolve(outputPath || DEFAULT_OUTPUT_PATH));
    return path.join(parsed.dir, `${parsed.name}-${suffix}-crop-sheet.png`);
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function resolveScoreReport({
    videoPath,
    scorePath,
    outputPath,
    suffix,
    timestamps,
    gridLimit,
    gridStep
}) {
    if (scorePath) {
        return await readJson(scorePath);
    }
    if (!videoPath) {
        throw new Error(`缺少 ${suffix === 'original' ? '--original' : '--current'} 视频路径`);
    }
    return await createVideoWatermarkCandidateScoreReport({
        inputPath: videoPath,
        outputPath: deriveReportPath(outputPath, suffix),
        cropSheetPath: deriveCropSheetPath(outputPath, suffix),
        timestamps,
        gridLimit,
        gridStep
    });
}

export function parseCliArgs(argv) {
    const parsed = {
        outputPath: DEFAULT_OUTPUT_PATH,
        timestamps: [...DEFAULT_TIMESTAMPS],
        gridLimit: 10,
        gridStep: 8,
        thresholds: {},
        failOnResidual: false
    };
    const args = [...argv];
    while (args.length) {
        const arg = args.shift();
        if (arg === '--') continue;
        if (arg === '--original' || arg === '--input' || arg === '--source') {
            parsed.originalPath = args.shift();
            continue;
        }
        if (arg === '--current' || arg === '--processed' || arg === '--output-video') {
            parsed.currentPath = args.shift();
            continue;
        }
        if (arg === '--original-score') {
            parsed.originalScorePath = args.shift();
            continue;
        }
        if (arg === '--current-score') {
            parsed.currentScorePath = args.shift();
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = args.shift() || parsed.outputPath;
            continue;
        }
        if (arg === '--timestamps') {
            parsed.timestamps = parseTimestampList(args.shift());
            continue;
        }
        if (arg === '--candidate-id') {
            parsed.candidateId = args.shift();
            continue;
        }
        if (arg === '--max-allowed-confidence') {
            parsed.thresholds.maxAllowedConfidence = toFiniteNumber(args.shift()) ?? DEFAULT_MAX_ALLOWED_CONFIDENCE;
            continue;
        }
        if (arg === '--min-reduction-ratio') {
            parsed.thresholds.minReductionRatio = toFiniteNumber(args.shift()) ?? DEFAULT_MIN_REDUCTION_RATIO;
            continue;
        }
        if (arg === '--min-original-confidence') {
            parsed.thresholds.minOriginalConfidence = toFiniteNumber(args.shift()) ?? DEFAULT_MIN_ORIGINAL_CONFIDENCE;
            continue;
        }
        if (arg === '--grid-limit') {
            parsed.gridLimit = toFiniteNumber(args.shift()) ?? parsed.gridLimit;
            continue;
        }
        if (arg === '--grid-step') {
            parsed.gridStep = toFiniteNumber(args.shift()) ?? parsed.gridStep;
            continue;
        }
        if (arg === '--fail-on-residual') {
            parsed.failOnResidual = true;
            continue;
        }
        if (!parsed.originalPath) {
            parsed.originalPath = arg;
        } else if (!parsed.currentPath) {
            parsed.currentPath = arg;
        }
    }
    return parsed;
}

export async function createVideoOutputResidualReport({
    originalPath = null,
    currentPath = null,
    originalScorePath = null,
    currentScorePath = null,
    outputPath = DEFAULT_OUTPUT_PATH,
    timestamps = [...DEFAULT_TIMESTAMPS],
    candidateId = null,
    thresholds = {},
    gridLimit = 10,
    gridStep = 8
} = {}) {
    const originalReport = await resolveScoreReport({
        videoPath: originalPath,
        scorePath: originalScorePath,
        outputPath,
        suffix: 'original',
        timestamps,
        gridLimit,
        gridStep
    });
    const currentReport = await resolveScoreReport({
        videoPath: currentPath,
        scorePath: currentScorePath,
        outputPath,
        suffix: 'current',
        timestamps,
        gridLimit,
        gridStep
    });
    const report = createOutputResidualGateReport({
        originalReport,
        currentReport,
        candidateId,
        thresholds
    });
    report.outputPath = path.resolve(outputPath);

    await mkdir(path.dirname(report.outputPath), { recursive: true });
    await writeFile(report.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
}

async function runCli() {
    const options = parseCliArgs(process.argv.slice(2));
    const report = await createVideoOutputResidualReport(options);
    console.log(`report: ${report.outputPath}`);
    console.log(`fixedAnchor: ${report.fixedAnchor.candidateId || 'none'}`);
    console.log(`original: ${report.verdict.originalMeanConfidence.toFixed(4)}`);
    console.log(`current: ${report.verdict.currentMeanConfidence.toFixed(4)}`);
    console.log(`reduction: ${(report.verdict.reductionRatio * 100).toFixed(1)}%`);
    console.log(`verdict: ${report.verdict.action} (${report.verdict.reason})`);
    process.exitCode = resolveVideoOutputResidualExitCode(report, {
        failOnResidual: options.failOnResidual
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

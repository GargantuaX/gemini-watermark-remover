import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import {
    calculateNearBlackRatio,
    evaluateRestorationCandidate
} from '../src/core/candidateSelector.js';
import { resolveGeminiWatermarkSearchCatalogEntries } from '../src/core/geminiSizeCatalog.js';
import { assessRemovalDiffArtifacts } from '../src/core/restorationMetrics.js';
import {
    buildRankingKey,
    compareRankingKey,
    scoreDamage,
    scoreOriginalEvidence,
    scoreResidual,
    shouldEarlyAccept
} from '../src/core/watermarkScoring.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import {
    calculateWatermarkPosition,
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from '../src/core/watermarkConfig.js';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/sample-benchmark/latest.json');
const RESIDUAL_FAIL_THRESHOLD = 0.22;
const GRADIENT_FAIL_THRESHOLD = 0.22;
const MIN_EXPECTED_SUPPRESSION_GAIN = 0.3;
const ALLOW_WEAK_RESIDUAL_MAX_ABS_SPATIAL = 0.35;
const CONSERVATIVE_CANONICAL_96_MAX_RESIDUAL = 0.35;
const CONSERVATIVE_CANONICAL_96_MAX_GRADIENT = 0.05;
const CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_SPATIAL = 0.55;
const CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_GRADIENT = 0.2;
const CONSERVATIVE_CANONICAL_96_MIN_SUPPRESSION_GAIN = 0.4;
const NON_GEMINI_MAX_CHANGED_RATIO = 0.01;
const NON_GEMINI_MAX_AVG_DELTA = 0.5;
const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg']);
const CANDIDATE_ALPHA_GAINS = Object.freeze([0.6, 1, 1.1, 1.15, 1.3, 0.45, 0.7, 0.85, 0.55]);
const CATALOG_DARK_ALPHA_GAIN_CANDIDATES = Object.freeze([0.9, 0.85, 0.8, 0.95, 0.7, 0.6]);
const FINE_ALPHA_STEP = 0.02;
const FINE_ALPHA_WINDOW = 0.04;
const CANDIDATE_RANKING_LIMIT = 8;
const CALIBRATED_SPATIAL_METRIC_RISKS = new Set([
    'flat-clipped-low-texture-spatial-correlation',
    'flat-low-variance-spatial-correlation',
    'nonlocalized-spatial-background-collision',
    'positive-halo-background-collision',
    'positive-spatial-background-collision',
    'structured-edge-background-collision',
    'weak-halo-background-collision'
]);
const FINE_ALPHA_STAGE_PRIORITY = Object.freeze([
    'weak-positive-residual-fine-alpha',
    'dark-catalog-fine-alpha'
]);

function resolveGoldManifestPath(sampleDir) {
    return path.join(sampleDir, 'gold-manifest.json');
}

function validateIssueRegressionAdmission(fileName, admission) {
    if (!admission || typeof admission !== 'object') {
        throw new Error(`${fileName}: formal admission metadata is required`);
    }
    if (admission.status !== 'confirmed-regression-input') {
        throw new Error(`${fileName}: admission status must be confirmed-regression-input`);
    }
    if (admission.source !== 'github-issue') {
        throw new Error(`${fileName}: admission source must be github-issue`);
    }
    if (!Number.isInteger(admission.issue) || admission.issue <= 0) {
        throw new Error(`${fileName}: admission issue must be a positive integer`);
    }
    if (typeof admission.originalFileName !== 'string' || !admission.originalFileName.trim()) {
        throw new Error(`${fileName}: admission originalFileName is required`);
    }
    if (typeof admission.confirmedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(admission.confirmedAt)) {
        throw new Error(`${fileName}: admission confirmedAt must use YYYY-MM-DD`);
    }
}

function validateKnownIssueExpectation(fileName, knownIssue, admission) {
    if (!knownIssue) return;
    if (!Number.isInteger(knownIssue.issue) || knownIssue.issue !== admission.issue) {
        throw new Error(`${fileName}: known issue must match admission issue`);
    }
    if (knownIssue.qualityStatus !== 'visible-residual') {
        throw new Error(`${fileName}: known issue qualityStatus must be visible-residual`);
    }
    if (knownIssue.bucket !== 'residual-edge') {
        throw new Error(`${fileName}: known issue bucket must be residual-edge`);
    }
}

export async function loadSampleGoldManifest(sampleDir = path.resolve('src/assets/samples')) {
    try {
        const manifest = JSON.parse(await readFile(resolveGoldManifestPath(sampleDir), 'utf8'));
        return {
            version: manifest.version ?? 1,
            samples: manifest.samples && typeof manifest.samples === 'object'
                ? manifest.samples
                : {}
        };
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return {
            version: 1,
            samples: {}
        };
    }
}

function resolveGoldSampleExpectation(fileName, manifest) {
    const entry = manifest?.samples?.[fileName];
    if (!entry || typeof entry !== 'object') {
        return {
            shouldProcess: true,
            knownUnsupported: false,
            expectedAnchor: null,
            expectedAlphaGain: null,
            allowWeakResidual: false,
            admission: null,
            knownIssue: null,
            tags: []
        };
    }

    return {
        shouldProcess: entry.shouldProcess !== false && entry.knownUnsupported !== true,
        knownUnsupported: entry.knownUnsupported === true,
        expectedAnchor: entry.expectedAnchor ?? null,
        expectedAlphaGain: entry.expectedAlphaGain ?? null,
        allowWeakResidual: entry.allowWeakResidual === true,
        admission: entry.admission ?? null,
        knownIssue: entry.knownIssue ?? null,
        tags: Array.isArray(entry.tags) ? entry.tags : []
    };
}

function inferMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.webp') return 'image/webp';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return 'image/png';
}

export async function listBenchmarkSampleAssets(sampleDir = path.resolve('src/assets/samples')) {
    const manifest = await loadSampleGoldManifest(sampleDir);
    const files = (await readdir(sampleDir))
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .filter((name) => !name.includes('-fix.'))
        .filter((name) => !name.includes('-after.'))
        .filter((name) => !name.startsWith('Gemini_Generated_Image_'))
        .sort((left, right) => left.localeCompare(right));
    const fileSet = new Set(files);

    for (const [fileName, entry] of Object.entries(manifest.samples ?? {})) {
        const tags = Array.isArray(entry?.tags) ? entry.tags : [];
        if (tags.includes('issue-regression') && !fileSet.has(fileName)) {
            throw new Error(`${fileName}: admitted sample file is missing`);
        }
    }

    for (const fileName of files) {
        const entry = manifest.samples?.[fileName];
        const tags = Array.isArray(entry?.tags) ? entry.tags : [];
        if (tags.includes('issue-regression')) {
            validateIssueRegressionAdmission(fileName, entry.admission);
            validateKnownIssueExpectation(fileName, entry.knownIssue, entry.admission);
            const sourceBuffer = await readFile(path.join(sampleDir, fileName));
            const actualSha256 = createHash('sha256').update(sourceBuffer).digest('hex');
            if (entry.admission.sha256 !== actualSha256) {
                throw new Error(`${fileName}: admitted source sha256 mismatch`);
            }
        }
    }

    return files
        .map((fileName) => {
            const gold = resolveGoldSampleExpectation(fileName, manifest);
            return {
                fileName,
                expectedGemini: gold.shouldProcess,
                gold
            };
        });
}

export async function decodeImageDataInNode(filePath) {
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

function measureRegionDelta(originalImageData, processedImageData, position) {
    let changedPixels = 0;
    let totalPixels = 0;
    let totalAbsoluteDelta = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * originalImageData.width + (position.x + col)) * 4;
            let pixelChanged = false;

            for (let channel = 0; channel < 3; channel++) {
                const delta = Math.abs(processedImageData.data[idx + channel] - originalImageData.data[idx + channel]);
                totalAbsoluteDelta += delta;
                if (delta > 0) pixelChanged = true;
            }

            if (pixelChanged) changedPixels++;
            totalPixels++;
        }
    }

    return {
        changedPixels,
        totalPixels,
        changedRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
        avgAbsoluteDeltaPerChannel: totalPixels > 0 ? totalAbsoluteDelta / (totalPixels * 3) : 0
    };
}

function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeAnchor(anchor) {
    if (!anchor || typeof anchor !== 'object') return null;
    const logoSize = anchor.logoSize ?? anchor.size;
    const { marginRight, marginBottom } = anchor;
    if (![logoSize, marginRight, marginBottom].every((value) => Number.isFinite(value))) {
        return null;
    }
    return {
        logoSize,
        marginRight,
        marginBottom,
        ...(typeof anchor.alphaVariant === 'string' && anchor.alphaVariant.length > 0
            ? { alphaVariant: anchor.alphaVariant }
            : {})
    };
}

function anchorMatches(actualAnchor, expectedAnchor) {
    const actual = normalizeAnchor(actualAnchor);
    const expected = normalizeAnchor(expectedAnchor);
    if (!actual || !expected) return true;

    return actual.logoSize === expected.logoSize &&
        actual.marginRight === expected.marginRight &&
        actual.marginBottom === expected.marginBottom;
}

function alphaGainInRange(alphaGain, expectedAlphaGain) {
    if (!expectedAlphaGain || typeof expectedAlphaGain !== 'object') return true;
    const value = toFiniteNumber(alphaGain);
    if (value === null) return false;

    const min = toFiniteNumber(expectedAlphaGain.min);
    const max = toFiniteNumber(expectedAlphaGain.max);
    if (min !== null && value < min) return false;
    if (max !== null && value > max) return false;
    return true;
}

function alphaGainEquals(left, right) {
    const resolvedLeft = toFiniteNumber(left);
    const resolvedRight = toFiniteNumber(right);
    if (resolvedLeft === null || resolvedRight === null) return false;
    return Math.abs(resolvedLeft - resolvedRight) < 0.0001;
}

function isConservativeCanonical96Residual(caseRecord) {
    const anchor = normalizeAnchor(caseRecord.actualAnchor);
    const alphaGain = toFiniteNumber(caseRecord.alphaGain);
    const residualScore = toFiniteNumber(caseRecord.residualScore);
    const processedGradientScore = toFiniteNumber(caseRecord.processedGradientScore);
    const originalSpatialScore = toFiniteNumber(caseRecord.originalSpatialScore);
    const originalGradientScore = toFiniteNumber(caseRecord.originalGradientScore);
    const suppressionGain = toFiniteNumber(caseRecord.suppressionGain);
    const alphaAdjustmentStages = Array.isArray(caseRecord.selectedCandidateDiagnostic?.alphaAdjustmentStages)
        ? caseRecord.selectedCandidateDiagnostic.alphaAdjustmentStages
        : [];
    const usedLocatedAggressive = alphaAdjustmentStages.some((stage) => (
        stage?.stage === 'located-aggressive-removal' ||
        stage === 'located-aggressive-removal'
    ));

    return anchor?.logoSize === 96 &&
        anchor.marginRight === 64 &&
        anchor.marginBottom === 64 &&
        alphaGain !== null &&
        alphaGain <= 1 &&
        residualScore !== null &&
        residualScore <= CONSERVATIVE_CANONICAL_96_MAX_RESIDUAL &&
        processedGradientScore !== null &&
        processedGradientScore <= CONSERVATIVE_CANONICAL_96_MAX_GRADIENT &&
        originalSpatialScore !== null &&
        originalSpatialScore >= CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_SPATIAL &&
        originalGradientScore !== null &&
        originalGradientScore >= CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_GRADIENT &&
        suppressionGain !== null &&
        suppressionGain >= CONSERVATIVE_CANONICAL_96_MIN_SUPPRESSION_GAIN &&
        !usedLocatedAggressive;
}

function classifyAlphaGainType(alphaGain) {
    if (CANDIDATE_ALPHA_GAINS.some((candidateGain) => alphaGainEquals(candidateGain, alphaGain))) {
        return 'discrete';
    }
    if (CATALOG_DARK_ALPHA_GAIN_CANDIDATES.some((candidateGain) => alphaGainEquals(candidateGain, alphaGain))) {
        return 'catalog-dark';
    }
    return toFiniteNumber(alphaGain) === null ? 'unknown' : 'fine';
}

function classifyFineAlphaTopDeltaBucket(delta) {
    const value = toFiniteNumber(delta);
    if (value === null) return 'unknown';
    if (Math.abs(value) < 0.0001) return 'same';

    const direction = value < 0 ? 'lower' : 'higher';
    const magnitude = Math.abs(value);
    if (magnitude <= 0.0401) return `micro-${direction}`;
    if (magnitude <= 0.1001) return `small-${direction}`;
    if (magnitude <= 0.3001) return `medium-${direction}`;
    return `large-${direction}`;
}

function isSignificantFineAlphaDeltaBucket(bucket) {
    return typeof bucket === 'string' && (
        bucket.startsWith('medium-') ||
        bucket.startsWith('large-')
    );
}

function classifySignificantFineAlphaDeltaConcern({
    residualScoreDelta = null,
    selectedDamagePenalty = null,
    topDamagePenalty = null,
    topDamageSafe = null,
    selectionReason = null,
    selectedAlphaGain = null,
    topAlphaGain = null,
    decisionTier = null
} = {}) {
    if (topDamageSafe === false) return 'report-top-damage-risk';

    const selectedPenalty = toFiniteNumber(selectedDamagePenalty);
    const topPenalty = toFiniteNumber(topDamagePenalty);
    if (selectedPenalty !== null && topPenalty !== null && topPenalty > selectedPenalty + 0.25) {
        return 'report-top-damage-risk';
    }

    const delta = toFiniteNumber(residualScoreDelta);
    if (delta === null) return 'unknown';
    if (
        delta < -0.05 &&
        selectionReason === 'production-kept-standard-alpha' &&
        alphaGainEquals(selectedAlphaGain, 1) &&
        toFiniteNumber(topAlphaGain) !== null &&
        decisionTier === 'direct-match'
    ) {
        return 'direct-match-standard-alpha-priority';
    }
    if (delta > 0.05) return 'report-top-worse-residual';
    if (delta < -0.05) return 'report-top-lower-residual';
    return 'near-tie';
}

export function classifyFineAlphaSelectionReason({
    alphaGain,
    fineAlphaSelectedRank = null,
    alphaAdjustmentStages = []
} = {}) {
    const stageNames = Array.isArray(alphaAdjustmentStages)
        ? alphaAdjustmentStages.map((stage) => stage?.stage).filter(Boolean)
        : [];
    for (const stageName of FINE_ALPHA_STAGE_PRIORITY) {
        if (stageNames.includes(stageName)) return stageName;
    }
    if (stageNames.length > 0) return 'production-alpha-adjustment';

    const selectedAlphaType = classifyAlphaGainType(alphaGain);
    if (fineAlphaSelectedRank === 1) {
        return selectedAlphaType === 'discrete'
            ? 'direct-discrete-alpha'
            : 'report-aligned-fine-alpha';
    }
    if (selectedAlphaType === 'discrete') {
        return 'production-kept-standard-alpha';
    }
    return 'report-prefers-micro-alpha';
}

function sameWatermarkConfig(left, right) {
    return left?.logoSize === right?.logoSize &&
        left?.marginRight === right?.marginRight &&
        left?.marginBottom === right?.marginBottom &&
        (left?.alphaVariant ?? null) === (right?.alphaVariant ?? null);
}

function resolveAlphaMapForConfig(config, { alpha48, alpha96, alpha96Variants, getAlphaMap }) {
    if (config?.alphaVariant && config.logoSize === 96 && alpha96Variants?.[config.alphaVariant]) {
        return alpha96Variants[config.alphaVariant];
    }
    if (config?.alphaVariant && typeof getAlphaMap === 'function') {
        const variantAlpha = getAlphaMap(`${config.logoSize}-${config.alphaVariant}`);
        if (variantAlpha) return variantAlpha;
    }
    if (config?.logoSize === 48) return alpha48;
    if (config?.logoSize === 96) return alpha96;
    return typeof getAlphaMap === 'function' ? getAlphaMap(config.logoSize) : null;
}

function describeAlphaMapProfile(config) {
    if (config?.alphaVariant) return `${config.logoSize}-${config.alphaVariant}`;
    if (config?.logoSize === 48) return '48-current';
    if (config?.logoSize === 96) return '96-current';
    return `${config?.logoSize ?? 'unknown'}-interpolated`;
}

function describeCandidateFamily(config, initialConfig) {
    if (sameWatermarkConfig(config, initialConfig)) return 'initial-standard';
    if (config?.logoSize === 48 && config.marginRight === 96 && config.marginBottom === 96) {
        return 'current-large-margin';
    }
    if (config?.logoSize === 96 && config.marginRight === 64 && config.marginBottom === 64) {
        return 'legacy-standard';
    }
    if (config?.logoSize === 96 && config.marginRight === 192 && config.marginBottom === 192) {
        return 'confirmed-new-margin';
    }
    if (config?.fixedVariant === true) return 'fixed-size-variant';
    return 'catalog-projected';
}

function getCandidateSourcePriority(config, initialConfig) {
    if (sameWatermarkConfig(config, initialConfig)) return 0;
    if (config?.logoSize === 48 && config.marginRight === 96 && config.marginBottom === 96) return 1;
    if (config?.logoSize === 96 && config.marginRight === 64 && config.marginBottom === 64) return 2;
    if (config?.logoSize === 96 && config.marginRight === 192 && config.marginBottom === 192) return 3;
    if (config?.fixedVariant === true) return 5;
    return 4;
}

function buildCandidateReportSortKey(candidate) {
    return [
        candidate.accepted === true ? 0 : 1,
        ...(Array.isArray(candidate.rankingKey) ? candidate.rankingKey : [])
    ];
}

function compareCandidateReportItems(left, right) {
    return compareRankingKey(
        buildCandidateReportSortKey(left),
        buildCandidateReportSortKey(right)
    );
}

function annotateCandidateRankingReport(candidates, {
    selectedAnchor = null,
    selectedAlphaGain = null,
    expectedAnchor = null,
    expectedAlphaGain = null
} = {}) {
    return candidates.map((candidate, index) => {
        const candidateAnchor = {
            logoSize: candidate.watermarkSize,
            marginRight: candidate.marginRight,
            marginBottom: candidate.marginBottom
        };
        return {
            ...candidate,
            rank: index + 1,
            matchesSelectedAnchor: anchorMatches(candidateAnchor, selectedAnchor),
            matchesSelectedAlpha: alphaGainEquals(candidate.alphaGain, selectedAlphaGain),
            matchesExpectedAnchor: anchorMatches(candidateAnchor, expectedAnchor),
            matchesExpectedAlpha: alphaGainInRange(candidate.alphaGain, expectedAlphaGain)
        };
    });
}

function candidateAnchorFromConfig(config) {
    const normalized = normalizeAnchor(config);
    if (!normalized) return null;
    return {
        logoSize: normalized.logoSize,
        watermarkSize: normalized.logoSize,
        marginRight: normalized.marginRight,
        marginBottom: normalized.marginBottom,
        ...(typeof normalized.alphaVariant === 'string' && normalized.alphaVariant.length > 0
            ? { alphaVariant: normalized.alphaVariant }
            : {})
    };
}

function buildFineAlphaGainSet(selectedAlphaGain) {
    const gains = new Set();
    for (const alphaGain of CANDIDATE_ALPHA_GAINS) {
        gains.add(alphaGain.toFixed(2));
    }
    for (const alphaGain of CATALOG_DARK_ALPHA_GAIN_CANDIDATES) {
        gains.add(alphaGain.toFixed(2));
    }

    const selected = toFiniteNumber(selectedAlphaGain);
    if (selected !== null) {
        gains.add(selected.toFixed(2));
        const stepCount = Math.round(FINE_ALPHA_WINDOW / FINE_ALPHA_STEP);
        for (let step = -stepCount; step <= stepCount; step++) {
            const alphaGain = selected + step * FINE_ALPHA_STEP;
            if (alphaGain > 0 && alphaGain < 1.5) {
                gains.add(alphaGain.toFixed(2));
            }
        }
    }

    return [...gains]
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((left, right) => left - right);
}

function buildFineAlphaGainDiagnostics({
    originalImageData,
    alphaMap,
    position,
    config,
    source,
    selectedAlphaGain,
    initialConfig
}) {
    const alphaGains = buildFineAlphaGainSet(selectedAlphaGain);
    const baselineNearBlackRatio = calculateNearBlackRatio(originalImageData, position);
    const sourcePriority = getCandidateSourcePriority(config, initialConfig);
    const diagnostics = [];

    for (const alphaGain of alphaGains) {
        const candidate = evaluateRestorationCandidate({
            originalImageData,
            alphaMap,
            position,
            source,
            config,
            baselineNearBlackRatio,
            alphaGain,
            includeImageData: true,
            sourcePriority
        });
        if (!candidate) continue;

        const artifacts = assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData: candidate.imageData,
            alphaMap,
            position,
            alphaGain
        });
        const residual = scoreResidual({
            processedSpatial: candidate.processedSpatialScore,
            processedGradient: candidate.processedGradientScore,
            suppressionGain: candidate.improvement,
            artifactCost: artifacts?.visualArtifactCost
        });
        const damage = scoreDamage({
            hardReject: candidate.hardReject,
            nearBlackIncrease: candidate.nearBlackIncrease,
            texturePenalty: candidate.texturePenalty,
            newlyClippedRatio: artifacts?.newlyClippedRatio,
            halo: artifacts?.halo ?? null
        });
        const alphaPriorityIndex = CANDIDATE_ALPHA_GAINS.findIndex((candidateGain) => (
            alphaGainEquals(candidateGain, alphaGain)
        ));
        const rankingKey = buildRankingKey({
            sourcePriority,
            originalEvidenceTier: candidate.originalEvidence?.tier,
            damageSafe: damage.safe,
            residualScore: residual.score,
            alphaPriorityIndex: alphaPriorityIndex >= 0 ? alphaPriorityIndex : 99,
            damagePenalty: damage.penalty
        });

        diagnostics.push({
            alphaGain,
            selected: alphaGainEquals(alphaGain, selectedAlphaGain),
            accepted: candidate.accepted === true,
            originalEvidence: candidate.originalEvidence,
            residual,
            damage: {
                safe: damage.safe,
                penalty: damage.penalty,
                reason: damage.reason,
                nearBlackIncrease: damage.nearBlackIncrease,
                texturePenalty: damage.texturePenalty,
                newlyClippedRatio: damage.newlyClippedRatio,
                halo: damage.halo
            },
            rankingKey
        });
    }

    return diagnostics.sort(compareCandidateReportItems);
}

export function buildSelectedCandidateDiagnostic({
    originalImageData,
    processedImageData,
    meta,
    initialConfig,
    alpha48,
    alpha96,
    alpha96Variants = null,
    getAlphaMap,
    expectedAnchor = null,
    expectedAlphaGain = null
} = {}) {
    if (!originalImageData || !processedImageData || meta?.applied !== true) return null;

    let config = normalizeAnchor(meta.config);
    const initialAnchor = normalizeAnchor(initialConfig);
    if (
        config &&
        !config.alphaVariant &&
        initialAnchor?.alphaVariant &&
        anchorMatches(config, initialAnchor)
    ) {
        config = {
            ...config,
            alphaVariant: initialAnchor.alphaVariant
        };
    }
    const position = meta.position;
    if (!config || !position) return null;

    const alphaMap = resolveAlphaMapForConfig(config, {
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap
    });
    if (!alphaMap) return null;

    const alphaGain = toFiniteNumber(meta.alphaGain) ?? 1;
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: processedImageData,
        alphaMap,
        position,
        alphaGain
    });
    const originalEvidence = scoreOriginalEvidence({
        spatial: meta.detection?.originalSpatialScore,
        gradient: meta.detection?.originalGradientScore
    });
    const residual = scoreResidual({
        processedSpatial: meta.detection?.processedSpatialScore,
        processedGradient: meta.detection?.processedGradientScore,
        suppressionGain: meta.detection?.suppressionGain,
        artifactCost: artifacts?.visualArtifactCost
    });
    const originalNearBlackRatio = calculateNearBlackRatio(originalImageData, position);
    const processedNearBlackRatio = calculateNearBlackRatio(processedImageData, position);
    const damage = scoreDamage({
        hardReject: false,
        nearBlackIncrease: processedNearBlackRatio - originalNearBlackRatio,
        newlyClippedRatio: artifacts?.newlyClippedRatio,
        halo: artifacts?.halo ?? null
    });
    const sourcePriority = getCandidateSourcePriority(config, initialConfig);
    const alphaPriorityIndex = CANDIDATE_ALPHA_GAINS.findIndex((candidateGain) => (
        alphaGainEquals(candidateGain, alphaGain)
    ));
    const rankingKey = buildRankingKey({
        sourcePriority,
        originalEvidenceTier: originalEvidence.tier,
        damageSafe: damage.safe,
        residualScore: residual.score,
        alphaPriorityIndex: alphaPriorityIndex >= 0 ? alphaPriorityIndex : 99,
        damagePenalty: damage.penalty
    });
    const candidateAnchor = candidateAnchorFromConfig(config);
    const fineAlphaNeighborhood = buildFineAlphaGainDiagnostics({
        originalImageData,
        alphaMap,
        position,
        config,
        source: meta.source ?? 'selected-final',
        selectedAlphaGain: alphaGain,
        initialConfig
    });
    const fineAlphaSelectedIndex = fineAlphaNeighborhood.findIndex((candidate) => candidate.selected === true);
    const fineAlphaSelectedRank = fineAlphaSelectedIndex >= 0 ? fineAlphaSelectedIndex + 1 : null;
    const fineAlphaTopAlphaGain = toFiniteNumber(fineAlphaNeighborhood[0]?.alphaGain);
    const fineAlphaTopDelta = fineAlphaTopAlphaGain !== null
        ? Number((fineAlphaTopAlphaGain - alphaGain).toFixed(4))
        : null;
    const fineAlphaTopDeltaBucket = classifyFineAlphaTopDeltaBucket(fineAlphaTopDelta);
    const alphaAdjustmentStages = Array.isArray(meta.alphaAdjustmentStages)
        ? meta.alphaAdjustmentStages
        : [];
    const fineAlphaSelectedAlphaType = classifyAlphaGainType(alphaGain);
    const fineAlphaTopAlphaType = classifyAlphaGainType(fineAlphaTopAlphaGain);
    const fineAlphaSelectionReason = classifyFineAlphaSelectionReason({
        alphaGain,
        fineAlphaSelectedRank,
        alphaAdjustmentStages
    });

    return {
        family: 'selected-final',
        source: meta.source ?? null,
        decisionTier: meta.decisionTier ?? null,
        sourcePriority,
        watermarkSize: candidateAnchor.watermarkSize,
        marginRight: candidateAnchor.marginRight,
        marginBottom: candidateAnchor.marginBottom,
        alphaGain,
        alphaMapProfile: describeAlphaMapProfile(config),
        accepted: true,
        earlyAccept: shouldEarlyAccept({
            sourcePriority,
            originalEvidence,
            residual,
            damage
        }),
        matchesExpectedAnchor: anchorMatches(candidateAnchor, expectedAnchor),
        matchesExpectedAlpha: alphaGainInRange(alphaGain, expectedAlphaGain),
        originalEvidence,
        residual,
        damage: {
            safe: damage.safe,
            penalty: damage.penalty,
            reason: damage.reason,
            nearBlackIncrease: damage.nearBlackIncrease,
            texturePenalty: damage.texturePenalty,
            newlyClippedRatio: damage.newlyClippedRatio,
            halo: damage.halo
        },
        alphaAdjustmentStages,
        fineAlphaSelectedRank,
        fineAlphaTopAlphaGain,
        fineAlphaTopDelta,
        fineAlphaTopDeltaBucket,
        fineAlphaSelectedAlphaType,
        fineAlphaTopAlphaType,
        fineAlphaSelectionReason,
        fineAlphaNeighborhood,
        rankingKey
    };
}

export function summarizeCandidateRankingReport(candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    const findRank = (predicate) => {
        const index = list.findIndex(predicate);
        return index >= 0 ? index + 1 : null;
    };

    return {
        total: list.length,
        acceptedCount: list.filter((candidate) => candidate.accepted === true).length,
        earlyAcceptRank: findRank((candidate) => candidate.earlyAccept === true),
        selectedAnchorRank: findRank((candidate) => candidate.matchesSelectedAnchor === true),
        selectedExactRank: findRank((candidate) => (
            candidate.matchesSelectedAnchor === true &&
            candidate.matchesSelectedAlpha === true
        )),
        expectedAnchorRank: findRank((candidate) => candidate.matchesExpectedAnchor === true),
        expectedAlphaRank: findRank((candidate) => (
            candidate.matchesExpectedAnchor === true &&
            candidate.matchesExpectedAlpha === true
        )),
        topAcceptedMatchesSelectedAnchor: list[0]?.accepted === true &&
            list[0]?.matchesSelectedAnchor === true,
        topAcceptedMatchesSelectedAlpha: list[0]?.accepted === true &&
            list[0]?.matchesSelectedAlpha === true
    };
}

export function buildCandidateRankingReport({
    imageData,
    initialConfig,
    alpha48,
    alpha96,
    alpha96Variants = null,
    getAlphaMap,
    limit = CANDIDATE_RANKING_LIMIT
}) {
    const catalogEntries = resolveGeminiWatermarkSearchCatalogEntries(
        imageData.width,
        imageData.height,
        initialConfig
    );
    const candidates = [];

    for (const catalogEntry of catalogEntries) {
        const config = catalogEntry.config;
        const alphaMap = resolveAlphaMapForConfig(config, {
            alpha48,
            alpha96,
            alpha96Variants,
            getAlphaMap
        });
        if (!alphaMap) continue;

        const position = calculateWatermarkPosition(imageData.width, imageData.height, config);
        if (
            position.x < 0 ||
            position.y < 0 ||
            position.x + position.width > imageData.width ||
            position.y + position.height > imageData.height
        ) {
            continue;
        }

        const baselineNearBlackRatio = calculateNearBlackRatio(imageData, position);
        const sourcePriority = catalogEntry.metadata?.sourcePriority ??
            getCandidateSourcePriority(config, initialConfig);
        const family = catalogEntry.metadata?.family ??
            describeCandidateFamily(config, initialConfig);
        const evaluationSource = sameWatermarkConfig(config, initialConfig)
            ? 'standard'
            : 'standard+catalog';
        const alphaMapProfile = describeAlphaMapProfile(config);

        for (const alphaGain of CANDIDATE_ALPHA_GAINS) {
            const candidate = evaluateRestorationCandidate({
                originalImageData: imageData,
                alphaMap,
                position,
                source: evaluationSource,
                config,
                baselineNearBlackRatio,
                alphaGain,
                provenance: {
                    catalogVariant: !sameWatermarkConfig(config, initialConfig),
                    fixedVariant: config.fixedVariant === true,
                    alphaVariant: config.alphaVariant ?? null
                },
                includeImageData: true
            });
            if (!candidate) continue;

            const artifacts = assessRemovalDiffArtifacts({
                originalImageData: imageData,
                candidateImageData: candidate.imageData,
                alphaMap,
                position,
                alphaGain
            });
            const spatial = toFiniteNumber(candidate.originalSpatialScore) ?? 0;
            const gradient = toFiniteNumber(candidate.originalGradientScore) ?? 0;
            const originalEvidence = scoreOriginalEvidence({ spatial, gradient });
            const residual = scoreResidual({
                processedSpatial: candidate.processedSpatialScore,
                processedGradient: candidate.processedGradientScore,
                suppressionGain: candidate.improvement,
                artifactCost: artifacts?.visualArtifactCost
            });
            const damage = scoreDamage({
                hardReject: candidate.hardReject,
                nearBlackIncrease: candidate.nearBlackIncrease,
                texturePenalty: candidate.texturePenalty,
                newlyClippedRatio: artifacts?.newlyClippedRatio,
                halo: artifacts?.halo ?? null
            });
            const alphaPriorityIndex = CANDIDATE_ALPHA_GAINS.indexOf(alphaGain);
            const rankingKey = buildRankingKey({
                sourcePriority,
                originalEvidenceTier: originalEvidence.tier,
                damageSafe: damage.safe,
                residualScore: residual.score,
                alphaPriorityIndex,
                damagePenalty: damage.penalty
            });
            const earlyAccept = shouldEarlyAccept({
                sourcePriority,
                originalEvidence,
                residual,
                damage
            });

            candidates.push({
                family,
                catalogMetadata: catalogEntry.metadata ?? null,
                sourcePriority,
                watermarkSize: config.logoSize,
                marginRight: config.marginRight,
                marginBottom: config.marginBottom,
                alphaGain,
                alphaMapProfile,
                accepted: candidate.accepted === true,
                earlyAccept,
                originalEvidence,
                residual,
                damage: {
                    safe: damage.safe,
                    penalty: damage.penalty,
                    reason: damage.reason,
                    nearBlackIncrease: damage.nearBlackIncrease,
                    texturePenalty: damage.texturePenalty,
                    newlyClippedRatio: damage.newlyClippedRatio,
                    halo: damage.halo
                },
                rankingKey
            });
        }
    }

    return candidates
        .sort(compareCandidateReportItems)
        .slice(0, limit);
}

function resolveBenchmarkPosition({ imageData, meta, alpha48, alpha96 }) {
    if (meta?.position) return meta.position;

    const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
    const resolvedConfig = resolveInitialStandardConfig({
        imageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    return calculateWatermarkPosition(imageData.width, imageData.height, resolvedConfig);
}

export function classifyBenchmarkQualityFailure(caseRecord, {
    allowWeakResidual = false,
    allowConservativeResidual = false
} = {}) {
    const finalDamageWarning = typeof caseRecord.finalDamageWarning === 'boolean'
        ? caseRecord.finalDamageWarning
        : (
            typeof caseRecord.qualitySignals?.damageWarning === 'boolean'
                ? caseRecord.qualitySignals.damageWarning
                : null
        );
    const qualityStatus = typeof caseRecord.qualityStatus === 'string'
        ? caseRecord.qualityStatus
        : (
            typeof caseRecord.qualitySignals?.qualityStatus === 'string'
                ? caseRecord.qualitySignals.qualityStatus
                : null
        );
    const hasFinalDamageMetadata = finalDamageWarning !== null || qualityStatus !== null;
    const finalDamageDetected =
        finalDamageWarning === true ||
        qualityStatus === 'possible-content-damage' ||
        qualityStatus === 'mixed';
    const selectionDamageSafe = typeof caseRecord.selectionDamageSafe === 'boolean'
        ? caseRecord.selectionDamageSafe
        : (
            typeof caseRecord.damageSafe === 'boolean'
                ? caseRecord.damageSafe
                : caseRecord.selectionDebug?.damage?.safe
        );
    if (
        finalDamageDetected ||
        (!hasFinalDamageMetadata && selectionDamageSafe === false)
    ) {
        return {
            status: 'fail',
            bucket: 'content-damage'
        };
    }

    const residualVisibility = caseRecord.residualVisibility;
    const hasCalibratedSpatialMetricRisk =
        residualVisibility?.rawVisible === true &&
        residualVisibility.visible === false &&
        CALIBRATED_SPATIAL_METRIC_RISKS.has(residualVisibility.metricRisk);
    const hasLowVarianceSpatialMetricRisk =
        hasCalibratedSpatialMetricRisk &&
        residualVisibility.metricRisk === 'flat-low-variance-spatial-correlation';
    const residualScore = toFiniteNumber(caseRecord.residualScore);
    if (
        residualScore !== null &&
        residualScore <= -RESIDUAL_FAIL_THRESHOLD &&
        !hasLowVarianceSpatialMetricRisk
    ) {
        return {
            status: 'fail',
            bucket: 'residual-overshoot'
        };
    }

    const processedGradientScore = toFiniteNumber(caseRecord.processedGradientScore);
    const hasPositiveSpatialResidual =
        !hasCalibratedSpatialMetricRisk &&
        residualScore !== null &&
        residualScore >= RESIDUAL_FAIL_THRESHOLD;
    const hasGradientResidual =
        processedGradientScore !== null &&
        processedGradientScore >= GRADIENT_FAIL_THRESHOLD;
    const hasVisibleResidual = residualVisibility?.visible === true;
    const hasNonSpatialVisibleResidual = hasVisibleResidual && (
        residualVisibility.visibleGradientResidual === true ||
        residualVisibility.visiblePositiveHalo === true ||
        residualVisibility.visibleSpatialResidual !== true
    );

    const suppressionGain = toFiniteNumber(caseRecord.suppressionGain);
    if (
        allowWeakResidual &&
        residualScore !== null &&
        Math.abs(residualScore) <= ALLOW_WEAK_RESIDUAL_MAX_ABS_SPATIAL &&
        suppressionGain !== null &&
        suppressionGain >= MIN_EXPECTED_SUPPRESSION_GAIN &&
        !hasGradientResidual &&
        !hasNonSpatialVisibleResidual
    ) {
        return null;
    }

    if (!hasPositiveSpatialResidual && !hasGradientResidual && !hasVisibleResidual) {
        return null;
    }

    if (
        allowConservativeResidual &&
        hasPositiveSpatialResidual &&
        !hasGradientResidual &&
        !hasVisibleResidual
    ) {
        return null;
    }

    if (
        suppressionGain === null ||
        suppressionGain < MIN_EXPECTED_SUPPRESSION_GAIN
    ) {
        return {
            status: 'fail',
            bucket: 'weak-suppression'
        };
    }

    return {
        status: 'fail',
        bucket: 'residual-edge'
    };
}

export function classifyBenchmarkCase(caseRecord) {
    if (caseRecord.expectedGemini) {
        if (caseRecord.applied !== true) {
            return {
                status: 'fail',
                bucket: 'missed-detection'
            };
        }

        if (!anchorMatches(caseRecord.actualAnchor, caseRecord.expectedAnchor)) {
            return {
                status: 'fail',
                bucket: 'anchor-mismatch'
            };
        }

        if (!alphaGainInRange(caseRecord.alphaGain, caseRecord.expectedAlphaGain)) {
            return {
                status: 'fail',
                bucket: 'alpha-mismatch'
            };
        }

        const qualityFailure = classifyBenchmarkQualityFailure(caseRecord, {
            allowWeakResidual: caseRecord.allowWeakResidual === true,
            allowConservativeResidual: isConservativeCanonical96Residual(caseRecord)
        });
        if (qualityFailure) {
            const knownIssue = caseRecord.knownIssue;
            if (
                Number.isInteger(knownIssue?.issue) &&
                knownIssue.issue > 0 &&
                knownIssue.qualityStatus === caseRecord.qualityStatus &&
                knownIssue.bucket === qualityFailure.bucket
            ) {
                return {
                    status: 'known-issue',
                    bucket: qualityFailure.bucket,
                    issue: knownIssue.issue
                };
            }
            return qualityFailure;
        }

        if (caseRecord.decisionTier === 'insufficient' || caseRecord.decisionTier == null) {
            return {
                status: 'fail',
                bucket: 'attribution-mismatch'
            };
        }

        return {
            status: 'pass',
            bucket: 'pass'
        };
    }

    if (
        caseRecord.applied === true ||
        (toFiniteNumber(caseRecord.changedRatio) !== null && caseRecord.changedRatio > NON_GEMINI_MAX_CHANGED_RATIO) ||
        (toFiniteNumber(caseRecord.avgAbsoluteDeltaPerChannel) !== null &&
            caseRecord.avgAbsoluteDeltaPerChannel > NON_GEMINI_MAX_AVG_DELTA)
    ) {
        return {
            status: 'fail',
            bucket: 'false-positive'
        };
    }

    return {
        status: 'pass',
        bucket: 'pass'
    };
}

export function summarizeBenchmarkResults(results) {
    const summary = {
        total: results.length,
        passCount: 0,
        knownIssueCount: 0,
        failCount: 0,
        buckets: {},
        candidateRanking: {
            topAcceptedMatchesSelectedAnchor: 0,
            topAcceptedMatchesSelectedAlpha: 0,
            selectedAnchorInTop: 0,
            selectedExactInTop: 0,
            earlyAcceptInTop: 0,
            selectedFinalDiagnosticCount: 0,
            selectedFinalExpectedAnchorCount: 0,
            selectedFinalExpectedAlphaCount: 0,
            selectedFinalFineAlphaNeighborhoodCount: 0,
            selectedFinalFineAlphaTopCount: 0,
            selectedFinalFineAlphaSelectedRankCounts: {},
            selectedFinalFineAlphaSelectionReasons: {},
            selectedFinalFineAlphaSelectedAlphaTypes: {},
            selectedFinalFineAlphaTopDeltaBuckets: {},
            selectedFinalFineAlphaNonTopReasonCounts: {},
            selectedFinalFineAlphaNonTopSelectedAlphaTypes: {},
            selectedFinalFineAlphaNonTopDeltaBuckets: {},
            selectedFinalFineAlphaNonTopWithAdjustmentCount: 0,
            selectedFinalFineAlphaNonTopWithoutAdjustmentCount: 0,
            selectedFinalFineAlphaNonTopSamples: [],
            selectedFinalFineAlphaSignificantDeltaCount: 0,
            selectedFinalFineAlphaSignificantDeltaConcerns: {},
            selectedFinalFineAlphaSignificantDeltaSamples: [],
            selectedFinalAlphaAdjustmentCount: 0,
            selectedFinalAlphaAdjustmentStages: {},
            selectedFinalAlphaAdjustmentStageSamples: {}
        }
    };

    for (const item of results) {
        const bucket = item.classification?.bucket || 'unknown';
        summary.buckets[bucket] = (summary.buckets[bucket] ?? 0) + 1;

        if (item.classification?.status === 'fail') {
            summary.failCount++;
        } else if (item.classification?.status === 'known-issue') {
            summary.knownIssueCount++;
        } else {
            summary.passCount++;
        }

        const candidateSummary = item.candidateRankingSummary;
        if (candidateSummary) {
            if (candidateSummary.topAcceptedMatchesSelectedAnchor) {
                summary.candidateRanking.topAcceptedMatchesSelectedAnchor++;
            }
            if (candidateSummary.topAcceptedMatchesSelectedAlpha) {
                summary.candidateRanking.topAcceptedMatchesSelectedAlpha++;
            }
            if (candidateSummary.selectedAnchorRank !== null) {
                summary.candidateRanking.selectedAnchorInTop++;
            }
            if (candidateSummary.selectedExactRank !== null) {
                summary.candidateRanking.selectedExactInTop++;
            }
            if (candidateSummary.earlyAcceptRank !== null) {
                summary.candidateRanking.earlyAcceptInTop++;
            }
        }

        const selectedDiagnostic = item.selectedCandidateDiagnostic;
        if (selectedDiagnostic) {
            summary.candidateRanking.selectedFinalDiagnosticCount++;
            if (selectedDiagnostic.matchesExpectedAnchor === true) {
                summary.candidateRanking.selectedFinalExpectedAnchorCount++;
            }
            if (selectedDiagnostic.matchesExpectedAlpha === true) {
                summary.candidateRanking.selectedFinalExpectedAlphaCount++;
            }
            const fineAlphaNeighborhood = Array.isArray(selectedDiagnostic.fineAlphaNeighborhood)
                ? selectedDiagnostic.fineAlphaNeighborhood
                : [];
            if (fineAlphaNeighborhood.length > 0) {
                summary.candidateRanking.selectedFinalFineAlphaNeighborhoodCount++;
            }
            if (fineAlphaNeighborhood[0]?.selected === true) {
                summary.candidateRanking.selectedFinalFineAlphaTopCount++;
            }
            if (Number.isInteger(selectedDiagnostic.fineAlphaSelectedRank)) {
                const rankKey = String(selectedDiagnostic.fineAlphaSelectedRank);
                summary.candidateRanking.selectedFinalFineAlphaSelectedRankCounts[rankKey] =
                    (summary.candidateRanking.selectedFinalFineAlphaSelectedRankCounts[rankKey] ?? 0) + 1;
                const selectedAlphaType = selectedDiagnostic.fineAlphaSelectedAlphaType ?? 'unknown';
                summary.candidateRanking.selectedFinalFineAlphaSelectedAlphaTypes[selectedAlphaType] =
                    (summary.candidateRanking.selectedFinalFineAlphaSelectedAlphaTypes[selectedAlphaType] ?? 0) + 1;
                const deltaBucket = selectedDiagnostic.fineAlphaTopDeltaBucket ?? 'unknown';
                summary.candidateRanking.selectedFinalFineAlphaTopDeltaBuckets[deltaBucket] =
                    (summary.candidateRanking.selectedFinalFineAlphaTopDeltaBuckets[deltaBucket] ?? 0) + 1;
                const selectionReason = selectedDiagnostic.fineAlphaSelectionReason ?? 'unknown';
                summary.candidateRanking.selectedFinalFineAlphaSelectionReasons[selectionReason] =
                    (summary.candidateRanking.selectedFinalFineAlphaSelectionReasons[selectionReason] ?? 0) + 1;
                if (selectedDiagnostic.fineAlphaSelectedRank !== 1 && typeof item.fileName === 'string') {
                    const hasAlphaAdjustment = Array.isArray(selectedDiagnostic.alphaAdjustmentStages) &&
                        selectedDiagnostic.alphaAdjustmentStages.length > 0;
                    const topFineAlphaCandidate = fineAlphaNeighborhood[0] ?? null;
                    const selectedResidualScore = toFiniteNumber(selectedDiagnostic.residual?.score);
                    const topResidualScore = toFiniteNumber(topFineAlphaCandidate?.residual?.score);
                    const selectedDamagePenalty = toFiniteNumber(selectedDiagnostic.damage?.penalty);
                    const topDamagePenalty = toFiniteNumber(topFineAlphaCandidate?.damage?.penalty);
                    const residualScoreDelta = selectedResidualScore !== null && topResidualScore !== null
                        ? Number((topResidualScore - selectedResidualScore).toFixed(6))
                        : null;
                    const significantDeltaConcern = classifySignificantFineAlphaDeltaConcern({
                        residualScoreDelta,
                        selectedDamagePenalty,
                        topDamagePenalty,
                        topDamageSafe: topFineAlphaCandidate?.damage?.safe ?? null,
                        selectionReason,
                        selectedAlphaGain: selectedDiagnostic.alphaGain,
                        topAlphaGain: selectedDiagnostic.fineAlphaTopAlphaGain,
                        decisionTier: selectedDiagnostic.decisionTier
                    });
                    if (hasAlphaAdjustment) {
                        summary.candidateRanking.selectedFinalFineAlphaNonTopWithAdjustmentCount++;
                    } else {
                        summary.candidateRanking.selectedFinalFineAlphaNonTopWithoutAdjustmentCount++;
                    }
                    summary.candidateRanking.selectedFinalFineAlphaNonTopReasonCounts[selectionReason] =
                        (summary.candidateRanking.selectedFinalFineAlphaNonTopReasonCounts[selectionReason] ?? 0) + 1;
                    summary.candidateRanking.selectedFinalFineAlphaNonTopSelectedAlphaTypes[selectedAlphaType] =
                        (summary.candidateRanking.selectedFinalFineAlphaNonTopSelectedAlphaTypes[selectedAlphaType] ?? 0) + 1;
                    summary.candidateRanking.selectedFinalFineAlphaNonTopDeltaBuckets[deltaBucket] =
                        (summary.candidateRanking.selectedFinalFineAlphaNonTopDeltaBuckets[deltaBucket] ?? 0) + 1;
                    const nonTopSample = {
                        fileName: item.fileName,
                        selectedRank: selectedDiagnostic.fineAlphaSelectedRank,
                        selectedAlphaGain: selectedDiagnostic.alphaGain,
                        topAlphaGain: selectedDiagnostic.fineAlphaTopAlphaGain,
                        alphaDelta: selectedDiagnostic.fineAlphaTopDelta,
                        alphaDeltaBucket: deltaBucket,
                        reason: selectionReason,
                        selectedAlphaType,
                        topAlphaType: selectedDiagnostic.fineAlphaTopAlphaType ?? 'unknown',
                        selectedResidualScore,
                        topResidualScore,
                        residualScoreDelta,
                        selectedDamagePenalty,
                        topDamagePenalty,
                        topDamageSafe: topFineAlphaCandidate?.damage?.safe ?? null,
                        topAccepted: topFineAlphaCandidate?.accepted ?? null,
                        significantDeltaConcern: isSignificantFineAlphaDeltaBucket(deltaBucket)
                            ? significantDeltaConcern
                            : null,
                        alphaAdjustmentStages: Array.isArray(selectedDiagnostic.alphaAdjustmentStages)
                            ? selectedDiagnostic.alphaAdjustmentStages.map((stage) => stage.stage).filter(Boolean)
                            : []
                    };
                    summary.candidateRanking.selectedFinalFineAlphaNonTopSamples.push(nonTopSample);
                    if (isSignificantFineAlphaDeltaBucket(deltaBucket)) {
                        summary.candidateRanking.selectedFinalFineAlphaSignificantDeltaCount++;
                        summary.candidateRanking.selectedFinalFineAlphaSignificantDeltaConcerns[significantDeltaConcern] =
                            (summary.candidateRanking.selectedFinalFineAlphaSignificantDeltaConcerns[significantDeltaConcern] ?? 0) + 1;
                        summary.candidateRanking.selectedFinalFineAlphaSignificantDeltaSamples.push(nonTopSample);
                    }
                }
            }
            if (Array.isArray(selectedDiagnostic.alphaAdjustmentStages) &&
                selectedDiagnostic.alphaAdjustmentStages.length > 0) {
                summary.candidateRanking.selectedFinalAlphaAdjustmentCount++;
                for (const stage of selectedDiagnostic.alphaAdjustmentStages) {
                    const stageName = typeof stage?.stage === 'string' && stage.stage.length > 0
                        ? stage.stage
                        : 'unknown';
                    summary.candidateRanking.selectedFinalAlphaAdjustmentStages[stageName] =
                        (summary.candidateRanking.selectedFinalAlphaAdjustmentStages[stageName] ?? 0) + 1;
                    if (typeof item.fileName === 'string' && item.fileName.length > 0) {
                        const stageSamples = summary.candidateRanking.selectedFinalAlphaAdjustmentStageSamples;
                        if (!Array.isArray(stageSamples[stageName])) {
                            stageSamples[stageName] = [];
                        }
                        if (!stageSamples[stageName].includes(item.fileName)) {
                            stageSamples[stageName].push(item.fileName);
                        }
                    }
                }
            }
        }
    }

    return summary;
}

async function buildBenchmarkReport({
    sampleDir = path.resolve('src/assets/samples')
} = {}) {
    const bg48Path = path.resolve('src/assets/bg_48.png');
    const bg96Path = path.resolve('src/assets/bg_96.png');
    const bg96NewMarginPath = path.resolve('src/assets/bg_96_20260520.png');
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(bg48Path));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(bg96Path));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(bg96NewMarginPath));
    const alpha96OutlineLight = getEmbeddedAlphaMap('96-outline-light');
    const alpha96OutlineDark = getEmbeddedAlphaMap('96-outline-dark');
    const alpha96Variants = {
        '20260520': alpha96NewMargin,
        'outline-light': alpha96OutlineLight,
        'outline-dark': alpha96OutlineDark
    };
    const alphaResolver = (size) => {
        if (size === '36-v2') return getEmbeddedAlphaMap('36-v2');
        if (size === '96-outline-light') return alpha96OutlineLight;
        if (size === '96-outline-dark') return alpha96OutlineDark;
        if (size === 48) return alpha48;
        if (size === 96) return alpha96;
        return interpolateAlphaMap(alpha96, 96, size);
    };

    const results = [];
    const sampleItems = await listBenchmarkSampleAssets(sampleDir);

    for (const item of sampleItems) {
        const filePath = path.join(sampleDir, item.fileName);
        const imageData = await decodeImageDataInNode(filePath);
        const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
        const initialConfig = resolveInitialStandardConfig({
            imageData,
            defaultConfig,
            alpha48,
            alpha96
        });
        const processed = processWatermarkImageData(imageData, {
            alpha48,
            alpha96,
            alpha96Variants,
            getAlphaMap: alphaResolver
        });
        const rawCandidateRankings = buildCandidateRankingReport({
            imageData,
            initialConfig,
            alpha48,
            alpha96,
            alpha96Variants,
            getAlphaMap: alphaResolver
        });
        const candidateRankings = annotateCandidateRankingReport(rawCandidateRankings, {
            selectedAnchor: normalizeAnchor(processed.meta.config),
            selectedAlphaGain: processed.meta.alphaGain,
            expectedAnchor: item.gold?.expectedAnchor ?? null,
            expectedAlphaGain: item.gold?.expectedAlphaGain ?? null
        });
        const candidateRankingSummary = summarizeCandidateRankingReport(candidateRankings);
        const selectedCandidateDiagnostic = buildSelectedCandidateDiagnostic({
            originalImageData: imageData,
            processedImageData: processed.imageData,
            meta: processed.meta,
            initialConfig,
            alpha48,
            alpha96,
            alpha96Variants,
            getAlphaMap: alphaResolver,
            expectedAnchor: item.gold?.expectedAnchor ?? null,
            expectedAlphaGain: item.gold?.expectedAlphaGain ?? null
        });
        const position = resolveBenchmarkPosition({
            imageData,
            meta: processed.meta,
            alpha48,
            alpha96
        });
        const regionDelta = measureRegionDelta(imageData, processed.imageData, position);
        const record = {
            fileName: item.fileName,
            filePath,
            expectedGemini: item.expectedGemini,
            gold: item.gold ?? null,
            admission: item.gold?.admission ?? null,
            knownIssue: item.gold?.knownIssue ?? null,
            applied: processed.meta.applied === true,
            skipReason: processed.meta.skipReason || null,
            source: processed.meta.source || '',
            decisionTier: processed.meta.decisionTier || null,
            actualAnchor: normalizeAnchor(processed.meta.config),
            expectedAnchor: item.gold?.expectedAnchor ?? null,
            alphaGain: toFiniteNumber(processed.meta.alphaGain),
            expectedAlphaGain: item.gold?.expectedAlphaGain ?? null,
            allowWeakResidual: item.gold?.allowWeakResidual === true,
            position,
            size: processed.meta.size ?? position.width,
            passCount: processed.meta.passCount ?? 0,
            attemptedPassCount: processed.meta.attemptedPassCount ?? 0,
            passStopReason: processed.meta.passStopReason || null,
            residualScore: toFiniteNumber(processed.meta.detection?.processedSpatialScore),
            processedGradientScore: toFiniteNumber(processed.meta.detection?.processedGradientScore),
            originalSpatialScore: toFiniteNumber(processed.meta.detection?.originalSpatialScore),
            originalGradientScore: toFiniteNumber(processed.meta.detection?.originalGradientScore),
            suppressionGain: toFiniteNumber(processed.meta.detection?.suppressionGain),
            adaptiveConfidence: toFiniteNumber(processed.meta.detection?.adaptiveConfidence),
            residualVisibility: processed.meta.detection?.residualVisibility ?? null,
            qualityStatus:
                processed.meta.qualityStatus ??
                processed.meta.qualitySignals?.qualityStatus ??
                null,
            finalDamageWarning:
                typeof processed.meta.qualitySignals?.damageWarning === 'boolean'
                    ? processed.meta.qualitySignals.damageWarning
                    : null,
            qualitySignals: processed.meta.qualitySignals ?? null,
            selectionDamageSafe: processed.meta.selectionDebug?.damage?.safe ?? null,
            decisionPath: processed.meta.decisionPath ?? null,
            changedRatio: regionDelta.changedRatio,
            avgAbsoluteDeltaPerChannel: regionDelta.avgAbsoluteDeltaPerChannel,
            selectionDebug: processed.meta.selectionDebug ?? null,
            selectedCandidateDiagnostic,
            candidateRankingSummary,
            candidateRankings
        };
        record.classification = classifyBenchmarkCase(record);
        results.push(record);
    }

    return {
        generatedAt: new Date().toISOString(),
        sampleDir,
        summary: summarizeBenchmarkResults(results),
        results
    };
}

export async function runSampleBenchmark({
    sampleDir = path.resolve('src/assets/samples'),
    outputPath = DEFAULT_OUTPUT_PATH
} = {}) {
    const report = await buildBenchmarkReport({ sampleDir });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
}

function parseCliArgs(argv) {
    const args = [...argv];
    const parsed = {
        sampleDir: path.resolve('src/assets/samples'),
        outputPath: DEFAULT_OUTPUT_PATH
    };

    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--sample-dir') {
            parsed.sampleDir = path.resolve(args.shift() || parsed.sampleDir);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
        }
    }

    return parsed;
}

async function runCli() {
    const options = parseCliArgs(process.argv.slice(2));
    const report = await runSampleBenchmark(options);

    for (const item of report.results) {
        if (item.classification.status === 'fail') {
            console.log(
                `[FAIL] ${item.fileName} bucket=${item.classification.bucket} ` +
                `tier=${item.decisionTier || 'null'} source=${item.source || 'null'} ` +
                `residual=${item.residualScore ?? 'null'} gain=${item.suppressionGain ?? 'null'}`
            );
        } else if (item.classification.status === 'known-issue') {
            console.log(
                `[KNOWN #${item.classification.issue}] ${item.fileName} ` +
                `bucket=${item.classification.bucket} quality=${item.qualityStatus || 'null'} ` +
                `residual=${item.residualScore ?? 'null'} gradient=${item.processedGradientScore ?? 'null'}`
            );
        }
    }

    console.log(
        `summary: pass=${report.summary.passCount} known=${report.summary.knownIssueCount} ` +
        `fail=${report.summary.failCount} total=${report.summary.total}`
    );
    console.log(`report: ${options.outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

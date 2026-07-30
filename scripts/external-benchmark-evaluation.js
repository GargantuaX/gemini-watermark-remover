import { classifyBenchmarkQualityFailure } from './sample-benchmark.js';

const CONSERVATIVE_CANONICAL_96_MAX_RESIDUAL = 0.35;
const CONSERVATIVE_CANONICAL_96_MAX_GRADIENT = 0.08;
const CONSERVATIVE_CANONICAL_96_MIN_SUPPRESSION_GAIN = 0.38;
const CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_SPATIAL = 0.55;
const CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_GRADIENT = 0.2;
const DATASET_IDENTITY_FIELDS = ['datasetId', 'labelManifestSha256', 'contentSetSha256'];
const RUNTIME_LABELS = new Set(['watermarked', 'clean', 'ambiguous', 'unlabeled']);

function normalizeExternalBenchmarkLabel(label) {
    if (label == null) return 'unlabeled';
    if (!RUNTIME_LABELS.has(label)) {
        throw new Error(`unknown external benchmark label: ${label}`);
    }
    return label;
}

function normalizeTrustedExternalBenchmarkRecord(record) {
    const label = normalizeExternalBenchmarkLabel(record.label);
    if (label === 'ambiguous' || label === 'unlabeled') {
        return {
            ...record,
            label,
            classification: { status: 'excluded', bucket: label, includedInMetrics: false }
        };
    }
    return { ...record, label };
}

function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isConservativeCanonical96Pass(record) {
    const anchor = record.actualAnchor;
    const alphaGain = toFiniteNumber(record.alphaGain);
    const residualScore = toFiniteNumber(record.residualScore);
    const processedGradientScore = toFiniteNumber(record.processedGradientScore);
    const originalSpatialScore = toFiniteNumber(record.originalSpatialScore);
    const originalGradientScore = toFiniteNumber(record.originalGradientScore);
    const suppressionGain = toFiniteNumber(record.suppressionGain);

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
        suppressionGain >= CONSERVATIVE_CANONICAL_96_MIN_SUPPRESSION_GAIN;
}

export function classifyExternalBenchmarkCase(record) {
    if (record.applied !== true) {
        return {
            status: 'fail',
            bucket: 'missed-detection'
        };
    }

    const qualityFailure = classifyBenchmarkQualityFailure(record, {
        allowConservativeResidual: isConservativeCanonical96Pass(record)
    });
    if (qualityFailure) return qualityFailure;

    if (record.decisionTier === 'insufficient' || record.decisionTier == null) {
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

export function classifyLabeledExternalBenchmarkCase(record) {
    const label = normalizeExternalBenchmarkLabel(record.label);
    if (label === 'ambiguous' || label === 'unlabeled') {
        return { status: 'excluded', bucket: label, includedInMetrics: false };
    }
    if (label === 'clean') {
        return record.pixelsChanged === true
            ? { status: 'fail', bucket: 'false-positive', includedInMetrics: true }
            : { status: 'pass', bucket: 'clean-skip', includedInMetrics: true };
    }
    const classification = classifyExternalBenchmarkCase(record);
    return { ...classification, includedInMetrics: true };
}

const metric = (numerator, denominator) => ({
    numerator,
    denominator,
    rate: denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null
});

function anchorKey(anchor) {
    if (!anchor) return 'none';
    const suffix = anchor.alphaVariant ? `/${anchor.alphaVariant}` : '';
    return `${anchor.logoSize}/${anchor.marginRight}/${anchor.marginBottom}${suffix}`;
}

function incrementBucket(map, key, status) {
    if (!map[key]) {
        map[key] = {
            total: 0,
            pass: 0,
            fail: 0,
            excludedCount: 0,
            qualifiedTotal: 0,
            rate: 0,
            buckets: {}
        };
    }
    map[key].total++;
    if (status.includedInMetrics === true) {
        map[key].qualifiedTotal++;
        if (status.status === 'pass') map[key].pass++;
        else if (status.status === 'fail') map[key].fail++;
    } else {
        map[key].excludedCount++;
    }
    map[key].buckets[status.bucket] = (map[key].buckets[status.bucket] ?? 0) + 1;
}

function finalizeBucketMap(map) {
    for (const value of Object.values(map)) {
        value.rate = value.qualifiedTotal > 0
            ? Number((value.pass / value.qualifiedTotal).toFixed(4))
            : null;
    }
}

function summarizeDiagnostics(results, successRate) {
    const summary = {
        total: results.length,
        passCount: 0,
        failCount: 0,
        excludedCount: 0,
        successRate,
        buckets: {},
        byGroup: {},
        byDecisionTier: {},
        bySource: {},
        byAnchor: {},
        contourResidualShadow: {
            measuredCount: 0,
            unavailableCount: 0,
            flaggedCount: 0,
            fallbackGeometryCount: 0
        },
        interiorResidualShadow: {
            evidenceStatus: 'provisional',
            measuredCount: 0,
            unavailableCount: 0,
            flaggedCount: 0,
            fallbackGeometryCount: 0
        },
        sourceOnly: null
    };

    for (const record of results) {
        const status = record.classification;
        if (status.status === 'pass') summary.passCount++;
        else if (status.status === 'fail') summary.failCount++;
        else summary.excludedCount++;
        summary.buckets[status.bucket] = (summary.buckets[status.bucket] ?? 0) + 1;
        incrementBucket(summary.byGroup, record.group ?? 'null', status);
        incrementBucket(summary.byDecisionTier, record.decisionTier ?? 'null', status);
        incrementBucket(summary.bySource, record.source || 'null', status);
        incrementBucket(summary.byAnchor, anchorKey(record.actualAnchor), status);
        if (record.contourResidualShadow?.status === 'measured') {
            summary.contourResidualShadow.measuredCount++;
            if (record.contourResidualShadow.geometrySource === 'review-fallback') {
                summary.contourResidualShadow.fallbackGeometryCount++;
            }
            if (record.contourResidualShadow.flagged === true) {
                summary.contourResidualShadow.flaggedCount++;
            }
        } else {
            summary.contourResidualShadow.unavailableCount++;
        }
        if (record.interiorResidualShadow?.status === 'measured') {
            summary.interiorResidualShadow.measuredCount++;
            if (record.interiorResidualShadow.geometrySource === 'review-fallback') {
                summary.interiorResidualShadow.fallbackGeometryCount++;
            }
            if (record.interiorResidualShadow.flagged === true) {
                summary.interiorResidualShadow.flaggedCount++;
            }
        } else {
            summary.interiorResidualShadow.unavailableCount++;
        }
    }

    finalizeBucketMap(summary.byGroup);
    finalizeBucketMap(summary.byDecisionTier);
    finalizeBucketMap(summary.bySource);
    finalizeBucketMap(summary.byAnchor);

    const sourceOnly = summary.byGroup['task-source'] ?? null;
    summary.sourceOnly = sourceOnly
        ? {
            total: sourceOnly.total,
            passCount: sourceOnly.pass,
            failCount: sourceOnly.fail,
            excludedCount: sourceOnly.excludedCount,
            qualifiedTotal: sourceOnly.qualifiedTotal,
            successRate: sourceOnly.rate,
            buckets: sourceOnly.buckets
        }
        : null;

    return summary;
}

export function summarizeTrustedExternalBenchmarkResults(results) {
    const labels = { watermarked: 0, clean: 0, ambiguous: 0, unlabeled: 0 };
    const normalizedResults = results.map(normalizeTrustedExternalBenchmarkRecord);
    for (const record of normalizedResults) labels[record.label]++;
    const watermarked = normalizedResults.filter((record) => record.label === 'watermarked');
    const clean = normalizedResults.filter((record) => record.label === 'clean');
    const appliedWatermarked = watermarked.filter((record) => record.applied === true);
    const passedWatermarked = watermarked.filter((record) => record.classification.status === 'pass');
    const cleanSkips = clean.filter((record) => record.classification.bucket === 'clean-skip');
    const falsePositives = clean.filter((record) => record.classification.bucket === 'false-positive');
    const qualifiedPasses = passedWatermarked.length + cleanSkips.length;
    const metrics = {
        watermarkDetectionRecall: metric(appliedWatermarked.length, watermarked.length),
        watermarkEndToEndPassRate: metric(passedWatermarked.length, watermarked.length),
        restorationPassRateAmongApplied: metric(passedWatermarked.length, appliedWatermarked.length),
        cleanSkipRate: metric(cleanSkips.length, clean.length),
        falsePositiveRate: metric(falsePositives.length, clean.length),
        qualifiedOverallPassRate: metric(qualifiedPasses, watermarked.length + clean.length)
    };
    return {
        labels,
        metrics,
        summary: summarizeDiagnostics(normalizedResults, metrics.qualifiedOverallPassRate.rate),
        reviewQueue: {
            ambiguous: normalizedResults.filter((record) => record.label === 'ambiguous'),
            unlabeled: normalizedResults.filter((record) => record.label === 'unlabeled')
        }
    };
}

export function compareTrustedExternalBenchmarkResults({ dataset, results, baseline }) {
    if (!baseline) return { status: 'not-requested', newlyPassing: [], newlyFailing: [] };
    if (dataset.trusted !== true || baseline.dataset?.trusted !== true) {
        throw new Error('baseline comparison requires trusted-labels reports');
    }
    for (const field of DATASET_IDENTITY_FIELDS) {
        if (dataset[field] !== baseline.dataset[field]) {
            throw new Error(`baseline dataset ${field} mismatch`);
        }
    }
    const previous = new Map(baseline.results
        .filter((record) => record.classification?.includedInMetrics === true)
        .map((record) => [record.contentSha256, record.classification.status]));
    const newlyPassing = [];
    const newlyFailing = [];
    for (const record of results.filter((item) => item.classification.includedInMetrics === true)) {
        const before = previous.get(record.contentSha256);
        if (before === 'fail' && record.classification.status === 'pass') newlyPassing.push(record.fileName);
        if (before === 'pass' && record.classification.status === 'fail') newlyFailing.push(record.fileName);
    }
    return { status: 'comparable', newlyPassing, newlyFailing };
}

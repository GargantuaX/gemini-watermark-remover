import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-decision-path.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-monitor'
);

const STRICT_THRESHOLDS = Object.freeze({
    spatialResidual: 0.04,
    gradientResidual: 0.08,
    positiveHaloLum: 3,
    damagePenalty: 0.2,
    texturePenalty: 0.25,
    nearBlackIncrease: 0.02,
    newlyClippedRatio: 0.005,
    minSuppressionGain: 0.3
});

const CLEAN_THRESHOLDS = Object.freeze({
    spatialResidual: 0.08,
    gradientResidual: 0.12,
    positiveHaloLum: 6,
    damagePenalty: 0.5,
    texturePenalty: 0.6,
    nearBlackIncrease: 0.05,
    newlyClippedRatio: 0.01,
    minSuppressionGain: 0.25
});

const SEVERE_THRESHOLDS = Object.freeze({
    spatialResidual: 0.18,
    gradientResidual: 0.22,
    positiveHaloLum: 12,
    damagePenalty: 1,
    texturePenalty: 1,
    nearBlackIncrease: 0.1,
    newlyClippedRatio: 0.03
});

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        baselinePath: null,
        outputDir: DEFAULT_OUTPUT_DIR,
        failOnStrictDefectIncrease: false,
        maxStrictDefectIncrease: 0,
        failOnPerfectLoss: false,
        maxPerfectLoss: 0,
        failOnAppliedLoss: false,
        maxAppliedLoss: 0
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
        } else if (arg === '--baseline') {
            parsed.baselinePath = path.resolve(args.shift() || '');
        } else if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
        } else if (arg === '--fail-on-strict-defect-increase') {
            parsed.failOnStrictDefectIncrease = true;
        } else if (arg === '--max-strict-defect-increase') {
            parsed.maxStrictDefectIncrease = parseInteger(args.shift(), parsed.maxStrictDefectIncrease);
        } else if (arg === '--fail-on-perfect-loss') {
            parsed.failOnPerfectLoss = true;
        } else if (arg === '--max-perfect-loss') {
            parsed.maxPerfectLoss = parseInteger(args.shift(), parsed.maxPerfectLoss);
        } else if (arg === '--fail-on-applied-loss') {
            parsed.failOnAppliedLoss = true;
        } else if (arg === '--max-applied-loss') {
            parsed.maxAppliedLoss = parseInteger(args.shift(), parsed.maxAppliedLoss);
        }
    }
    return parsed;
}

function parseInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function round(value, digits = 6) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function rate(count, total) {
    return total > 0 ? round(count / total, 6) : 0;
}

function percent(count, total) {
    return total > 0 ? `${(count / total * 100).toFixed(2)}%` : '0.00%';
}

function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function anchorKey(anchor) {
    if (!anchor) return 'none';
    const suffix = anchor.alphaVariant ? `/${anchor.alphaVariant}` : '';
    return `${anchor.logoSize}/${anchor.marginRight}/${anchor.marginBottom}${suffix}`;
}

export function extractDamage(record) {
    const alphaDamage = record.decisionPath?.alphaTrial?.damage ?? null;
    const evaluationDamage = record.decisionPath?.evaluation?.damage ?? null;
    const repairDamage = record.decisionPath?.repairTrial?.damage ?? null;
    return alphaDamage ?? repairDamage ?? evaluationDamage ?? null;
}

function extractFinalAlphaArtifacts(record) {
    return record.decisionPath?.alphaTrial?.artifacts ??
        record.qualitySignals?.artifacts ??
        null;
}

function extractFinalAlphaResidual(record, artifacts) {
    if (!artifacts) return null;
    return record.decisionPath?.alphaTrial?.residual ?? null;
}

export function summarizeRecord(record) {
    const residualVisibility = record.residualVisibility ?? {};
    const damage = extractDamage(record);
    const artifacts = extractFinalAlphaArtifacts(record);
    const finalResidual = extractFinalAlphaResidual(record, artifacts);
    const residual = Math.abs(
        toFiniteNumber(finalResidual?.spatialResidual) ??
        toFiniteNumber(finalResidual?.spatial) ??
        toFiniteNumber(record.residualScore) ??
        0
    );
    const gradient = Math.max(
        0,
        toFiniteNumber(finalResidual?.gradientResidual) ??
        toFiniteNumber(finalResidual?.gradient) ??
        toFiniteNumber(record.processedGradientScore) ??
        0
    );
    const positiveHaloLum = Math.max(0, toFiniteNumber(residualVisibility.positiveHaloLum) ?? 0);
    const suppressionGain = toFiniteNumber(record.suppressionGain);
    const damagePenalty = Math.max(0, toFiniteNumber(damage?.penalty) ?? 0);
    const texturePenalty = Math.max(0, toFiniteNumber(damage?.texturePenalty) ?? 0);
    const nearBlackIncrease = Math.max(0, toFiniteNumber(damage?.nearBlackIncrease) ?? 0);
    const newlyClippedRatio = Math.max(
        0,
        toFiniteNumber(artifacts?.newlyClippedRatio) ??
        toFiniteNumber(damage?.newlyClippedRatio) ??
        0
    );
    const riskFlags = Array.isArray(record.decisionPath?.riskFlags)
        ? record.decisionPath.riskFlags
        : [];

    return {
        fileName: record.fileName,
        applied: record.applied === true,
        pass: record.classification?.status === 'pass',
        bucket: record.classification?.bucket ?? 'unknown',
        source: record.source || 'null',
        decisionTier: record.decisionTier ?? 'null',
        anchor: anchorKey(record.actualAnchor),
        residual,
        gradient,
        positiveHaloLum,
        residualVisible: residualVisibility.visible === true,
        visiblePositiveHalo: residualVisibility.visiblePositiveHalo === true,
        visibleGradientResidual: residualVisibility.visibleGradientResidual === true,
        visibleSpatialResidual: residualVisibility.visibleSpatialResidual === true,
        suppressionGain,
        damagePenalty,
        texturePenalty,
        nearBlackIncrease,
        newlyClippedRatio,
        damageMetricAvailable: Boolean(damage || artifacts),
        riskFlags
    };
}

function buildFlags(metrics, thresholds = CLEAN_THRESHOLDS) {
    const flags = [];
    if (!metrics.applied || metrics.bucket === 'missed-detection') flags.push('missed-detection');
    if (!metrics.pass) flags.push(`benchmark-${metrics.bucket}`);
    if (metrics.residualVisible) flags.push('visible-residual');
    if (metrics.residual > thresholds.spatialResidual) flags.push('spatial-residual');
    if (metrics.gradient > thresholds.gradientResidual) flags.push('gradient-residual');
    if (metrics.positiveHaloLum > thresholds.positiveHaloLum) flags.push('positive-halo');
    if (
        metrics.applied &&
        Number.isFinite(metrics.suppressionGain) &&
        metrics.suppressionGain < thresholds.minSuppressionGain
    ) {
        flags.push('weak-suppression');
    }
    if (metrics.damagePenalty > thresholds.damagePenalty) flags.push('damage-penalty');
    if (metrics.texturePenalty > thresholds.texturePenalty) flags.push('texture-penalty');
    if (metrics.nearBlackIncrease > thresholds.nearBlackIncrease) flags.push('near-black-increase');
    if (metrics.newlyClippedRatio > thresholds.newlyClippedRatio) flags.push('newly-clipped');
    if (metrics.riskFlags.length > 0) flags.push('decision-risk-flags');
    return flags;
}

function buildSevereFlags(metrics) {
    const flags = [];
    if (!metrics.applied || !metrics.pass) flags.push('benchmark-failure');
    if (metrics.residualVisible) flags.push('visible-residual');
    if (metrics.residual > SEVERE_THRESHOLDS.spatialResidual) flags.push('severe-spatial-residual');
    if (metrics.gradient > SEVERE_THRESHOLDS.gradientResidual) flags.push('severe-gradient-residual');
    if (metrics.positiveHaloLum > SEVERE_THRESHOLDS.positiveHaloLum) flags.push('severe-positive-halo');
    if (metrics.damagePenalty > SEVERE_THRESHOLDS.damagePenalty) flags.push('severe-damage-penalty');
    if (metrics.texturePenalty > SEVERE_THRESHOLDS.texturePenalty) flags.push('severe-texture-penalty');
    if (metrics.nearBlackIncrease > SEVERE_THRESHOLDS.nearBlackIncrease) flags.push('severe-near-black-increase');
    if (metrics.newlyClippedRatio > SEVERE_THRESHOLDS.newlyClippedRatio) flags.push('severe-newly-clipped');
    return flags;
}

export function classifyRecord(record) {
    const metrics = summarizeRecord(record);
    const strictFlags = buildFlags(metrics, STRICT_THRESHOLDS);
    const cleanFlags = buildFlags(metrics, CLEAN_THRESHOLDS);
    const severeFlags = buildSevereFlags(metrics);
    const perfect = metrics.pass && metrics.applied && strictFlags.length === 0;
    const clean = metrics.pass && metrics.applied && cleanFlags.length === 0;
    const severeDefect = severeFlags.length > 0;

    return {
        fileName: record.fileName,
        filePath: record.filePath,
        group: record.group,
        metrics,
        perfect,
        clean,
        severeDefect,
        strictFlags,
        cleanFlags,
        severeFlags
    };
}

function increment(map, key, value = 1) {
    map[key] = (map[key] ?? 0) + value;
}

function summarizeClassified(records) {
    const total = records.length;
    const summary = {
        total,
        appliedCount: 0,
        passCount: 0,
        failCount: 0,
        perfectCount: 0,
        cleanCount: 0,
        strictDefectCount: 0,
        cleanDefectCount: 0,
        severeDefectCount: 0,
        visibleResidualCount: 0,
        damageMetricAvailableCount: 0,
        strictDefectAmongPassCount: 0,
        cleanDefectAmongPassCount: 0,
        rates: {},
        strictFlagCounts: {},
        cleanFlagCounts: {},
        severeFlagCounts: {},
        byAnchor: {},
        byDecisionTier: {},
        bySource: {},
        topStrictDefectSources: [],
        topStrictDefectAnchors: []
    };

    for (const record of records) {
        if (record.metrics.applied) summary.appliedCount++;
        if (record.metrics.pass) summary.passCount++;
        else summary.failCount++;
        if (record.perfect) summary.perfectCount++;
        if (record.clean) summary.cleanCount++;
        if (record.strictFlags.length > 0) summary.strictDefectCount++;
        if (record.cleanFlags.length > 0) summary.cleanDefectCount++;
        if (record.severeDefect) summary.severeDefectCount++;
        if (record.metrics.residualVisible) summary.visibleResidualCount++;
        if (record.metrics.damageMetricAvailable) summary.damageMetricAvailableCount++;
        if (record.metrics.pass && record.strictFlags.length > 0) summary.strictDefectAmongPassCount++;
        if (record.metrics.pass && record.cleanFlags.length > 0) summary.cleanDefectAmongPassCount++;
        for (const flag of record.strictFlags) increment(summary.strictFlagCounts, flag);
        for (const flag of record.cleanFlags) increment(summary.cleanFlagCounts, flag);
        for (const flag of record.severeFlags) increment(summary.severeFlagCounts, flag);
        incrementGrouped(summary.byAnchor, record.metrics.anchor, record);
        incrementGrouped(summary.byDecisionTier, record.metrics.decisionTier, record);
        incrementGrouped(summary.bySource, record.metrics.source, record);
    }

    finalizeGroups(summary.byAnchor);
    finalizeGroups(summary.byDecisionTier);
    finalizeGroups(summary.bySource);
    summary.rates = {
        passRate: rate(summary.passCount, total),
        perfectRate: rate(summary.perfectCount, total),
        cleanRate: rate(summary.cleanCount, total),
        strictDefectRate: rate(summary.strictDefectCount, total),
        cleanDefectRate: rate(summary.cleanDefectCount, total),
        severeDefectRate: rate(summary.severeDefectCount, total),
        visibleResidualRate: rate(summary.visibleResidualCount, total),
        damageMetricCoverageRate: rate(summary.damageMetricAvailableCount, total),
        strictDefectAmongPassRate: rate(summary.strictDefectAmongPassCount, summary.passCount),
        cleanDefectAmongPassRate: rate(summary.cleanDefectAmongPassCount, summary.passCount)
    };
    summary.topStrictDefectSources = topGroups(summary.bySource);
    summary.topStrictDefectAnchors = topGroups(summary.byAnchor);
    return summary;
}

function incrementGrouped(groups, key, record) {
    if (!groups[key]) {
        groups[key] = {
            total: 0,
            passCount: 0,
            perfectCount: 0,
            strictDefectCount: 0,
            cleanDefectCount: 0,
            severeDefectCount: 0,
            visibleResidualCount: 0
        };
    }
    const group = groups[key];
    group.total++;
    if (record.metrics.pass) group.passCount++;
    if (record.perfect) group.perfectCount++;
    if (record.strictFlags.length > 0) group.strictDefectCount++;
    if (record.cleanFlags.length > 0) group.cleanDefectCount++;
    if (record.severeDefect) group.severeDefectCount++;
    if (record.metrics.residualVisible) group.visibleResidualCount++;
}

function finalizeGroups(groups) {
    for (const group of Object.values(groups)) {
        group.passRate = rate(group.passCount, group.total);
        group.perfectRate = rate(group.perfectCount, group.total);
        group.strictDefectRate = rate(group.strictDefectCount, group.total);
        group.cleanDefectRate = rate(group.cleanDefectCount, group.total);
        group.severeDefectRate = rate(group.severeDefectCount, group.total);
        group.visibleResidualRate = rate(group.visibleResidualCount, group.total);
    }
}

function topGroups(groups, limit = 12) {
    return Object.entries(groups)
        .map(([key, value]) => ({ key, ...value }))
        .sort((left, right) => (
            right.strictDefectCount - left.strictDefectCount ||
            right.visibleResidualCount - left.visibleResidualCount ||
            right.total - left.total ||
            left.key.localeCompare(right.key)
        ))
        .slice(0, limit);
}

function compareReports(currentRecords, baselineRecords) {
    if (!baselineRecords) return null;

    const currentByFile = new Map(currentRecords.map((record) => [record.fileName, record]));
    const baselineByFile = new Map(baselineRecords.map((record) => [record.fileName, record]));
    const sharedFiles = [...currentByFile.keys()].filter((fileName) => baselineByFile.has(fileName));
    const currentOnlyFiles = [...currentByFile.keys()].filter((fileName) => !baselineByFile.has(fileName));
    const baselineOnlyFiles = [...baselineByFile.keys()].filter((fileName) => !currentByFile.has(fileName));
    const changes = {
        sharedTotal: sharedFiles.length,
        appliedGained: [],
        appliedLost: [],
        perfectGained: [],
        perfectLost: [],
        strictDefectIntroduced: [],
        strictDefectResolved: [],
        severeDefectIntroduced: [],
        severeDefectResolved: [],
        visibleResidualIntroduced: [],
        visibleResidualResolved: [],
        passGained: [],
        passLost: []
    };

    for (const fileName of baselineOnlyFiles) {
        if (baselineByFile.get(fileName).metrics.applied) {
            changes.appliedLost.push(fileName);
        }
    }

    for (const fileName of sharedFiles) {
        const current = currentByFile.get(fileName);
        const baseline = baselineByFile.get(fileName);
        compareBooleanChange(
            changes.appliedGained,
            changes.appliedLost,
            fileName,
            baseline.metrics.applied,
            current.metrics.applied
        );
        compareBooleanChange(changes.perfectGained, changes.perfectLost, fileName, baseline.perfect, current.perfect);
        compareBooleanChange(
            changes.strictDefectIntroduced,
            changes.strictDefectResolved,
            fileName,
            baseline.strictFlags.length > 0,
            current.strictFlags.length > 0
        );
        compareBooleanChange(
            changes.severeDefectIntroduced,
            changes.severeDefectResolved,
            fileName,
            baseline.severeDefect,
            current.severeDefect
        );
        compareBooleanChange(
            changes.visibleResidualIntroduced,
            changes.visibleResidualResolved,
            fileName,
            baseline.metrics.residualVisible,
            current.metrics.residualVisible
        );
        compareBooleanChange(changes.passGained, changes.passLost, fileName, baseline.metrics.pass, current.metrics.pass);
    }

    return {
        sharedTotal: changes.sharedTotal,
        alignment: {
            currentOnlyCount: currentOnlyFiles.length,
            baselineOnlyCount: baselineOnlyFiles.length,
            currentOnlyExamples: currentOnlyFiles.slice(0, 20),
            baselineOnlyExamples: baselineOnlyFiles.slice(0, 20)
        },
        deltas: {
            applied: changes.appliedGained.length - changes.appliedLost.length,
            perfect: changes.perfectGained.length - changes.perfectLost.length,
            strictDefect: changes.strictDefectIntroduced.length - changes.strictDefectResolved.length,
            severeDefect: changes.severeDefectIntroduced.length - changes.severeDefectResolved.length,
            visibleResidual: changes.visibleResidualIntroduced.length - changes.visibleResidualResolved.length,
            pass: changes.passGained.length - changes.passLost.length
        },
        counts: Object.fromEntries(Object.entries(changes)
            .filter(([key]) => key !== 'sharedTotal')
            .map(([key, value]) => [key, value.length])),
        metricCoverageWarning: buildMetricCoverageWarning({ currentRecords, baselineRecords }),
        examples: Object.fromEntries(Object.entries(changes)
            .filter(([key, value]) => Array.isArray(value))
            .map(([key, value]) => [key, value.slice(0, 20)]))
    };
}

function buildMetricCoverageWarning({ currentRecords, baselineRecords }) {
    const currentCoverage = currentRecords.filter((record) => record.metrics.damageMetricAvailable).length;
    const baselineCoverage = baselineRecords.filter((record) => record.metrics.damageMetricAvailable).length;
    if (currentCoverage === baselineCoverage) return null;
    return {
        kind: 'damage-metric-coverage-mismatch',
        currentCoverage,
        baselineCoverage,
        message: 'Perfect/defect deltas that depend on damage or texture are not apples-to-apples across these reports.'
    };
}

function compareBooleanChange(positiveList, negativeList, fileName, before, after) {
    if (before === false && after === true) positiveList.push(fileName);
    if (before === true && after === false) negativeList.push(fileName);
}

function renderMarkdown({ reportPath, baselinePath, summary, comparison, records }) {
    const lines = [
        '# Online Sample Quality Monitor',
        '',
        `- Report: \`${reportPath}\``,
        baselinePath ? `- Baseline: \`${baselinePath}\`` : '- Baseline: none',
        `- Total: ${summary.total}`,
        `- Pass: ${summary.passCount}/${summary.total} (${percent(summary.passCount, summary.total)})`,
        `- Perfect strict: ${summary.perfectCount}/${summary.total} (${percent(summary.perfectCount, summary.total)})`,
        `- Clean pass: ${summary.cleanCount}/${summary.total} (${percent(summary.cleanCount, summary.total)})`,
        `- Strict defect: ${summary.strictDefectCount}/${summary.total} (${percent(summary.strictDefectCount, summary.total)})`,
        `- Clean defect: ${summary.cleanDefectCount}/${summary.total} (${percent(summary.cleanDefectCount, summary.total)})`,
        `- Severe defect: ${summary.severeDefectCount}/${summary.total} (${percent(summary.severeDefectCount, summary.total)})`,
        `- Visible residual: ${summary.visibleResidualCount}/${summary.total} (${percent(summary.visibleResidualCount, summary.total)})`,
        `- Damage metric coverage: ${summary.damageMetricAvailableCount}/${summary.total} (${percent(summary.damageMetricAvailableCount, summary.total)})`,
        `- Strict defect among pass: ${summary.strictDefectAmongPassCount}/${summary.passCount} (${percent(summary.strictDefectAmongPassCount, summary.passCount)})`,
        '',
        '## Thresholds',
        '',
        `- Strict: \`${JSON.stringify(STRICT_THRESHOLDS)}\``,
        `- Clean: \`${JSON.stringify(CLEAN_THRESHOLDS)}\``,
        `- Severe: \`${JSON.stringify(SEVERE_THRESHOLDS)}\``,
        '',
        '## Strict Defect Flags',
        '',
        ...renderCountList(summary.strictFlagCounts),
        '',
        '## Severe Defect Flags',
        '',
        ...renderCountList(summary.severeFlagCounts),
        '',
        '## Top Strict Defect Sources',
        '',
        ...summary.topStrictDefectSources.map(renderGroupLine),
        '',
        '## Top Strict Defect Anchors',
        '',
        ...summary.topStrictDefectAnchors.map(renderGroupLine),
        ''
    ];

    if (comparison) {
        lines.push('## Baseline Diff');
        lines.push('');
        lines.push(`- Shared total: ${comparison.sharedTotal}`);
        lines.push(`- Applied coverage delta: ${comparison.deltas.applied}`);
        lines.push(`- Perfect delta: ${comparison.deltas.perfect}`);
        lines.push(`- Strict defect delta: ${comparison.deltas.strictDefect}`);
        lines.push(`- Severe defect delta: ${comparison.deltas.severeDefect}`);
        lines.push(`- Visible residual delta: ${comparison.deltas.visibleResidual}`);
        lines.push(`- Pass delta: ${comparison.deltas.pass}`);
        if (comparison.metricCoverageWarning) {
            lines.push(`- Metric coverage warning: ${comparison.metricCoverageWarning.message}`);
            lines.push(`- Current damage coverage: ${comparison.metricCoverageWarning.currentCoverage}`);
            lines.push(`- Baseline damage coverage: ${comparison.metricCoverageWarning.baselineCoverage}`);
        }
        lines.push('');
        lines.push('### Diff Counts');
        lines.push('');
        lines.push(...renderCountList(comparison.counts));
        lines.push('');
    }

    const topDefects = records
        .filter((record) => record.strictFlags.length > 0)
        .sort((left, right) => (
            Number(right.severeDefect) - Number(left.severeDefect) ||
            right.metrics.positiveHaloLum - left.metrics.positiveHaloLum ||
            right.metrics.gradient - left.metrics.gradient ||
            right.metrics.residual - left.metrics.residual
        ))
        .slice(0, 20);

    lines.push('## Top Defect Examples');
    lines.push('');
    for (const record of topDefects) {
        lines.push(
            `- ${record.fileName} | flags=${record.strictFlags.join('+')} | ` +
            `bucket=${record.metrics.bucket} | anchor=${record.metrics.anchor} | ` +
            `spatial=${round(record.metrics.residual)} gradient=${round(record.metrics.gradient)} ` +
            `halo=${round(record.metrics.positiveHaloLum, 3)} damage=${round(record.metrics.damagePenalty, 3)}`
        );
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

function renderCountList(counts) {
    const entries = Object.entries(counts)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    return entries.length > 0 ? entries.map(([key, count]) => `- ${key}: ${count}`) : ['- none'];
}

function renderGroupLine(group) {
    return `- ${group.key}: strict=${group.strictDefectCount}/${group.total} (${percent(group.strictDefectCount, group.total)}), ` +
        `perfect=${group.perfectCount}/${group.total} (${percent(group.perfectCount, group.total)}), ` +
        `visible=${group.visibleResidualCount}/${group.total} (${percent(group.visibleResidualCount, group.total)})`;
}

async function loadClassified(reportPath) {
    const report = JSON.parse(stripBom(await readFile(reportPath, 'utf8')));
    if (!Array.isArray(report.results)) {
        throw new Error(`${reportPath} must contain a results array`);
    }
    const records = report.results.map(classifyRecord);
    return {
        report,
        records,
        summary: summarizeClassified(records)
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await mkdir(args.outputDir, { recursive: true });
    const current = await loadClassified(args.reportPath);
    const baseline = args.baselinePath ? await loadClassified(args.baselinePath) : null;
    const comparison = baseline ? compareReports(current.records, baseline.records) : null;
    const failures = [];

    if (
        args.failOnStrictDefectIncrease &&
        comparison &&
        comparison.deltas.strictDefect > args.maxStrictDefectIncrease
    ) {
        failures.push(
            `strict defect delta ${comparison.deltas.strictDefect} > ${args.maxStrictDefectIncrease}`
        );
    }
    if (
        args.failOnPerfectLoss &&
        comparison &&
        -comparison.deltas.perfect > args.maxPerfectLoss
    ) {
        failures.push(`perfect loss ${-comparison.deltas.perfect} > ${args.maxPerfectLoss}`);
    }
    if (
        args.failOnAppliedLoss &&
        comparison &&
        comparison.counts.appliedLost > args.maxAppliedLoss
    ) {
        failures.push(
            `applied loss ${comparison.counts.appliedLost} > ${args.maxAppliedLoss}`
        );
    }

    const output = {
        generatedAt: new Date().toISOString(),
        reportPath: args.reportPath,
        baselinePath: args.baselinePath,
        thresholds: {
            strict: STRICT_THRESHOLDS,
            clean: CLEAN_THRESHOLDS,
            severe: SEVERE_THRESHOLDS
        },
        summary: current.summary,
        comparison,
        failures,
        records: current.records
    };
    const latestJson = path.join(args.outputDir, 'latest.json');
    const latestMd = path.join(args.outputDir, 'latest.md');
    await writeFile(latestJson, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await writeFile(latestMd, renderMarkdown({
        reportPath: args.reportPath,
        baselinePath: args.baselinePath,
        summary: current.summary,
        comparison,
        records: current.records
    }), 'utf8');

    console.log(JSON.stringify({
        ok: failures.length === 0,
        outputDir: args.outputDir,
        latestJson,
        latestMd,
        summary: current.summary.rates,
        counts: {
            total: current.summary.total,
            pass: current.summary.passCount,
            perfect: current.summary.perfectCount,
            clean: current.summary.cleanCount,
            strictDefect: current.summary.strictDefectCount,
            cleanDefect: current.summary.cleanDefectCount,
            severeDefect: current.summary.severeDefectCount,
            visibleResidual: current.summary.visibleResidualCount
        },
        comparison: comparison
            ? {
                deltas: comparison.deltas,
                counts: comparison.counts
            }
            : null,
        failures
    }, null, 2));
    if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

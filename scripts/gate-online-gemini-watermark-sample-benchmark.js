import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-after-rebalance.json'
);
const DEFAULT_REQUIRED_ANCHORS = Object.freeze([
    ['96/192/192/20260520', 40]
]);
const REPORT_LABELS = ['watermarked', 'clean', 'ambiguous', 'unlabeled'];
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseNumber(value, option) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${option} requires a finite number`);
    return parsed;
}

function takeRequiredValue(args, option) {
    const value = args.shift();
    if (value == null || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
}

export function parseOnlineSampleBenchmarkGateArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        expectedTotal: 105,
        expectedPaths: 119,
        minSuccessRate: 0.97,
        maxNewlyFailing: 0,
        minNewlyPassing: 21,
        requiredAnchors: [...DEFAULT_REQUIRED_ANCHORS]
    };

    const args = [...argv];
    if (args[0] === '--') args.shift();
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(takeRequiredValue(args, arg));
        } else if (arg === '--expected-total') {
            parsed.expectedTotal = parseNumber(takeRequiredValue(args, arg), arg);
        } else if (arg === '--expected-paths') {
            parsed.expectedPaths = parseNumber(takeRequiredValue(args, arg), arg);
        } else if (arg === '--min-success-rate') {
            parsed.minSuccessRate = parseNumber(takeRequiredValue(args, arg), arg);
        } else if (arg === '--max-newly-failing') {
            parsed.maxNewlyFailing = parseNumber(takeRequiredValue(args, arg), arg);
        } else if (arg === '--min-newly-passing') {
            parsed.minNewlyPassing = parseNumber(takeRequiredValue(args, arg), arg);
        } else if (arg === '--require-anchor-pass') {
            const value = takeRequiredValue(args, arg);
            const [anchor, countText] = value.split('=');
            if (!anchor || countText == null || countText === '') {
                throw new Error('--require-anchor-pass requires anchor=count');
            }
            parsed.requiredAnchors.push([anchor, parseNumber(countText, arg)]);
        } else if (arg === '--no-default-anchors') {
            parsed.requiredAnchors = [];
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }

    return parsed;
}

function assertCondition(failures, condition, message) {
    if (!condition) failures.push(message);
}

function readAnchor(summary, key) {
    return summary?.byAnchor?.[key] ?? null;
}

function anchorKey(anchor) {
    if (!anchor) return 'none';
    const suffix = anchor.alphaVariant ? `/${anchor.alphaVariant}` : '';
    return `${anchor.logoSize}/${anchor.marginRight}/${anchor.marginBottom}${suffix}`;
}

function metric(numerator, denominator) {
    return {
        numerator,
        denominator,
        rate: denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null
    };
}

function incrementAnchor(map, key, status) {
    if (!map[key]) map[key] = { total: 0, pass: 0, fail: 0 };
    map[key].total++;
    if (status === 'pass') map[key].pass++;
    else if (status === 'fail') map[key].fail++;
}

export function evaluateOnlineSampleBenchmarkGate(report, args) {
    const newlyPassing = Array.isArray(report.newlyPassing) ? report.newlyPassing.length : 0;
    const newlyFailing = Array.isArray(report.newlyFailing) ? report.newlyFailing.length : 0;
    const failures = [];
    const dataset = report.dataset ?? {};
    const summary = report.summary ?? {};
    const labels = report.labels;
    const results = report.results;
    const recomputedLabels = { watermarked: 0, clean: 0, ambiguous: 0, unlabeled: 0 };
    const recomputedSummary = { passCount: 0, failCount: 0, excludedCount: 0 };
    const recomputedAnchors = {};
    const contentHashes = new Set();
    const paths = new Set();
    let qualifiedNumerator = 0;
    let qualifiedDenominator = 0;

    assertCondition(
        failures,
        dataset.trusted === true && dataset.mode === 'trusted-labels',
        'report must use trusted-labels'
    );
    assertCondition(
        failures,
        typeof dataset.datasetId === 'string' && Boolean(dataset.datasetId.trim()),
        'datasetId is required'
    );
    for (const field of ['labelManifestSha256', 'contentSetSha256']) {
        assertCondition(
            failures,
            SHA256_PATTERN.test(dataset[field] ?? ''),
            `${field} must be a SHA-256`
        );
    }
    const labelsAreComplete = labels && typeof labels === 'object' && !Array.isArray(labels) &&
        REPORT_LABELS.every((label) => Number.isInteger(labels[label]) && labels[label] >= 0);
    assertCondition(failures, labelsAreComplete, 'report labels are required with complete non-negative counts');
    const resultsAreComplete = Array.isArray(results) && results.length > 0;
    assertCondition(failures, resultsAreComplete, 'report results must be a non-empty array');

    if (resultsAreComplete) {
        for (let index = 0; index < results.length; index++) {
            const record = results[index] ?? {};
            const recordSha = record.contentSha256;
            if (!SHA256_PATTERN.test(recordSha ?? '')) {
                failures.push(`result ${index} contentSha256 must be a SHA-256`);
            } else {
                const normalizedSha = recordSha.toLowerCase();
                if (contentHashes.has(normalizedSha)) {
                    failures.push(`duplicate contentSha256 in results: ${normalizedSha}`);
                }
                contentHashes.add(normalizedSha);
            }
            if (!Array.isArray(record.paths) || record.paths.length === 0) {
                failures.push(`result ${index} paths must be a non-empty array`);
            } else {
                for (const fileName of record.paths) {
                    if (typeof fileName !== 'string' || !fileName) {
                        failures.push(`result ${index} contains an invalid path`);
                    } else if (paths.has(fileName)) {
                        failures.push(`duplicate result path: ${fileName}`);
                    } else {
                        paths.add(fileName);
                    }
                }
            }
            if (!REPORT_LABELS.includes(record.label)) {
                failures.push(`result ${index} has invalid label: ${record.label}`);
                continue;
            }
            recomputedLabels[record.label]++;
            const classification = record.classification ?? {};
            const shouldBeIncluded = record.label === 'watermarked' || record.label === 'clean';
            assertCondition(
                failures,
                classification.includedInMetrics === shouldBeIncluded,
                `result ${index} includedInMetrics is inconsistent with label ${record.label}`
            );
            const expectedStatuses = shouldBeIncluded ? ['pass', 'fail'] : ['excluded'];
            assertCondition(
                failures,
                expectedStatuses.includes(classification.status),
                `result ${index} status is inconsistent with label ${record.label}`
            );
            if (classification.status === 'pass') recomputedSummary.passCount++;
            else if (classification.status === 'fail') recomputedSummary.failCount++;
            else if (classification.status === 'excluded') recomputedSummary.excludedCount++;
            if (shouldBeIncluded) {
                qualifiedDenominator++;
                if (classification.status === 'pass') qualifiedNumerator++;
            }
            if (record.label === 'watermarked' && classification.includedInMetrics === true) {
                incrementAnchor(recomputedAnchors, anchorKey(record.actualAnchor), classification.status);
            }
        }
    }

    const qualified = metric(qualifiedNumerator, qualifiedDenominator);
    if (labelsAreComplete) {
        for (const label of REPORT_LABELS) {
            assertCondition(
                failures,
                labels[label] === recomputedLabels[label],
                `label count ${label} mismatch: report=${labels[label]} results=${recomputedLabels[label]}`
            );
        }
    }
    assertCondition(
        failures,
        summary.passCount === recomputedSummary.passCount,
        `summary passCount mismatch: report=${summary.passCount} results=${recomputedSummary.passCount}`
    );
    assertCondition(
        failures,
        summary.failCount === recomputedSummary.failCount,
        `summary failCount mismatch: report=${summary.failCount} results=${recomputedSummary.failCount}`
    );
    assertCondition(
        failures,
        summary.excludedCount === recomputedSummary.excludedCount,
        `summary excludedCount mismatch: report=${summary.excludedCount} results=${recomputedSummary.excludedCount}`
    );
    const reportedQualified = report.metrics?.qualifiedOverallPassRate;
    assertCondition(
        failures,
        reportedQualified?.numerator === qualified.numerator &&
            reportedQualified?.denominator === qualified.denominator &&
            reportedQualified?.rate === qualified.rate,
        'qualifiedOverallPassRate does not match results'
    );
    assertCondition(
        failures,
        resultsAreComplete && results.length === dataset.uniqueContentCount &&
            contentHashes.size === dataset.uniqueContentCount,
        `unique content count does not match results: dataset=${dataset.uniqueContentCount} results=${contentHashes.size}`
    );
    assertCondition(
        failures,
        resultsAreComplete && paths.size === dataset.pathCount,
        `path count does not match results: dataset=${dataset.pathCount} results=${paths.size}`
    );
    if (contentHashes.size > 0 && SHA256_PATTERN.test(dataset.contentSetSha256 ?? '')) {
        const recomputedContentSetSha256 = sha256([...contentHashes].sort().join('\n'));
        assertCondition(
            failures,
            recomputedContentSetSha256 === dataset.contentSetSha256.toLowerCase(),
            'contentSetSha256 does not match results'
        );
    }
    assertCondition(
        failures,
        recomputedLabels.unlabeled === 0,
        'report must not contain unlabeled content'
    );
    assertCondition(
        failures,
        dataset.uniqueContentCount === args.expectedTotal,
        `expected unique total ${args.expectedTotal}, got ${dataset.uniqueContentCount}`
    );
    assertCondition(
        failures,
        dataset.pathCount === args.expectedPaths,
        `expected path total ${args.expectedPaths}, got ${dataset.pathCount}`
    );
    assertCondition(
        failures,
        qualified.rate !== null && qualified.rate >= args.minSuccessRate,
        `expected qualifiedOverallPassRate >= ${args.minSuccessRate}, got ${qualified.rate}`
    );
    if (args.minNewlyPassing > 0 || args.maxNewlyFailing < Number.POSITIVE_INFINITY) {
        assertCondition(failures, report.comparison?.status === 'comparable', 'comparable trusted baseline is required');
    }
    assertCondition(
        failures,
        newlyFailing <= args.maxNewlyFailing,
        `expected newlyFailing <= ${args.maxNewlyFailing}, got ${newlyFailing}`
    );
    assertCondition(
        failures,
        newlyPassing >= args.minNewlyPassing,
        `expected newlyPassing >= ${args.minNewlyPassing}, got ${newlyPassing}`
    );

    for (const [anchorKey, expectedPass] of args.requiredAnchors) {
        const anchor = readAnchor({ byAnchor: recomputedAnchors }, anchorKey);
        assertCondition(failures, Boolean(anchor), `required anchor ${anchorKey} is missing`);
        if (!anchor) continue;
        assertCondition(
            failures,
            anchor.pass >= expectedPass && anchor.fail === 0,
            `expected anchor ${anchorKey} pass >= ${expectedPass} and fail=0, got pass=${anchor.pass} fail=${anchor.fail}`
        );
    }

    return {
        ok: failures.length === 0,
        dataset,
        total: contentHashes.size,
        pathCount: paths.size,
        passCount: recomputedSummary.passCount,
        failCount: recomputedSummary.failCount,
        unlabeledCount: recomputedLabels.unlabeled,
        successRate: qualified.rate,
        newlyPassing,
        newlyFailing,
        requiredAnchors: Object.fromEntries(args.requiredAnchors.map(([key]) => [
            key,
            readAnchor({ byAnchor: recomputedAnchors }, key)
        ])),
        failures
    };
}

async function main() {
    const args = parseOnlineSampleBenchmarkGateArgs(process.argv.slice(2));
    const report = JSON.parse(await readFile(args.reportPath, 'utf8'));
    const output = {
        ...evaluateOnlineSampleBenchmarkGate(report, args),
        reportPath: args.reportPath
    };

    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

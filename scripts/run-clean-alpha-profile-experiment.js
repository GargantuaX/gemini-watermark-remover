import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermarkFromImageDataSync } from '../src/sdk/image-data.js';
import {
    compareAlphaMaps,
    estimateWhiteLogoAlphaMap,
    fitAlphaMapScale
} from './clean-alpha-profile-estimation.js';
import { decodeImageDataInNode } from './sample-benchmark.js';
import { decomposeRecompositionError } from './synthetic-cleanliness-benchmark.js';

const DEFAULT_LABELS_PATH =
    '.artifacts/shadow-residual-profile-ensemble/' +
    'directional-positive-spatial/visual-labels.json';
const DEFAULT_SOURCE_REPORT_PATH =
    '.artifacts/shadow-residual-profile-ensemble/' +
    'directional-positive-spatial/source-report.json';
const DEFAULT_OUTPUT_PATH =
    '.artifacts/shadow-residual-profile-ensemble/' +
    'directional-positive-spatial/clean-alpha-profile-experiment.json';

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function finiteValues(values) {
    return values.filter(Number.isFinite);
}

function quantile(values, fraction) {
    const sorted = finiteValues(values).sort((left, right) => left - right);
    if (sorted.length === 0) return null;
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.floor(fraction * sorted.length))
    );
    return sorted[index];
}

function summarizeValues(values) {
    const finite = finiteValues(values);
    if (finite.length === 0) {
        return {
            count: 0,
            mean: null,
            p50: null,
            p90: null,
            min: null,
            max: null
        };
    }
    return {
        count: finite.length,
        mean: finite.reduce((sum, value) => sum + value, 0) /
            finite.length,
        p50: quantile(finite, 0.5),
        p90: quantile(finite, 0.9),
        min: Math.min(...finite),
        max: Math.max(...finite)
    };
}

function meanAlpha(alphaMap) {
    return alphaMap.reduce((sum, value) => sum + value, 0) /
        alphaMap.length;
}

function selectCleanControls(labelsReport, sourceReport) {
    const sourceRecords = Array.isArray(sourceReport.results)
        ? sourceReport.results
        : Array.isArray(sourceReport.records)
            ? sourceReport.records
            : [];
    const sourceByFileName = new Map(
        sourceRecords.map((record) => [record.fileName, record])
    );
    return (labelsReport.records ?? [])
        .filter((record) => record.label === 'clean' && record.size === 48)
        .map((label) => ({
            ...label,
            source: sourceByFileName.get(label.fileName) ?? null
        }))
        .filter((record) => record.source?.filePath);
}

async function processControl(record) {
    const originalImageData = await decodeImageDataInNode(
        record.source.filePath
    );
    const processed = removeWatermarkFromImageDataSync(
        cloneImageData(originalImageData)
    );
    const position = processed.meta?.position ?? record.source.position;
    if (
        processed.meta?.applied !== true ||
        !position ||
        position.width !== 48 ||
        position.height !== 48
    ) {
        return {
            status: 'unavailable',
            fileName: record.fileName,
            reason:
                processed.meta?.applied === true
                    ? 'unsupported-current-position'
                    : processed.meta?.skipReason ?? 'processing-not-applied'
        };
    }
    return {
        status: 'complete',
        fileName: record.fileName,
        filePath: record.source.filePath,
        originalImageData,
        candidateImageData: processed.imageData,
        position,
        alphaGain: Number.isFinite(processed.meta.alphaGain)
            ? processed.meta.alphaGain
            : 1,
        source: processed.meta.source ?? null,
        qualityStatus:
            processed.meta.qualityStatus ??
            processed.meta.qualitySignals?.qualityStatus ??
            null
    };
}

function cycleEvidence(control, alphaMap, alphaGain = 1) {
    return decomposeRecompositionError({
        originalImageData: control.originalImageData,
        candidateImageData: control.candidateImageData,
        alphaMap,
        position: control.position,
        alphaGain
    });
}

function summarizeCycle(records, field) {
    return summarizeValues(records.map((record) => record[field]));
}

function serializeEstimate(estimate) {
    return {
        status: estimate.status,
        width: estimate.width,
        height: estimate.height,
        alphaMap: Array.from(estimate.alphaMap),
        supportCounts: Array.from(estimate.supportCounts),
        diagnostics: estimate.diagnostics
    };
}

function renderMarkdown(report) {
    const lines = [
        '# Clean-control alpha profile experiment',
        '',
        `Generated: ${report.generatedAt}`,
        '',
        '- Mode: shadow-only; no production decision or catalog update',
        `- Requested clean controls: ${report.selection.requested}`,
        `- Completed clean controls: ${report.selection.completed}`,
        `- Leave-one-out records: ${report.leaveOneOut.records.length}`,
        '',
        '## Learned profile vs embedded 48px profile',
        '',
        '| Metric | Value |',
        '|---|---:|',
        `| correlation | ${report.fullProfile.comparisonToEmbedded.correlation ?? 'n/a'} |`,
        `| MAE | ${report.fullProfile.comparisonToEmbedded.mae} |`,
        `| RMSE | ${report.fullProfile.comparisonToEmbedded.rmse} |`,
        `| max absolute error | ${report.fullProfile.comparisonToEmbedded.maxAbsoluteError} |`,
        `| learned mean alpha | ${report.fullProfile.meanAlpha} |`,
        `| embedded mean alpha | ${report.fullProfile.embeddedMeanAlpha} |`,
        `| optimal embedded scale | ${report.fullProfile.scaledComparisonToEmbedded.scale} |`,
        `| scaled-shape MAE | ${report.fullProfile.scaledComparisonToEmbedded.residual.mae} |`,
        `| scaled-shape RMSE | ${report.fullProfile.scaledComparisonToEmbedded.residual.rmse} |`,
        `| scaled-shape max error | ${report.fullProfile.scaledComparisonToEmbedded.residual.maxAbsoluteError} |`,
        '',
        '## Leave-one-out clean-control error',
        '',
        '| Model | total mean | total p90 | orthogonal mean | |signed| mean |',
        '|---|---:|---:|---:|---:|',
        `| embedded gain=1 | ${report.leaveOneOut.summary.embedded.total.mean} | ${report.leaveOneOut.summary.embedded.total.p90} | ${report.leaveOneOut.summary.embedded.orthogonal.mean} | ${report.leaveOneOut.summary.embedded.absoluteSigned.mean} |`,
        `| embedded current gain | ${report.leaveOneOut.summary.embeddedCurrentGain.total.mean} | ${report.leaveOneOut.summary.embeddedCurrentGain.total.p90} | ${report.leaveOneOut.summary.embeddedCurrentGain.orthogonal.mean} | ${report.leaveOneOut.summary.embeddedCurrentGain.absoluteSigned.mean} |`,
        `| learned LOO profile | ${report.leaveOneOut.summary.learned.total.mean} | ${report.leaveOneOut.summary.learned.total.p90} | ${report.leaveOneOut.summary.learned.orthogonal.mean} | ${report.leaveOneOut.summary.learned.absoluteSigned.mean} |`,
        '',
        'Interpretation: a reusable profile direction is supported only if the ' +
            'learned leave-one-out row materially lowers held-out clean error ' +
            'without unstable per-fold maps. This report does not fit a ' +
            'cleanliness threshold.'
    ];
    return `${lines.join('\n')}\n`;
}

export async function runCleanAlphaProfileExperiment({
    labelsPath = path.resolve(DEFAULT_LABELS_PATH),
    sourceReportPath = path.resolve(DEFAULT_SOURCE_REPORT_PATH),
    outputPath = path.resolve(DEFAULT_OUTPUT_PATH)
} = {}) {
    const labelsReport = JSON.parse(await readFile(labelsPath, 'utf8'));
    const sourceReport = JSON.parse(
        await readFile(sourceReportPath, 'utf8')
    );
    const selected = selectCleanControls(labelsReport, sourceReport);
    const processedControls = [];
    for (const [index, record] of selected.entries()) {
        console.log(
            `clean alpha control ${index + 1}/${selected.length}: ` +
            record.fileName
        );
        processedControls.push(await processControl(record));
    }
    const controls = processedControls.filter(
        (record) => record.status === 'complete'
    );
    if (controls.length < 2) {
        throw new Error(
            'at least two completed clean controls are required'
        );
    }

    const embeddedAlphaMap = getEmbeddedAlphaMap(48);
    const pairs = controls.map((control) => ({
        originalImageData: control.originalImageData,
        candidateImageData: control.candidateImageData,
        position: control.position
    }));
    const fullEstimate = estimateWhiteLogoAlphaMap({ pairs });
    const leaveOneOutRecords = controls.map((control, index) => {
        const trainingPairs = pairs.filter(
            (_, pairIndex) => pairIndex !== index
        );
        const learned = estimateWhiteLogoAlphaMap({
            pairs: trainingPairs
        });
        const embedded = cycleEvidence(
            control,
            embeddedAlphaMap,
            1
        );
        const embeddedCurrentGain = cycleEvidence(
            control,
            embeddedAlphaMap,
            control.alphaGain
        );
        const learnedEvidence = cycleEvidence(
            control,
            learned.alphaMap,
            1
        );
        return {
            fileName: control.fileName,
            alphaGain: control.alphaGain,
            source: control.source,
            qualityStatus: control.qualityStatus,
            learnedProfile: {
                status: learned.status,
                comparisonToFull:
                    compareAlphaMaps(
                        learned.alphaMap,
                        fullEstimate.alphaMap
                    ),
                diagnostics: learned.diagnostics
            },
            embedded: {
                normalizedTotalError: embedded.normalizedTotalError,
                signedTemplateAmplitude:
                    embedded.signedTemplateAmplitude,
                normalizedOrthogonalError:
                    embedded.normalizedOrthogonalError
            },
            embeddedCurrentGain: {
                normalizedTotalError:
                    embeddedCurrentGain.normalizedTotalError,
                signedTemplateAmplitude:
                    embeddedCurrentGain.signedTemplateAmplitude,
                normalizedOrthogonalError:
                    embeddedCurrentGain.normalizedOrthogonalError
            },
            learned: {
                normalizedTotalError:
                    learnedEvidence.normalizedTotalError,
                signedTemplateAmplitude:
                    learnedEvidence.signedTemplateAmplitude,
                normalizedOrthogonalError:
                    learnedEvidence.normalizedOrthogonalError
            }
        };
    });

    const summarizeModel = (key) => ({
        total: summarizeCycle(
            leaveOneOutRecords.map((record) => record[key]),
            'normalizedTotalError'
        ),
        signed: summarizeCycle(
            leaveOneOutRecords.map((record) => record[key]),
            'signedTemplateAmplitude'
        ),
        absoluteSigned: summarizeValues(
            leaveOneOutRecords.map((record) =>
                Math.abs(record[key].signedTemplateAmplitude)
            )
        ),
        orthogonal: summarizeCycle(
            leaveOneOutRecords.map((record) => record[key]),
            'normalizedOrthogonalError'
        )
    });
    const report = {
        schema: 'clean-alpha-profile-experiment/v1',
        generatedAt: new Date().toISOString(),
        mode: 'shadow-only',
        productionDecisionSemantics: 'none',
        inputs: {
            labelsPath,
            sourceReportPath
        },
        selection: {
            requested: selected.length,
            completed: controls.length,
            unavailable: processedControls
                .filter((record) => record.status !== 'complete')
                .map(({ fileName, reason }) => ({ fileName, reason }))
        },
        fullProfile: {
            ...serializeEstimate(fullEstimate),
            meanAlpha: meanAlpha(fullEstimate.alphaMap),
            embeddedMeanAlpha: meanAlpha(embeddedAlphaMap),
            comparisonToEmbedded:
                compareAlphaMaps(
                    fullEstimate.alphaMap,
                    embeddedAlphaMap
                ),
            scaledComparisonToEmbedded:
                fitAlphaMapScale({
                    referenceMap: embeddedAlphaMap,
                    observedMap: fullEstimate.alphaMap
                })
        },
        leaveOneOut: {
            summary: {
                embedded: summarizeModel('embedded'),
                embeddedCurrentGain:
                    summarizeModel('embeddedCurrentGain'),
                learned: summarizeModel('learned')
            },
            records: leaveOneOutRecords
        }
    };

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
        outputPath,
        `${JSON.stringify(report, null, 2)}\n`
    );
    const markdownPath = outputPath.replace(/\.json$/i, '.md');
    await writeFile(markdownPath, renderMarkdown(report));
    return { report, outputPath, markdownPath };
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    runCleanAlphaProfileExperiment()
        .then(({ report, outputPath, markdownPath }) => {
            console.log(
                JSON.stringify(
                    {
                        outputPath,
                        markdownPath,
                        selection: report.selection,
                        comparisonToEmbedded:
                            report.fullProfile.comparisonToEmbedded,
                        leaveOneOut: report.leaveOneOut.summary
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

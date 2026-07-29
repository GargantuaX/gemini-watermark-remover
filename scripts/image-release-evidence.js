import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const IMAGE_RELEASE_SOURCE_PATHS = Object.freeze([
    'src/core/adaptiveDetector.js',
    'src/core/candidateEvaluation.js',
    'src/core/candidateSelector.js',
    'src/core/darkOutlineContourRepair.js',
    'src/core/embeddedAlphaMaps.js',
    'src/core/embeddedDarkOutlineAlphaMap.js',
    'src/core/embeddedOutlineAlphaMap.js',
    'src/core/geminiSizeCatalog.js',
    'src/core/imageWatermarkPipeline.js',
    'src/core/pipelineAcceptedExecutor.js',
    'src/core/pipelineAlphaStageSpecs.js',
    'src/core/pipelineAlphaTraceContract.js',
    'src/core/pipelineAlphaTrial.js',
    'src/core/pipelineCandidatePool.js',
    'src/core/pipelineCandidateQuality.js',
    'src/core/pipelineCandidateRunner.js',
    'src/core/pipelineFinalization.js',
    'src/core/pipelineInitialSelection.js',
    'src/core/pipelineMeta.js',
    'src/core/pipelineRepairGates.js',
    'src/core/pipelineRepairStageSpecs.js',
    'src/core/pipelineResult.js',
    'src/core/pipelineRuntime.js',
    'src/core/previewAlphaCalibration.js',
    'src/core/restorationMetrics.js',
    'src/core/watermarkEngine.js',
    'src/core/watermarkProcessor.js',
    'src/sdk/image-data.js'
]);

export async function sha256File(filePath) {
    const value = await readFile(filePath);
    return createHash('sha256').update(value).digest('hex');
}

function stablePosition(value) {
    const position = value?.selectedCandidate?.position || value?.position || null;
    return position
        ? `${position.x}:${position.y}:${position.width}:${position.height}`
        : null;
}

export function compareCuratedReports(before, after, allowedCandidateChanges = []) {
    const beforeByName = new Map((before?.results || []).map((item) => [item.fileName, item]));
    const afterByName = new Map((after?.results || []).map((item) => [item.fileName, item]));
    const names = [...new Set([...beforeByName.keys(), ...afterByName.keys()])].sort();
    const allowlist = new Set(allowedCandidateChanges);
    const changedFileNames = [];
    let positionChangeCount = 0;
    let qualityStatusChangeCount = 0;
    let missingBeforeCount = 0;
    let missingAfterCount = 0;

    for (const name of names) {
        const left = beforeByName.get(name);
        const right = afterByName.get(name);
        if (!left) {
            missingBeforeCount++;
            continue;
        }
        if (!right) {
            missingAfterCount++;
            continue;
        }
        if (left.selectedCandidate?.id !== right.selectedCandidate?.id) changedFileNames.push(name);
        if (stablePosition(left) !== stablePosition(right)) positionChangeCount++;
        if (left.qualityStatus !== right.qualityStatus) qualityStatusChangeCount++;
    }

    return {
        total: after?.summary?.count ?? after?.results?.length ?? 0,
        candidateChangeCount: changedFileNames.length,
        changedFileNames,
        outOfScopeChangeCount: changedFileNames.filter((name) => !allowlist.has(name)).length,
        positionChangeCount,
        qualityStatusChangeCount,
        missingBeforeCount,
        missingAfterCount
    };
}

export function summarizeExact96Review(report, decisions) {
    const verdictByName = new Map((decisions?.decisions || []).map((item) => [item.fileName, item.verdict]));
    const exact96Records = (report?.records || []).filter((record) => (
        record?.status === 'matched' &&
        record?.selected?.position?.width === 96 &&
        record?.selected?.position?.height === 96 &&
        verdictByName.has(record.fileName)
    ));
    const exact96 = {
        alternativeBetter: 0,
        tie: 0,
        currentBetter: 0,
        unclear: 0
    };
    const verdictKeys = {
        'alternative-better': 'alternativeBetter',
        tie: 'tie',
        'current-better': 'currentBetter',
        unclear: 'unclear'
    };

    for (const record of exact96Records) {
        const key = verdictKeys[verdictByName.get(record.fileName)];
        if (key) exact96[key]++;
    }

    return {
        exact96,
        fileNames: exact96Records.map((record) => record.fileName).sort()
    };
}

export async function buildImageReleaseEvidence({
    version,
    generatedAt = new Date().toISOString(),
    contrast,
    curatedBefore,
    curatedAfter,
    manualReview,
    automated,
    provenance,
    releasePackage
}) {
    const curated = compareCuratedReports(curatedBefore, curatedAfter, manualReview?.fileNames || []);
    const exact96 = manualReview?.exact96 || {};
    return {
        schemaVersion: 1,
        releaseScope: 'image-defaults',
        version,
        generatedAt,
        provenance,
        validation: {
            contrast: {
                total: contrast?.summary?.total ?? 0,
                catastrophicBlocks: contrast?.summary?.catastrophicBlocks ?? 0,
                retryRecommended: (contrast?.results || []).filter((item) => item.retryRecommended === true).length,
                recoveredClean: contrast?.summary?.recoveredClean ?? 0,
                recoveredCleanTotal: contrast?.summary?.recoveredCleanTotal ?? 0
            },
            curated: {
                ...curated,
                errors: curatedAfter?.summary?.errors ?? 0,
                catastrophicBlocks: curatedAfter?.summary?.catastrophicBlocks ?? 0,
                retryRecommended: curatedAfter?.summary?.retryRecommended ?? 0
            },
            manualExact96: {
                total: Object.values(exact96).reduce((sum, value) => sum + Number(value || 0), 0),
                alternativeBetter: exact96.alternativeBetter ?? 0,
                tie: exact96.tie ?? 0,
                currentBetter: exact96.currentBetter ?? 0,
                unclear: exact96.unclear ?? 0
            },
            automated
        },
        releasePackage
    };
}

export function verifyImageReleaseEvidence(evidence, current) {
    const blockers = [];
    if (evidence?.schemaVersion !== 1) blockers.push('image-evidence-schema-unsupported');
    if (evidence?.releaseScope !== 'image-defaults') blockers.push('image-evidence-scope-mismatch');
    if (evidence?.version !== current?.version) blockers.push('image-evidence-version-mismatch');

    const contrast = evidence?.validation?.contrast;
    if (contrast?.total !== 36) blockers.push('image-evidence-contrast-total-mismatch');
    if (contrast?.catastrophicBlocks !== 0) blockers.push('image-evidence-contrast-catastrophic');
    if (contrast?.retryRecommended !== 0) blockers.push('image-evidence-contrast-retry');
    if (contrast?.recoveredClean < 15 || contrast?.recoveredCleanTotal !== 16) {
        blockers.push('image-evidence-contrast-recovery-regression');
    }

    const curated = evidence?.validation?.curated;
    if (curated?.total !== 424) blockers.push('image-evidence-curated-total-mismatch');
    if (curated?.candidateChangeCount !== 10) blockers.push('image-evidence-curated-candidate-change-count-mismatch');
    for (const key of [
        'errors',
        'catastrophicBlocks',
        'retryRecommended',
        'positionChangeCount',
        'qualityStatusChangeCount',
        'outOfScopeChangeCount',
        'missingBeforeCount',
        'missingAfterCount'
    ]) {
        if (curated?.[key] !== 0) blockers.push(`image-evidence-curated-${key}`);
    }

    const exact96 = evidence?.validation?.manualExact96;
    if (
        exact96?.total !== 10 ||
        exact96?.alternativeBetter !== 7 ||
        exact96?.tie !== 3 ||
        exact96?.currentBetter !== 0 ||
        exact96?.unclear !== 0
    ) {
        blockers.push('image-evidence-manual-exact96-verdict-mismatch');
    }

    for (const key of ['fullTest', 'sdkSmoke', 'build', 'extensionPackage']) {
        if (evidence?.validation?.automated?.[key]?.ok !== true) {
            blockers.push(`image-evidence-${key}-not-passing`);
        }
    }

    for (const source of evidence?.provenance?.sourceFiles || []) {
        if (current?.sourceHashes?.get(source.path) !== source.sha256) {
            blockers.push(`image-evidence-source-hash-mismatch:${source.path}`);
        }
    }
    if ((current?.outOfScopeChangedFiles || []).length > 0) {
        blockers.push('image-evidence-video-scope-changed');
    }

    if (evidence?.releasePackage?.version !== current?.releasePackage?.version) {
        blockers.push('image-evidence-package-version-mismatch');
    }
    if (evidence?.releasePackage?.sha256 !== current?.releasePackage?.sha256) {
        blockers.push('image-evidence-package-hash-mismatch');
    }
    if (evidence?.releasePackage?.size !== current?.releasePackage?.size) {
        blockers.push('image-evidence-package-size-mismatch');
    }

    return { ok: blockers.length === 0, blockers };
}

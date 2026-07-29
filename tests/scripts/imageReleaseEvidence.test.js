import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    IMAGE_RELEASE_SOURCE_PATHS,
    buildImageReleaseEvidence,
    compareCuratedReports,
    summarizeExact96Review,
    verifyImageReleaseEvidence
} from '../../scripts/image-release-evidence.js';
import { parseNodeTestSummary, resolvePnpmInvocation } from '../../scripts/run-image-release-validation.js';
import { checkImageReleaseEvidence } from '../../scripts/check-image-release-evidence.js';
import {
    DEFAULT_PATHS,
    createImageReleaseEvidence
} from '../../scripts/create-image-release-evidence.js';

function curatedResult(fileName, {
    candidateId,
    qualityStatus = 'clean',
    position = { x: 100, y: 100, width: 96, height: 96 },
    retryRecommended = false,
    catastrophicBlock = false
}) {
    return {
        fileName,
        selectedCandidate: { id: candidateId, position },
        position,
        qualityStatus,
        retryRecommended,
        catastrophicBlock
    };
}

function validEvidence() {
    return {
        schemaVersion: 1,
        releaseScope: 'image-defaults',
        version: '1.0.30',
        provenance: {
            sourceFiles: [{ path: 'src/core/example.js', sha256: 'a'.repeat(64) }],
            inputArtifacts: []
        },
        validation: {
            contrast: {
                total: 36,
                catastrophicBlocks: 0,
                retryRecommended: 0,
                recoveredClean: 15,
                recoveredCleanTotal: 16
            },
            curated: {
                total: 424,
                errors: 0,
                catastrophicBlocks: 0,
                retryRecommended: 0,
                candidateChangeCount: 10,
                positionChangeCount: 0,
                qualityStatusChangeCount: 0,
                outOfScopeChangeCount: 0,
                missingBeforeCount: 0,
                missingAfterCount: 0
            },
            manualExact96: {
                total: 10,
                alternativeBetter: 7,
                tie: 3,
                currentBetter: 0,
                unclear: 0
            },
            automated: {
                fullTest: { ok: true, failed: 0 },
                sdkSmoke: { ok: true, failed: 0 },
                build: { ok: true },
                extensionPackage: { ok: true }
            }
        },
        releasePackage: {
            version: '1.0.30',
            file: 'release.zip',
            sha256: 'b'.repeat(64),
            size: 123
        }
    };
}

function validCurrent() {
    return {
        version: '1.0.30',
        sourceHashes: new Map([['src/core/example.js', 'a'.repeat(64)]]),
        releasePackage: { version: '1.0.30', sha256: 'b'.repeat(64), size: 123 },
        outOfScopeChangedFiles: []
    };
}

async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return filePath;
}

test('compareCuratedReports counts reviewed candidate changes without position or status drift', () => {
    const before = {
        summary: { count: 2 },
        results: [
            curatedResult('a.png', { candidateId: 'old-a' }),
            curatedResult('b.png', { candidateId: 'same-b' })
        ]
    };
    const after = {
        summary: { count: 2 },
        results: [
            curatedResult('a.png', { candidateId: 'new-a' }),
            curatedResult('b.png', { candidateId: 'same-b' })
        ]
    };

    assert.deepEqual(compareCuratedReports(before, after, ['a.png']), {
        total: 2,
        candidateChangeCount: 1,
        changedFileNames: ['a.png'],
        outOfScopeChangeCount: 0,
        positionChangeCount: 0,
        qualityStatusChangeCount: 0,
        missingBeforeCount: 0,
        missingAfterCount: 0
    });
});

test('summarizeExact96Review excludes other sizes and joins decisions by file name', () => {
    const summary = summarizeExact96Review({
        records: [
            { fileName: 'a.png', status: 'matched', selected: { position: { width: 96, height: 96 } } },
            { fileName: 'b.png', status: 'matched', selected: { position: { width: 48, height: 48 } } },
            { fileName: 'c.png', status: 'not-reproduced', selected: { position: { width: 96, height: 96 } } }
        ]
    }, {
        decisions: [
            { fileName: 'a.png', verdict: 'alternative-better' },
            { fileName: 'b.png', verdict: 'current-better' },
            { fileName: 'c.png', verdict: 'unclear' }
        ]
    });

    assert.deepEqual(summary, {
        exact96: { alternativeBetter: 1, tie: 0, currentBetter: 0, unclear: 0 },
        fileNames: ['a.png']
    });
});

test('buildImageReleaseEvidence normalizes real report fields', async () => {
    const evidence = await buildImageReleaseEvidence({
        version: '1.0.30',
        generatedAt: '2026-07-16T00:00:00.000Z',
        contrast: {
            summary: { total: 36, catastrophicBlocks: 0, recoveredClean: 15, recoveredCleanTotal: 16 },
            results: [{ retryRecommended: false }]
        },
        curatedBefore: { summary: { count: 1 }, results: [curatedResult('a.png', { candidateId: 'old' })] },
        curatedAfter: {
            summary: { count: 1, errors: 0, retryRecommended: 0, catastrophicBlocks: 0 },
            results: [curatedResult('a.png', { candidateId: 'new' })]
        },
        manualReview: {
            exact96: { alternativeBetter: 1, tie: 0, currentBetter: 0, unclear: 0 },
            fileNames: ['a.png']
        },
        automated: { fullTest: { ok: true }, sdkSmoke: { ok: true }, build: { ok: true }, extensionPackage: { ok: true } },
        provenance: { sourceFiles: [], inputArtifacts: [] },
        releasePackage: { version: '1.0.30', file: 'x.zip', sha256: 'a'.repeat(64), size: 123 }
    });

    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.releaseScope, 'image-defaults');
    assert.equal(evidence.validation.contrast.retryRecommended, 0);
    assert.equal(evidence.validation.curated.candidateChangeCount, 1);
    assert.deepEqual(evidence.validation.manualExact96, {
        total: 1,
        alternativeBetter: 1,
        tie: 0,
        currentBetter: 0,
        unclear: 0
    });
});

test('verifyImageReleaseEvidence accepts the complete current contract', () => {
    assert.deepEqual(verifyImageReleaseEvidence(validEvidence(), validCurrent()), {
        ok: true,
        blockers: []
    });
});

test('verifyImageReleaseEvidence fails closed on stale hashes and out-of-scope video changes', () => {
    const current = validCurrent();
    current.sourceHashes.set('src/core/example.js', 'c'.repeat(64));
    current.outOfScopeChangedFiles = ['src/video/videoPresetPolicy.js'];

    const result = verifyImageReleaseEvidence(validEvidence(), current);

    assert.equal(result.ok, false);
    assert.ok(result.blockers.includes('image-evidence-source-hash-mismatch:src/core/example.js'));
    assert.ok(result.blockers.includes('image-evidence-video-scope-changed'));
});

test('verifyImageReleaseEvidence rejects unsafe image metrics and package drift', () => {
    const evidence = validEvidence();
    evidence.validation.curated.errors = 1;
    evidence.validation.manualExact96.currentBetter = 1;
    evidence.releasePackage.sha256 = 'd'.repeat(64);

    const result = verifyImageReleaseEvidence(evidence, validCurrent());

    assert.equal(result.ok, false);
    assert.ok(result.blockers.includes('image-evidence-curated-errors'));
    assert.ok(result.blockers.includes('image-evidence-manual-exact96-verdict-mismatch'));
    assert.ok(result.blockers.includes('image-evidence-package-hash-mismatch'));
});

test('parseNodeTestSummary reads node test TAP totals', () => {
    assert.deepEqual(parseNodeTestSummary(`
# tests 1344
# suites 0
# pass 1316
# fail 0
# cancelled 0
# skipped 28
`), {
        total: 1344,
        passed: 1316,
        failed: 0,
        skipped: 28
    });
});

test('resolvePnpmInvocation avoids spawning cmd shims directly on Windows', () => {
    assert.deepEqual(resolvePnpmInvocation('win32', 'C:\\Windows\\System32\\cmd.exe'), {
        command: 'C:\\Windows\\System32\\cmd.exe',
        prefixArgs: ['/d', '/s', '/c', 'pnpm']
    });
    assert.deepEqual(resolvePnpmInvocation('linux'), {
        command: 'pnpm',
        prefixArgs: []
    });
});

test('image release evidence covers the mutable alpha pipeline modules', () => {
    const covered = new Set(IMAGE_RELEASE_SOURCE_PATHS);
    const required = [
        'src/core/geminiSizeCatalog.js',
        'src/core/pipelineAlphaStageSpecs.js',
        'src/core/pipelineAlphaTraceContract.js',
        'src/core/pipelineAlphaTrial.js',
        'src/core/pipelineRuntime.js',
        'src/core/previewAlphaCalibration.js'
    ];

    assert.deepEqual(
        required.filter((sourcePath) => !covered.has(sourcePath)),
        [],
        'release evidence must hash every mutable module in the image alpha pipeline'
    );
});

test('image release evidence defaults to the immutable reviewed snapshot', () => {
    const snapshotDirectory = path.resolve(
        '.artifacts/same-anchor-96-imperfection-preference/before-review'
    );

    assert.equal(DEFAULT_PATHS.manualReport, path.join(snapshotDirectory, 'report.json'));
    assert.equal(DEFAULT_PATHS.manualDecisions, path.join(snapshotDirectory, 'review.json'));
});

test('checkImageReleaseEvidence reuses the pure contract for readiness and CLI callers', async () => {
    const result = await checkImageReleaseEvidence({
        evidence: validEvidence(),
        current: validCurrent(),
        quiet: true
    });

    assert.deepEqual(result, { ok: true, blockers: [] });
});

test('createImageReleaseEvidence reads reports, hashes sources, and writes pinned JSON', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-image-release-evidence-'));
    const sourcePath = path.join(tempDir, 'source.js');
    await writeFile(sourcePath, 'export const value = 1;\n', 'utf8');
    const before = { summary: { count: 1 }, results: [curatedResult('a.png', { candidateId: 'old' })] };
    const after = {
        summary: { count: 1, errors: 0, retryRecommended: 0, catastrophicBlocks: 0 },
        results: [curatedResult('a.png', { candidateId: 'new' })]
    };
    const paths = {
        contrast: await writeJson(path.join(tempDir, 'contrast.json'), {
            summary: { total: 36, catastrophicBlocks: 0, recoveredClean: 15, recoveredCleanTotal: 16 },
            results: []
        }),
        curatedBefore: await writeJson(path.join(tempDir, 'before.json'), before),
        curatedAfter: await writeJson(path.join(tempDir, 'after.json'), after),
        manualReport: await writeJson(path.join(tempDir, 'manual-report.json'), {
            records: [{ fileName: 'a.png', status: 'matched', selected: { position: { width: 96, height: 96 } } }]
        }),
        manualDecisions: await writeJson(path.join(tempDir, 'manual-decisions.json'), {
            decisions: [{ fileName: 'a.png', verdict: 'alternative-better' }]
        }),
        automated: await writeJson(path.join(tempDir, 'automated.json'), {
            fullTest: { ok: true }, sdkSmoke: { ok: true }, build: { ok: true }, extensionPackage: { ok: true }
        }),
        packageJson: await writeJson(path.join(tempDir, 'package.json'), { version: '1.0.30' }),
        output: path.join(tempDir, 'evidence.json')
    };

    const evidence = await createImageReleaseEvidence({
        paths,
        sourcePaths: [sourcePath],
        releasePackage: { version: '1.0.30', file: 'x.zip', sha256: 'd'.repeat(64), size: 10 }
    });
    const written = JSON.parse(await readFile(paths.output, 'utf8'));

    assert.equal(evidence.provenance.sourceFiles.length, 1);
    assert.match(evidence.provenance.sourceFiles[0].sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(written, evidence);
});

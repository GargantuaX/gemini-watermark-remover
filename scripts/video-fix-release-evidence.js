import { createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

import { IMAGE_RELEASE_SOURCE_PATHS } from './image-release-evidence.js';
import { checkGithubCi } from './check-github-ci.js';

export const DEFAULT_PUBLISHED_BASELINE_TAG = 'v1.0.43';
export const EXPECTED_BASELINE_COMMIT = 'e9ba84d8e5465928d4b9343a1fe121d0cae0e3da';
export const EXPECTED_INTEGRATION_SRC_TREE = '189854013bafed0c5a13497da2303865878907eb';
export const ONLY_ALLOWED_PRODUCTION_SRC = 'src/video/videoWatermarkDetector.js';

export const PRODUCTION_BUILD_INPUT_PREFIXES = Object.freeze([
    'src',
    'bin',
    'public',
    'skills',
    'build.js',
    'scripts/package-extension-release.js',
    'pnpm-lock.yaml'
]);

export const FROZEN_REVIEWER_VERIFICATION_HASH = '6019aecc38398b9045f928355c9040c00e9abea66dad18656d6aac12659b162d';
export const FROZEN_INTEGRATION_REPORT_HASH = '9e0db80fa2ea80c2c5188f1d1f0f91b8249fe123614f2ca4b4d1d01387cbae5a';
export const FROZEN_RESULTS_JSON_HASH = '1165bac8599607b4f1af3de38d7e699409c0dac5ad8954da0572d3928d0d52d3';

export const FROZEN_VIDEO_INTEGRATION_SPECS = Object.freeze({
    issue150: {
        inputHash: 'c5a84b5f5ef2dc050fdda50ba4d5649f7d44bfbada52d78e1dc5d42171f277d6',
        outputHash: 'ff563ad4ef163931347e525ac8cc8429ed24194c9bf51d477719d1a03c941057',
        fileName: 'issue150_integrated.mp4',
        frames: 192,
        audioPackets: 375,
        payloadStreamHash: '6599e66dbcf0b828ce698e43152d790a62ed4d7b03b8eb4254f61a4024addbe4'
    },
    issue136a: {
        inputHash: '65d7f4b1522209774a70098f0a1a87690c0c4aba973a611090f53882750099f1',
        outputHash: 'a17dd4ebf886575ae3ed4c2d9dc9cf83873b9dd4c0883d579241768c124416ea',
        fileName: 'issue136a_integrated.mp4',
        frames: 240,
        audioPackets: 469,
        payloadStreamHash: '4bdae19c3449e36fa6b506c205e6bef0e742e0fcd8d13b4ce4a56f0eb4de027f'
    },
    issue136b: {
        inputHash: '01cf9bd139a1119856e826e533f778a6d29b565d8e5d4a079036bdd62c0a88e7',
        outputHash: '4973c82e6271744be91a7e9fd5ab616c340fc2f00e2a089d4d19ccb3a04c5ece',
        fileName: 'issue136b_integrated.mp4',
        frames: 240,
        audioPackets: 469,
        payloadStreamHash: '4bdae19c3449e36fa6b506c205e6bef0e742e0fcd8d13b4ce4a56f0eb4de027f'
    },
    realUiDefault: {
        outputHash: '70691a2b08ff8dedb5d3e9d1a0561e14c75a258c08412d58e0cfc375fef3fd83',
        fileName: 'issue150_ui_default_integrated.mp4',
        frames: 192
    },
    nodeSdkWrapperDefault: {
        outputHash: 'e3961daebfd48341442f8548d4b59149ca198efded0d190753fe0c065016f45f',
        fileName: 'issue150_ui_allenk_onnx_integrated.mp4',
        frames: 192
    }
});

export async function sha256File(filePath) {
    const data = await readFile(filePath);
    return createHash('sha256').update(data).digest('hex');
}

export function sha256NormalizedText(text) {
    const normalized = String(text || '').replaceAll('\r\n', '\n');
    return createHash('sha256').update(normalized).digest('hex');
}

function readGitOutput(args, cwd, execFn = execFileSync) {
    return execFn('git', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

export function resolvePublishedBaseline({
    baseTag = DEFAULT_PUBLISHED_BASELINE_TAG,
    cwd = process.cwd(),
    execFn = execFileSync
} = {}) {
    if (!/^v\d+\.\d+\.\d+$/.test(baseTag || '')) {
        return {
            ok: false,
            blockers: [`video-fix-baseline-invalid-format:${baseTag}`]
        };
    }
    try {
        const commit = readGitOutput(['rev-parse', `${baseTag}^{commit}`], cwd, execFn).trim();
        if (baseTag !== DEFAULT_PUBLISHED_BASELINE_TAG || commit !== EXPECTED_BASELINE_COMMIT) {
            return { ok: false, blockers: ['video-fix-published-baseline-not-reviewed'] };
        }
        if (!commit || commit.length !== 40) {
            return {
                ok: false,
                blockers: [`video-fix-baseline-unresolved:${baseTag}`]
            };
        }
        const pkgRaw = readGitOutput(['show', `${baseTag}:package.json`], cwd, execFn);
        const pkg = JSON.parse(pkgRaw);
        if (pkg.version !== baseTag.slice(1)) {
            return {
                ok: false,
                blockers: [`video-fix-baseline-version-mismatch:${pkg.version}!==${baseTag.slice(1)}`]
            };
        }
        return {
            ok: true,
            blockers: [],
            baseTag,
            commit,
            version: pkg.version
        };
    } catch (error) {
        return {
            ok: false,
            blockers: [`video-fix-baseline-error:${error?.message || error}`]
        };
    }
}

export function verifyTrackedProductionAndManifest({
    baseTag = DEFAULT_PUBLISHED_BASELINE_TAG,
    cwd = process.cwd(),
    execFn = execFileSync
} = {}) {
    const blockers = [];
    try {
        const baseCommit = readGitOutput(['rev-parse', `${baseTag}^{commit}`], cwd, execFn).trim();

        // 1. Verify HEAD:src Git tree equals reviewed integration src tree
        const headSrcTree = readGitOutput(['rev-parse', 'HEAD:src'], cwd, execFn).trim();
        if (headSrcTree !== EXPECTED_INTEGRATION_SRC_TREE) {
            blockers.push(`video-fix-src-tree-not-equal-integration:${headSrcTree}!==${EXPECTED_INTEGRATION_SRC_TREE}`);
        }

        // 2. Tracked production build inputs comparison
        const diffOutput = readGitOutput(
            ['diff', '--name-only', baseCommit, 'HEAD', '--', ...PRODUCTION_BUILD_INPUT_PREFIXES],
            cwd,
            execFn
        );
        const changedFiles = diffOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

        for (const file of changedFiles) {
            if (file !== ONLY_ALLOWED_PRODUCTION_SRC) {
                blockers.push(`video-fix-unauthorized-input-drift:${file}`);
            }
        }
        if (!changedFiles.includes(ONLY_ALLOWED_PRODUCTION_SRC)) {
            blockers.push('video-fix-expected-production-change-missing');
        }

        // 3. Clean relevant working tree for production files
        const statusOutput = readGitOutput(
            ['status', '--porcelain', '--', ...PRODUCTION_BUILD_INPUT_PREFIXES],
            cwd,
            execFn
        );
        const statusLines = statusOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of statusLines) {
            const p = line.replace(/^[MADRCU?! ]+\s+/, '').trim();
            blockers.push(`video-fix-production-working-tree-dirty:${p}`);
        }

        // 4. Comprehensive package.json field comparison
        const basePkg = JSON.parse(readGitOutput(['show', `${baseCommit}:package.json`], cwd, execFn));
        const headPkg = JSON.parse(readGitOutput(['show', 'HEAD:package.json'], cwd, execFn));
        const diskPkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));

        const allKeys = new Set([
            ...Object.keys(basePkg),
            ...Object.keys(headPkg),
            ...Object.keys(diskPkg)
        ]);

        for (const key of allKeys) {
            if (key === 'version') {
                if (diskPkg.version !== '1.0.44' || headPkg.version !== '1.0.44') {
                    blockers.push(`video-fix-package-version-invalid:${diskPkg.version}`);
                }
                continue;
            }
            if (key === 'scripts') {
                const baseScripts = basePkg.scripts || {};
                const diskScripts = diskPkg.scripts || {};
                for (const [sName, sCmd] of Object.entries(baseScripts)) {
                    if (diskScripts[sName] !== sCmd) {
                        blockers.push(`video-fix-existing-script-altered:${sName}`);
                    }
                }
                for (const sName of Object.keys(diskScripts)) {
                    if (!(sName in baseScripts) && !sName.startsWith('release:video-fix-')) {
                        blockers.push(`video-fix-unauthorized-script-added:${sName}`);
                    }
                }
                continue;
            }
            const baseVal = JSON.stringify(basePkg[key] ?? null);
            const diskVal = JSON.stringify(diskPkg[key] ?? null);
            if (baseVal !== diskVal) {
                blockers.push(`video-fix-package-field-drift:${key}`);
            }
        }

        return {
            ok: blockers.length === 0,
            blockers,
            changedProductionFiles: changedFiles
        };
    } catch (error) {
        return {
            ok: false,
            blockers: [`video-fix-manifest-comparison-error:${error?.message || error}`]
        };
    }
}

export async function verifyHistoricalImageEvidence({
    baseTag = DEFAULT_PUBLISHED_BASELINE_TAG,
    cwd = process.cwd(),
    execFn = execFileSync
} = {}) {
    const blockers = [];
    try {
        const qualityPath = `release/evidence/${baseTag}-image-quality.json`;
        const inventoryPath = `release/evidence/${baseTag}-image-inventory.json`;

        let gitQualityBlob = '';
        let gitInventoryBlob = '';
        try {
            gitQualityBlob = readGitOutput(['show', `${baseTag}:${qualityPath}`], cwd, execFn);
            gitInventoryBlob = readGitOutput(['show', `${baseTag}:${inventoryPath}`], cwd, execFn);
        } catch {
            blockers.push(`video-fix-image-evidence-missing-in-baseline:${baseTag}`);
            return { ok: false, blockers };
        }

        const diskQualityPath = path.resolve(cwd, qualityPath);
        const diskInventoryPath = path.resolve(cwd, inventoryPath);
        if (!existsSync(diskQualityPath)) {
            blockers.push(`video-fix-image-evidence-file-missing:${qualityPath}`);
            return { ok: false, blockers };
        }
        if (!existsSync(diskInventoryPath)) {
            blockers.push(`video-fix-image-inventory-file-missing:${inventoryPath}`);
            return { ok: false, blockers };
        }

        const diskQualityContent = await readFile(diskQualityPath, 'utf8');
        const diskInventoryContent = await readFile(diskInventoryPath, 'utf8');

        if (sha256NormalizedText(diskQualityContent) !== sha256NormalizedText(gitQualityBlob)) {
            blockers.push('video-fix-image-evidence-tampered-against-git-blob');
        }
        if (sha256NormalizedText(diskInventoryContent) !== sha256NormalizedText(gitInventoryBlob)) {
            blockers.push('video-fix-image-inventory-tampered-against-git-blob');
        }

        const evidence = JSON.parse(gitQualityBlob);
        if (evidence.schemaVersion !== 2) {
            blockers.push('video-fix-image-evidence-schema-invalid');
        }
        if (evidence.releaseScope !== 'image-defaults') {
            blockers.push('video-fix-image-evidence-scope-mismatch');
        }
        if (evidence.version !== baseTag.slice(1)) {
            blockers.push(`video-fix-image-evidence-version-mismatch:${evidence.version}`);
        }

        for (const imgPath of IMAGE_RELEASE_SOURCE_PATHS) {
            const diff = readGitOutput(['diff', baseTag, 'HEAD', '--', imgPath], cwd, execFn).trim();
            if (diff.length > 0) {
                blockers.push(`video-fix-image-core-source-drift:${imgPath}`);
            }
        }

        return {
            ok: blockers.length === 0,
            blockers,
            reusedBaselineEvidence: qualityPath,
            baselineVersion: evidence.version,
            coreImageModulesVerified: IMAGE_RELEASE_SOURCE_PATHS.length
        };
    } catch (error) {
        return {
            ok: false,
            blockers: [`video-fix-historical-image-error:${error?.message || error}`]
        };
    }
}

export async function verifyCoreVideoIntegrationEvidence({
    integrationDir = null,
    cwd = process.cwd()
} = {}) {
    const blockers = [];
    const resolvedDir = integrationDir
        ? path.resolve(cwd, integrationDir)
        : path.resolve(cwd, '../pr157-integration/.artifacts/ordinary-browser');

    if (!existsSync(resolvedDir)) {
        blockers.push(`video-fix-integration-evidence-missing: Integration directory not found at ${resolvedDir}`);
        return { ok: false, blockers };
    }

    try {
        const revPath = path.join(resolvedDir, 'reviewer-verification.json');
        const reportPath = path.join(resolvedDir, 'report.md');
        const resultsPath = path.join(resolvedDir, 'ordinary-browser-results.json');

        if (!existsSync(revPath) || !existsSync(reportPath) || !existsSync(resultsPath)) {
            blockers.push('video-fix-integration-report-files-missing');
            return { ok: false, blockers };
        }

        const [revContent, reportContent, resultsContent] = await Promise.all([
            readFile(revPath),
            readFile(reportPath),
            readFile(resultsPath)
        ]);

        const revHash = createHash('sha256').update(revContent).digest('hex');
        const reportHash = createHash('sha256').update(reportContent).digest('hex');
        const resultsHash = createHash('sha256').update(resultsContent).digest('hex');

        if (revHash !== FROZEN_REVIEWER_VERIFICATION_HASH) {
            blockers.push(`video-fix-reviewer-verification-hash-tampered:${revHash}!==${FROZEN_REVIEWER_VERIFICATION_HASH}`);
        }
        if (reportHash !== FROZEN_INTEGRATION_REPORT_HASH) {
            blockers.push(`video-fix-integration-report-hash-tampered:${reportHash}!==${FROZEN_INTEGRATION_REPORT_HASH}`);
        }
        if (resultsHash !== FROZEN_RESULTS_JSON_HASH) {
            blockers.push(`video-fix-integration-results-json-tampered:${resultsHash}!==${FROZEN_RESULTS_JSON_HASH}`);
        }

        let reviewData = null;
        try {
            reviewData = JSON.parse(revContent.toString('utf8'));
        } catch {
            blockers.push('video-fix-reviewer-verification-json-corrupt');
            return { ok: false, blockers };
        }

        if (!Array.isArray(reviewData) || reviewData.length !== 5) {
            blockers.push(`video-fix-reviewer-records-count-invalid:${reviewData?.length ?? 0}!==5`);
        }
        const reviewByKey = new Map((reviewData || []).map((item) => [item.key, item]));

        for (const [key, spec] of Object.entries(FROZEN_VIDEO_INTEGRATION_SPECS)) {
            const rev = reviewByKey.get(key);
            if (!rev) {
                blockers.push(`video-fix-reviewer-record-missing:${key}`);
                continue;
            }
            if (rev.outputHash !== spec.outputHash) {
                blockers.push(`video-fix-reviewer-hash-mismatch:${key}`);
            }
            if (spec.inputHash && rev.inputHash !== spec.inputHash) {
                blockers.push(`video-fix-reviewer-input-hash-mismatch:${key}`);
            }

            const diskFile = path.join(resolvedDir, spec.fileName);
            if (!existsSync(diskFile)) {
                blockers.push(`video-fix-integration-file-missing:${spec.fileName}`);
                continue;
            }
            const diskHash = await sha256File(diskFile);
            if (diskHash !== spec.outputHash) {
                blockers.push(`video-fix-integration-file-hash-mismatch:${spec.fileName}`);
            }
        }

        let resultsJson = null;
        try {
            resultsJson = JSON.parse(resultsContent.toString('utf8'));
        } catch {
            blockers.push('video-fix-integration-results-json-corrupt');
        }

        const exportResults = resultsJson?.exportResults || {};
        for (const [key, spec] of Object.entries(FROZEN_VIDEO_INTEGRATION_SPECS)) {
            if (spec.frames && exportResults[key]) {
                const clip = exportResults[key];
                if (clip.videoFrames?.count !== spec.frames) {
                    blockers.push(`video-fix-frames-count-mismatch:${key}:${clip.videoFrames?.count}!==${spec.frames}`);
                }
                if (spec.payloadStreamHash && clip.audioPackets?.payloadStreamHash !== spec.payloadStreamHash) {
                    blockers.push(`video-fix-audio-payload-hash-mismatch:${key}`);
                }
            }
        }

        return {
            ok: blockers.length === 0,
            blockers,
            integrationDir: resolvedDir,
            reviewerVerificationHash: revHash,
            integrationReportHash: reportHash,
            verifiedOutputsCount: Object.keys(FROZEN_VIDEO_INTEGRATION_SPECS).length
        };
    } catch (error) {
        return {
            ok: false,
            blockers: [`video-fix-integration-verification-error:${error?.message || error}`]
        };
    }
}

export async function verifyReleaseArtifacts({
    latestExtensionPath = 'release/latest-extension.json',
    tgzPath = null,
    cwd = process.cwd(),
    candidateCi = null,
    downloadArtifact = downloadCiArtifact
} = {}) {
    const blockers = [];
    const fullExtensionPath = path.resolve(cwd, latestExtensionPath);
    if (!existsSync(fullExtensionPath)) {
        blockers.push(`video-fix-latest-extension-missing:${latestExtensionPath}`);
        return { ok: false, blockers };
    }

    let extensionData = null;
    try {
        extensionData = JSON.parse(await readFile(fullExtensionPath, 'utf8'));
        if (extensionData.version !== '1.0.44') {
            blockers.push(`video-fix-extension-version-mismatch:${extensionData.version}!==1.0.44`);
        }
        const releaseDir = path.dirname(fullExtensionPath);
        const zipFile = path.resolve(releaseDir, extensionData.file);
        if (!existsSync(zipFile)) {
            blockers.push(`video-fix-extension-zip-missing:${extensionData.file}`);
        } else {
            const [sha, info, checksumText] = await Promise.all([
                sha256File(zipFile),
                stat(zipFile),
                readFile(`${zipFile}.sha256.txt`, 'utf8')
            ]);
            if (sha !== extensionData.sha256) {
                blockers.push(`video-fix-extension-zip-hash-mismatch:${sha}!==${extensionData.sha256}`);
            }
            if (info.size !== extensionData.size) {
                blockers.push(`video-fix-extension-zip-size-mismatch:${info.size}!==${extensionData.size}`);
            }
            if (!checksumText.trim().startsWith(extensionData.sha256)) {
                blockers.push('video-fix-extension-checksum-file-mismatch');
            }
        }
    } catch (error) {
        blockers.push(`video-fix-extension-read-error:${error?.message || error}`);
    }

    const defaultTgz = path.resolve(cwd, 'release/pilio-gemini-watermark-remover-1.0.44.tgz');

    const resolvedTgzPath = tgzPath ? path.resolve(cwd, tgzPath) : defaultTgz;

    let tgzSha = null;
    let tgzSize = 0;
    if (!existsSync(resolvedTgzPath)) {
        blockers.push('video-fix-tgz-artifact-missing: Candidate tarball provenance missing; package tgz not found.');
    } else {
        try {
            const [sha, info] = await Promise.all([
                sha256File(resolvedTgzPath),
                stat(resolvedTgzPath)
            ]);
            tgzSha = sha;
            tgzSize = info.size;
            if (tgzSize === 0) {
                blockers.push('video-fix-tgz-artifact-empty');
            }
        } catch (error) {
            blockers.push(`video-fix-tgz-read-error:${error?.message || error}`);
        }
    }

    if (!candidateCi?.ciRun?.databaseId || !candidateCi.classification?.ok ||
        candidateCi.ciRun.headSha !== candidateCi.commitSha) {
        blockers.push('video-fix-artifact-successful-current-ci-required');
    } else {
        const downloadDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-artifact-'));
        try {
            await downloadArtifact(candidateCi.ciRun.databaseId, downloadDir, cwd);
            const remoteTgz = path.join(downloadDir, '.artifacts/release-candidate/pilio-gemini-watermark-remover-1.0.44.tgz');
            const remoteMetadata = JSON.parse(await readFile(path.join(downloadDir, 'release/latest-extension.json'), 'utf8'));
            if (tgzSha !== await sha256File(remoteTgz)) blockers.push('video-fix-tgz-not-current-ci-artifact');
            if (!extensionData || extensionData.file !== remoteMetadata.file ||
                extensionData.version !== remoteMetadata.version || extensionData.sha256 !== remoteMetadata.sha256 ||
                extensionData.size !== remoteMetadata.size ||
                extensionData.sha256 !== await sha256File(path.join(downloadDir, 'release', remoteMetadata.file))) {
                blockers.push('video-fix-extension-not-current-ci-artifact');
            }
        } catch (error) {
            blockers.push(`video-fix-ci-artifact-source-unavailable:${error.message}`);
        } finally {
            await rm(downloadDir, { recursive: true, force: true });
        }
    }

    return {
        ok: blockers.length === 0,
        blockers,
        extension: extensionData,
        tgz: tgzSha ? { path: resolvedTgzPath, sha256: tgzSha, size: tgzSize } : null
    };
}

async function downloadCiArtifact(runId, directory, cwd) {
    if (!/^\d+$/.test(String(runId))) throw new Error('Invalid CI run id');
    await promisify(execFile)('gh', ['run', 'download', String(runId), '--name', 'release-candidate-artifacts', '--dir', directory],
        { cwd, maxBuffer: 1024 * 1024, timeout: 180000 });
}

// Release files are committed after a build. Reuse that build only when all
// production inputs still match and GitHub confirms its recorded successful run.
export async function resolveArtifactCi({ cwd, candidateCi, execFn = execFileSync, checkGithubCiFn = checkGithubCi }) {
    const recordPath = path.join(cwd, 'release/evidence/v1.0.44-video-build.json');
    if (!existsSync(recordPath)) return candidateCi;
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    if (!/^[a-f0-9]{40}$/.test(record.commit || '') || !/^\d+$/.test(String(record.runId))) {
        throw new Error('Invalid recorded build identity');
    }
    const changedInputs = readGitOutput(['diff', '--name-only', record.commit, 'HEAD', '--',
        ...PRODUCTION_BUILD_INPUT_PREFIXES, 'package.json'], cwd, execFn).trim();
    if (changedInputs) throw new Error(`Recorded build inputs differ: ${changedInputs}`);
    const ci = await checkGithubCiFn({ workflow: 'ci.yml', commitSha: record.commit, cwd });
    if (!ci?.classification?.ok || ci.run?.headSha !== record.commit || String(ci.run.databaseId) !== String(record.runId)) {
        throw new Error('Recorded build CI is not verified');
    }
    return { commitSha: record.commit, ciRun: ci.run, classification: ci.classification };
}

export async function verifyCandidateLiveCi({
    workflow = 'ci.yml',
    cwd = process.cwd(),
    checkGithubCiFn = checkGithubCi,
    execFn = execFileSync
} = {}) {
    const blockers = [];
    let currentHead = '';
    try {
        currentHead = readGitOutput(['rev-parse', 'HEAD'], cwd, execFn).trim();
    } catch (error) {
        blockers.push(`video-fix-ci-head-resolve-error:${error?.message || error}`);
    }

    const targetCommit = currentHead;

    let ciResult = null;
    try {
        ciResult = await checkGithubCiFn({ workflow, commitSha: targetCommit, cwd });
    } catch (error) {
        blockers.push(`video-fix-ci-query-error:${error?.message || error}`);
    }

    if (!ciResult?.run || ciResult.run.headSha !== currentHead) {
        blockers.push('video-fix-ci-current-head-not-verified');
    }
    if (ciResult) {
        if (!ciResult.classification?.ok) {
            blockers.push(`video-fix-ci-not-passing:${ciResult.classification?.blocker || ciResult.classification?.status || 'unknown'}`);
        }
    }

    try {
        const gitStatus = readGitOutput(['status', '--porcelain'], cwd, execFn);
        const uncommittedLines = gitStatus.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const codeChanges = uncommittedLines.filter((line) => {
            const p = line.replace(/^[MADRCU?! ]+\s+/, '').trim();
            return p.startsWith('scripts/') || p.startsWith('src/') || p.startsWith('tests/') ||
                p.startsWith('.github/') || PRODUCTION_BUILD_INPUT_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix + '/')) || p === 'package.json';
        });

        if (codeChanges.length > 0) {
            blockers.push(
                'video-fix-ci-required-for-new-diff: Working tree contains uncommitted changes not tested by GitHub Actions CI. A new CI run on the final committed SHA is required before release.'
            );
        }
    } catch (error) {
        blockers.push(`video-fix-ci-status-check-error:${error?.message || error}`);
    }

    return {
        ok: blockers.length === 0,
        blockers,
        commitSha: targetCommit,
        ciRun: ciResult?.run || null,
        classification: ciResult?.classification || null
    };
}

export function renderVideoFixGateMarkdown({
    generatedAt = new Date().toISOString(),
    baseline,
    manifest,
    historicalImage,
    integration,
    releaseArtifacts,
    candidateCi,
    allBlockers
}) {
    const isOverallReady = allBlockers.length === 0;
    const lines = [];

    lines.push('# 视频修复发布门禁验证报告（v1.0.44 RC）');
    lines.push('');
    lines.push(`- **生成时间**: ${generatedAt}`);
    lines.push(`- **门禁结论**: ${isOverallReady ? '**通过（READY）**' : '**阻塞（BLOCKED）**'}`);
    lines.push(`- **发布范围**: \`video-fix\`（限定视频候选选择修复，保留既有图片处理与默认配置不变）`);
    lines.push('');
    lines.push('## 1. 验证矩阵');
    lines.push('');
    lines.push('| 检查项 | 状态 | 说明 |');
    lines.push('| --- | --- | --- |');
    lines.push(`| **已发布基准定位** | ${baseline.ok ? '通过' : '阻塞'} | 标签 \`${baseline.baseTag || DEFAULT_PUBLISHED_BASELINE_TAG}\` 解析至 SHA \`${baseline.commit || '-'}\`（版本 ${baseline.version || '-'}） |`);
    lines.push(`| **生产源码与构建清单比对** | ${manifest.ok ? '通过' : '阻塞'} | 生产源码严格限定于 \`${ONLY_ALLOWED_PRODUCTION_SRC}\`；HEAD:src 与已审集成树（${EXPECTED_INTEGRATION_SRC_TREE}）完全一致；依赖零漂移 |`);
    lines.push(`| **历史图片证据不可变复用** | ${historicalImage.ok ? '通过' : '阻塞'} | 依据 Git 已发布 Blob \`${historicalImage.reusedBaselineEvidence || '-'}\` 校验，${IMAGE_RELEASE_SOURCE_PATHS.length} 个核心图片流水线模块完全无漂移，确认为不可变历史证据复用（非重跑） |`);
    lines.push(`| **视频核心集成证据** | ${integration.ok ? '通过' : '阻塞'} | 绑定不可变评审报告与结果哈希（\`reviewer-verification.json\`），5 份导出 MP4 哈希匹配，音频逐包 payload 校验一致 |`);
    lines.push(`| **发布制品校验（ZIP & TGZ）** | ${releaseArtifacts.ok ? '通过' : '阻塞'} | 扩展包 \`${releaseArtifacts.extension?.file || '-'}\` 与候选发布包 \`pilio-gemini-watermark-remover-1.0.44.tgz\` 均完成哈希与大小校验 |`);
    lines.push(`| **GitHub Actions 候选 CI 状态** | ${candidateCi.ok ? '通过' : '阻塞'} | 实时查询 GitHub CI（commit: \`${candidateCi.commitSha || '-'}\`）；检查未提交改动是否需要新 CI 覆盖 |`);
    lines.push('');
    lines.push('## 2. 质量边界与事实声明');
    lines.push('');
    lines.push('- **采样投票事实**：Issue 150 候选选择基于 12 个检测时间点采样投票（非 192 票；192 为总帧数），目标候选 48 获 12/12 全票，背景候选 24 为 0 票。');
    lines.push('- **排除虚构失败**：第 0 帧（f0）并非检测失败，检测采样按预设时间跨度执行。');
    lines.push('- **浏览器有效终端控制**：真实浏览器默认流程初始虽显示为 fdncnn-browser，但最终生效执行路径自动转为 canvas-footprint-polish，不发起任何 ONNX/WASM 模型请求。');
    lines.push('- **排除未证实因果**：残留暗斑差异不归因于未证实的 FDnCNN 影响。');
    lines.push('- **#136b 局限保留**：#136b 为已编辑/未知来源导出样本，基线与补丁输出均存在暗斑，本次发布不作全片无损或彻底干净之宽泛声明。');
    lines.push('- **流程完成边界**：导出流程成功完成不等于制品达到发布状态，必须经证据哈希绑定核验。');
    lines.push('');
    lines.push('## 3. 门禁阻塞项（Gate Blockers）');
    lines.push('');
    if (allBlockers.length === 0) {
        lines.push('无阻塞项，全部独立验证要求满足。');
    } else {
        lines.push(`当前存在 **${allBlockers.length}** 个阻塞项：`);
        lines.push('');
        for (const blocker of allBlockers) {
            lines.push(`- 🔴 \`${blocker}\``);
        }
    }
    lines.push('');
    lines.push('## 4. 剩余发布前提条件（Remaining Release Prerequisites）');
    lines.push('');
    lines.push('1. **新 diff CI 覆盖**：新增门禁代码使得工作树产生新代码提交，在发布前需提交 PR 并获得 GitHub Actions 新 CI 通过。');
    lines.push('2. **官网发布阻塞（独立发布面）**：官网 PR #18 关联 CI 的 WebKit E2E job 因 GitHub 托管账单/额度限制未启动，待账户方解决 Billing 后重跑确认。');
    lines.push('3. **发布者审批**：本步骤仅完成本地独立发布门禁与证据核定，不执行发布、部署或远端推送。');
    lines.push('');

    return lines.join('\n');
}

export async function checkVideoFixReleaseEvidence({
    baseTag = DEFAULT_PUBLISHED_BASELINE_TAG,
    integrationDir = null,
    tgzPath = null,
    latestExtensionPath = 'release/latest-extension.json',
    workflow = 'ci.yml',
    cwd = process.cwd(),
    execFn = execFileSync,
    checkGithubCiFn = checkGithubCi
} = {}) {
    const baseline = resolvePublishedBaseline({ baseTag, cwd, execFn });
    const manifest = verifyTrackedProductionAndManifest({ baseTag, cwd, execFn });
    const historicalImage = await verifyHistoricalImageEvidence({ baseTag, cwd, execFn });
    const integration = await verifyCoreVideoIntegrationEvidence({ integrationDir, cwd });
    const candidateCi = await verifyCandidateLiveCi({ workflow, cwd, execFn, checkGithubCiFn });
    let releaseArtifacts;
    try {
        const artifactCi = await resolveArtifactCi({ cwd, candidateCi, execFn, checkGithubCiFn });
        releaseArtifacts = await verifyReleaseArtifacts({ latestExtensionPath, tgzPath, cwd, candidateCi: artifactCi });
        releaseArtifacts.buildCommit = artifactCi?.commitSha;
    } catch (error) {
        releaseArtifacts = { ok: false, blockers: [`video-fix-recorded-build-invalid:${error.message}`] };
    }

    const allBlockers = [
        ...baseline.blockers,
        ...manifest.blockers,
        ...historicalImage.blockers,
        ...integration.blockers,
        ...releaseArtifacts.blockers,
        ...candidateCi.blockers
    ];

    const markdownReport = renderVideoFixGateMarkdown({
        baseline,
        manifest,
        historicalImage,
        integration,
        releaseArtifacts,
        candidateCi,
        allBlockers
    });

    return {
        ok: allBlockers.length === 0,
        blockers: allBlockers,
        details: {
            baseline,
            manifest,
            historicalImage,
            integration,
            releaseArtifacts,
            candidateCi
        },
        markdownReport
    };
}

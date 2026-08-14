import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    IMAGE_RELEASE_SOURCE_PATHS,
    sha256File,
    verifyImageReleaseEvidence
} from './image-release-evidence.js';

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function loadReleasePackage(latestExtensionPath) {
    const latest = await readJson(latestExtensionPath);
    const releaseDir = path.dirname(latestExtensionPath);
    const zipPath = path.resolve(releaseDir, latest.file);
    const [sha256, info, checksumText] = await Promise.all([
        sha256File(zipPath),
        stat(zipPath),
        readFile(`${zipPath}.sha256.txt`, 'utf8')
    ]);
    if (sha256 !== latest.sha256 || info.size !== latest.size || !checksumText.trim().startsWith(sha256)) {
        throw new Error('Release package metadata does not match the zip/checksum files');
    }
    return { version: latest.version, file: latest.file, sha256, size: info.size };
}

function readGitOutput(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function resolvePreviousPackageReleaseRef(currentVersion, cwd) {
    const commits = readGitOutput(['log', '--format=%H', '--', 'package.json'], cwd)
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
    for (const commit of commits) {
        const pkg = JSON.parse(readGitOutput(['show', commit + ':package.json'], cwd));
        if (pkg.version && pkg.version !== currentVersion) return commit;
    }
    throw new Error('Unable to resolve the previous package release before ' + currentVersion);
}

function readVideoChangedFiles(baseRef, cwd) {
    const output = readGitOutput([
        'diff',
        '--name-only',
        baseRef,
        '--',
        'src/video',
        'src/video-app.js'
    ], cwd);
    return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

async function loadCurrentState({
    packageJsonPath,
    latestExtensionPath,
    sourcePaths,
    baseTag,
    changedFiles,
    cwd
}) {
    const pkg = await readJson(packageJsonPath);
    const sourceHashes = new Map();
    for (const sourcePath of sourcePaths) {
        sourceHashes.set(sourcePath, await sha256File(path.resolve(cwd, sourcePath)));
    }
    const outOfScopeChangedFiles = changedFiles ?? readVideoChangedFiles(
        baseTag || resolvePreviousPackageReleaseRef(pkg.version, cwd),
        cwd
    );
    return {
        version: pkg.version,
        sourceHashes,
        releasePackage: await loadReleasePackage(latestExtensionPath),
        outOfScopeChangedFiles
    };
}

export async function checkImageReleaseEvidence({
    evidence = null,
    current = null,
    evidencePath = null,
    packageJsonPath = path.resolve('package.json'),
    latestExtensionPath = path.resolve('release/latest-extension.json'),
    sourcePaths = IMAGE_RELEASE_SOURCE_PATHS,
    baseTag = null,
    changedFiles = null,
    quiet = false,
    cwd = process.cwd()
} = {}) {
    try {
        const pkg = current ? null : await readJson(packageJsonPath);
        const resolvedEvidencePath = evidencePath || path.resolve(
            `release/evidence/v${current?.version || pkg.version}-image-quality.json`
        );
        const evidenceValue = evidence || await readJson(resolvedEvidencePath);
        const currentValue = current || await loadCurrentState({
            packageJsonPath,
            latestExtensionPath,
            sourcePaths,
            baseTag,
            changedFiles,
            cwd
        });
        const result = verifyImageReleaseEvidence(evidenceValue, currentValue);
        if (!quiet) {
            console.log(`image release quality gate: ${result.ok ? 'pass' : 'fail'}`);
            for (const blocker of result.blockers) console.error(`- ${blocker}`);
        }
        return result;
    } catch (error) {
        const result = { ok: false, blockers: [`image-evidence-check-error:${error?.message || error}`] };
        if (!quiet) {
            console.log('image release quality gate: fail');
            console.error(`- ${result.blockers[0]}`);
        }
        return result;
    }
}

function parseArgs(argv) {
    const parsed = {};
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--evidence') parsed.evidencePath = path.resolve(argv[++index]);
        else if (arg === '--base-tag') parsed.baseTag = argv[++index];
        else if (arg === '--changed-files-json') parsed.changedFilesPath = path.resolve(argv[++index]);
    }
    return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const args = parseArgs(process.argv.slice(2));
    const changedFiles = args.changedFilesPath ? await readJson(args.changedFilesPath) : null;
    const result = await checkImageReleaseEvidence({ ...args, changedFiles });
    if (!result.ok) process.exitCode = 1;
}

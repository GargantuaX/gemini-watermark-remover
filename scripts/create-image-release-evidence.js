import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    IMAGE_RELEASE_SOURCE_PATHS,
    buildImageReleaseEvidence,
    sha256File,
    summarizeExact96Review
} from './image-release-evidence.js';

const DEFAULT_PATHS = Object.freeze({
    contrast: path.resolve('.artifacts/top-n-candidate-selection/contrast-report.json'),
    curatedBefore: path.resolve('.artifacts/same-anchor-96-imperfection-preference/before-424-report.json'),
    curatedAfter: path.resolve('.artifacts/expanded-sample-validation/curated-top-n/combined-report.json'),
    manualReport: path.resolve(
        '.artifacts/same-anchor-96-imperfection-preference/before-review/report.json'
    ),
    manualDecisions: path.resolve(
        '.artifacts/same-anchor-96-imperfection-preference/before-review/review.json'
    ),
    automated: path.resolve('.artifacts/release-image-quality/automated-results.json'),
    packageJson: path.resolve('package.json'),
    latestExtension: path.resolve('release/latest-extension.json'),
    output: null
});

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readCurrentReleasePackage(latestExtensionPath) {
    const latest = await readJson(latestExtensionPath);
    const zipPath = path.resolve(path.dirname(latestExtensionPath), latest.file);
    const [sha256, info] = await Promise.all([sha256File(zipPath), stat(zipPath)]);
    if (sha256 !== latest.sha256 || info.size !== latest.size) {
        throw new Error('Release package metadata does not match the current zip');
    }
    return { version: latest.version, file: latest.file, sha256, size: info.size };
}

export async function createImageReleaseEvidence({
    paths: overrides = {},
    sourcePaths = IMAGE_RELEASE_SOURCE_PATHS,
    releasePackage = null
} = {}) {
    const paths = { ...DEFAULT_PATHS, ...overrides };
    const pkg = await readJson(paths.packageJson);
    const outputPath = paths.output || path.resolve(`release/evidence/v${pkg.version}-image-quality.json`);
    const inputEntries = [
        ['contrast', paths.contrast],
        ['curatedBefore', paths.curatedBefore],
        ['curatedAfter', paths.curatedAfter],
        ['manualReport', paths.manualReport],
        ['manualDecisions', paths.manualDecisions],
        ['automated', paths.automated]
    ];
    const values = Object.fromEntries(await Promise.all(
        inputEntries.map(async ([id, filePath]) => [id, await readJson(filePath)])
    ));
    const inputArtifacts = await Promise.all(inputEntries.map(async ([id, filePath]) => ({
        id,
        path: filePath,
        sha256: await sha256File(filePath)
    })));
    const sourceFiles = await Promise.all(sourcePaths.map(async (sourcePath) => ({
        path: sourcePath,
        sha256: await sha256File(path.resolve(sourcePath))
    })));
    const manualReview = summarizeExact96Review(values.manualReport, values.manualDecisions);
    const evidence = await buildImageReleaseEvidence({
        version: pkg.version,
        contrast: values.contrast,
        curatedBefore: values.curatedBefore,
        curatedAfter: values.curatedAfter,
        manualReview,
        automated: values.automated,
        provenance: { sourceFiles, inputArtifacts },
        releasePackage: releasePackage || await readCurrentReleasePackage(paths.latestExtension)
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return evidence;
}

function parseArgs(argv) {
    const paths = {};
    const flags = new Map([
        ['--contrast', 'contrast'],
        ['--curated-before', 'curatedBefore'],
        ['--curated-after', 'curatedAfter'],
        ['--manual-report', 'manualReport'],
        ['--manual-decisions', 'manualDecisions'],
        ['--automated', 'automated'],
        ['--output', 'output']
    ]);
    for (let index = 0; index < argv.length; index++) {
        const key = flags.get(argv[index]);
        if (key) paths[key] = path.resolve(argv[++index]);
    }
    return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    createImageReleaseEvidence({ paths: parseArgs(process.argv.slice(2)) }).then((evidence) => {
        console.log(`image release evidence: v${evidence.version}`);
    }).catch((error) => {
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}

export { DEFAULT_PATHS };

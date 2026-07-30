import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const LABELS = new Set(['watermarked', 'clean', 'ambiguous']);
const REVIEW_CONFIDENCE = new Set(['high', 'medium']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const reportPath = (value) => value.replace(/\\/g, '/');

function inferSampleGroup(relativePath) {
    const firstSegment = relativePath.split('/')[0] || 'root';
    return /^\d{4}-\d{2}-\d{2}$/.test(firstSegment) ? 'task-source' : firstSegment;
}

export function canonicalizeExternalBenchmarkJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalizeExternalBenchmarkJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalizeExternalBenchmarkJson(value[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}

function resolveInsideRoot(sampleRoot, relativePath) {
    if (typeof relativePath !== 'string') throw new Error('label path must be a string');
    const normalized = reportPath(relativePath);
    const resolved = path.resolve(sampleRoot, normalized);
    const relative = reportPath(path.relative(sampleRoot, resolved));
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        throw new Error(`label path escapes sample root: ${relativePath}`);
    }
    return { normalized, resolved };
}

export async function listExternalBenchmarkImages(sampleRoot) {
    const images = [];

    async function visit(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(filePath);
                continue;
            }
            if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            const fileName = reportPath(path.relative(sampleRoot, filePath));
            images.push({ fileName, filePath, group: inferSampleGroup(fileName) });
        }
    }

    await visit(sampleRoot);
    return images.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export async function indexExternalBenchmarkImages(images) {
    const groups = new Map();
    for (const image of images) {
        const bytes = await readFile(image.filePath);
        const contentSha256 = sha256(bytes);
        const record = { ...image, contentSha256 };
        const group = groups.get(contentSha256) ?? { sha256: contentSha256, images: [], paths: [] };
        group.images.push(record);
        group.paths.push(image.fileName);
        groups.set(contentSha256, group);
    }
    return new Map([...groups.values()]
        .map((group) => ({
            ...group,
            images: group.images.sort((left, right) => left.fileName.localeCompare(right.fileName)),
            paths: group.paths.sort((left, right) => left.localeCompare(right))
        }))
        .sort((left, right) => left.sha256.localeCompare(right.sha256))
        .map((group) => [group.sha256, group]));
}

function validateManifestEntry(sampleRoot, fileName, entry) {
    const location = resolveInsideRoot(sampleRoot, fileName);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`invalid label manifest entry: ${fileName}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256 ?? '')) throw new Error(`invalid sha256: ${fileName}`);
    if (!LABELS.has(entry.label)) throw new Error(`unknown label: ${entry.label}`);
    if (!REVIEW_CONFIDENCE.has(entry.reviewConfidence)) {
        throw new Error(`unknown reviewConfidence: ${entry.reviewConfidence}`);
    }
    return { ...location, ...entry, sha256: entry.sha256.toLowerCase() };
}

function createDatasetMetadata({ mode, trusted, datasetId, labelManifestSha256, groups, pathCount }) {
    return {
        mode,
        trusted,
        datasetId,
        labelManifestSha256,
        contentSetSha256: sha256([...groups.keys()].sort().join('\n')),
        pathCount,
        uniqueContentCount: groups.size,
        duplicatePathCount: pathCount - groups.size
    };
}

export async function loadTrustedExternalBenchmarkDataset({ sampleRoot, labelManifestPath, images }) {
    const manifest = JSON.parse((await readFile(labelManifestPath, 'utf8')).replace(/^\uFEFF/, ''));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('label manifest must be an object');
    if (manifest.version !== 1) throw new Error(`unsupported label manifest version: ${manifest.version}`);
    if (typeof manifest.datasetId !== 'string' || !manifest.datasetId.trim()) throw new Error('datasetId is required');
    if (!manifest.samples || typeof manifest.samples !== 'object' || Array.isArray(manifest.samples)) {
        throw new Error('manifest samples are required');
    }

    const indexedImages = await indexExternalBenchmarkImages(images);
    const imagePaths = new Map(images.map((image) => [reportPath(image.fileName), image]));
    const labels = new Map();
    for (const [fileName, entry] of Object.entries(manifest.samples)) {
        const validated = validateManifestEntry(sampleRoot, fileName, entry);
        const image = imagePaths.get(validated.normalized);
        if (!image) throw new Error(`manifest file is missing: ${fileName}`);
        const bytes = await readFile(validated.resolved);
        if (sha256(bytes) !== validated.sha256) throw new Error(`sha256 mismatch: ${fileName}`);
        labels.set(validated.normalized, validated);
    }

    const cases = [...indexedImages.values()].map((content) => {
        const entries = content.images.map((image) => labels.get(reportPath(image.fileName))).filter(Boolean);
        const distinctLabels = [...new Set(entries.map((entry) => entry.label))];
        if (distinctLabels.length > 1) throw new Error(`conflicting labels for sha256: ${content.sha256}`);
        const representative = entries[0] ?? null;
        const firstImage = content.images[0];
        return {
            fileName: firstImage.fileName,
            filePath: firstImage.filePath,
            paths: content.paths,
            sha256: content.sha256,
            contentSha256: content.sha256,
            label: representative?.label ?? 'unlabeled',
            reviewConfidence: representative?.reviewConfidence ?? null,
            watermarkFamily: representative?.watermarkFamily ?? null,
            expectedAnchor: representative?.expectedAnchor ?? null,
            note: representative?.note ?? null,
            group: firstImage.group
        };
    });

    return {
        dataset: createDatasetMetadata({
            mode: 'trusted-labels',
            trusted: true,
            datasetId: manifest.datasetId,
            labelManifestSha256: sha256(canonicalizeExternalBenchmarkJson(manifest)),
            groups: indexedImages,
            pathCount: images.length
        }),
        cases
    };
}

export async function createAssumedWatermarkedDataset({ sampleRoot, images }) {
    const groups = await indexExternalBenchmarkImages(images);
    const hashesByPath = new Map([...groups.values()].flatMap((group) => group.images.map((image) => [image.fileName, group.sha256])));
    return {
        dataset: createDatasetMetadata({
            mode: 'assumed-watermarked',
            trusted: false,
            datasetId: null,
            labelManifestSha256: null,
            groups,
            pathCount: images.length
        }),
        cases: [...images].sort((left, right) => left.fileName.localeCompare(right.fileName)).map((image) => {
            const contentSha256 = hashesByPath.get(image.fileName);
            return {
                fileName: image.fileName,
                filePath: image.filePath,
                paths: [image.fileName],
                sha256: contentSha256,
                contentSha256,
                label: 'watermarked',
                reviewConfidence: null,
                watermarkFamily: null,
                expectedAnchor: null,
                note: null,
                group: image.group ?? inferSampleGroup(image.fileName)
            };
        })
    };
}

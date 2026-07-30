import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
    canonicalizeExternalBenchmarkJson,
    listExternalBenchmarkImages,
    loadTrustedExternalBenchmarkDataset
} from '../../scripts/external-benchmark-dataset.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('canonical manifest hash input is stable across object key order', () => {
    assert.equal(
        canonicalizeExternalBenchmarkJson({ samples: { b: { label: 'clean' }, a: { label: 'watermarked' } }, version: 1 }),
        canonicalizeExternalBenchmarkJson({ version: 1, samples: { a: { label: 'watermarked' }, b: { label: 'clean' } } })
    );
});

test('trusted dataset validates hashes, deduplicates bytes, and keeps every path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gwr-trusted-dataset-'));
    await mkdir(path.join(root, '2026-07-29'));
    const bytes = Buffer.from('same-image-bytes');
    for (const name of ['a.png', 'b.png']) await writeFile(path.join(root, '2026-07-29', name), bytes);
    const manifestPath = path.join(root, 'labels.json');
    await writeFile(manifestPath, JSON.stringify({
        version: 1,
        datasetId: 'fixture-dataset',
        samples: {
            '2026-07-29/a.png': { sha256: sha256(bytes), label: 'clean', reviewConfidence: 'high' },
            '2026-07-29/b.png': { sha256: sha256(bytes), label: 'clean', reviewConfidence: 'high' }
        }
    }));
    const images = await listExternalBenchmarkImages(root);
    const loaded = await loadTrustedExternalBenchmarkDataset({ sampleRoot: root, labelManifestPath: manifestPath, images });

    assert.equal(loaded.dataset.pathCount, 2);
    assert.equal(loaded.dataset.uniqueContentCount, 1);
    assert.equal(loaded.dataset.duplicatePathCount, 1);
    assert.deepEqual(loaded.cases[0].paths, ['2026-07-29/a.png', '2026-07-29/b.png']);
    assert.equal(loaded.cases[0].label, 'clean');
});

async function createManifestFixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'gwr-trusted-invalid-'));
    const bytes = Buffer.from('fixture-image');
    await writeFile(path.join(root, 'a.png'), bytes);
    return {
        root,
        bytes,
        images: await listExternalBenchmarkImages(root),
        valid: {
            version: 1,
            datasetId: 'fixture',
            samples: { 'a.png': { sha256: sha256(bytes), label: 'clean', reviewConfidence: 'high' } }
        }
    };
}

test('trusted dataset fails closed on malformed or stale manifests', async (t) => {
    const cases = [
        ['unknown version', (value) => ({ ...value, version: 2 }), /unsupported label manifest version/],
        ['missing dataset id', (value) => ({ ...value, datasetId: '' }), /datasetId is required/],
        ['unknown label', (value) => ({ ...value, samples: { 'a.png': { ...value.samples['a.png'], label: 'unknown' } } }), /unknown label/],
        ['path escape', (value) => ({ ...value, samples: { '../escape.png': value.samples['a.png'] } }), /escapes sample root/],
        ['stale path', (value) => ({ ...value, samples: { 'missing.png': value.samples['a.png'] } }), /manifest file is missing/],
        ['hash mismatch', (value) => ({ ...value, samples: { 'a.png': { ...value.samples['a.png'], sha256: '0'.repeat(64) } } }), /sha256 mismatch/]
    ];
    for (const [name, mutate, pattern] of cases) await t.test(name, async () => {
        const fixture = await createManifestFixture();
        const manifestPath = path.join(fixture.root, 'labels.json');
        await writeFile(manifestPath, JSON.stringify(mutate(fixture.valid)));
        await assert.rejects(
            loadTrustedExternalBenchmarkDataset({ sampleRoot: fixture.root, labelManifestPath: manifestPath, images: fixture.images }),
            pattern
        );
    });
});

test('trusted dataset rejects conflicting labels for duplicate bytes', async () => {
    const fixture = await createManifestFixture();
    await writeFile(path.join(fixture.root, 'b.png'), fixture.bytes);
    const manifestPath = path.join(fixture.root, 'labels.json');
    await writeFile(manifestPath, JSON.stringify({
        ...fixture.valid,
        samples: {
            'a.png': fixture.valid.samples['a.png'],
            'b.png': { sha256: sha256(fixture.bytes), label: 'watermarked', reviewConfidence: 'high' }
        }
    }));
    await assert.rejects(
        loadTrustedExternalBenchmarkDataset({
            sampleRoot: fixture.root,
            labelManifestPath: manifestPath,
            images: await listExternalBenchmarkImages(fixture.root)
        }),
        /conflicting labels for sha256/
    );
});

test('a file absent from the manifest remains unlabeled', async () => {
    const fixture = await createManifestFixture();
    await writeFile(path.join(fixture.root, 'b.png'), Buffer.from('different-image'));
    const manifestPath = path.join(fixture.root, 'labels.json');
    await writeFile(manifestPath, JSON.stringify(fixture.valid));
    const loaded = await loadTrustedExternalBenchmarkDataset({
        sampleRoot: fixture.root,
        labelManifestPath: manifestPath,
        images: await listExternalBenchmarkImages(fixture.root)
    });
    assert.equal(loaded.cases.find((record) => record.fileName === 'b.png').label, 'unlabeled');
});

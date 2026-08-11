import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getReferenceVideoWatermarkCatalog,
    resolveVideoWatermarkCandidates
} from '../../src/video/videoWatermarkCatalog.js';

test('resolveVideoWatermarkCandidates should expose confirmed 1920x1080 positions', () => {
    const candidates = resolveVideoWatermarkCandidates(1920, 1080);

    assert.equal(candidates.length, 2);
    assert.deepEqual(
        candidates.map((candidate) => ({
            id: candidate.id,
            x: candidate.x,
            y: candidate.y,
            size: candidate.size
        })),
        [
            { id: 'veo-1080p-standard', x: 1740, y: 900, size: 72 },
            { id: 'veo-1080p-inset', x: 1704, y: 864, size: 72 }
        ]
    );
});

test('resolveVideoWatermarkCandidates should expose allenk binary-prior 1080x1920 portrait positions', () => {
    const candidates = resolveVideoWatermarkCandidates(1080, 1920);

    assert.deepEqual(
        candidates
            .filter((candidate) => candidate.id.startsWith('veo-1080x1920'))
            .map((candidate) => ({
                id: candidate.id,
                x: candidate.x,
                y: candidate.y,
                size: candidate.size,
                marginRight: candidate.marginRight,
                marginBottom: candidate.marginBottom,
                sourceFamily: candidate.sourceFamily,
                evidenceGate: candidate.evidenceGate,
                exactSizeVariant: candidate.exactSizeVariant
            })),
        [
            {
                id: 'veo-1080x1920-portrait-72',
                x: 900,
                y: 1740,
                size: 72,
                marginRight: 108,
                marginBottom: 108,
                sourceFamily: 'binary-prior',
                evidenceGate: 'required',
                exactSizeVariant: true
            },
            {
                id: 'veo-1080x1920-portrait-relocated-72',
                x: 864,
                y: 1704,
                size: 72,
                marginRight: 144,
                marginBottom: 144,
                sourceFamily: 'binary-prior',
                evidenceGate: 'required',
                exactSizeVariant: true
            }
        ]
    );
});

test('resolveVideoWatermarkCandidates should expose allenk 720p variants', () => {
    const candidates = resolveVideoWatermarkCandidates(1280, 720);

    assert.deepEqual(
        candidates.map((candidate) => ({
            id: candidate.id,
            x: candidate.x,
            y: candidate.y,
            size: candidate.size
        })),
        [
            { id: 'veo-720p-3-inset', x: 1136, y: 576, size: 48 },
            { id: 'veo-720p-1-standard', x: 1160, y: 600, size: 48 },
            { id: 'veo-720p-2-compact', x: 1207, y: 636, size: 44 }
        ]
    );
});

test('resolveVideoWatermarkCandidates should expose confirmed 720x1280 vertical variants', () => {
    const candidates = resolveVideoWatermarkCandidates(720, 1280);

    assert.deepEqual(
        candidates
            .filter((candidate) => candidate.id.startsWith('veo-720x1280'))
            .map((candidate) => ({
                id: candidate.id,
                x: candidate.x,
                y: candidate.y,
                size: candidate.size,
                marginRight: candidate.marginRight,
                marginBottom: candidate.marginBottom,
                sourceFamily: candidate.sourceFamily,
                evidenceGate: candidate.evidenceGate,
                exactSizeVariant: candidate.exactSizeVariant
            })),
        [
            {
                id: 'veo-720x1280-portrait-relocated-48',
                x: 576,
                y: 1136,
                size: 48,
                marginRight: 96,
                marginBottom: 96,
                sourceFamily: 'exact-size-exception',
                evidenceGate: 'required',
                exactSizeVariant: true
            },
            {
                id: 'veo-720x1280-animated-compact-24',
                x: 648,
                y: 1208,
                size: 24,
                marginRight: 48,
                marginBottom: 48,
                sourceFamily: 'exact-size-exception',
                evidenceGate: 'required',
                exactSizeVariant: true
            },
            {
                id: 'veo-720x1280-portrait-48',
                x: 600,
                y: 1160,
                size: 48,
                marginRight: 72,
                marginBottom: 72,
                sourceFamily: 'binary-prior',
                evidenceGate: 'required',
                exactSizeVariant: true
            },
            {
                id: 'veo-720x1280-vertical-inset',
                x: 583,
                y: 1149,
                size: 35,
                marginRight: 102,
                marginBottom: 96,
                sourceFamily: 'exact-size-exception',
                evidenceGate: 'required',
                exactSizeVariant: true
            },
            {
                id: 'veo-720x1280-compact-44',
                x: 647,
                y: 1196,
                size: 44,
                marginRight: 29,
                marginBottom: 40,
                sourceFamily: 'binary-prior',
                evidenceGate: 'required',
                exactSizeVariant: true
            }
        ]
    );
});

test('resolveVideoWatermarkCandidates should merge projected reference anchors with exact-size exceptions', () => {
    const candidates = resolveVideoWatermarkCandidates(1280, 720);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

    assert.deepEqual(
        {
            standard: {
                scaledFromReference: byId.get('veo-720p-1-standard')?.scaledFromReference,
                sourceCandidateId: byId.get('veo-720p-1-standard')?.sourceCandidateId
            },
            inset: {
                scaledFromReference: byId.get('veo-720p-3-inset')?.scaledFromReference,
                sourceCandidateId: byId.get('veo-720p-3-inset')?.sourceCandidateId
            },
            compact: {
                scaledFromReference: byId.get('veo-720p-2-compact')?.scaledFromReference,
                sourceCandidateId: byId.get('veo-720p-2-compact')?.sourceCandidateId
            }
        },
        {
            standard: {
                scaledFromReference: true,
                sourceCandidateId: 'veo-1080p-standard'
            },
            inset: {
                scaledFromReference: true,
                sourceCandidateId: 'veo-1080p-inset'
            },
            compact: {
                scaledFromReference: false,
                sourceCandidateId: null
            }
        }
    );
});

test('resolveVideoWatermarkCandidates should expose candidate source metadata for validation gates', () => {
    const candidates = resolveVideoWatermarkCandidates(1280, 720);

    assert.deepEqual(
        candidates.map((candidate) => ({
            id: candidate.id,
            sourceFamily: candidate.sourceFamily,
            evidenceGate: candidate.evidenceGate,
            exactSizeVariant: candidate.exactSizeVariant
        })),
        [
            {
                id: 'veo-720p-3-inset',
                sourceFamily: 'reference-projected',
                evidenceGate: 'standard',
                exactSizeVariant: true
            },
            {
                id: 'veo-720p-1-standard',
                sourceFamily: 'reference-projected',
                evidenceGate: 'standard',
                exactSizeVariant: true
            },
            {
                id: 'veo-720p-2-compact',
                sourceFamily: 'exact-size-exception',
                evidenceGate: 'required',
                exactSizeVariant: true
            }
        ]
    );
});

test('getReferenceVideoWatermarkCatalog should return defensive copies', () => {
    const first = getReferenceVideoWatermarkCatalog();
    const second = getReferenceVideoWatermarkCatalog();

    first.candidates[0].size = 1;

    assert.equal(second.candidates[0].size, 72);
});

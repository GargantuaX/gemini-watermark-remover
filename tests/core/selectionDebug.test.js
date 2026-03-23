import test from 'node:test';
import assert from 'node:assert/strict';

import { createSelectionDebugSummary } from '../../src/core/selectionDebug.js';

test('createSelectionDebugSummary should mark usedSizeJitter from structured provenance', () => {
    const summary = createSelectionDebugSummary({
        selectedTrial: {
            source: 'standard+validated',
            provenance: { sizeJitter: true },
            texturePenalty: 0.12,
            tooDark: false,
            tooFlat: false,
            hardReject: false
        },
        selectionSource: 'standard+validated'
    });

    assert.equal(summary.usedSizeJitter, true);
    assert.equal(summary.candidateSource, 'standard+validated');
});

test('createSelectionDebugSummary should not infer usedSizeJitter only from source tags', () => {
    const summary = createSelectionDebugSummary({
        selectedTrial: {
            source: 'standard+size+validated',
            provenance: {},
            texturePenalty: 0,
            tooDark: false,
            tooFlat: false,
            hardReject: false
        },
        selectionSource: 'standard+size+validated'
    });

    assert.equal(summary.usedSizeJitter, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createRepairCleanupFlags,
    isKnown48AnchorConfig,
    isV2SmallAnchorConfig,
    shouldUseKnown48EdgeCleanup,
    shouldUsePreviewAnchorFastCleanup,
    shouldUseV2SmallEdgeCleanup
} from '../../src/core/pipelineRepairGates.js';

test('shouldUsePreviewAnchorFastCleanup should accept preview anchors in size range', () => {
    assert.equal(shouldUsePreviewAnchorFastCleanup(
        { provenance: { previewAnchor: true } },
        { width: 27 }
    ), true);
    assert.equal(shouldUsePreviewAnchorFastCleanup(
        { provenance: { previewAnchor: true } },
        { width: 34 }
    ), false);
    assert.equal(shouldUsePreviewAnchorFastCleanup(
        { provenance: { previewAnchor: true } },
        { width: 40 }
    ), false);
});

test('known 48 cleanup gate should accept canonical and large-margin anchors', () => {
    assert.equal(isKnown48AnchorConfig({ logoSize: 48, marginRight: 32, marginBottom: 32 }), true);
    assert.equal(isKnown48AnchorConfig({ logoSize: 48, marginRight: 96, marginBottom: 96 }), true);
    assert.equal(isKnown48AnchorConfig({ logoSize: 48, marginRight: 64, marginBottom: 64 }), false);

    assert.equal(shouldUseKnown48EdgeCleanup({
        selectedTrial: {
            config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
            provenance: {}
        },
        position: { width: 48 },
        source: 'standard+catalog'
    }), true);
});

test('v2 small cleanup gate should require v2 catalog provenance', () => {
    const selectedTrial = {
        config: { logoSize: 36, marginRight: 64, marginBottom: 64, alphaVariant: 'v2' },
        provenance: { catalogFamily: 'gemini-v2-small' }
    };

    assert.equal(isV2SmallAnchorConfig(selectedTrial.config), true);
    assert.equal(shouldUseV2SmallEdgeCleanup({
        selectedTrial,
        position: { width: 36 },
        source: 'standard+catalog'
    }), true);
    assert.equal(shouldUseV2SmallEdgeCleanup({
        selectedTrial: { ...selectedTrial, provenance: {} },
        position: { width: 36 },
        source: 'standard+catalog'
    }), false);
});

test('createRepairCleanupFlags should aggregate cleanup gates', () => {
    const flags = createRepairCleanupFlags({
        selectedTrial: {
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            provenance: {}
        },
        position: { width: 48 },
        source: 'standard'
    });

    assert.deepEqual(flags, {
        usePreviewAnchorFastCleanup: false,
        useKnown48EdgeCleanup: true,
        useV2SmallEdgeCleanup: false
    });
});

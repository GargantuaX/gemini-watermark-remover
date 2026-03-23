import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isConfirmedWatermarkDecision,
    resolveDisplayWatermarkInfo
} from '../../src/core/watermarkDisplay.js';

test('resolveDisplayWatermarkInfo should prefer processed meta over estimated info', () => {
    const item = {
        originalImg: { width: 768, height: 1376 },
        processedMeta: {
            size: 96,
            position: { x: 608, y: 1216, width: 96, height: 96 },
            config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
            source: 'standard'
        }
    };

    const estimated = {
        size: 48,
        position: { x: 688, y: 1296, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 }
    };

    const display = resolveDisplayWatermarkInfo(item, estimated);

    assert.equal(display.size, 96);
    assert.deepEqual(display.position, { x: 608, y: 1216, width: 96, height: 96 });
    assert.equal(display.source, 'standard');
});

test('resolveDisplayWatermarkInfo should fallback to estimated info when processed meta is missing', () => {
    const item = {
        originalImg: { width: 1024, height: 1024 },
        processedMeta: null
    };

    const estimated = {
        size: 48,
        position: { x: 944, y: 944, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 }
    };

    const display = resolveDisplayWatermarkInfo(item, estimated);

    assert.equal(display.size, 48);
    assert.deepEqual(display.position, estimated.position);
    assert.equal(display.source, 'estimated');
});

test('isConfirmedWatermarkDecision should prefer decisionTier over legacy applied flag', () => {
    assert.equal(
        isConfirmedWatermarkDecision({
            processedMeta: {
                applied: true,
                decisionTier: 'insufficient'
            }
        }),
        false
    );

    assert.equal(
        isConfirmedWatermarkDecision({
            processedMeta: {
                applied: true,
                decisionTier: 'validated-match'
            }
        }),
        true
    );
});

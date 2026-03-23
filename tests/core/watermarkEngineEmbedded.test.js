import test from 'node:test';
import assert from 'node:assert/strict';

test('WatermarkEngine should be importable in Node and expose embedded alpha maps', async () => {
    const mod = await import('../../src/core/watermarkEngine.js');
    const engine = new mod.WatermarkEngine();

    const alpha48 = await engine.getAlphaMap(48);
    const alpha96 = await engine.getAlphaMap(96);
    const alpha72 = await engine.getAlphaMap(72);

    assert.equal(alpha48.length, 48 * 48);
    assert.equal(alpha96.length, 96 * 96);
    assert.equal(alpha72.length, 72 * 72);
    assert.ok(alpha48.some((value) => value > 0), 'expected embedded alpha48 to contain non-zero values');
    assert.ok(alpha96.some((value) => value > 0), 'expected embedded alpha96 to contain non-zero values');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGeminiVideoWatermark, removeGeminiVideoWatermark } from '../../src/video/videoExport.js';

test('pre-cancelled video jobs reject before opening any input or emitting progress', async () => {
    const controller = new AbortController();
    controller.abort();
    for (const process of [detectGeminiVideoWatermark, removeGeminiVideoWatermark]) {
        let progress = 0;
        await assert.rejects(process(null, {
            signal: controller.signal,
            onProgress: () => { progress++; }
        }), { name: 'AbortError' });
        assert.equal(progress, 0);
    }
});

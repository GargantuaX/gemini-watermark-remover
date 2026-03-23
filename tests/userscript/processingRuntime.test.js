import test from 'node:test';
import assert from 'node:assert/strict';

import { createUserscriptProcessingRuntime } from '../../src/userscript/processingRuntime.js';

test('createUserscriptProcessingRuntime should allow detached removeWatermarkFromBlob calls', async () => {
  const runtime = createUserscriptProcessingRuntime({
    workerCode: '',
    env: {},
    logger: { warn() {}, log() {} }
  });

  let receivedOptions = null;
  runtime.processWatermarkBlob = async (_blob, options = {}) => {
    receivedOptions = options;
    return {
      processedBlob: new Blob(['processed'], { type: 'image/png' }),
      processedMeta: { source: 'stub' }
    };
  };

  const detachedRemoveWatermarkFromBlob = runtime.removeWatermarkFromBlob;
  const processedBlob = await detachedRemoveWatermarkFromBlob(
    new Blob(['raw'], { type: 'image/png' }),
    { adaptiveMode: 'never', maxPasses: 2 }
  );

  assert.equal(await processedBlob.text(), 'processed');
  assert.deepEqual(receivedOptions, {
    adaptiveMode: 'never',
    maxPasses: 2
  });
});

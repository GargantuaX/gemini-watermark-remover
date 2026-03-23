import test from 'node:test';
import assert from 'node:assert/strict';

import { runTampermonkeySmoke } from '../../scripts/tampermonkey-smoke.js';

test('tampermonkey DOM-sandbox bridge smoke should verify worker escape from page CSP', async (t) => {
  if (process.env.GWR_TAMPERMONKEY_SMOKE !== '1') {
    t.skip('Set GWR_TAMPERMONKEY_SMOKE=1 after manually preparing the fixed Tampermonkey profile');
    return;
  }

  const report = await runTampermonkeySmoke({
    closeOnSuccess: true
  });

  assert.equal(report.pageDirectBlobWorker?.ok, false);
  assert.equal(report.userscriptDetected, true);
  assert.equal(report.userscriptSandboxWorker?.ok, true);
  assert.equal(report.bridgeRoundtrip?.ok, true);
});

// ==UserScript==
// @name         GWR Tampermonkey DOM Worker Probe
// @namespace    https://github.com/GargantuaX/gemini-watermark-remover
// @version      0.1.0
// @description  Probe DOM-sandbox Worker availability and page bridge on local test pages
// @match        http://127.0.0.1/*
// @match        http://localhost/*
// @sandbox      DOM
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  const READY_MESSAGE = 'gwr:tm-probe-ready';
  const HANDSHAKE_MESSAGE = 'gwr:tm-probe-handshake';
  const BRIDGE_REQUEST = 'gwr:tm-bridge-request';
  const BRIDGE_RESPONSE = 'gwr:tm-bridge-response';

  async function runWorkerRoundtrip(payload) {
    let workerUrl = '';
    let worker = null;
    try {
      workerUrl = URL.createObjectURL(new Blob([
        [
          'self.onmessage = (event) => {',
          '  self.postMessage({',
          '    ok: true,',
          '    echoed: event.data,',
          '    from: "tampermonkey-dom-worker"',
          '  });',
          '};'
        ].join('\n')
      ], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
      const result = await new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => reject(new Error('Tampermonkey sandbox worker timed out')), 2500);
        worker.addEventListener('message', (event) => {
          window.clearTimeout(timeoutId);
          resolve(event.data);
        }, { once: true });
        worker.addEventListener('error', (event) => {
          window.clearTimeout(timeoutId);
          reject(event.error || new Error(event.message || 'Tampermonkey sandbox worker crashed'));
        }, { once: true });
        worker.postMessage(payload);
      });
      return {
        ok: true,
        summary: 'Worker OK',
        result
      };
    } catch (error) {
      return {
        ok: false,
        summary: error?.name || 'Worker failed',
        message: error?.message || String(error)
      };
    } finally {
      if (worker) worker.terminate();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
    }
  }

  const workerProbePromise = runWorkerRoundtrip({
    text: 'ping-from-userscript',
    sentAt: Date.now()
  });

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const payload = event.data || {};

    if (payload.type === HANDSHAKE_MESSAGE) {
      window.postMessage({
        type: READY_MESSAGE,
        payload: await workerProbePromise
      }, '*');
      return;
    }

    if (payload.type === BRIDGE_REQUEST) {
      const response = await runWorkerRoundtrip(payload.payload || null);
      window.postMessage({
        type: BRIDGE_RESPONSE,
        ok: response.ok,
        summary: response.summary,
        error: response.message || '',
        result: response.result || null
      }, '*');
    }
  });
})();

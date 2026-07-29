import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractChromeUpdateVersion,
  extractSiteRuntimeVersion,
  renderMarkdown
} from '../../scripts/check-release-distribution.js';

test('extractChromeUpdateVersion reads the extension update version', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><gupdate protocol="2.0"><app appid="cjlmnfcfnofnglkphbcdclbpimdjkmdf" status="ok"><updatecheck status="ok" version="1.0.26"/></app></gupdate>';

  assert.equal(extractChromeUpdateVersion(xml), '1.0.26');
});

test('extractSiteRuntimeVersion accepts only a self-consistent bundled SDK manifest', () => {
  assert.equal(extractSiteRuntimeVersion({
    schemaVersion: 1,
    packageName: '@pilio/gemini-watermark-remover',
    declaredVersion: '1.0.33',
    bundledVersion: '1.0.33'
  }), '1.0.33');

  assert.equal(extractSiteRuntimeVersion({
    schemaVersion: 1,
    packageName: '@pilio/gemini-watermark-remover',
    declaredVersion: '1.0.33',
    bundledVersion: '1.0.31'
  }), null);
});

test('release distribution markdown includes waiting checks', () => {
  const markdown = renderMarkdown({
    generatedAt: '2026-06-28T00:00:00.000Z',
    expectedVersion: '1.0.28',
    overall: {
      status: 'waiting'
    },
    checks: [
      {
        id: 'chrome-web-store-update',
        status: 'waiting',
        expected: '1.0.28',
        actual: '1.0.26',
        blocker: 'chrome-web-store-update-not-propagated'
      }
    ],
    evidence: {
      githubRelease: { url: 'https://example.test/github' },
      npm: { url: 'https://example.test/npm' },
      siteUserscript: { url: 'https://example.test/userscript' },
      siteRuntime: { url: 'https://example.test/gwr-runtime-version.json' },
      siteLatestExtension: { url: 'https://example.test/latest-extension' },
      siteExtensionZip: { url: 'https://example.test/zip' },
      chromeUpdate: { url: 'https://example.test/chrome-update' }
    }
  });

  assert.match(markdown, /chrome-web-store-update/);
  assert.match(markdown, /1\.0\.26/);
  assert.match(markdown, /chrome-web-store-update-not-propagated/);
});

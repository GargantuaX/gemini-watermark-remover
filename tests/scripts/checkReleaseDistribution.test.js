import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractChromeUpdateVersion,
  renderMarkdown
} from '../../scripts/check-release-distribution.js';

test('extractChromeUpdateVersion reads the extension update version', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><gupdate protocol="2.0"><app appid="cjlmnfcfnofnglkphbcdclbpimdjkmdf" status="ok"><updatecheck status="ok" version="1.0.26"/></app></gupdate>';

  assert.equal(extractChromeUpdateVersion(xml), '1.0.26');
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
      siteLatestExtension: { url: 'https://example.test/latest-extension' },
      siteExtensionZip: { url: 'https://example.test/zip' },
      chromeUpdate: { url: 'https://example.test/chrome-update' }
    }
  });

  assert.match(markdown, /chrome-web-store-update/);
  assert.match(markdown, /1\.0\.26/);
  assert.match(markdown, /chrome-web-store-update-not-propagated/);
});

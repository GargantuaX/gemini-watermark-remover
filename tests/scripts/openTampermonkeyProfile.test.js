import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  DEFAULT_CDP_PORT,
  buildTampermonkeyProfileLaunchArgs,
  parseOpenTampermonkeyProfileCliArgs
} from '../../scripts/open-tampermonkey-profile.js';

test('parseOpenTampermonkeyProfileCliArgs should default to fixed profile and local proxy', () => {
  const parsed = parseOpenTampermonkeyProfileCliArgs([]);

  assert.equal(parsed.profileDir.includes('.chrome-debug'), true);
  assert.equal(parsed.profileDir.endsWith('tampermonkey-profile'), true);
  assert.equal(parsed.proxyServer, 'http://127.0.0.1:7890');
  assert.equal(parsed.targetUrl, 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo');
  assert.equal(parsed.cdpPort, DEFAULT_CDP_PORT);
});

test('parseOpenTampermonkeyProfileCliArgs should accept explicit url, cdp port and disable proxy', () => {
  const parsed = parseOpenTampermonkeyProfileCliArgs([
    '--proxy',
    'off',
    '--cdp-port',
    '9333',
    '--url',
    'http://127.0.0.1:4174/tampermonkey-worker-probe.html'
  ]);

  assert.equal(parsed.proxyServer, '');
  assert.equal(parsed.cdpPort, 9333);
  assert.equal(parsed.targetUrl, 'http://127.0.0.1:4174/tampermonkey-worker-probe.html');
});

test('buildTampermonkeyProfileLaunchArgs should include fixed profile, proxy bypass and cdp port', () => {
  const args = buildTampermonkeyProfileLaunchArgs({
    profileDir: 'D:\\tmp\\tm-profile',
    proxyServer: 'http://127.0.0.1:7890',
    cdpPort: 9334,
    targetUrl: 'https://example.com'
  });

  assert.deepEqual(args.slice(0, 3), [
    '--user-data-dir=D:\\tmp\\tm-profile',
    '--no-first-run',
    '--no-default-browser-check'
  ]);
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:7890'));
  assert.ok(args.includes('--proxy-bypass-list=localhost;127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=9334'));
  assert.equal(args.at(-1), 'https://example.com');
});

test('package.json should expose a manual fixed-profile launcher', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.scripts['probe:tm:profile'], 'node scripts/open-tampermonkey-profile.js');
});

test('project root should expose a fixed-profile launcher cmd script', () => {
  const scriptPath = new URL('../../open-fixed-chrome-profile.cmd', import.meta.url);
  assert.equal(existsSync(scriptPath), true);

  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /scripts\\open-tampermonkey-profile\.js/);
  assert.match(source, /tampermonkey-worker-probe\.html/);
  assert.match(source, /--cdp-port/);
});

test('project root should expose a fixed-profile launcher powershell script', () => {
  const scriptPath = new URL('../../open-fixed-chrome-profile.ps1', import.meta.url);
  assert.equal(existsSync(scriptPath), true);

  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /scripts\/open-tampermonkey-profile\.js|scripts\\open-tampermonkey-profile\.js/);
  assert.match(source, /tampermonkey-worker-probe\.html/);
  assert.match(source, /--cdp-port/);
});

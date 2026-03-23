import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_TAMPERMONKEY_PROFILE_DIR,
  buildTampermonkeySmokeChromeArgs,
  shouldReuseProbePage,
  parseTampermonkeySmokeCliArgs
} from '../../scripts/tampermonkey-smoke.js';

test('parseTampermonkeySmokeCliArgs should default to fixed profile and local proxy', () => {
  const parsed = parseTampermonkeySmokeCliArgs([]);

  assert.equal(parsed.mode, 'run');
  assert.equal(parsed.profileDir.includes('.chrome-debug'), true);
  assert.equal(parsed.profileDir.endsWith('tampermonkey-profile'), true);
  assert.equal(parsed.profileDir, DEFAULT_TAMPERMONKEY_PROFILE_DIR);
  assert.equal(parsed.proxyServer, 'http://127.0.0.1:7890');
});

test('parseTampermonkeySmokeCliArgs should accept setup mode and explicit overrides', () => {
  const parsed = parseTampermonkeySmokeCliArgs([
    'setup',
    '--profile',
    '.chrome-debug/manual-tm-profile',
    '--port',
    '4319',
    '--proxy',
    'off'
  ]);

  assert.equal(parsed.mode, 'setup');
  assert.match(parsed.profileDir, /manual-tm-profile$/);
  assert.equal(parsed.port, 4319);
  assert.equal(parsed.proxyServer, '');
});

test('buildTampermonkeySmokeChromeArgs should use remote debugging instead of playwright automation flags', () => {
  const args = buildTampermonkeySmokeChromeArgs({
    profileDir: 'D:\\tmp\\tm-profile',
    proxyServer: 'http://127.0.0.1:7890',
    port: 9334,
    targetUrl: 'http://127.0.0.1:4174/tampermonkey-worker-probe.html'
  });

  assert.ok(args.includes('--remote-debugging-port=9334'));
  assert.ok(args.includes('--user-data-dir=D:\\tmp\\tm-profile'));
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:7890'));
  assert.ok(args.includes('--proxy-bypass-list=localhost;127.0.0.1'));
  assert.ok(args.includes('http://127.0.0.1:4174/tampermonkey-worker-probe.html'));
  assert.equal(args.some((arg) => arg.includes('--disable-extensions')), false);
  assert.equal(args.some((arg) => arg.includes('--enable-automation')), false);
});

test('shouldReuseProbePage should reuse an already opened probe page on the same host', () => {
  assert.equal(
    shouldReuseProbePage(
      'http://127.0.0.1:4175/tampermonkey-worker-probe.html?boot=1',
      'http://127.0.0.1:4175/tampermonkey-worker-probe.html?ts=123'
    ),
    true
  );
  assert.equal(
    shouldReuseProbePage(
      'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html',
      'http://127.0.0.1:4175/tampermonkey-worker-probe.html?ts=123'
    ),
    false
  );
});

test('package.json should expose tampermonkey probe commands', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.scripts['probe:tm'], 'node scripts/tampermonkey-smoke.js run');
  assert.equal(pkg.scripts['probe:tm:setup'], 'node scripts/tampermonkey-smoke.js setup');
});

test('tampermonkey probe userscript should use DOM sandbox and local host matches', () => {
  const source = readFileSync(new URL('../../public/tampermonkey-worker-probe.user.js', import.meta.url), 'utf8');

  assert.match(source, /\/\/ @sandbox\s+DOM/);
  assert.match(source, /\/\/ @match\s+http:\/\/127\.0\.0\.1\/\*/);
  assert.match(source, /\/\/ @match\s+http:\/\/localhost\/\*/);
  assert.doesNotMatch(source, /unsafeWindow/);
  assert.match(source, /gwr:tm-probe-ready/);
  assert.match(source, /gwr:tm-bridge-response/);
});

test('tampermonkey probe page should enforce a worker-src policy and expose install link', () => {
  const source = readFileSync(new URL('../../public/tampermonkey-worker-probe.html', import.meta.url), 'utf8');

  assert.match(source, /worker-src 'self'/);
  assert.match(source, /tampermonkey-worker-probe\.user\.js/);
  assert.match(source, /gwr:tm-bridge-request/);
  assert.match(source, /__gwrTampermonkeyProbeState/);
});

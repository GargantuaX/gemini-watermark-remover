import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const LOCAL_PATH_PATTERNS = [
  /[A-Za-z]:[\\/]+(?:Users|Project)[\\/]+/i,
  /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//
];

// Frozen release evidence: preserve the published bytes rather than rewriting history.
// Hash pins prevent these exceptions from accepting new paths or other changes.
const HISTORICAL_EVIDENCE = new Map([
  ['release/evidence/v1.0.30-image-quality.json', '0d26a07a117138427ce3a84e26485cd01771162dc21cb2ddec4466ee23367b9b'],
  ['release/evidence/v1.0.31-image-quality.json', '9239225c047a3de2ecc6fd87a9e36c74c54fc45e23b6f16c79b6e65fb68dfa55']
]);

function hasLocalPath(text) {
  return LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

test('local path detection covers raw and escaped Windows paths and Unix home paths', () => {
  const windows = ['Q:', 'Users', 'private-user', 'sample.png'].join('\\');
  const project = ['R:', 'Project', 'private-project', 'sample.png'].join('\\');
  for (const value of [windows, project, windows.replaceAll('\\', '/'),
    ['', 'Users', 'private-user', 'sample.png'].join('/'),
    ['', 'home', 'private-user', 'sample.png'].join('/')]) {
    assert.equal(hasLocalPath(value), true);
    assert.equal(hasLocalPath(JSON.stringify({ path: value })), true);
    assert.equal(hasLocalPath(JSON.stringify(JSON.stringify(value))), true);
  }
  for (const value of ['src/assets/samples/a.png', '.artifacts/report.json',
    '/path/to/sample-files', 'Z:\\fixtures\\project\\sample.png', 'https://example.com']) {
    assert.equal(hasLocalPath(value), false);
  }
});

const SKIPPED_EXTENSIONS = new Set([
  '.gif',
  '.ico',
  '.jpg',
  '.jpeg',
  '.mp4',
  '.onnx',
  '.png',
  '.wasm',
  '.webp',
  '.zip'
]);

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'buffer'
  });
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function extensionOf(filePath) {
  const match = filePath.match(/(\.[^./\\]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function isLikelyText(buffer) {
  return buffer.includes(0) === false;
}

test('tracked text files should not leak local absolute paths', () => {
  const leaks = [];
  for (const filePath of trackedFiles()) {
    if (SKIPPED_EXTENSIONS.has(extensionOf(filePath))) continue;

    const buffer = readFileSync(new URL(`../../${filePath}`, import.meta.url));
    if (!isLikelyText(buffer)) continue;

    const text = buffer.toString('utf8');
    if (HISTORICAL_EVIDENCE.has(filePath)) {
      const hash = createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
      assert.equal(hash, HISTORICAL_EVIDENCE.get(filePath), `Historical evidence changed: ${filePath}`);
      continue;
    }
    for (const pattern of LOCAL_PATH_PATTERNS) {
      if (pattern.test(text)) {
        leaks.push(`${filePath}: ${pattern}`);
      }
    }
  }

  assert.deepEqual(leaks, []);
});

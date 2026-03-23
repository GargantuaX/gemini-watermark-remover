import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('removed plugin source directory should not remain as an empty placeholder', () => {
  assert.equal(
    existsSync(new URL('../../src/extension', import.meta.url)),
    false,
    'expected src/extension to be removed after the plugin cleanup'
  );
});

test('public directory should not keep removed plugin fixture pages', () => {
  const removedFixturePages = [
    'extension-blob-source-fixture.html',
    'extension-canvas-fallback-fixture.html',
    'extension-rendered-fallback-fixture.html',
    'extension-src-rerender-fixture.html'
  ];

  for (const filename of removedFixturePages) {
    assert.equal(
      existsSync(new URL(`../../public/${filename}`, import.meta.url)),
      false,
      `expected public/${filename} to be removed`
    );
  }
});

test('obsolete plugin design notes should not stay in active docs', () => {
  const removedPlanDocs = [
    '2026-03-20-extension-offscreen-worker-bridge.md',
    '2026-03-20-extension-worker-mvp.md'
  ];

  for (const filename of removedPlanDocs) {
    assert.equal(
      existsSync(new URL(`../../docs/superpowers/plans/${filename}`, import.meta.url)),
      false,
      `expected docs/superpowers/plans/${filename} to be removed`
    );
  }
});

test('orphaned superpowers plan directories should not remain after removing obsolete notes', () => {
  assert.equal(
    existsSync(new URL('../../docs/superpowers/plans', import.meta.url)),
    false,
    'expected docs/superpowers/plans to be removed once obsolete notes are deleted'
  );
  assert.equal(
    existsSync(new URL('../../docs/superpowers', import.meta.url)),
    false,
    'expected docs/superpowers to be removed when it becomes empty'
  );
});

test('historical implementation plan docs should not remain in docs/plans', () => {
  const removedPlanDocs = [
    '2026-03-19-5png-residual-repair-plan.md',
    '2026-03-19-algorithm-improvements.md',
    '2026-03-19-delayed-adaptive-fallback-plan.md'
  ];

  for (const filename of removedPlanDocs) {
    assert.equal(
      existsSync(new URL(`../../docs/plans/${filename}`, import.meta.url)),
      false,
      `expected docs/plans/${filename} to be removed`
    );
  }

  assert.equal(
    existsSync(new URL('../../docs/plans', import.meta.url)),
    false,
    'expected docs/plans to be removed once historical implementation plans are deleted'
  );
});

test('AGENTS guide should not reference removed historical validation docs', () => {
  const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');

  assert.equal(
    existsSync(new URL('../../docs/tests/2026-03-20-tampermonkey-worker-validation.md', import.meta.url)),
    false,
    'expected historical tampermonkey validation timeline doc to be removed'
  );
  assert.doesNotMatch(
    agents,
    /docs\/tests\/2026-03-20-tampermonkey-worker-validation\.md/
  );
});

test('standalone sample asset notes should not remain when they are not part of the active docs surface', () => {
  assert.equal(
    existsSync(new URL('../../docs/tests/sample-assets.md', import.meta.url)),
    false,
    'expected docs/tests/sample-assets.md to be removed'
  );
  assert.equal(
    existsSync(new URL('../../docs/tests', import.meta.url)),
    false,
    'expected docs/tests to be removed once stale test notes are deleted'
  );
});

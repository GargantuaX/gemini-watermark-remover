import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('watermark worker should respond to ping messages before image processing', () => {
  const source = readFileSync(new URL('../../src/workers/watermarkWorker.js', import.meta.url), 'utf8');

  assert.match(source, /payload\.type === 'ping'/);
  assert.match(source, /ready:\s*true/);
  assert.match(source, /payload\.type !== 'process-image'/);
});

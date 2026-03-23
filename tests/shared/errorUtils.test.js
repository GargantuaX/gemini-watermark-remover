import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeErrorMessage } from '../../src/shared/errorUtils.js';

test('normalizeErrorMessage should prefer message from plain error-like objects', () => {
  assert.equal(
    normalizeErrorMessage({ message: 'Failed to decode image blob' }),
    'Failed to decode image blob'
  );

  assert.equal(
    normalizeErrorMessage({ error: 'Unexpected content type: text/html' }),
    'Unexpected content type: text/html'
  );
});

test('normalizeErrorMessage should serialize useful fallback details for non-Error objects', () => {
  assert.equal(
    normalizeErrorMessage({ status: 403, statusText: 'Forbidden' }),
    '403 Forbidden'
  );
});

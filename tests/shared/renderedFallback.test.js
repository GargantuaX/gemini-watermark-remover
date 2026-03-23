import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasNearbyActionCluster,
  isProcessableGeminiMediaElement,
  shouldUseRenderedImageFallback
} from '../../src/shared/domAdapter.js';

test('hasNearbyActionCluster should detect a nearby image action row', () => {
  const actionRow = {
    tagName: 'DIV',
    querySelectorAll: (selector) => selector === 'button,[role="button"]'
      ? [{}, {}, {}, {}]
      : [],
    parentElement: null
  };
  const wrapper = {
    tagName: 'DIV',
    querySelectorAll: () => [],
    parentElement: actionRow
  };
  const image = {
    tagName: 'IMG',
    parentElement: wrapper
  };

  assert.equal(hasNearbyActionCluster(image), true);
});

test('shouldUseRenderedImageFallback should accept large images with nearby actions', () => {
  const actionRow = {
    tagName: 'DIV',
    querySelectorAll: (selector) => selector === 'button,[role="button"]'
      ? [{}, {}, {}, {}]
      : [],
    parentElement: null
  };
  const wrapper = {
    tagName: 'DIV',
    querySelectorAll: () => [],
    parentElement: actionRow
  };
  const image = {
    tagName: 'IMG',
    parentElement: wrapper,
    naturalWidth: 1024,
    naturalHeight: 1024,
    clientWidth: 480,
    clientHeight: 480
  };

  assert.equal(shouldUseRenderedImageFallback(image), true);
});

test('shouldUseRenderedImageFallback should reject large images without nearby actions', () => {
  const image = {
    tagName: 'IMG',
    parentElement: {
      tagName: 'DIV',
      querySelectorAll: () => [],
      parentElement: null
    },
    naturalWidth: 1024,
    naturalHeight: 1024,
    clientWidth: 480,
    clientHeight: 480
  };

  assert.equal(shouldUseRenderedImageFallback(image), false);
});

test('isProcessableGeminiMediaElement should accept large canvases with nearby actions', () => {
  const actionRow = {
    tagName: 'DIV',
    querySelectorAll: (selector) => selector === 'button,[role="button"]'
      ? [{}, {}, {}, {}]
      : [],
    parentElement: null
  };
  const wrapper = {
    tagName: 'DIV',
    querySelectorAll: () => [],
    parentElement: actionRow
  };
  const canvas = {
    tagName: 'CANVAS',
    parentElement: wrapper,
    width: 1024,
    height: 1024,
    clientWidth: 480,
    clientHeight: 480
  };

  assert.equal(isProcessableGeminiMediaElement(canvas), true);
});

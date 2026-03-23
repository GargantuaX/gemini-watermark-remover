import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getGeminiImageQuerySelector,
  getPreferredGeminiImageContainer,
  resolveCandidateImageUrl,
  isProcessableGeminiImageElement
} from '../../src/shared/domAdapter.js';

test('getGeminiImageQuerySelector should target img descendants for every Gemini container selector', () => {
  assert.equal(
    getGeminiImageQuerySelector(),
    'generated-image img,.generated-image-container img'
  );
});

test('resolveCandidateImageUrl should prefer explicit data-gwr-source-url over rendered src', () => {
  const url = resolveCandidateImageUrl({
    dataset: {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    currentSrc: 'http://127.0.0.1:8080/src/assets/samples/5.png',
    src: 'http://127.0.0.1:8080/src/assets/samples/5.png'
  });

  assert.equal(url, 'https://lh3.googleusercontent.com/rd-gg/example=s1024');
});

test('resolveCandidateImageUrl should ignore processed preview images', () => {
  const url = resolveCandidateImageUrl({
    dataset: {
      gwrPreviewImage: 'true',
      gwrSourceUrl: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    currentSrc: 'blob:https://gemini.google.com/processed',
    src: 'blob:https://gemini.google.com/processed'
  });

  assert.equal(url, '');
});

test('resolveCandidateImageUrl should keep stable source when current image src is replaced with blob url', () => {
  const url = resolveCandidateImageUrl({
    dataset: {
      gwrStableSource: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    currentSrc: 'blob:https://gemini.google.com/processed',
    src: 'blob:https://gemini.google.com/processed'
  });

  assert.equal(url, 'https://lh3.googleusercontent.com/rd-gg/example=s1024');
});

test('resolveCandidateImageUrl should fallback to currentSrc and src when no explicit source exists', () => {
  assert.equal(resolveCandidateImageUrl({
    dataset: {},
    currentSrc: 'https://lh3.googleusercontent.com/rd-gg/example=s512',
    src: 'https://lh3.googleusercontent.com/rd-gg/example=s256'
  }), 'https://lh3.googleusercontent.com/rd-gg/example=s512');

  assert.equal(resolveCandidateImageUrl({
    dataset: {},
    currentSrc: '',
    src: 'https://lh3.googleusercontent.com/rd-gg/example=s256'
  }), 'https://lh3.googleusercontent.com/rd-gg/example=s256');
});

test('isProcessableGeminiImageElement should accept generated-image descendants with Gemini source urls', () => {
  const element = {
    dataset: {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    naturalWidth: 1024,
    naturalHeight: 1024,
    clientWidth: 512,
    clientHeight: 512,
    currentSrc: 'http://127.0.0.1:8080/src/assets/samples/5.png',
    src: 'http://127.0.0.1:8080/src/assets/samples/5.png',
    closest: (selector) => selector === 'generated-image,.generated-image-container' ? {} : null
  };

  assert.equal(isProcessableGeminiImageElement(element), true);
});

test('isProcessableGeminiImageElement should reject processed preview images', () => {
  assert.equal(isProcessableGeminiImageElement({
    dataset: {
      gwrPreviewImage: 'true',
      gwrSourceUrl: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    naturalWidth: 1024,
    naturalHeight: 1024,
    clientWidth: 512,
    clientHeight: 512,
    currentSrc: 'blob:https://gemini.google.com/processed',
    src: 'blob:https://gemini.google.com/processed',
    closest: () => ({})
  }), false);
});

test('isProcessableGeminiImageElement should accept large Gemini images even outside known containers', () => {
  assert.equal(isProcessableGeminiImageElement({
    dataset: {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    naturalWidth: 1024,
    naturalHeight: 768,
    clientWidth: 480,
    clientHeight: 360,
    currentSrc: 'blob:https://gemini.google.com/example',
    src: 'blob:https://gemini.google.com/example',
    closest: () => null
  }), true);
});

test('isProcessableGeminiImageElement should reject non-Gemini urls and tiny images outside Gemini containers', () => {
  assert.equal(isProcessableGeminiImageElement({
    dataset: {},
    naturalWidth: 512,
    naturalHeight: 512,
    clientWidth: 64,
    clientHeight: 64,
    currentSrc: 'https://example.com/image.png',
    src: 'https://example.com/image.png',
    closest: () => ({})
  }), false);

  assert.equal(isProcessableGeminiImageElement({
    dataset: {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    naturalWidth: 96,
    naturalHeight: 96,
    clientWidth: 48,
    clientHeight: 48,
    currentSrc: 'http://127.0.0.1:8080/src/assets/samples/5.png',
    src: 'http://127.0.0.1:8080/src/assets/samples/5.png',
    closest: () => null
  }), false);
});

test('getPreferredGeminiImageContainer should fallback to a nearby block ancestor when known container is missing', () => {
  const outer = { tagName: 'DIV', parentElement: null, closest: () => null };
  const inner = { tagName: 'DIV', parentElement: outer, closest: () => null };
  const img = {
    tagName: 'IMG',
    parentElement: inner,
    closest: () => null
  };

  assert.equal(getPreferredGeminiImageContainer(img), inner);
});

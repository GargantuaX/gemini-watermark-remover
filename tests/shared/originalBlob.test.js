import test from 'node:test';
import assert from 'node:assert/strict';

import { acquireOriginalBlob } from '../../src/shared/originalBlob.js';

test('acquireOriginalBlob should fetch Gemini asset urls through background', async () => {
  const backgroundBlob = new Blob(['background'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/rd-gg/example=s1024',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return backgroundBlob;
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, backgroundBlob);
  assert.deepEqual(calls, [
    ['background', 'https://lh3.googleusercontent.com/rd-gg/example=s1024']
  ]);
});

test('acquireOriginalBlob should fetch Gemini gg-dl asset urls through background', async () => {
  const backgroundBlob = new Blob(['background'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example=s1024-rj',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return backgroundBlob;
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, backgroundBlob);
  assert.deepEqual(calls, [
    ['background', 'https://lh3.googleusercontent.com/gg-dl/example=s1024-rj']
  ]);
});

test('acquireOriginalBlob should fetch tiered Gemini gg download asset urls through background', async () => {
  const backgroundBlob = new Blob(['background'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-premium-dl/example=s1024-rj',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return backgroundBlob;
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, backgroundBlob);
  assert.deepEqual(calls, [
    ['background', 'https://lh3.googleusercontent.com/gg-premium-dl/example=s1024-rj']
  ]);
});

test('acquireOriginalBlob should ignore visible capture for Gemini gg preview urls', async () => {
  const renderedBlob = new Blob(['rendered-capture'], { type: 'image/png' });
  const visibleBlob = new Blob(['visible-capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return renderedBlob;
    },
    captureVisibleElementBlob: async (image) => {
      calls.push(['visible-capture', image]);
      return visibleBlob;
    }
  });

  assert.equal(blob, renderedBlob);
  assert.deepEqual(calls, [
    ['capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should capture Gemini gg tiered preview urls from rendered image', async () => {
  const renderedBlob = new Blob(['rendered-capture'], { type: 'image/png' });
  const visibleBlob = new Blob(['visible-capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-premium/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return renderedBlob;
    },
    captureVisibleElementBlob: async (image) => {
      calls.push(['visible-capture', image]);
      return visibleBlob;
    }
  });

  assert.equal(blob, renderedBlob);
  assert.deepEqual(calls, [
    ['capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should capture Gemini gg ultra preview urls from rendered image', async () => {
  const renderedBlob = new Blob(['rendered-capture'], { type: 'image/png' });
  const visibleBlob = new Blob(['visible-capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-ultra/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return renderedBlob;
    },
    captureVisibleElementBlob: async (image) => {
      calls.push(['visible-capture', image]);
      return visibleBlob;
    }
  });

  assert.equal(blob, renderedBlob);
  assert.deepEqual(calls, [
    ['capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should fall back to rendered capture when Gemini asset validation fails', async () => {
  const renderedBlob = new Blob(['rendered-capture'], { type: 'image/png' });
  const invalidBlob = new Blob(['invalid'], { type: 'text/plain' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return invalidBlob;
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    validateBlob: async (blob) => {
      calls.push(['validate', blob]);
      throw new Error('blob decode failed');
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return renderedBlob;
    },
    captureVisibleElementBlob: async () => {
      throw new Error('visible capture should not be used');
    }
  });

  assert.equal(blob, renderedBlob);
  assert.deepEqual(calls, [
    ['background', 'https://lh3.googleusercontent.com/gg-dl/example=s1024-rj'],
    ['validate', invalidBlob],
    ['capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should fetch blob urls directly in the page context', async () => {
  const directBlob = new Blob(['direct'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'blob:https://gemini.google.com/1234',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return directBlob;
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, directBlob);
  assert.deepEqual(calls, [
    ['direct', 'blob:https://gemini.google.com/1234']
  ]);
});

test('acquireOriginalBlob should fetch data urls directly in the page context', async () => {
  const directBlob = new Blob(['direct'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'data:image/png;base64,AAAA',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return directBlob;
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, directBlob);
  assert.deepEqual(calls, [
    ['direct', 'data:image/png;base64,AAAA']
  ]);
});

test('acquireOriginalBlob should fall back to rendered capture for non-Gemini non-inline sources', async () => {
  const capturedBlob = new Blob(['capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://example.com/rendered.png',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return capturedBlob;
    }
  });

  assert.equal(blob, capturedBlob);
  assert.deepEqual(calls, [
    ['capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should capture Gemini gg preview urls with rendered capture when visible capture is unavailable', async () => {
  const capturedBlob = new Blob(['capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return capturedBlob;
    }
  });

  assert.equal(blob, capturedBlob);
  assert.deepEqual(calls, [
    ['capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should surface rendered capture errors for Gemini gg preview urls', async () => {
  const fixtureImage = { id: 'fixture-image' };
  const visibleBlob = new Blob(['visible-capture'], { type: 'image/png' });
  const calls = [];

  await assert.rejects(
    () => acquireOriginalBlob({
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      image: fixtureImage,
      fetchBlobFromBackground: async (url) => {
        calls.push(['background', url]);
        return new Blob(['background'], { type: 'image/png' });
      },
      fetchBlobDirect: async () => {
        throw new Error('direct fetch should not be used');
      },
      captureRenderedImageBlob: async (image) => {
        calls.push(['capture', image]);
        const error = new Error("Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported.");
        error.name = 'SecurityError';
        throw error;
      },
      captureVisibleElementBlob: async (image) => {
        calls.push(['visible-capture', image]);
        return visibleBlob;
      }
    }),
    {
      name: 'SecurityError',
      message: /tainted canvases may not be exported/i
    }
  );

  assert.deepEqual(calls, [
    ['capture', fixtureImage]
  ]);
});

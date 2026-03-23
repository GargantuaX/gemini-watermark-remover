import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPageImageSourceRequest,
  collectCandidateImages,
  createRootBatchProcessor,
  buildPreviewReplacementCandidates,
  createPageImageReplacementController,
  emitPageImageProcessingStart,
  handlePageImageMutations,
  handlePageImageProcessingFailure,
  isSelfWrittenProcessedImageSource,
  preparePageImageProcessing,
  processPageImageSource,
  processOriginalPageImageSource,
  processPreviewPageImageSource,
  applyPageImageProcessingResult,
  fetchBlobFromBackground,
  hideProcessingOverlay,
  intersectCaptureRectWithViewport,
  resolvePreviewReplacementResult,
  resolveVisibleCaptureRect,
  shouldSkipPreviewProcessingFailure,
  shouldScheduleAttributeMutation,
  shouldScheduleMutationRoot,
  showProcessingOverlay,
  waitForRenderableImageSize
} from '../../src/shared/pageImageReplacement.js';

function createMockElement(tagName = 'div') {
  return {
    tagName: String(tagName).toUpperCase(),
    dataset: {},
    style: {},
    textContent: '',
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
        child.parentNode = null;
      }
      return child;
    }
  };
}

function createSilentLogger() {
  return {
    info() {},
    warn() {}
  };
}

async function withPageImageTestEnv(run) {
  const originalDocument = globalThis.document;
  const originalHTMLImageElement = globalThis.HTMLImageElement;
  const originalURL = globalThis.URL;
  const originalCreateObjectURL = globalThis.URL?.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL?.revokeObjectURL;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  class MockHTMLImageElement {}

  globalThis.document = {
    createElement(tagName) {
      return createMockElement(tagName);
    }
  };
  globalThis.HTMLImageElement = MockHTMLImageElement;
  globalThis.URL = originalURL;
  globalThis.URL.createObjectURL = (blob) => `blob:mock:${blob.size}`;
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };
  globalThis.clearTimeout = () => {};

  try {
    await run({ MockHTMLImageElement });
  } finally {
    globalThis.document = originalDocument;
    globalThis.HTMLImageElement = originalHTMLImageElement;
    globalThis.URL = originalURL;
    if (globalThis.URL) {
      globalThis.URL.createObjectURL = originalCreateObjectURL;
      globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    }
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

test('resolveVisibleCaptureRect should prefer Gemini container rect when image rect is too small', () => {
  const container = {
    getBoundingClientRect() {
      return {
        left: 24,
        top: 36,
        width: 512,
        height: 512
      };
    }
  };

  const image = {
    parentElement: container,
    closest(selector) {
      return selector === 'generated-image,.generated-image-container'
        ? container
        : null;
    },
    getBoundingClientRect() {
      return {
        left: 28,
        top: 40,
        width: 8,
        height: 8
      };
    }
  };

  assert.deepEqual(resolveVisibleCaptureRect(image), {
    left: 24,
    top: 36,
    width: 512,
    height: 512
  });
});

test('resolveVisibleCaptureRect should keep image rect when it is already meaningful', () => {
  const container = {
    getBoundingClientRect() {
      return {
        left: 20,
        top: 30,
        width: 540,
        height: 540
      };
    }
  };

  const image = {
    parentElement: container,
    closest(selector) {
      return selector === 'generated-image,.generated-image-container'
        ? container
        : null;
    },
    getBoundingClientRect() {
      return {
        left: 42,
        top: 54,
        width: 480,
        height: 480
      };
    }
  };

  assert.deepEqual(resolveVisibleCaptureRect(image), {
    left: 42,
    top: 54,
    width: 480,
    height: 480
  });
});

test('resolveVisibleCaptureRect should crop to rendered image content box for object-fit contain previews', () => {
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({
    objectFit: 'contain',
    objectPosition: '50% 50%'
  });

  try {
    const image = {
      naturalWidth: 1200,
      naturalHeight: 600,
      parentElement: null,
      closest: () => null,
      getBoundingClientRect() {
        return {
          left: 20,
          top: 40,
          width: 600,
          height: 600
        };
      }
    };

    assert.deepEqual(resolveVisibleCaptureRect(image), {
      left: 20,
      top: 190,
      width: 600,
      height: 300
    });
  } finally {
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

test('intersectCaptureRectWithViewport should clip target rect to visible viewport', () => {
  assert.deepEqual(
    intersectCaptureRectWithViewport(
      {
        left: 20,
        top: 580,
        width: 500,
        height: 220
      },
      {
        left: 0,
        top: 0,
        width: 800,
        height: 640
      }
    ),
    {
      left: 20,
      top: 580,
      width: 500,
      height: 60
    }
  );
});

test('resolvePreviewReplacementResult should skip insufficient preview candidates and choose a confirmed one', async () => {
  const pageBlob = new Blob(['page'], { type: 'image/png' });
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });

  const result = await resolvePreviewReplacementResult({
    candidates: [
      { strategy: 'page-fetch' },
      { strategy: 'rendered-capture' }
    ],
    processCandidate: async (candidate) => {
      if (candidate.strategy === 'page-fetch') {
        return {
          processedBlob: pageBlob,
          processedMeta: {
            applied: false
          }
        };
      }

      return {
        processedBlob: renderedBlob,
        processedMeta: {
          applied: true,
          processorPath: 'worker',
          size: 48,
          position: {
            x: 900,
            y: 900,
            width: 48,
            height: 48
          },
          source: 'validated-standard',
          detection: {
            originalSpatialScore: 0.24,
            processedSpatialScore: 0.08,
            suppressionGain: 0.35
          }
        }
      };
    }
  });

  assert.equal(result.strategy, 'rendered-capture');
  assert.equal(result.processedBlob, renderedBlob);
  assert.equal(result.diagnostics[0]?.processorPath, '');
  assert.equal(result.diagnostics[1]?.processorPath, 'worker');
  assert.match(result.diagnosticsSummary, /processor=worker/);
});

test('resolvePreviewReplacementResult should allow rendered capture as a safe fallback when visible capture is insufficient', async () => {
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });

  const result = await resolvePreviewReplacementResult({
    candidates: [
      { strategy: 'page-fetch' },
      { strategy: 'rendered-capture' }
    ],
    processCandidate: async (candidate) => {
      if (candidate.strategy === 'page-fetch') {
        return {
          processedBlob: new Blob(['page'], { type: 'image/png' }),
          processedMeta: {
            applied: false
          }
        };
      }

      return {
        processedBlob: renderedBlob,
        processedMeta: {
          applied: false
        }
      };
    }
  });

  assert.equal(result.strategy, 'rendered-capture');
  assert.equal(result.processedBlob, renderedBlob);
});

test('resolvePreviewReplacementResult should throw when every preview candidate is insufficient', async () => {
  await assert.rejects(
    () => resolvePreviewReplacementResult({
      candidates: [
        { strategy: 'page-fetch' }
      ],
      processCandidate: async () => ({
        processedBlob: new Blob(['noop'], { type: 'image/png' }),
        processedMeta: {
          applied: false
        }
      })
    }),
    /No confirmed Gemini preview candidate succeeded/
  );
});

test('resolvePreviewReplacementResult should not accept visible capture only because the blob is large', async () => {
  const largePageBlob = new Blob([new Uint8Array(160 * 1024)], { type: 'image/png' });

  await assert.rejects(
    () => resolvePreviewReplacementResult({
      candidates: [
        { strategy: 'page-fetch' }
      ],
      processCandidate: async () => ({
        processedBlob: largePageBlob,
        processedMeta: {
          applied: false
        },
        sourceBlobType: 'image/png',
        sourceBlobSize: largePageBlob.size
      })
    }),
    /No confirmed Gemini preview candidate succeeded/
  );
});

test('resolvePreviewReplacementResult should surface safe fallback errors instead of masking them as insufficient', async () => {
  await assert.rejects(
    async () => {
      await resolvePreviewReplacementResult({
        candidates: [
          { strategy: 'page-fetch' },
          { strategy: 'rendered-capture' }
        ],
        processCandidate: async (candidate) => {
          if (candidate.strategy === 'page-fetch') {
            return {
              processedBlob: new Blob(['page'], { type: 'image/png' }),
              processedMeta: {
                applied: false
              }
            };
          }

          throw new Error('Rendered capture tainted');
        }
      });
    },
    /Rendered capture tainted/
  );
});

test('resolvePreviewReplacementResult should return rendered fallback when page-fetch fails but rendered capture still produces a blob', async () => {
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });

  const result = await resolvePreviewReplacementResult({
    candidates: [
      { strategy: 'page-fetch' },
      { strategy: 'rendered-capture' }
    ],
    processCandidate: async (candidate) => {
      if (candidate.strategy === 'page-fetch') {
        throw new Error('Failed to fetch');
      }

      return {
        processedBlob: renderedBlob,
        processedMeta: {
          applied: false
        }
      };
    }
  });

  assert.equal(result.strategy, 'rendered-capture');
  assert.equal(result.processedBlob, renderedBlob);
  assert.match(result.diagnosticsSummary, /page-fetch,error/);
  assert.match(result.diagnosticsSummary, /rendered-capture,insufficient/);
});

test('resolvePreviewReplacementResult should include source blob metadata for candidate errors', async () => {
  await assert.rejects(
    async () => {
      await resolvePreviewReplacementResult({
        candidates: [
          { strategy: 'page-fetch' }
        ],
        processCandidate: async () => {
          const error = new Error('Failed to decode Gemini image blob');
          error.sourceBlobType = 'image/heic';
          error.sourceBlobSize = 245760;
          throw error;
        }
      });
    },
    (error) => {
      assert.equal(error?.candidateDiagnostics?.[0]?.strategy, 'page-fetch');
      assert.equal(error?.candidateDiagnostics?.[0]?.sourceBlobType, 'image/heic');
      assert.equal(error?.candidateDiagnostics?.[0]?.sourceBlobSize, 245760);
      assert.match(error?.candidateDiagnosticsSummary || '', /sourceType=image\/heic/);
      assert.match(error?.candidateDiagnosticsSummary || '', /sourceSize=245760/);
      return true;
    }
  );
});

test('buildPreviewReplacementCandidates should prefer page fetch bridge for preview urls when runtime messaging is unavailable', async () => {
  const image = { id: 'fixture-image' };
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';

  const candidates = buildPreviewReplacementCandidates({
    imageElement: image,
    sourceUrl,
    captureRenderedImageBlob: async (targetImage) => {
      assert.equal(targetImage, image);
      return renderedBlob;
    }
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.strategy),
    ['page-fetch', 'rendered-capture']
  );
  assert.equal(await candidates[1].getOriginalBlob(), renderedBlob);
});

test('buildPreviewReplacementCandidates should prefer page fetch whenever preview fetching is available', async () => {
  const image = { id: 'fixture-image' };
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
  const normalizedSourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s0-rj';
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });
  const pageFetchedBlob = new Blob(['page-fetch'], { type: 'image/webp' });

  const candidates = buildPreviewReplacementCandidates({
    imageElement: image,
    sourceUrl,
    fetchPreviewBlob: async (url) => {
      assert.equal(url, normalizedSourceUrl);
      return pageFetchedBlob;
    },
    captureRenderedImageBlob: async (targetImage) => {
      assert.equal(targetImage, image);
      return renderedBlob;
    }
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.strategy),
    ['page-fetch', 'rendered-capture']
  );
  assert.equal(await candidates[0].getOriginalBlob(), pageFetchedBlob);
  assert.equal(await candidates[1].getOriginalBlob(), renderedBlob);
});

test('buildPreviewReplacementCandidates should only keep rendered capture when preview fetching is omitted', async () => {
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';

  const candidates = buildPreviewReplacementCandidates({
    imageElement: { id: 'fixture-image' },
    sourceUrl,
    fetchPreviewBlob: null,
    captureRenderedImageBlob: async () => new Blob(['rendered'], { type: 'image/png' })
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.strategy),
    ['rendered-capture']
  );
});

test('fetchBlobFromBackground should use provided fallback fetcher with the simplified signature', async () => {
  const fetchedBlob = new Blob(['gm-fetch'], { type: 'image/webp' });
  const calls = [];

  const blob = await fetchBlobFromBackground(
    'https://lh3.googleusercontent.com/gg-dl/example-token=s0-rj',
    async (url) => {
      calls.push(url);
      return fetchedBlob;
    }
  );

  assert.equal(blob, fetchedBlob);
  assert.deepEqual(calls, [
    'https://lh3.googleusercontent.com/gg-dl/example-token=s0-rj'
  ]);
});

test('processPageImageSource should process preview candidates and return selected strategy diagnostics', async () => {
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
  const imageElement = { id: 'fixture-image' };
  const originalBlob = new Blob(['page-fetch'], { type: 'image/webp' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });

  const result = await processPageImageSource({
    sourceUrl,
    imageElement,
    fetchPreviewBlob: async (url) => {
      assert.equal(url, 'https://lh3.googleusercontent.com/gg/example-token=s0-rj');
      return originalBlob;
    },
    captureRenderedImageBlob: async () => {
      throw new Error('rendered capture should not be used');
    },
    processWatermarkBlobImpl: async (blob) => {
      assert.equal(blob, originalBlob);
      return {
        processedBlob,
        processedMeta: {
          applied: true,
          size: 96,
          position: {
            width: 96,
            height: 96
          },
          source: 'validated-standard',
          detection: {
            originalSpatialScore: 0.36,
            processedSpatialScore: 0.08,
            suppressionGain: 0.42
          }
        }
      };
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.processedBlob, processedBlob);
  assert.equal(result.selectedStrategy, 'page-fetch');
  assert.equal(result.candidateDiagnostics?.[0]?.strategy, 'page-fetch');
});

test('processPageImageSource should return skipped preview result when page fetch is forbidden and rendered capture is tainted', async () => {
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';

  const result = await processPageImageSource({
    sourceUrl,
    imageElement: { id: 'fixture-image' },
    fetchPreviewBlob: async () => {
      throw new Error('Failed to fetch image: 403');
    },
    captureRenderedImageBlob: async () => {
      const error = new Error("Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported.");
      error.name = 'SecurityError';
      throw error;
    },
    processWatermarkBlobImpl: async () => {
      throw new Error('preview processing should not run');
    }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'preview-fetch-unavailable');
  assert.match(result.candidateDiagnosticsSummary || '', /page-fetch,error/);
  assert.match(result.candidateDiagnosticsSummary || '', /rendered-capture,error/);
});

test('processPreviewPageImageSource should return confirmed preview candidate result', async () => {
  const originalBlob = new Blob(['page-fetch'], { type: 'image/webp' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });

  const result = await processPreviewPageImageSource({
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    imageElement: { id: 'fixture-image' },
    fetchPreviewBlob: async () => originalBlob,
    captureRenderedImageBlob: async () => {
      throw new Error('rendered capture should not run');
    },
    processWatermarkBlobImpl: async (blob) => {
      assert.equal(blob, originalBlob);
      return {
        processedBlob,
        processedMeta: {
          applied: true,
          size: 96,
          position: { width: 96, height: 96 },
          source: 'validated-standard',
          detection: {
            originalSpatialScore: 0.36,
            processedSpatialScore: 0.08,
            suppressionGain: 0.42
          }
        }
      };
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.processedBlob, processedBlob);
  assert.equal(result.selectedStrategy, 'page-fetch');
});

test('processOriginalPageImageSource should acquire original blob and remove watermark', async () => {
  const originalBlob = new Blob(['original'], { type: 'image/jpeg' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });

  const result = await processOriginalPageImageSource({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example-token=s1024-rj',
    imageElement: { id: 'fixture-image' },
    fetchPreviewBlob: async () => {
      throw new Error('preview fetch should not run directly');
    },
    fetchBlobFromBackgroundImpl: async (url, fallbackFetchBlob) => {
      assert.equal(url, 'https://lh3.googleusercontent.com/gg-dl/example-token=s0-rj');
      assert.equal(typeof fallbackFetchBlob, 'function');
      return originalBlob;
    },
    fetchBlobDirectImpl: async () => {
      throw new Error('direct fetch should not run');
    },
    captureRenderedImageBlob: async () => {
      throw new Error('rendered capture should not run');
    },
    validateBlob: async () => ({ width: 1, height: 1 }),
    removeWatermarkFromBlobImpl: async (blob) => {
      assert.equal(blob, originalBlob);
      return processedBlob;
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.processedBlob, processedBlob);
  assert.equal(result.selectedStrategy, '');
  assert.equal(result.candidateDiagnostics, null);
});

test('collectCandidateImages should include a processable root image and dedupe descendants', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const container = {};
    const rootImage = new MockHTMLImageElement();
    rootImage.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj'
    };
    rootImage.src = rootImage.dataset.gwrSourceUrl;
    rootImage.currentSrc = rootImage.src;
    rootImage.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? container
      : null;
    rootImage.querySelectorAll = () => [rootImage];

    const candidates = collectCandidateImages(rootImage);

    assert.deepEqual(candidates, [rootImage]);
  });
});

test('collectCandidateImages should collect processable descendant images only once', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const container = {};
    const imageA = new MockHTMLImageElement();
    imageA.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg/example-a=s1024-rj'
    };
    imageA.src = imageA.dataset.gwrSourceUrl;
    imageA.currentSrc = imageA.src;
    imageA.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? container
      : null;

    const imageB = new MockHTMLImageElement();
    imageB.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg/example-b=s1024-rj'
    };
    imageB.src = imageB.dataset.gwrSourceUrl;
    imageB.currentSrc = imageB.src;
    imageB.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? container
      : null;

    const root = {
      querySelectorAll() {
        return [imageA, imageA, imageB];
      }
    };

    const candidates = collectCandidateImages(root);

    assert.deepEqual(candidates, [imageA, imageB]);
  });
});

test('preparePageImageProcessing should skip ready image with unchanged source', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrPageImageSource: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      gwrPageImageState: 'ready'
    };
    image.style = {};

    const processing = new Set();
    let overlayCalls = 0;

    const result = preparePageImageProcessing(image, {
      processing,
      HTMLImageElementClass: MockHTMLImageElement,
      isProcessableImage: () => true,
      resolveSourceUrl: () => 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      showProcessingOverlayImpl: () => {
        overlayCalls += 1;
      }
    });

    assert.equal(result, null);
    assert.equal(processing.has(image), false);
    assert.equal(overlayCalls, 0);
    assert.equal(image.dataset.gwrPageImageState, 'ready');
  });
});

test('preparePageImageProcessing should reset previous processed state and return new source context', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrPageImageSource: 'blob:mock:old-source',
      gwrPageImageState: 'ready',
      gwrWatermarkObjectUrl: 'blob:mock:old-processed'
    };
    image.style = {};

    const processing = new Set();
    const hiddenImages = [];
    const revokedUrls = [];
    const shownImages = [];

    const result = preparePageImageProcessing(image, {
      processing,
      HTMLImageElementClass: MockHTMLImageElement,
      isProcessableImage: () => true,
      resolveSourceUrl: () => 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      hideProcessingOverlayImpl: (target, options) => {
        hiddenImages.push([target, options]);
      },
      revokeTrackedObjectUrlImpl: (target) => {
        revokedUrls.push(target.dataset.gwrWatermarkObjectUrl);
        delete target.dataset.gwrWatermarkObjectUrl;
      },
      showProcessingOverlayImpl: (target) => {
        shownImages.push(target);
      }
    });

    assert.deepEqual(result, {
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      normalizedUrl: 'https://lh3.googleusercontent.com/gg/example-token=s0-rj',
      isPreviewSource: true
    });
    assert.equal(processing.has(image), true);
    assert.equal(image.dataset.gwrStableSource, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.equal(image.dataset.gwrPageImageSource, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.equal(image.dataset.gwrPageImageState, 'processing');
    assert.equal(image.dataset.gwrWatermarkObjectUrl, undefined);
    assert.deepEqual(hiddenImages, [[image, { removeImmediately: true }]]);
    assert.deepEqual(revokedUrls, ['blob:mock:old-processed']);
    assert.deepEqual(shownImages, [image]);
  });
});

test('emitPageImageProcessingStart should emit preview start and strategy events', () => {
  const logs = [];

  emitPageImageProcessingStart({
    logger: createSilentLogger(),
    onLog: (type, payload) => logs.push([type, payload]),
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    normalizedUrl: 'https://lh3.googleusercontent.com/gg/example-token=s0-rj',
    isPreviewSource: true
  });

  assert.deepEqual(
    logs.map(([type]) => type),
    ['page-image-process-start', 'page-image-process-strategy']
  );
  assert.equal(logs[0][1].normalizedUrl, 'https://lh3.googleusercontent.com/gg/example-token=s0-rj');
  assert.equal(logs[1][1].strategy, 'preview-candidate-fallback');
});

test('applyPageImageProcessingResult should apply ready state and emit success payload', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const logs = [];
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.style = {};
    image.src = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';

    const processedBlob = new Blob(['processed'], { type: 'image/png' });

    applyPageImageProcessingResult({
      imageElement: image,
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      normalizedUrl: 'https://lh3.googleusercontent.com/gg/example-token=s0-rj',
      isPreviewSource: true,
      sourceResult: {
        skipped: false,
        processedBlob,
        selectedStrategy: '',
        candidateDiagnostics: [{ strategy: 'rendered-capture', status: 'insufficient' }],
        candidateDiagnosticsSummary: 'rendered-capture,insufficient'
      },
      logger: createSilentLogger(),
      onLog: (type, payload) => logs.push([type, payload])
    });

    assert.equal(image.dataset.gwrPageImageState, 'ready');
    assert.equal(image.dataset.gwrWatermarkObjectUrl, `blob:mock:${processedBlob.size}`);
    assert.equal(image.src, `blob:mock:${processedBlob.size}`);
    assert.deepEqual(logs.map(([type]) => type), ['page-image-process-success']);
    assert.equal(logs[0][1].strategy, 'preview-candidate');
    assert.equal(logs[0][1].blobType, 'image/png');
    assert.equal(logs[0][1].blobSize, processedBlob.size);
  });
});

test('handlePageImageProcessingFailure should mark image failed and emit diagnostics', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const logs = [];
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.style = {};

    const error = new Error('boom');
    error.candidateDiagnostics = [{ strategy: 'page-fetch', status: 'error', error: 'boom' }];
    error.candidateDiagnosticsSummary = 'page-fetch,error,error=boom';

    handlePageImageProcessingFailure({
      imageElement: image,
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      normalizedUrl: 'https://lh3.googleusercontent.com/gg/example-token=s0-rj',
      error,
      logger: createSilentLogger(),
      onLog: (type, payload) => logs.push([type, payload])
    });

    assert.equal(image.dataset.gwrPageImageState, 'failed');
    assert.deepEqual(logs.map(([type]) => type), ['page-image-process-failed']);
    assert.equal(logs[0][1].error, 'boom');
    assert.equal(logs[0][1].candidateDiagnosticsSummary, 'page-fetch,error,error=boom');
  });
});

test('buildPageImageSourceRequest should assemble source processing dependencies', () => {
  const imageElement = { tagName: 'IMG' };
  const fetchPreviewBlob = () => {};
  const processWatermarkBlobImpl = () => {};
  const removeWatermarkFromBlobImpl = () => {};

  const request = buildPageImageSourceRequest({
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    imageElement,
    fetchPreviewBlob,
    processWatermarkBlobImpl,
    removeWatermarkFromBlobImpl
  });

  assert.equal(request.sourceUrl, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
  assert.equal(request.imageElement, imageElement);
  assert.equal(request.fetchPreviewBlob, fetchPreviewBlob);
  assert.equal(request.processWatermarkBlobImpl, processWatermarkBlobImpl);
  assert.equal(request.removeWatermarkFromBlobImpl, removeWatermarkFromBlobImpl);
  assert.equal(typeof request.captureRenderedImageBlob, 'function');
  assert.equal(typeof request.fetchBlobDirectImpl, 'function');
  assert.equal(typeof request.validateBlob, 'function');
  assert.equal(typeof request.fetchBlobFromBackgroundImpl, 'function');
});

test('createPageImageReplacementController should apply successful helper result and emit preview events', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const logs = [];
    const previewBlob = new Blob(['processed'], { type: 'image/png' });
    const container = createMockElement('div');
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj'
    };
    image.style = {};
    image.src = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
    image.currentSrc = image.src;
    image.parentElement = container;
    image.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? container
      : null;

    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      onLog: (type, payload) => logs.push([type, payload]),
      processPageImageSourceImpl: async ({ sourceUrl, imageElement }) => {
        assert.equal(sourceUrl, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
        assert.equal(imageElement, image);
        return {
          skipped: false,
          processedBlob: previewBlob,
          selectedStrategy: 'page-fetch',
          candidateDiagnostics: [{ strategy: 'page-fetch', status: 'confirmed' }],
          candidateDiagnosticsSummary: 'page-fetch,confirmed'
        };
      }
    });

    controller.processRoot({
      querySelectorAll() {
        return [image];
      }
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(image.dataset.gwrPageImageState, 'ready');
    assert.equal(image.dataset.gwrWatermarkObjectUrl, `blob:mock:${previewBlob.size}`);
    assert.equal(image.src, `blob:mock:${previewBlob.size}`);
    assert.deepEqual(
      logs.map(([type]) => type),
      ['page-image-process-start', 'page-image-process-strategy', 'page-image-process-success']
    );
    assert.equal(logs[2][1].strategy, 'page-fetch');
  });
});

test('createPageImageReplacementController should apply skipped helper result without creating object urls', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const logs = [];
    const container = createMockElement('div');
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj'
    };
    image.style = {};
    image.src = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
    image.currentSrc = image.src;
    image.parentElement = container;
    image.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? container
      : null;

    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      onLog: (type, payload) => logs.push([type, payload]),
      processPageImageSourceImpl: async () => ({
        skipped: true,
        reason: 'preview-fetch-unavailable',
        candidateDiagnostics: [{ strategy: 'page-fetch', status: 'error' }],
        candidateDiagnosticsSummary: 'page-fetch,error'
      })
    });

    controller.processRoot({
      querySelectorAll() {
        return [image];
      }
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(image.dataset.gwrPageImageState, 'skipped');
    assert.equal(image.dataset.gwrWatermarkObjectUrl, undefined);
    assert.equal(image.src, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.deepEqual(
      logs.map(([type]) => type),
      ['page-image-process-start', 'page-image-process-strategy', 'page-image-process-skipped']
    );
    assert.equal(logs[2][1].reason, 'preview-fetch-unavailable');
  });
});

test('handlePageImageMutations should schedule meaningful image attribute mutations and relevant added roots', () => {
  class MockHTMLImageElement {}
  const scheduledRoots = [];
  const targetImage = new MockHTMLImageElement();
  targetImage.dataset = {};
  targetImage.currentSrc = 'https://lh3.googleusercontent.com/rd-gg/example=s1024';
  targetImage.src = targetImage.currentSrc;

  const ignoredImage = new MockHTMLImageElement();
  ignoredImage.dataset = {
    gwrWatermarkObjectUrl: 'blob:processed'
  };
  ignoredImage.currentSrc = 'blob:processed';
  ignoredImage.src = 'blob:processed';

  const relevantRoot = {
    tagName: 'IMG'
  };
  const ignoredRoot = {
    tagName: 'DIV',
    matches: () => false,
    querySelector: () => null
  };

  handlePageImageMutations([
    {
      type: 'attributes',
      target: targetImage,
      attributeName: 'src',
      addedNodes: []
    },
    {
      type: 'attributes',
      target: ignoredImage,
      attributeName: 'src',
      addedNodes: []
    },
    {
      type: 'childList',
      addedNodes: [ignoredRoot, relevantRoot]
    }
  ], {
    scheduleProcess: (root) => scheduledRoots.push(root),
    HTMLImageElementClass: MockHTMLImageElement
  });

  assert.deepEqual(scheduledRoots, [
    targetImage,
    relevantRoot
  ]);
});

test('handlePageImageMutations should ignore non-image attribute mutations and missing added nodes', () => {
  class MockHTMLImageElement {}
  const scheduledRoots = [];

  handlePageImageMutations([
    {
      type: 'attributes',
      target: { tagName: 'IMG' },
      attributeName: 'src',
      addedNodes: []
    },
    {
      type: 'childList',
      addedNodes: [null, { tagName: 'SPAN' }]
    }
  ], {
    scheduleProcess: (root) => scheduledRoots.push(root),
    HTMLImageElementClass: MockHTMLImageElement
  });

  assert.deepEqual(scheduledRoots, []);
});

test('shouldScheduleMutationRoot should ignore irrelevant added nodes', () => {
  assert.equal(shouldScheduleMutationRoot(null), false);
  assert.equal(shouldScheduleMutationRoot({ tagName: 'SPAN' }), false);
  assert.equal(shouldScheduleMutationRoot({
    tagName: 'DIV',
    matches: () => false,
    querySelector: () => null
  }), false);

  assert.equal(shouldScheduleMutationRoot({ tagName: 'IMG' }), true);
  assert.equal(shouldScheduleMutationRoot({
    tagName: 'GENERATED-IMAGE',
    matches: () => true
  }), true);
  assert.equal(shouldScheduleMutationRoot({
    tagName: 'DIV',
    matches: () => false,
    querySelector: () => ({ tagName: 'GENERATED-IMAGE' })
  }), true);
});

test('shouldScheduleAttributeMutation should ignore self-written processed blob src updates', () => {
  assert.equal(shouldScheduleAttributeMutation({
    dataset: {
      gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed',
      gwrStableSource: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    currentSrc: 'blob:https://gemini.google.com/processed',
    src: 'blob:https://gemini.google.com/processed'
  }, 'src'), false);
});

test('isSelfWrittenProcessedImageSource should detect tracked processed object urls', () => {
  assert.equal(isSelfWrittenProcessedImageSource({
    dataset: {
      gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed'
    },
    currentSrc: 'blob:https://gemini.google.com/processed',
    src: 'blob:https://gemini.google.com/processed'
  }), true);
});

test('isSelfWrittenProcessedImageSource should ignore meaningful non-blob source changes', () => {
  assert.equal(isSelfWrittenProcessedImageSource({
    dataset: {
      gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed'
    },
    currentSrc: 'https://lh3.googleusercontent.com/rd-gg/example=s2048',
    src: 'https://lh3.googleusercontent.com/rd-gg/example=s2048'
  }), false);
  assert.equal(isSelfWrittenProcessedImageSource({
    dataset: {}
  }), false);
});

test('shouldScheduleAttributeMutation should still react to meaningful source changes', () => {
  assert.equal(shouldScheduleAttributeMutation({
    dataset: {
      gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed',
      gwrStableSource: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    currentSrc: 'https://lh3.googleusercontent.com/rd-gg/example=s2048',
    src: 'https://lh3.googleusercontent.com/rd-gg/example=s2048'
  }, 'src'), true);
  assert.equal(shouldScheduleAttributeMutation({
    dataset: {
      gwrStableSource: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    }
  }, 'data-gwr-stable-source'), false);
});

test('createRootBatchProcessor should batch multiple schedule calls behind one flush', () => {
  const scheduledCallbacks = [];
  const processedRoots = [];
  const batchProcessor = createRootBatchProcessor({
    processRoot(root) {
      processedRoots.push(root);
    },
    scheduleFlush(callback) {
      scheduledCallbacks.push(callback);
    }
  });

  batchProcessor.schedule('root-a');
  batchProcessor.schedule('root-b');
  batchProcessor.schedule('root-a');

  assert.equal(scheduledCallbacks.length, 1);
  assert.deepEqual(processedRoots, []);

  scheduledCallbacks[0]();

  assert.deepEqual(processedRoots, ['root-a', 'root-b']);
});

test('createRootBatchProcessor should schedule a new flush after the previous one finishes', () => {
  const scheduledCallbacks = [];
  const processedRoots = [];
  const batchProcessor = createRootBatchProcessor({
    processRoot(root) {
      processedRoots.push(root);
    },
    scheduleFlush(callback) {
      scheduledCallbacks.push(callback);
    }
  });

  batchProcessor.schedule('root-a');
  scheduledCallbacks[0]();
  batchProcessor.schedule('root-b');

  assert.equal(scheduledCallbacks.length, 2);

  scheduledCallbacks[1]();

  assert.deepEqual(processedRoots, ['root-a', 'root-b']);
});

test('createRootBatchProcessor should ignore descendant roots when an ancestor is already pending', () => {
  const scheduledCallbacks = [];
  const processedRoots = [];
  const root = {
    name: 'root',
    contains(node) {
      return node === child;
    }
  };
  const child = {
    name: 'child',
    contains() {
      return false;
    }
  };
  const batchProcessor = createRootBatchProcessor({
    processRoot(rootNode) {
      processedRoots.push(rootNode.name);
    },
    scheduleFlush(callback) {
      scheduledCallbacks.push(callback);
    }
  });

  batchProcessor.schedule(root);
  batchProcessor.schedule(child);
  scheduledCallbacks[0]();

  assert.deepEqual(processedRoots, ['root']);
});

test('createRootBatchProcessor should replace pending descendants when a parent root arrives later', () => {
  const scheduledCallbacks = [];
  const processedRoots = [];
  const root = {
    name: 'root',
    contains(node) {
      return node === child;
    }
  };
  const child = {
    name: 'child',
    contains() {
      return false;
    }
  };
  const batchProcessor = createRootBatchProcessor({
    processRoot(rootNode) {
      processedRoots.push(rootNode.name);
    },
    scheduleFlush(callback) {
      scheduledCallbacks.push(callback);
    }
  });

  batchProcessor.schedule(child);
  batchProcessor.schedule(root);
  scheduledCallbacks[0]();

  assert.deepEqual(processedRoots, ['root']);
});

test('shouldSkipPreviewProcessingFailure should skip previews when fetch is forbidden and rendered capture is tainted', () => {
  assert.equal(shouldSkipPreviewProcessingFailure([
    {
      strategy: 'page-fetch',
      status: 'error',
      error: 'Failed to fetch image: 403'
    },
    {
      strategy: 'rendered-capture',
      status: 'error',
      error: "Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported."
    }
  ]), true);

  assert.equal(shouldSkipPreviewProcessingFailure([
    {
      strategy: 'page-fetch',
      status: 'error',
      error: 'Failed to decode Gemini image blob'
    },
    {
      strategy: 'rendered-capture',
      status: 'error',
      error: "Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported."
      }
    ]), false);
});

test('showProcessingOverlay should append one overlay and apply a subdued processing look to the image', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  image.style.filter = 'contrast(1.1)';

  const createdElements = [];
  const createElement = (tagName) => {
    const element = createMockElement(tagName);
    createdElements.push(element);
    return element;
  };

  showProcessingOverlay(image, {
    container,
    createElement
  });
  showProcessingOverlay(image, {
    container,
    createElement
  });

  assert.equal(container.children.length, 1);
  assert.equal(createdElements.length, 1);
  assert.equal(container.children[0].dataset.gwrProcessingOverlay, 'true');
  assert.equal(container.children[0].textContent, 'Processing...');
  assert.match(image.style.filter, /blur/);
  assert.match(image.style.filter, /brightness/);
  assert.match(image.style.filter, /contrast\(1\.1\)/);
});

test('hideProcessingOverlay should remove overlay and restore the previous image filter', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  image.style.filter = 'saturate(1.2)';

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  hideProcessingOverlay(image, {
    removeImmediately: true
  });

  assert.equal(container.children.length, 0);
  assert.equal(image.style.filter, 'saturate(1.2)');
  assert.equal(image.dataset.gwrProcessingVisual, undefined);
});

test('hideProcessingOverlay should fade the overlay out before removing it by default', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  const timers = [];

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  hideProcessingOverlay(image, {
    setTimeoutImpl(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].style.opacity, '0');
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 0);

  timers[0].callback();

  assert.equal(container.children.length, 0);
  assert.equal(image.dataset.gwrProcessingVisual, undefined);
});

test('stale hide callback should not remove an overlay that has been shown again', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  const timers = [];

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  hideProcessingOverlay(image, {
    setTimeoutImpl(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement,
    clearTimeoutImpl() {
      // Simulate a timer that can no longer be reliably cancelled.
    }
  });

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].style.opacity, '1');

  timers[0].callback();

  assert.equal(container.children.length, 1);
  assert.equal(image.dataset.gwrProcessingVisual, 'true');
});

test('hideProcessingOverlay should not overwrite container position changed by page code during processing', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  container.style.position = 'sticky';

  hideProcessingOverlay(image, {
    removeImmediately: true
  });

  assert.equal(container.style.position, 'sticky');
});

test('waitForRenderableImageSize should wait for preview images that become renderable on the next frame', async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const image = {
    naturalWidth: 0,
    naturalHeight: 0,
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0
  };

  globalThis.requestAnimationFrame = (callback) => {
    image.naturalWidth = 1024;
    image.naturalHeight = 1024;
    image.clientWidth = 512;
    image.clientHeight = 512;
    setTimeout(() => callback(16), 0);
    return 1;
  };

  try {
    await assert.doesNotReject(() => waitForRenderableImageSize(image, 50));
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

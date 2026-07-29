import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRecentImageSourceHintToImage,
  buildRecentImageSourceHint,
  buildPageImageSourceRequest,
  bindProcessedPreviewResultToImages,
  bindOriginalAssetUrlToImages,
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
  getRememberedPreviewResultRegistryEntryForTests,
  getRememberedPreviewResultRegistrySizeForTests,
  hideProcessingOverlay,
  intersectCaptureRectWithViewport,
  resolvePreviewReplacementResult,
  resolveVisibleCaptureRect,
  shouldSkipPreviewProcessingFailure,
  shouldScheduleAttributeMutation,
  shouldScheduleMutationRoot,
  showProcessingOverlay,
  waitForRenderableImageSize,
  resetPageImageReplacementRegistriesForTests
} from '../../src/shared/pageImageReplacement.js';
import { createImageSessionStore } from '../../src/shared/imageSessionStore.js';

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
  resetPageImageReplacementRegistriesForTests();

  try {
    await run({ MockHTMLImageElement });
  } finally {
    resetPageImageReplacementRegistriesForTests();
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

test('collectCandidateImages should include fullscreen dialog images outside generated-image containers', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const actionCluster = {
      querySelectorAll(selector) {
        return selector === 'button,[role="button"]' ? [{}, {}, {}] : [];
      },
      parentElement: null
    };
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.src = 'blob:https://gemini.google.com/fullscreen-preview';
    image.currentSrc = image.src;
    image.naturalWidth = 1408;
    image.naturalHeight = 768;
    image.width = 1408;
    image.height = 768;
    image.clientWidth = 951;
    image.clientHeight = 519;
    image.parentElement = actionCluster;
    image.closest = () => null;

    const root = {
      querySelectorAll(selector) {
        if (selector === 'img') {
          return [image];
        }
        return [];
      }
    };

    assert.deepEqual(collectCandidateImages(root), [image]);
  });
});

test('bindOriginalAssetUrlToImages should bind fullscreen dialog images discovered through generic img queries', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const actionCluster = {
      querySelectorAll(selector) {
        return selector === 'button,[role="button"]' ? [{}, {}, {}] : [];
      },
      parentElement: null
    };
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrResponseId: 'r_example',
      gwrDraftId: 'rc_example',
      gwrConversationId: 'c_example'
    };
    image.src = 'blob:https://gemini.google.com/fullscreen-preview';
    image.currentSrc = image.src;
    image.naturalWidth = 1408;
    image.naturalHeight = 768;
    image.width = 1408;
    image.height = 768;
    image.clientWidth = 951;
    image.clientHeight = 519;
    image.parentElement = actionCluster;
    image.closest = () => null;

    const root = {
      querySelectorAll(selector) {
        if (selector === 'img') {
          return [image];
        }
        return [];
      }
    };

    const updatedCount = bindOriginalAssetUrlToImages({
      root,
      assetIds: {
        responseId: 'r_example',
        draftId: 'rc_example',
        conversationId: 'c_example'
      },
      sourceUrl: 'https://lh3.googleusercontent.com/rd-gg/example=s0-rp'
    });

    assert.equal(updatedCount, 1);
    assert.equal(image.dataset.gwrSourceUrl, 'https://lh3.googleusercontent.com/rd-gg/example=s0-rp');
  });
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

test('processPreviewPageImageSource should use full-strength watermark processing without preview-only overrides', async () => {
  const originalBlob = new Blob(['page-fetch'], { type: 'image/webp' });
  let receivedOptions = null;

  await processPreviewPageImageSource({
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    imageElement: { id: 'fixture-image' },
    fetchPreviewBlob: async () => originalBlob,
    captureRenderedImageBlob: async () => {
      throw new Error('rendered capture should not run');
    },
    processWatermarkBlobImpl: async (_blob, options) => {
      receivedOptions = options;
      return {
        processedBlob: new Blob(['processed'], { type: 'image/png' }),
        processedMeta: {
          applied: true,
          size: 34,
          position: { x: 966, y: 501, width: 34, height: 34 },
          source: 'standard+preview-anchor+validated',
          detection: {
            originalSpatialScore: 0.31,
            processedSpatialScore: 0.08,
            suppressionGain: 0.34
          }
        }
      };
    }
  });

  assert.equal(receivedOptions, undefined);
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

test('collectCandidateImages should include opaque blob images when they look like Gemini generated images', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const actionCluster = {
      querySelectorAll: () => [{}, {}, {}],
      parentElement: null
    };
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.naturalWidth = 1024;
    image.naturalHeight = 768;
    image.clientWidth = 480;
    image.clientHeight = 360;
    image.currentSrc = 'blob:https://gemini.google.com/runtime-preview';
    image.src = image.currentSrc;
    image.parentElement = actionCluster;
    image.closest = () => null;

    const root = {
      querySelectorAll() {
        return [image];
      }
    };

    const candidates = collectCandidateImages(root);

    assert.deepEqual(candidates, [image]);
  });
});

test('collectCandidateImages should include fullscreen cached blob images inside Gemini containers', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const container = {};
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.naturalWidth = 2048;
    image.naturalHeight = 1118;
    image.clientWidth = 951;
    image.clientHeight = 519;
    image.currentSrc = 'blob:https://gemini.google.com/fullscreen-cached';
    image.src = image.currentSrc;
    image.closest = (selector) => {
      if (selector === 'generated-image,.generated-image-container') return container;
      if (selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane') return {};
      return null;
    };

    const root = {
      querySelectorAll() {
        return [image];
      }
    };

    const candidates = collectCandidateImages(root);

    assert.deepEqual(candidates, [image]);
  });
});

test('collectCandidateImages should include zero-sized fullscreen blob images inside Gemini containers before load completes', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const container = {};
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.naturalWidth = 0;
    image.naturalHeight = 0;
    image.clientWidth = 0;
    image.clientHeight = 0;
    image.complete = false;
    image.currentSrc = '';
    image.src = 'blob:https://gemini.google.com/fullscreen-pending';
    image.closest = (selector) => {
      if (selector === 'generated-image,.generated-image-container') return container;
      if (selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane') return {};
      return null;
    };

    const root = {
      querySelectorAll() {
        return [image];
      }
    };

    const candidates = collectCandidateImages(root);

    assert.deepEqual(candidates, [image]);
  });
});

test('collectCandidateImages should ignore inline blob images inside Gemini containers without Gemini evidence', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const container = {};
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.naturalWidth = 1024;
    image.naturalHeight = 768;
    image.clientWidth = 480;
    image.clientHeight = 360;
    image.currentSrc = 'blob:https://gemini.google.com/user-upload';
    image.src = image.currentSrc;
    image.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? container
      : null;

    const root = {
      querySelectorAll() {
        return [image];
      }
    };

    const candidates = collectCandidateImages(root);

    assert.deepEqual(candidates, []);
  });
});

test('collectCandidateImages should ignore uploader preview images even when blob fallback cues are present', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const actionCluster = {
      querySelectorAll: () => [{}, {}, {}],
      parentElement: null
    };
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.naturalWidth = 1024;
    image.naturalHeight = 768;
    image.clientWidth = 480;
    image.clientHeight = 360;
    image.currentSrc = 'blob:https://gemini.google.com/user-upload-preview';
    image.src = image.currentSrc;
    image.parentElement = actionCluster;
    image.closest = (selector) => selector === '[data-test-id="image-preview"],uploader-file-preview,uploader-file-preview-container,.attachment-preview-wrapper,.file-preview-container'
      ? {}
      : null;

    const root = {
      querySelectorAll() {
        return [image];
      }
    };

    const candidates = collectCandidateImages(root);

    assert.deepEqual(candidates, []);
  });
});

test('processPageImageSource should treat blob page images as full-strength rendered captures', async () => {
  const sourceUrl = 'blob:https://gemini.google.com/runtime-preview';
  const imageElement = { id: 'fixture-image' };
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });
  const calls = [];

  const result = await processPageImageSource({
    sourceUrl,
    imageElement,
    fetchPreviewBlob: async () => {
      calls.push('preview-fetch');
      throw new Error('preview fetch should not run');
    },
    fetchBlobDirectImpl: async () => {
      calls.push('blob-fetch');
      throw new Error('blob fetch should not run');
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return renderedBlob;
    },
    processWatermarkBlobImpl: async (blob, options) => {
      calls.push(['process', blob, options]);
      return {
        processedBlob,
        processedMeta: {
          applied: true,
          size: 35,
          position: { x: 0, y: 0, width: 35, height: 35 },
          source: 'standard+preview-anchor+validated'
        }
      };
    },
    removeWatermarkFromBlobImpl: async () => {
      calls.push('remove');
      throw new Error('full-strength remove should not run for blob previews');
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.processedBlob, processedBlob);
  assert.equal(result.selectedStrategy, 'rendered-capture');
  assert.deepEqual(calls, [
    ['capture', imageElement],
    ['process', renderedBlob, undefined]
  ]);
});

function assertOriginalQualityValidationFlow(calls, {
  originalBlob,
  tail
}) {
  assert.deepEqual(calls[0], [
    'background',
    'https://lh3.googleusercontent.com/gg/example-token=s0-rj',
    'function'
  ]);

  const validateCalls = calls.filter((entry) => Array.isArray(entry) && entry[0] === 'validate');
  assert.ok(
    validateCalls.length >= 1 && validateCalls.length <= 2,
    `expected 1 or 2 validate calls, got ${validateCalls.length}`
  );
  for (const entry of validateCalls) {
    assert.deepEqual(entry, ['validate', originalBlob]);
  }

  const nonValidateTail = calls.filter((entry) => !(Array.isArray(entry) && entry[0] === 'validate')).slice(1);
  assert.deepEqual(nonValidateTail, tail);
}

test('processPageImageSource should treat explicitly bound Gemini preview urls as original-quality sources', async () => {
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
  const originalBlob = new Blob(['background'], { type: 'image/jpeg' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });
  const imageElement = {
    dataset: {
      gwrSourceUrl: sourceUrl
    }
  };
  const calls = [];

  const result = await processPageImageSource({
    sourceUrl,
    imageElement,
    fetchPreviewBlob: async () => {
      calls.push('preview-fetch');
      throw new Error('preview fetch should not run for bound original sources');
    },
    fetchBlobFromBackgroundImpl: async (url, fallbackFetchBlob) => {
      calls.push(['background', url, typeof fallbackFetchBlob]);
      return originalBlob;
    },
    fetchBlobDirectImpl: async () => {
      calls.push('direct-fetch');
      throw new Error('direct fetch should not run');
    },
    captureRenderedImageBlob: async () => {
      calls.push('capture');
      throw new Error('rendered capture should not run');
    },
    validateBlob: async (blob) => {
      calls.push(['validate', blob]);
      return { width: 1024, height: 1024 };
    },
    processWatermarkBlobImpl: async () => {
      calls.push('preview-process');
      throw new Error('preview-only processing should not run');
    },
    removeWatermarkFromBlobImpl: async (blob) => {
      calls.push(['remove', blob]);
      return processedBlob;
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.processedBlob, processedBlob);
  assertOriginalQualityValidationFlow(calls, {
    originalBlob,
    tail: [
      ['remove', originalBlob]
    ]
  });
});

test('processPageImageSource should fall back to rendered preview when an explicitly bound Gemini preview fetch fails', async () => {
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });
  const imageElement = {
    dataset: {
      gwrSourceUrl: sourceUrl
    }
  };
  const calls = [];

  const result = await processPageImageSource({
    sourceUrl,
    imageElement,
    fetchPreviewBlob: async (url) => {
      calls.push(['preview-fetch', url]);
      throw new Error('Failed to fetch image: 403');
    },
    fetchBlobFromBackgroundImpl: async (url) => {
      calls.push(['background', url]);
      throw new Error('Failed to fetch image: 403');
    },
    fetchBlobDirectImpl: async () => {
      throw new Error('direct fetch should not run');
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return renderedBlob;
    },
    validateBlob: async () => {
      throw new Error('validation should not run after fetch failure');
    },
    removeWatermarkFromBlobImpl: async () => {
      calls.push('remove');
      throw new Error('full-strength removal should not run on rendered preview');
    },
    processWatermarkBlobImpl: async (blob, options) => {
      calls.push(['preview-process', blob, options]);
      return {
        processedBlob,
        processedMeta: {
          applied: true,
          source: 'standard+preview-anchor+validated'
        }
      };
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.processedBlob, processedBlob);
  assert.equal(result.selectedStrategy, 'rendered-capture');
  assert.deepEqual(calls, [
    ['background', 'https://lh3.googleusercontent.com/gg/example-token=s0-rj'],
    ['preview-fetch', 'https://lh3.googleusercontent.com/gg/example-token=s0-rj'],
    ['capture', imageElement],
    ['preview-process', renderedBlob, undefined]
  ]);
});

test('processPageImageSource should prefer original-quality processing for Gemini preview urls before preview fallback', async () => {
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
  const originalBlob = new Blob(['background'], { type: 'image/jpeg' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });
  const calls = [];

  const result = await processPageImageSource({
    sourceUrl,
    imageElement: { dataset: {} },
    fetchPreviewBlob: async () => {
      calls.push('preview-fetch');
      return new Blob(['preview'], { type: 'image/webp' });
    },
    fetchBlobFromBackgroundImpl: async (url, fallbackFetchBlob) => {
      calls.push(['background', url, typeof fallbackFetchBlob]);
      return originalBlob;
    },
    fetchBlobDirectImpl: async () => {
      calls.push('direct-fetch');
      throw new Error('direct fetch should not run');
    },
    captureRenderedImageBlob: async () => {
      calls.push('capture');
      throw new Error('rendered capture should not run');
    },
    validateBlob: async (blob) => {
      calls.push(['validate', blob]);
      return { width: 1024, height: 1024 };
    },
    processWatermarkBlobImpl: async () => {
      calls.push('preview-process');
      throw new Error('preview processing should not run when original-quality fetch succeeds');
    },
    removeWatermarkFromBlobImpl: async (blob) => {
      calls.push(['remove', blob]);
      return processedBlob;
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.processedBlob, processedBlob);
  assertOriginalQualityValidationFlow(calls, {
    originalBlob,
    tail: [
      ['remove', originalBlob]
    ]
  });
});

test('processPageImageSource should fall back to preview processing when original-quality preview blob aspect ratio mismatches the visible preview', async () => {
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
  const originalBlob = new Blob(['background'], { type: 'image/jpeg' });
  const previewBlob = new Blob(['preview'], { type: 'image/webp' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });
  const imageElement = {
    dataset: {},
    naturalWidth: 426,
    naturalHeight: 758,
    clientWidth: 426,
    clientHeight: 758
  };
  const calls = [];

  const result = await processPageImageSource({
    sourceUrl,
    imageElement,
    fetchPreviewBlob: async (url) => {
      calls.push(['preview-fetch', url]);
      return previewBlob;
    },
    fetchBlobFromBackgroundImpl: async (url, fallbackFetchBlob) => {
      calls.push(['background', url, typeof fallbackFetchBlob]);
      return originalBlob;
    },
    fetchBlobDirectImpl: async () => {
      calls.push('direct-fetch');
      throw new Error('direct fetch should not run');
    },
    captureRenderedImageBlob: async () => {
      calls.push('capture');
      throw new Error('rendered capture should not run');
    },
    validateBlob: async (blob) => {
      calls.push(['validate', blob]);
      return { width: 1024, height: 1024 };
    },
    processWatermarkBlobImpl: async (blob) => {
      calls.push(['preview-process', blob]);
      return {
        processedBlob,
        processedMeta: {
          applied: true,
          decisionTier: 'validated-match',
          size: 34,
          position: { x: 392, y: 724, width: 34, height: 34 },
          source: 'standard+preview-anchor+validated',
          detection: {
            originalSpatialScore: 0.41,
            processedSpatialScore: 0.08,
            suppressionGain: 0.33
          }
        }
      };
    },
    removeWatermarkFromBlobImpl: async (blob) => {
      calls.push(['remove', blob]);
      throw new Error('original-quality removal should not run when the preview aspect ratio mismatches');
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.processedBlob, processedBlob);
  assert.equal(result.selectedStrategy, 'page-fetch');
  assertOriginalQualityValidationFlow(calls, {
    originalBlob,
    tail: [
      ['preview-fetch', 'https://lh3.googleusercontent.com/gg/example-token=s0-rj'],
      ['preview-process', previewBlob]
    ]
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
      resolveAssetIds: () => ({
        responseId: 'r_d7ef418292ede05c',
        draftId: 'rc_2315ec0b5621fce5',
        conversationId: 'c_cdec91057e5fdcaf'
      }),
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

    assert.equal(result?.sourceUrl, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.equal(result?.normalizedUrl, 'https://lh3.googleusercontent.com/gg/example-token=s0-rj');
    assert.equal(result?.isPreviewSource, true);
    assert.equal(result?.sessionKey, 'draft:rc_2315ec0b5621fce5');
    assert.equal(result?.surfaceType, 'preview');
    assert.deepEqual(result?.assetIds, {
      responseId: 'r_d7ef418292ede05c',
      draftId: 'rc_2315ec0b5621fce5',
      conversationId: 'c_cdec91057e5fdcaf'
    });
    assert.equal(processing.has(image), true);
    assert.equal(image.dataset.gwrStableSource, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.equal(image.dataset.gwrPageImageSource, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.equal(image.dataset.gwrPageImageState, 'processing');
    assert.equal(image.dataset.gwrResponseId, 'r_d7ef418292ede05c');
    assert.equal(image.dataset.gwrDraftId, 'rc_2315ec0b5621fce5');
    assert.equal(image.dataset.gwrConversationId, 'c_cdec91057e5fdcaf');
    assert.equal(image.dataset.gwrWatermarkObjectUrl, undefined);
    assert.deepEqual(hiddenImages, [[image, { removeImmediately: true }]]);
    assert.deepEqual(revokedUrls, ['blob:mock:old-processed']);
    assert.deepEqual(shownImages, [image]);
  });
});

test('preparePageImageProcessing should mark explicitly bound Gemini preview urls as non-preview work', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrSourceUrl: sourceUrl
    };
    image.style = {};

    const result = preparePageImageProcessing(image, {
      HTMLImageElementClass: MockHTMLImageElement,
      isProcessableImage: () => true,
      resolveSourceUrl: () => sourceUrl
    });

    assert.equal(result?.sourceUrl, sourceUrl);
    assert.equal(result?.isPreviewSource, false);
  });
});

test('preparePageImageProcessing should accept cross-realm image-like elements when tagName is IMG', async () => {
  const image = {
    tagName: 'IMG',
    dataset: {},
    style: {},
    closest() {
      return null;
    }
  };

  const result = preparePageImageProcessing(image, {
    HTMLImageElementClass: class MockImageElement {},
    isProcessableImage: () => true,
    resolveSourceUrl: () => 'https://lh3.googleusercontent.com/gg-dl/example-token=s1024-rj'
  });

  assert.equal(result?.sourceUrl, 'https://lh3.googleusercontent.com/gg-dl/example-token=s1024-rj');
  assert.equal(result?.normalizedUrl, 'https://lh3.googleusercontent.com/gg-dl/example-token=s0-rj');
  assert.equal(result?.isPreviewSource, true);
  assert.equal(image.dataset.gwrPageImageState, 'processing');
});

test('preparePageImageProcessing should skip preview fallback when request-layer preview output already exists', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrResponseId: 'r_phase2_skip',
      gwrDraftId: 'rc_phase2_skip',
      gwrConversationId: 'c_phase2_skip'
    };
    image.style = {};

    const sessionKey = imageSessionStore.getOrCreateByAssetIds({
      responseId: 'r_phase2_skip',
      draftId: 'rc_phase2_skip',
      conversationId: 'c_phase2_skip'
    });
    imageSessionStore.updateProcessedResult(sessionKey, {
      slot: 'preview',
      objectUrl: 'blob:https://gemini.google.com/request-preview',
      blob: new Blob(['preview'], { type: 'image/png' }),
      blobType: 'image/png',
      processedFrom: 'request-preview'
    });

    const result = preparePageImageProcessing(image, {
      HTMLImageElementClass: MockHTMLImageElement,
      imageSessionStore,
      isProcessableImage: () => true,
      resolveSourceUrl: () => 'blob:https://gemini.google.com/runtime-preview',
      resolveAssetIds: () => ({
        responseId: 'r_phase2_skip',
        draftId: 'rc_phase2_skip',
        conversationId: 'c_phase2_skip'
      })
    });

    assert.equal(result, null);
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
    const container = createMockElement('div');
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.style = {};
    image.src = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
    image.parentElement = container;

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
        processedMeta: {
          applied: true,
          selectionDebug: {
            candidateSource: 'official-nearby-catalog',
            initialConfig: { logoSize: 96, marginRight: 64, marginBottom: 64 },
            initialPosition: { x: 608, y: 1216, width: 96, height: 96 },
            finalConfig: { logoSize: 94, marginRight: 64, marginBottom: 62 },
            finalPosition: { x: 611, y: 1214, width: 94, height: 94 },
            texturePenalty: 0.04,
            tooDark: false,
            tooFlat: false,
            hardReject: false,
            usedCatalogVariant: true,
            usedSizeJitter: true,
            usedLocalShift: true,
            usedAdaptive: false,
            usedPreviewAnchor: false
          }
        },
        candidateDiagnostics: [{ strategy: 'rendered-capture', status: 'insufficient' }],
        candidateDiagnosticsSummary: 'rendered-capture,insufficient'
      },
      logger: createSilentLogger(),
      onLog: (type, payload) => logs.push([type, payload])
    });

    assert.equal(image.dataset.gwrPageImageState, 'ready');
    assert.equal(image.dataset.gwrWatermarkObjectUrl, `blob:mock:${processedBlob.size}`);
    assert.equal(image.src, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].dataset.gwrPreviewImage, 'true');
    assert.equal(container.children[0].style.backgroundImage, `url(\"blob:mock:${processedBlob.size}\")`);
    assert.deepEqual(logs.map(([type]) => type), ['page-image-process-success']);
    assert.equal(logs[0][1].strategy, 'preview-candidate');
    assert.equal(logs[0][1].blobType, 'image/png');
    assert.equal(logs[0][1].blobSize, processedBlob.size);
    assert.equal(logs[0][1].selectionDebug?.candidateSource, 'official-nearby-catalog');
    assert.equal(logs[0][1].selectionDebug?.usedLocalShift, true);
    assert.equal(logs[0][1].sourceUrl, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.equal(logs[0][1].normalizedUrl, 'https://lh3.googleusercontent.com/gg/example-token=s0-rj');
  });
});

test('handlePageImageProcessingFailure should expose source and normalized url in diagnostics payload', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const logs = [];
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.style = {};

    handlePageImageProcessingFailure({
      imageElement: image,
      sourceUrl: 'blob:https://gemini.google.com/failure-preview',
      normalizedUrl: 'blob:https://gemini.google.com/failure-preview',
      error: new Error('boom'),
      logger: createSilentLogger(),
      onLog: (type, payload) => logs.push([type, payload])
    });

    assert.equal(logs[0][0], 'page-image-process-failed');
    assert.equal(logs[0][1].sourceUrl, 'blob:https://gemini.google.com/failure-preview');
    assert.equal(logs[0][1].normalizedUrl, 'blob:https://gemini.google.com/failure-preview');
  });
});

test('applyPageImageProcessingResult should mirror processed result into the image session store', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrResponseId: 'r_store_ready',
      gwrDraftId: 'rc_store_ready',
      gwrConversationId: 'c_store_ready'
    };
    image.style = {};
    image.src = 'blob:https://gemini.google.com/store-ready';
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.width = 1024;
    image.height = 559;
    image.clientWidth = 456;
    image.clientHeight = 249;
    image.parentElement = createMockElement('div');
    image.closest = () => null;

    const processedBlob = new Blob(['processed-store'], { type: 'image/png' });

    applyPageImageProcessingResult({
      imageElement: image,
      sourceUrl: 'blob:https://gemini.google.com/store-ready',
      normalizedUrl: 'blob:https://gemini.google.com/store-ready',
      isPreviewSource: true,
      imageSessionStore,
      sourceResult: {
        skipped: false,
        processedBlob,
        selectedStrategy: 'page-fetch',
        processedMeta: {
          applied: true
        }
      },
      logger: createSilentLogger()
    });

      const snapshot = imageSessionStore.getSnapshot('draft:rc_store_ready');
      assert.equal(snapshot?.derived?.processedBlobUrl, `blob:mock:${processedBlob.size}`);
      assert.equal(snapshot?.derived?.processedBlobType, 'image/png');
      assert.equal(snapshot?.derived?.processedFrom, 'page-fetch');
      assert.equal(snapshot?.derived?.processedSlots?.preview?.objectUrl, `blob:mock:${processedBlob.size}`);
      assert.equal(snapshot?.derived?.processedSlots?.full?.objectUrl, '');
      assert.equal(snapshot?.state?.preview, 'ready');
    });
  });

test('applyPageImageProcessingResult should store non-preview processed results in the full slot', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrResponseId: 'r_store_full',
      gwrDraftId: 'rc_store_full',
      gwrConversationId: 'c_store_full'
    };
    image.style = {};
    image.src = 'https://lh3.googleusercontent.com/rd-gg/store-full=s0-rp';
    image.currentSrc = image.src;
    image.naturalWidth = 1408;
    image.naturalHeight = 768;
    image.width = 1408;
    image.height = 768;
    image.clientWidth = 704;
    image.clientHeight = 384;
    image.parentElement = createMockElement('div');
    image.closest = () => null;

    const processedBlob = new Blob(['processed-full'], { type: 'image/png' });

    applyPageImageProcessingResult({
      imageElement: image,
      sourceUrl: 'https://lh3.googleusercontent.com/rd-gg/store-full=s0-rp',
      normalizedUrl: 'https://lh3.googleusercontent.com/rd-gg/store-full=s0-rp',
      isPreviewSource: false,
      imageSessionStore,
      sourceResult: {
        skipped: false,
        processedBlob,
        selectedStrategy: 'original-download',
        processedMeta: {
          applied: true
        }
      },
      logger: createSilentLogger()
    });

    const snapshot = imageSessionStore.getSnapshot('draft:rc_store_full');
    assert.equal(snapshot?.derived?.processedSlots?.full?.objectUrl, `blob:mock:${processedBlob.size}`);
    assert.equal(snapshot?.derived?.processedSlots?.full?.processedFrom, 'original-download');
    assert.equal(snapshot?.derived?.processedSlots?.preview?.objectUrl, '');
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
    assetIds: {
      responseId: 'r_d7ef418292ede05c',
      draftId: 'rc_2315ec0b5621fce5',
      conversationId: 'c_cdec91057e5fdcaf'
    },
    imageElement,
    fetchPreviewBlob,
    processWatermarkBlobImpl,
    removeWatermarkFromBlobImpl
  });

  assert.equal(request.sourceUrl, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
  assert.deepEqual(request.assetIds, {
    responseId: 'r_d7ef418292ede05c',
    draftId: 'rc_2315ec0b5621fce5',
    conversationId: 'c_cdec91057e5fdcaf'
  });
  assert.equal(request.imageElement, imageElement);
  assert.equal(request.fetchPreviewBlob, fetchPreviewBlob);
  assert.equal(request.processWatermarkBlobImpl, processWatermarkBlobImpl);
  assert.equal(request.removeWatermarkFromBlobImpl, removeWatermarkFromBlobImpl);
  assert.equal(typeof request.captureRenderedImageBlob, 'function');
  assert.equal(typeof request.fetchBlobDirectImpl, 'function');
  assert.equal(typeof request.validateBlob, 'function');
  assert.equal(typeof request.fetchBlobFromBackgroundImpl, 'function');
});

test('bindOriginalAssetUrlToImages should attach original asset url to matching Gemini image cards', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const container = {
      querySelectorAll(selector) {
        return selector === 'button,[role="button"]' ? [{}, {}, {}] : [];
      }
    };
    const matchedImage = new MockHTMLImageElement();
    matchedImage.dataset = {
      gwrResponseId: 'r_d7ef418292ede05c',
      gwrDraftId: 'rc_2315ec0b5621fce5',
      gwrConversationId: 'c_cdec91057e5fdcaf'
    };
    matchedImage.src = 'blob:https://gemini.google.com/matched';
    matchedImage.currentSrc = matchedImage.src;
    matchedImage.naturalWidth = 1024;
    matchedImage.naturalHeight = 559;
    matchedImage.width = 1024;
    matchedImage.height = 559;
    matchedImage.clientWidth = 456;
    matchedImage.clientHeight = 249;
    matchedImage.parentElement = container;
    matchedImage.closest = (selector) => (
      selector === 'generated-image,.generated-image-container' ? container : null
    );

    const otherImage = new MockHTMLImageElement();
    otherImage.dataset = {
      gwrResponseId: 'r_other',
      gwrDraftId: 'rc_other',
      gwrConversationId: 'c_cdec91057e5fdcaf'
    };
    otherImage.src = 'blob:https://gemini.google.com/other';
    otherImage.currentSrc = otherImage.src;
    otherImage.naturalWidth = 1024;
    otherImage.naturalHeight = 559;
    otherImage.width = 1024;
    otherImage.height = 559;
    otherImage.clientWidth = 456;
    otherImage.clientHeight = 249;
    otherImage.parentElement = container;
    otherImage.closest = (selector) => (
      selector === 'generated-image,.generated-image-container' ? container : null
    );

    const root = {
      querySelectorAll() {
        return [matchedImage, otherImage];
      }
    };

    const updatedCount = bindOriginalAssetUrlToImages({
      root,
      assetIds: {
        responseId: 'r_d7ef418292ede05c',
        draftId: 'rc_2315ec0b5621fce5',
        conversationId: 'c_cdec91057e5fdcaf'
      },
      sourceUrl: 'https://lh3.googleusercontent.com/rd-gg-dl/example=s0'
    });

    assert.equal(updatedCount, 1);
    assert.equal(matchedImage.dataset.gwrSourceUrl, 'https://lh3.googleusercontent.com/rd-gg-dl/example=s0');
    assert.equal(otherImage.dataset.gwrSourceUrl, undefined);
  });
});

test('bindOriginalAssetUrlToImages should mirror original source into the image session store', async () => {
  await withPageImageTestEnv(async () => {
    const imageSessionStore = createImageSessionStore();

    bindOriginalAssetUrlToImages({
      root: {
        querySelectorAll() {
          return [];
        }
      },
      assetIds: {
        responseId: 'r_store_source',
        draftId: 'rc_store_source',
        conversationId: 'c_store_source'
      },
      sourceUrl: 'https://lh3.googleusercontent.com/rd-gg/store-source=s0-rp',
      imageSessionStore
    });

    const snapshot = imageSessionStore.getSnapshot('draft:rc_store_source');
    assert.equal(snapshot?.sources?.originalUrl, 'https://lh3.googleusercontent.com/rd-gg/store-source=s0-rp');
  });
});

test('bindOriginalAssetUrlToImages should let a matching preview-source image reuse a request-layer preview url binding', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrResponseId: 'r_preview_bind',
      gwrDraftId: 'rc_preview_bind',
      gwrConversationId: 'c_preview_bind'
    };
    image.style = {};

    bindOriginalAssetUrlToImages({
      root: {
        querySelectorAll() {
          return [image];
        }
      },
      assetIds: {
        responseId: 'r_preview_bind',
        draftId: 'rc_preview_bind',
        conversationId: 'c_preview_bind'
      },
      sourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example-preview=s0-rj?alr=yes',
      imageSessionStore
    });

    const result = preparePageImageProcessing(image, {
      HTMLImageElementClass: MockHTMLImageElement,
      imageSessionStore,
      isProcessableImage: () => true,
      resolveSourceUrl: () => 'blob:https://gemini.google.com/runtime-preview'
    });

    assert.equal(result?.sourceUrl, 'https://lh3.googleusercontent.com/gg-dl/example-preview=s0-rj?alr=yes');
    assert.equal(result?.isPreviewSource, false);
    assert.equal(image.dataset.gwrSourceUrl, 'https://lh3.googleusercontent.com/gg-dl/example-preview=s0-rj?alr=yes');
  });
});

test('bindProcessedPreviewResultToImages should apply a remembered request-layer preview blob to a matching image node', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example-preview=s0-rj?alr=yes',
      gwrResponseId: 'r_preview_apply',
      gwrDraftId: 'rc_preview_apply',
      gwrConversationId: 'c_preview_apply'
    };
    image.style = {};
    image.src = image.dataset.gwrSourceUrl;
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.width = 1024;
    image.height = 559;
    image.clientWidth = 456;
    image.clientHeight = 249;
    image.parentElement = createMockElement('div');
    image.closest = (selector) => (
      selector === 'generated-image,.generated-image-container'
        ? image.parentElement
        : null
    );

    const processedBlob = new Blob(['processed-preview'], { type: 'image/png' });
    const updatedCount = bindProcessedPreviewResultToImages({
      root: {
        querySelectorAll() {
          return [image];
        }
      },
      sourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example-preview=s1024-rj?alr=yes',
      processedBlob,
      processedFrom: 'request-preview',
      imageSessionStore
    });

    assert.equal(updatedCount, 1);
    assert.equal(image.dataset.gwrPageImageState, 'ready');
    assert.equal(typeof image.dataset.gwrWatermarkObjectUrl, 'string');
    assert.ok(image.dataset.gwrWatermarkObjectUrl.startsWith('blob:mock:'));

    const snapshot = imageSessionStore.getSnapshot('draft:rc_preview_apply');
    assert.equal(snapshot?.derived?.processedSlots?.preview?.processedFrom, 'request-preview');
    assert.equal(snapshot?.derived?.processedSlots?.preview?.blobType, 'image/png');
  });
});

test('bindProcessedPreviewResultToImages should remember preview results by session key instead of caching raw blob payloads', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example-preview-registry=s0-rj?alr=yes',
      gwrResponseId: 'r_preview_registry',
      gwrDraftId: 'rc_preview_registry',
      gwrConversationId: 'c_preview_registry'
    };
    image.style = {};
    image.src = image.dataset.gwrSourceUrl;
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.width = 1024;
    image.height = 559;
    image.clientWidth = 456;
    image.clientHeight = 249;
    image.parentElement = createMockElement('div');
    image.closest = (selector) => (
      selector === 'generated-image,.generated-image-container'
        ? image.parentElement
        : null
    );

    const processedBlob = new Blob(['processed-preview'], { type: 'image/png' });
    bindProcessedPreviewResultToImages({
      root: {
        querySelectorAll() {
          return [image];
        }
      },
      sourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example-preview-registry=s1024-rj?alr=yes',
      processedBlob,
      processedFrom: 'request-preview',
      imageSessionStore
    });

    const rememberedEntry = getRememberedPreviewResultRegistryEntryForTests(
      'https://lh3.googleusercontent.com/gg-dl/example-preview-registry=s1024-rj?alr=yes'
    );
    assert.equal(rememberedEntry?.sessionKey, 'draft:rc_preview_registry');
    assert.equal(rememberedEntry?.processedFrom, 'request-preview');
    assert.equal('processedBlob' in (rememberedEntry || {}), false);
  });
});

test('bindProcessedPreviewResultToImages should evict the oldest remembered preview results once the registry cap is exceeded', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const processedBlob = new Blob(['processed-preview'], { type: 'image/png' });

    for (let index = 0; index < 40; index += 1) {
      const image = new MockHTMLImageElement();
      image.dataset = {
        gwrSourceUrl: `https://lh3.googleusercontent.com/gg-dl/example-preview-${index}=s0-rj?alr=yes`,
        gwrResponseId: `r_preview_registry_${index}`,
        gwrDraftId: `rc_preview_registry_${index}`,
        gwrConversationId: `c_preview_registry_${index}`
      };
      image.style = {};
      image.src = image.dataset.gwrSourceUrl;
      image.currentSrc = image.src;
      image.naturalWidth = 1024;
      image.naturalHeight = 559;
      image.width = 1024;
      image.height = 559;
      image.clientWidth = 456;
      image.clientHeight = 249;
      image.parentElement = createMockElement('div');
      image.closest = (selector) => (
        selector === 'generated-image,.generated-image-container'
          ? image.parentElement
          : null
      );

      bindProcessedPreviewResultToImages({
        root: {
          querySelectorAll() {
            return [image];
          }
        },
        sourceUrl: `https://lh3.googleusercontent.com/gg-dl/example-preview-${index}=s1024-rj?alr=yes`,
        processedBlob,
        processedFrom: 'request-preview',
        imageSessionStore
      });
    }

    assert.equal(getRememberedPreviewResultRegistrySizeForTests(), 32);
    assert.equal(
      getRememberedPreviewResultRegistryEntryForTests(
        'https://lh3.googleusercontent.com/gg-dl/example-preview-0=s1024-rj?alr=yes'
      ),
      null
    );
    assert.equal(
      getRememberedPreviewResultRegistryEntryForTests(
        'https://lh3.googleusercontent.com/gg-dl/example-preview-39=s1024-rj?alr=yes'
      )?.sessionKey,
      'draft:rc_preview_registry_39'
    );
  });
});

test('bindProcessedPreviewResultToImages should not apply a remembered preview blob to an unbound blob image without explicit source mapping', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.style = {};
    image.src = 'blob:https://gemini.google.com/runtime-preview-unbound';
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.width = 1024;
    image.height = 559;
    image.clientWidth = 456;
    image.clientHeight = 249;

    const processedBlob = new Blob(['processed-preview'], { type: 'image/png' });
    const updatedCount = bindProcessedPreviewResultToImages({
      root: {
        querySelectorAll() {
          return [image];
        }
      },
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-preview-unbound=s1024-rj',
      processedBlob,
      processedFrom: 'request-preview',
      imageSessionStore
    });

    assert.equal(updatedCount, 0);
    assert.equal(image.dataset.gwrPageImageState, undefined);
    assert.equal(image.dataset.gwrWatermarkObjectUrl, undefined);
    assert.equal(image.dataset.gwrSourceUrl, undefined);
  });
});

test('preparePageImageProcessing should reuse remembered original asset urls when RPC binding arrives before the image node', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    bindOriginalAssetUrlToImages({
      root: {
        querySelectorAll() {
          return [];
        }
      },
      assetIds: {
        responseId: 'r_latebind123456789',
        draftId: 'rc_latebind123456789',
        conversationId: 'c_latebind123456789'
      },
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-late-bind=s0-rj'
    });

    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.style = {};

    const result = preparePageImageProcessing(image, {
      HTMLImageElementClass: MockHTMLImageElement,
      isProcessableImage: () => true,
      resolveSourceUrl: () => 'blob:https://gemini.google.com/runtime-preview',
      resolveAssetIds: () => ({
        responseId: 'r_latebind123456789',
        draftId: 'rc_latebind123456789',
        conversationId: 'c_latebind123456789'
      })
    });

    assert.equal(result?.sourceUrl, 'https://lh3.googleusercontent.com/gg/example-late-bind=s0-rj');
    assert.equal(image.dataset.gwrSourceUrl, 'https://lh3.googleusercontent.com/gg/example-late-bind=s0-rj');
    assert.equal(image.dataset.gwrPageImageSource, 'https://lh3.googleusercontent.com/gg/example-late-bind=s0-rj');
  });
});

test('preparePageImageProcessing should reuse request-layer preview source urls from the session store before falling back to blob capture', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const sessionKey = imageSessionStore.getOrCreateByAssetIds({
      responseId: 'r_store_preview_source',
      draftId: 'rc_store_preview_source',
      conversationId: 'c_store_preview_source'
    });
    imageSessionStore.updateSourceSnapshot(sessionKey, {
      sourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example-store-preview=s0-rj?alr=yes',
      isPreviewSource: true
    });

    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrResponseId: 'r_store_preview_source',
      gwrDraftId: 'rc_store_preview_source',
      gwrConversationId: 'c_store_preview_source'
    };
    image.style = {};
    image.src = 'blob:https://gemini.google.com/store-preview-runtime';
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.width = 1024;
    image.height = 559;
    image.clientWidth = 456;
    image.clientHeight = 249;
    image.parentElement = createMockElement('div');
    image.closest = () => null;

    const result = preparePageImageProcessing(image, {
      imageSessionStore,
      HTMLImageElementClass: MockHTMLImageElement,
      isProcessableImage: () => true
    });

    assert.equal(result?.sourceUrl, 'https://lh3.googleusercontent.com/gg-dl/example-store-preview=s0-rj?alr=yes');
    assert.equal(result?.normalizedUrl, 'https://lh3.googleusercontent.com/gg-dl/example-store-preview=s0-rj?alr=yes');
    assert.equal(result?.isPreviewSource, false);
    assert.equal(image.dataset.gwrSourceUrl, 'https://lh3.googleusercontent.com/gg-dl/example-store-preview=s0-rj?alr=yes');
    assert.equal(image.dataset.gwrPageImageSource, 'https://lh3.googleusercontent.com/gg-dl/example-store-preview=s0-rj?alr=yes');
  });
});

test('preparePageImageProcessing should attach processing image state to the image session store', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrResponseId: 'r_store_processing',
      gwrDraftId: 'rc_store_processing',
      gwrConversationId: 'c_store_processing'
    };
    image.style = {};
    image.src = 'blob:https://gemini.google.com/store-processing';
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.width = 1024;
    image.height = 559;
    image.clientWidth = 456;
    image.clientHeight = 249;
    image.parentElement = createMockElement('div');
    image.closest = () => null;

    const result = preparePageImageProcessing(image, {
      imageSessionStore,
      isProcessableImage: () => true
    });

    assert.equal(result?.sessionKey, 'draft:rc_store_processing');
    const snapshot = imageSessionStore.getSnapshot('draft:rc_store_processing');
    assert.equal(snapshot?.state?.preview, 'processing');
    assert.equal(snapshot?.sources?.currentBlobUrl, 'blob:https://gemini.google.com/store-processing');
    assert.equal(snapshot?.surfaces?.previewCount, 1);
  });
});

test('buildRecentImageSourceHint should capture source url and asset ids from the clicked preview image', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj'
    };
    image.naturalWidth = 1024;
    image.naturalHeight = 559;

    const hint = buildRecentImageSourceHint(image, {
      now: 1234,
      resolveAssetIds: () => ({
        responseId: 'r_hint123',
        draftId: 'rc_hint123',
        conversationId: 'c_hint123'
      })
    });

    assert.deepEqual(hint, {
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      createdAt: 1234,
      size: {
        width: 1024,
        height: 559
      },
      assetIds: {
        responseId: 'r_hint123',
        draftId: 'rc_hint123',
        conversationId: 'c_hint123'
      }
    });
  });
});

test('buildRecentImageSourceHint should retain asset ids even when the clicked preview image only has a blob source', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrResponseId: 'r_hint123',
      gwrDraftId: 'rc_hint123',
      gwrConversationId: 'c_hint123'
    };
    image.src = 'blob:https://gemini.google.com/runtime-preview';
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? {}
      : null;

    const hint = buildRecentImageSourceHint(image, {
      now: 1234
    });

    assert.deepEqual(hint, {
      sourceUrl: '',
      createdAt: 1234,
      size: {
        width: 1024,
        height: 559
      },
      assetIds: {
        responseId: 'r_hint123',
        draftId: 'rc_hint123',
        conversationId: 'c_hint123'
      }
    });
  });
});

test('applyRecentImageSourceHintToImage should promote a fullscreen blob image to the clicked preview source', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.src = 'blob:https://gemini.google.com/fullscreen-cached';
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.clientWidth = 951;
    image.clientHeight = 519;
    image.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? {}
      : null;

    const applied = applyRecentImageSourceHintToImage(image, {
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      createdAt: 1000,
      size: {
        width: 1024,
        height: 559
      },
      assetIds: {
        responseId: 'r_hint123',
        draftId: 'rc_hint123',
        conversationId: 'c_hint123'
      }
    }, {
      now: 2000
    });

    assert.equal(applied, true);
    assert.equal(image.dataset.gwrSourceUrl, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.equal(image.dataset.gwrResponseId, 'r_hint123');
    assert.equal(image.dataset.gwrDraftId, 'rc_hint123');
    assert.equal(image.dataset.gwrConversationId, 'c_hint123');
  });
});

test('applyRecentImageSourceHintToImage should ignore stale hints for fullscreen blob images', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.src = 'blob:https://gemini.google.com/fullscreen-cached';
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? {}
      : null;

    const applied = applyRecentImageSourceHintToImage(image, {
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      createdAt: 1000,
      size: {
        width: 1024,
        height: 559
      },
      assetIds: {
        responseId: 'r_hint123',
        draftId: 'rc_hint123',
        conversationId: 'c_hint123'
      }
    }, {
      now: 7001
    });

    assert.equal(applied, false);
    assert.equal(image.dataset.gwrSourceUrl, undefined);
  });
});

test('applyRecentImageSourceHintToImage should ignore mismatched asset ids on fullscreen blob images', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrResponseId: 'r_actual123',
      gwrDraftId: 'rc_actual123',
      gwrConversationId: 'c_actual123'
    };
    image.src = 'blob:https://gemini.google.com/fullscreen-cached';
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? {}
      : null;

    const applied = applyRecentImageSourceHintToImage(image, {
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      createdAt: 1000,
      size: {
        width: 1024,
        height: 559
      },
      assetIds: {
        responseId: 'r_hint123',
        draftId: 'rc_hint123',
        conversationId: 'c_hint123'
      }
    }, {
      now: 2000
    });

    assert.equal(applied, false);
    assert.equal(image.dataset.gwrSourceUrl, undefined);
  });
});

test('applyRecentImageSourceHintToImage should transfer asset ids to fullscreen blob images even when preview source url is unavailable', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const image = new MockHTMLImageElement();
    image.dataset = {};
    image.src = 'blob:https://gemini.google.com/fullscreen-cached';
    image.currentSrc = image.src;
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
    image.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? {}
      : null;

    const applied = applyRecentImageSourceHintToImage(image, {
      sourceUrl: '',
      createdAt: 1000,
      size: {
        width: 1024,
        height: 559
      },
      assetIds: {
        responseId: 'r_hint123',
        draftId: 'rc_hint123',
        conversationId: 'c_hint123'
      }
    }, {
      now: 2000
    });

    assert.equal(applied, true);
    assert.equal(image.dataset.gwrSourceUrl, undefined);
    assert.equal(image.dataset.gwrResponseId, 'r_hint123');
    assert.equal(image.dataset.gwrDraftId, 'rc_hint123');
    assert.equal(image.dataset.gwrConversationId, 'c_hint123');
  });
});

test('createPageImageReplacementController should reuse clicked preview source for a fullscreen blob image without asset ids', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const listeners = new Map();
    const targetDocument = {
      readyState: 'complete',
      body: {},
      documentElement: {},
      querySelectorAll() {
        return [];
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type) {
        listeners.delete(type);
      }
    };
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };

    const previewImage = new MockHTMLImageElement();
    previewImage.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
      gwrResponseId: 'r_hint123',
      gwrDraftId: 'rc_hint123',
      gwrConversationId: 'c_hint123'
    };
    previewImage.src = previewImage.dataset.gwrSourceUrl;
    previewImage.currentSrc = previewImage.src;
    previewImage.naturalWidth = 1024;
    previewImage.naturalHeight = 559;
    previewImage.clientWidth = 512;
    previewImage.clientHeight = 280;
    previewImage.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? previewContainer
      : null;

    const previewContainer = {
      querySelector(selector) {
        return selector === 'img' ? previewImage : null;
      }
    };

    const fullscreenImage = new MockHTMLImageElement();
    fullscreenImage.dataset = {};
    fullscreenImage.src = 'blob:https://gemini.google.com/fullscreen-cached';
    fullscreenImage.currentSrc = fullscreenImage.src;
    fullscreenImage.naturalWidth = 1024;
    fullscreenImage.naturalHeight = 559;
    fullscreenImage.clientWidth = 951;
    fullscreenImage.clientHeight = 519;
    fullscreenImage.style = {};
    fullscreenImage.closest = (selector) => {
      if (selector === 'generated-image,.generated-image-container') return {};
      if (selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane') return {};
      return null;
    };

    const seenSources = [];
    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      targetDocument,
      processPageImageSourceImpl: async ({ sourceUrl }) => {
        seenSources.push(sourceUrl);
        return {
          skipped: true,
          reason: 'test-stop'
        };
      }
    });

    controller.install();
    listeners.get('pointerdown')?.({
      target: {
        closest(selector) {
          return selector === 'generated-image,.generated-image-container'
            ? previewContainer
            : null;
        }
      }
    });

    controller.processRoot({
      querySelectorAll() {
        return [fullscreenImage];
      }
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(seenSources, ['https://lh3.googleusercontent.com/gg/example-token=s1024-rj']);
    assert.equal(fullscreenImage.dataset.gwrSourceUrl, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    controller.dispose();
  });
});

test('createPageImageReplacementController should reuse fullscreen dialog source hints from action buttons', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const listeners = new Map();
    const targetDocument = {
      readyState: 'complete',
      body: {},
      documentElement: {},
      querySelectorAll() {
        return [];
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type) {
        listeners.delete(type);
      }
    };
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };

    const fullscreenSourceImage = new MockHTMLImageElement();
    fullscreenSourceImage.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg/fullscreen-token=s1024-rj',
      gwrResponseId: 'r_fullscreen_hint',
      gwrDraftId: 'rc_fullscreen_hint',
      gwrConversationId: 'c_fullscreen_hint'
    };
    fullscreenSourceImage.src = 'blob:https://gemini.google.com/fullscreen-processed';
    fullscreenSourceImage.currentSrc = fullscreenSourceImage.src;
    fullscreenSourceImage.naturalWidth = 1024;
    fullscreenSourceImage.naturalHeight = 559;
    fullscreenSourceImage.clientWidth = 951;
    fullscreenSourceImage.clientHeight = 519;
    fullscreenSourceImage.closest = (selector) => {
      if (selector === 'generated-image,.generated-image-container') return {};
      if (selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane') return fullscreenDialog;
      return null;
    };

    const fullscreenDialog = {
      querySelector(selector) {
        return selector === 'img' ? fullscreenSourceImage : null;
      }
    };

    const refreshedFullscreenImage = new MockHTMLImageElement();
    refreshedFullscreenImage.dataset = {};
    refreshedFullscreenImage.src = 'blob:https://gemini.google.com/fullscreen-refreshed';
    refreshedFullscreenImage.currentSrc = refreshedFullscreenImage.src;
    refreshedFullscreenImage.naturalWidth = 1024;
    refreshedFullscreenImage.naturalHeight = 559;
    refreshedFullscreenImage.clientWidth = 951;
    refreshedFullscreenImage.clientHeight = 519;
    refreshedFullscreenImage.complete = true;
    refreshedFullscreenImage.style = {};
    refreshedFullscreenImage.closest = (selector) => {
      if (selector === 'generated-image,.generated-image-container') return {};
      if (selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane') return fullscreenDialog;
      return null;
    };

    const seenSources = [];
    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      targetDocument,
      processPageImageSourceImpl: async ({ sourceUrl }) => {
        seenSources.push(sourceUrl);
        return {
          skipped: true,
          reason: 'test-stop'
        };
      }
    });

    controller.install();
    listeners.get('pointerdown')?.({
      target: {
        closest(selector) {
          return selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane'
            ? fullscreenDialog
            : null;
        }
      }
    });

    controller.processRoot({
      querySelectorAll() {
        return [refreshedFullscreenImage];
      }
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(seenSources, ['https://lh3.googleusercontent.com/gg/fullscreen-token=s1024-rj']);
    assert.equal(refreshedFullscreenImage.dataset.gwrSourceUrl, 'https://lh3.googleusercontent.com/gg/fullscreen-token=s1024-rj');
    assert.equal(refreshedFullscreenImage.dataset.gwrDraftId, 'rc_fullscreen_hint');
    controller.dispose();
  });
});

test('createPageImageReplacementController should reuse full processed session blobs for refreshed fullscreen images', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const imageSessionStore = createImageSessionStore();
    const sessionKey = imageSessionStore.getOrCreateByAssetIds({
      responseId: 'r_fullscreen_full_cache',
      draftId: 'rc_fullscreen_full_cache',
      conversationId: 'c_fullscreen_full_cache'
    });
    const fullProcessedBlob = new Blob(['fullscreen-full-processed'], { type: 'image/png' });
    imageSessionStore.updateProcessedResult(sessionKey, {
      slot: 'full',
      objectUrl: 'blob:https://gemini.google.com/full-cache',
      blob: fullProcessedBlob,
      blobType: 'image/png',
      processedFrom: 'original-clipboard'
    });

    const fullscreenImage = new MockHTMLImageElement();
    fullscreenImage.dataset = {
      gwrResponseId: 'r_fullscreen_full_cache',
      gwrDraftId: 'rc_fullscreen_full_cache',
      gwrConversationId: 'c_fullscreen_full_cache'
    };
    fullscreenImage.src = 'blob:https://gemini.google.com/fullscreen-refreshed-after-copy';
    fullscreenImage.currentSrc = fullscreenImage.src;
    fullscreenImage.naturalWidth = 1024;
    fullscreenImage.naturalHeight = 559;
    fullscreenImage.clientWidth = 951;
    fullscreenImage.clientHeight = 519;
    fullscreenImage.complete = true;
    fullscreenImage.style = {};
    fullscreenImage.closest = (selector) => {
      if (selector === 'generated-image,.generated-image-container') return {};
      if (selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane') return {};
      return null;
    };

    let processCalls = 0;
    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      imageSessionStore,
      processPageImageSourceImpl: async () => {
        processCalls += 1;
        return {
          skipped: true,
          reason: 'should-not-process'
        };
      }
    });

    controller.processRoot({
      querySelectorAll() {
        return [fullscreenImage];
      }
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(processCalls, 0);
    assert.equal(fullscreenImage.dataset.gwrPageImageState, 'ready');
    assert.equal(fullscreenImage.dataset.gwrWatermarkObjectUrl, `blob:mock:${fullProcessedBlob.size}`);
    controller.dispose();
  });
});

test('createPageImageReplacementController should reuse remembered original asset urls for fullscreen blob images when clicked preview only exposes asset ids', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const listeners = new Map();
    const targetDocument = {
      readyState: 'complete',
      body: {},
      documentElement: {},
      querySelectorAll() {
        return [];
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type) {
        listeners.delete(type);
      }
    };
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };

    bindOriginalAssetUrlToImages({
      root: {
        querySelectorAll() {
          return [];
        }
      },
      assetIds: {
        responseId: 'r_hint123',
        draftId: 'rc_hint123',
        conversationId: 'c_hint123'
      },
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s0-rj'
    });

    const previewImage = new MockHTMLImageElement();
    previewImage.dataset = {
      gwrResponseId: 'r_hint123',
      gwrDraftId: 'rc_hint123',
      gwrConversationId: 'c_hint123'
    };
    previewImage.src = 'blob:https://gemini.google.com/runtime-preview';
    previewImage.currentSrc = previewImage.src;
    previewImage.naturalWidth = 1024;
    previewImage.naturalHeight = 559;
    previewImage.clientWidth = 512;
    previewImage.clientHeight = 280;
    previewImage.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? previewContainer
      : null;

    const previewContainer = {
      querySelector(selector) {
        return selector === 'img' ? previewImage : null;
      }
    };

    const fullscreenImage = new MockHTMLImageElement();
    fullscreenImage.dataset = {};
    fullscreenImage.src = 'blob:https://gemini.google.com/fullscreen-cached';
    fullscreenImage.currentSrc = fullscreenImage.src;
    fullscreenImage.naturalWidth = 1024;
    fullscreenImage.naturalHeight = 559;
    fullscreenImage.clientWidth = 951;
    fullscreenImage.clientHeight = 519;
    fullscreenImage.style = {};
    fullscreenImage.closest = (selector) => {
      if (selector === 'generated-image,.generated-image-container') return {};
      if (selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane') return {};
      return null;
    };

    const seenSources = [];
    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      targetDocument,
      processPageImageSourceImpl: async ({ sourceUrl }) => {
        seenSources.push(sourceUrl);
        return {
          skipped: true,
          reason: 'test-stop'
        };
      }
    });

    controller.install();
    listeners.get('pointerdown')?.({
      target: {
        closest(selector) {
          return selector === 'generated-image,.generated-image-container'
            ? previewContainer
            : null;
        }
      }
    });

    controller.processRoot({
      querySelectorAll() {
        return [fullscreenImage];
      }
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(seenSources, ['https://lh3.googleusercontent.com/gg/example-token=s0-rj']);
    assert.equal(fullscreenImage.dataset.gwrSourceUrl, 'https://lh3.googleusercontent.com/gg/example-token=s0-rj');
    assert.equal(fullscreenImage.dataset.gwrDraftId, 'rc_hint123');
    controller.dispose();
  });
});

test('createPageImageReplacementController should not adopt a single remembered preview blob onto an unrelated blob image', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const targetDocument = {
      readyState: 'complete',
      body: {},
      documentElement: {},
      querySelectorAll() {
        return [];
      },
      addEventListener() {},
      removeEventListener() {}
    };
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };

    const fullscreenImage = new MockHTMLImageElement();
    fullscreenImage.dataset = {};
    fullscreenImage.src = 'blob:https://gemini.google.com/fullscreen-unrelated';
    fullscreenImage.currentSrc = fullscreenImage.src;
    fullscreenImage.naturalWidth = 1024;
    fullscreenImage.naturalHeight = 559;
    fullscreenImage.clientWidth = 951;
    fullscreenImage.clientHeight = 519;
    fullscreenImage.style = {};
    fullscreenImage.closest = () => ({});

    bindProcessedPreviewResultToImages({
      root: {
        querySelectorAll() {
          return [];
        }
      },
      sourceUrl: 'https://lh3.googleusercontent.com/gg/example-remembered=s1024-rj',
      processedBlob: new Blob(['processed-preview'], { type: 'image/png' }),
      processedFrom: 'request-preview'
    });

    const seenSources = [];
    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      targetDocument,
      processPageImageSourceImpl: async ({ sourceUrl }) => {
        seenSources.push(sourceUrl);
        return {
          skipped: true,
          reason: 'test-stop'
        };
      }
    });

    controller.install();
    controller.processRoot({
      querySelectorAll() {
        return [fullscreenImage];
      }
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(seenSources, []);
    assert.equal(fullscreenImage.dataset.gwrWatermarkObjectUrl, undefined);
    assert.equal(fullscreenImage.dataset.gwrSourceUrl, undefined);
    controller.dispose();
  });
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
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
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
    assert.equal(image.src, 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj');
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].dataset.gwrPreviewImage, 'true');
    assert.equal(container.children[0].style.backgroundImage, `url(\"blob:mock:${previewBlob.size}\")`);
    assert.deepEqual(
      logs.map(([type]) => type),
      ['page-image-process-start', 'page-image-process-success']
    );
    assert.equal(logs[1][1].strategy, 'page-fetch');
  });
});

test('applyPageImageProcessingResult should keep preview overlay constrained to the rendered image box instead of the whole Gemini container', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const processedBlob = new Blob(['processed'], { type: 'image/png' });
    const container = createMockElement('div');
    container.getBoundingClientRect = () => ({
      left: 100,
      top: 80,
      width: 900,
      height: 700
    });

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
    image.getBoundingClientRect = () => ({
      left: 140,
      top: 120,
      width: 640,
      height: 360
    });

    applyPageImageProcessingResult({
      imageElement: image,
      sourceUrl: image.src,
      normalizedUrl: image.src,
      sourceResult: {
        skipped: false,
        processedBlob,
        selectedStrategy: 'page-fetch'
      },
      logger: createSilentLogger()
    });

    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].dataset.gwrPreviewImage, 'true');
    assert.equal(container.children[0].style.inset, 'auto');
    assert.equal(container.children[0].style.left, '40px');
    assert.equal(container.children[0].style.top, '40px');
    assert.equal(container.children[0].style.width, '640px');
    assert.equal(container.children[0].style.height, '360px');
  });
});

test('applyPageImageProcessingResult should keep the original Gemini image visible for native copy compatibility', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const processedBlob = new Blob(['processed'], { type: 'image/png' });
    const container = createMockElement('div');

    const image = new MockHTMLImageElement();
    image.dataset = {
      gwrSourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj'
    };
    image.style = {
      opacity: '1'
    };
    image.src = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
    image.currentSrc = image.src;
    image.parentElement = container;
    image.closest = (selector) => selector === 'generated-image,.generated-image-container'
      ? container
      : null;
    image.getBoundingClientRect = () => ({
      left: 140,
      top: 120,
      width: 640,
      height: 360
    });
    container.getBoundingClientRect = () => ({
      left: 100,
      top: 80,
      width: 900,
      height: 700
    });

    applyPageImageProcessingResult({
      imageElement: image,
      sourceUrl: image.src,
      normalizedUrl: image.src,
      sourceResult: {
        skipped: false,
        processedBlob,
        selectedStrategy: 'page-fetch'
      },
      logger: createSilentLogger()
    });

    assert.equal(image.style.opacity, '1');
  });
});

test('applyPageImageProcessingResult should mount preview overlay inside overlay-container before generated-image-controls', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const processedBlob = new Blob(['processed'], { type: 'image/png' });
    const controls = createMockElement('div');
    controls.className = 'generated-image-controls';
    const overlayContainer = createMockElement('div');
    overlayContainer.className = 'overlay-container';
    overlayContainer.insertBefore = (child, referenceNode) => {
      child.parentNode = overlayContainer;
      const index = overlayContainer.children.indexOf(referenceNode);
      if (index === -1) {
        overlayContainer.children.push(child);
      } else {
        overlayContainer.children.splice(index, 0, child);
      }
      return child;
    };
    const imageContainer = createMockElement('div');
    imageContainer.className = 'image-container';
    const singleImage = createMockElement('single-image');
    singleImage.className = 'generated-image large';
    const container = createMockElement('div');
    container.getBoundingClientRect = () => ({
      left: 100,
      top: 80,
      width: 900,
      height: 700
    });
    container.querySelector = (selector) => selector === '.generated-image-controls' ? controls : null;
    container.insertBefore = (child, referenceNode) => {
      child.parentNode = container;
      const index = container.children.indexOf(referenceNode);
      if (index === -1) {
        container.children.push(child);
      } else {
        container.children.splice(index, 0, child);
      }
      return child;
    };
    overlayContainer.appendChild(controls);
    imageContainer.appendChild(overlayContainer);
    singleImage.appendChild(imageContainer);
    container.appendChild(singleImage);

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
    image.getBoundingClientRect = () => ({
      left: 140,
      top: 120,
      width: 640,
      height: 360
    });

    applyPageImageProcessingResult({
      imageElement: image,
      sourceUrl: image.src,
      normalizedUrl: image.src,
      sourceResult: {
        skipped: false,
        processedBlob,
        selectedStrategy: 'page-fetch'
      },
      logger: createSilentLogger()
    });

    const overlayIndex = container.children.findIndex((child) => child.dataset?.gwrPreviewImage === 'true');
    const controlsIndex = overlayContainer.children.indexOf(controls);
    const previewIndex = overlayContainer.children.findIndex((child) => child.dataset?.gwrPreviewImage === 'true');

    assert.equal(overlayIndex, -1);
    assert.notEqual(previewIndex, -1);
    assert.notEqual(controlsIndex, -1);
    assert.ok(previewIndex < controlsIndex);
    assert.equal(overlayContainer.children[previewIndex].parentNode, overlayContainer);
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
    image.naturalWidth = 1024;
    image.naturalHeight = 559;
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
      ['page-image-process-start', 'page-image-process-skipped']
    );
    assert.equal(logs[1][1].reason, 'preview-fetch-unavailable');
  });
});

test('createPageImageReplacementController should process at most one image per scheduled idle drain', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const scheduledDrains = [];
    const started = [];
    const resolvers = [];

    const makeImage = (id) => {
      const container = createMockElement('div');
      const image = new MockHTMLImageElement();
      image.dataset = {
        gwrSourceUrl: `https://lh3.googleusercontent.com/gg/${id}=s1024-rj`,
        testId: id
      };
      image.style = {};
      image.src = image.dataset.gwrSourceUrl;
      image.currentSrc = image.src;
      image.naturalWidth = 1024;
      image.naturalHeight = 559;
      image.parentElement = container;
      image.closest = (selector) => selector === 'generated-image,.generated-image-container'
        ? container
        : null;
      return image;
    };

    const imageA = makeImage('a');
    const imageB = makeImage('b');

    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      scheduleProcessingDrain(callback) {
        scheduledDrains.push(callback);
      },
      processPageImageSourceImpl: async ({ imageElement }) => {
        started.push(imageElement.dataset.testId);
        return await new Promise((resolve) => {
          resolvers.push(() => resolve({
            skipped: true,
            reason: 'preview-fetch-unavailable',
            candidateDiagnostics: [{ strategy: 'page-fetch', status: 'error' }],
            candidateDiagnosticsSummary: 'page-fetch,error'
          }));
        });
      }
    });

    controller.processRoot({
      querySelectorAll() {
        return [imageA, imageB];
      }
    });

    assert.equal(started.length, 0);
    assert.equal(scheduledDrains.length, 1);

    scheduledDrains[0]();
    await Promise.resolve();

    assert.deepEqual(started, ['a']);

    resolvers[0]();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(started, ['a']);
    assert.equal(scheduledDrains.length, 2);

    scheduledDrains[1]();
    await Promise.resolve();

    assert.deepEqual(started, ['a', 'b']);
  });
});

test('createPageImageReplacementController should prioritize fullscreen images ahead of queued preview images', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const scheduledDrains = [];
    const started = [];

    const makeImage = (id, { fullscreen = false } = {}) => {
      const container = createMockElement('div');
      const image = new MockHTMLImageElement();
      image.dataset = {
        gwrSourceUrl: `https://lh3.googleusercontent.com/gg/${id}=s1024-rj`,
        testId: id
      };
      image.style = {};
      image.src = image.dataset.gwrSourceUrl;
      image.currentSrc = image.src;
      image.naturalWidth = 1024;
      image.naturalHeight = 559;
      image.parentElement = container;
      image.closest = (selector) => {
        if (selector === 'generated-image,.generated-image-container') {
          return container;
        }
        if (fullscreen && selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane') {
          return {};
        }
        return null;
      };
      return image;
    };

    const previewImage = makeImage('preview');
    const fullscreenImage = makeImage('fullscreen', { fullscreen: true });

    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      scheduleProcessingDrain(callback) {
        scheduledDrains.push(callback);
      },
      processPageImageSourceImpl: async ({ imageElement }) => ({
        skipped: true,
        reason: `processed-${started.push(imageElement.dataset.testId)}`,
        candidateDiagnostics: [{ strategy: 'page-fetch', status: 'error' }],
        candidateDiagnosticsSummary: 'page-fetch,error'
      })
    });

    controller.processRoot({
      querySelectorAll() {
        return [previewImage, fullscreenImage];
      }
    });

    assert.equal(scheduledDrains.length, 1);

    scheduledDrains[0]();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(started, ['fullscreen']);
  });
});

test('createPageImageReplacementController should defer incomplete preview images without blocking later ready images', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const scheduledDrains = [];
    const timers = [];
    const started = [];

    const makeImage = (id, {
      complete = true,
      naturalWidth = 1024,
      naturalHeight = 559,
      clientWidth = 456,
      clientHeight = 249,
      sourceUrl = `blob:https://gemini.google.com/${id}`
    } = {}) => {
      const actionCluster = {
        querySelectorAll: () => [{}, {}, {}],
        parentElement: null
      };
      const listeners = new Map();
      const image = new MockHTMLImageElement();
      image.dataset = {
        gwrSourceUrl: sourceUrl,
        testId: id
      };
      image.style = {};
      image.src = sourceUrl;
      image.currentSrc = image.src;
      image.complete = complete;
      image.naturalWidth = naturalWidth;
      image.naturalHeight = naturalHeight;
      image.clientWidth = clientWidth;
      image.clientHeight = clientHeight;
      image.parentElement = actionCluster;
      image.closest = () => null;
      image.addEventListener = (type, listener) => {
        listeners.set(type, listener);
      };
      image.removeEventListener = (type) => {
        listeners.delete(type);
      };
      image.emit = (type) => {
        listeners.get(type)?.();
      };
      return image;
    };

    const delayedImage = makeImage('delayed', {
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
      clientWidth: 456,
      clientHeight: 249
    });
    const readyImage = makeImage('ready');

    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      scheduleProcessingDrain(callback) {
        scheduledDrains.push(callback);
      },
      setTimeoutImpl(callback, delay) {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeoutImpl() {},
      processPageImageSourceImpl: async ({ imageElement }) => {
        started.push(imageElement.dataset.testId);
        return {
          skipped: true,
          reason: 'preview-fetch-unavailable',
          candidateDiagnostics: [{ strategy: 'page-fetch', status: 'error' }],
          candidateDiagnosticsSummary: 'page-fetch,error'
        };
      }
    });

    controller.processRoot({
      querySelectorAll() {
        return [delayedImage, readyImage];
      }
    });

    assert.equal(scheduledDrains.length, 1);

    scheduledDrains[0]();
    await Promise.resolve();

    assert.deepEqual(started, []);
    assert.equal(delayedImage.dataset.gwrPageImageState, undefined);
    assert.equal(timers.length, 1);
    assert.equal(scheduledDrains.length, 2);

    scheduledDrains[1]();
    await Promise.resolve();

    assert.deepEqual(started, ['ready']);
    assert.equal(readyImage.dataset.gwrPageImageState, 'skipped');

    delayedImage.complete = true;
    delayedImage.naturalWidth = 1024;
    delayedImage.naturalHeight = 559;
    delayedImage.emit('load');
    await Promise.resolve();

    assert.equal(scheduledDrains.length, 3);

    scheduledDrains[2]();
    await Promise.resolve();

    assert.deepEqual(started, ['ready', 'delayed']);
    assert.equal(delayedImage.dataset.gwrPageImageState, 'skipped');
  });
});

test('createPageImageReplacementController should defer zero-sized rendered images even when an original url is bound', async () => {
  await withPageImageTestEnv(async ({ MockHTMLImageElement }) => {
    const scheduledDrains = [];
    const timers = [];
    const started = [];

    const makeImage = ({ id, sourceUrl, renderedUrl, complete, naturalWidth, naturalHeight }) => {
      const container = createMockElement('div');
      const image = new MockHTMLImageElement();
      image.dataset = {
        gwrSourceUrl: sourceUrl,
        testId: id
      };
      image.style = {};
      image.src = renderedUrl;
      image.currentSrc = renderedUrl;
      image.complete = complete;
      image.naturalWidth = naturalWidth;
      image.naturalHeight = naturalHeight;
      image.parentElement = container;
      image.closest = (selector) => selector === 'generated-image,.generated-image-container'
        ? container
        : null;
      image.addEventListener = () => {};
      image.removeEventListener = () => {};
      return image;
    };

    const transientSourceImage = makeImage({
      id: 'transient-source',
      sourceUrl: 'https://lh3.googleusercontent.com/gg/transient=s0',
      renderedUrl: 'https://lh3.googleusercontent.com/gg/transient=s0',
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0
    });
    const delayedBlobImage = makeImage({
      id: 'delayed',
      sourceUrl: 'https://lh3.googleusercontent.com/gg/delayed=s0',
      renderedUrl: 'blob:https://gemini.google.com/delayed',
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0
    });
    const readyImage = makeImage({
      id: 'ready',
      sourceUrl: 'https://lh3.googleusercontent.com/gg/ready=s0',
      renderedUrl: 'https://lh3.googleusercontent.com/gg/ready=s0',
      complete: true,
      naturalWidth: 1024,
      naturalHeight: 559
    });

    const controller = createPageImageReplacementController({
      logger: createSilentLogger(),
      scheduleProcessingDrain(callback) {
        scheduledDrains.push(callback);
      },
      setTimeoutImpl(callback, delay) {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeoutImpl() {},
      processPageImageSourceImpl: async ({ imageElement }) => {
        started.push(imageElement.dataset.testId);
        return {
          skipped: true,
          reason: 'preview-fetch-unavailable',
          candidateDiagnostics: [{ strategy: 'page-fetch', status: 'error' }],
          candidateDiagnosticsSummary: 'page-fetch,error'
        };
      }
    });

    controller.processRoot({
      querySelectorAll() {
        return [transientSourceImage, delayedBlobImage, readyImage];
      }
    });

    scheduledDrains[0]();
    await Promise.resolve();

    assert.deepEqual(started, []);
    assert.equal(transientSourceImage.dataset.gwrPageImageState, undefined);
    assert.equal(timers.length, 1);
    assert.equal(scheduledDrains.length, 2);

    scheduledDrains[1]();
    await Promise.resolve();

    assert.deepEqual(started, []);
    assert.equal(delayedBlobImage.dataset.gwrPageImageState, undefined);
    assert.equal(timers.length, 2);
    assert.equal(scheduledDrains.length, 3);

    scheduledDrains[2]();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(started, ['ready']);
    assert.equal(readyImage.dataset.gwrPageImageState, 'skipped');
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

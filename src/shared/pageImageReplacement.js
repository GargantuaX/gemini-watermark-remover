import { canvasToBlob } from '../core/canvasBlob.js';
import { classifyGeminiAttributionFromWatermarkMeta } from '../core/watermarkDecisionPolicy.js';
import {
  isGeminiPreviewAssetUrl,
  normalizeGoogleusercontentImageUrl
} from '../userscript/urlUtils.js';
import { normalizeErrorMessage } from './errorUtils.js';
import { acquireOriginalBlob } from './originalBlob.js';
import {
  getGeminiImageContainerSelector,
  getGeminiImageQuerySelector,
  getPreferredGeminiImageContainer,
  isProcessableGeminiImageElement,
  resolveCandidateImageUrl
} from './domAdapter.js';
import { loadImageFromBlob, processWatermarkBlob, removeWatermarkFromBlob } from './imageProcessing.js';

const PAGE_IMAGE_STATE_KEY = 'gwrPageImageState';
const PAGE_IMAGE_SOURCE_KEY = 'gwrPageImageSource';
const PAGE_IMAGE_OBJECT_URL_KEY = 'gwrWatermarkObjectUrl';
const PROCESSING_OVERLAY_DATA_KEY = 'gwrProcessingOverlay';
const PROCESSING_VISUAL_DATA_KEY = 'gwrProcessingVisual';
const OBSERVED_ATTRIBUTES = ['src', 'srcset', 'data-gwr-source-url'];
const PAGE_FETCH_REQUEST = 'gwr:page-fetch-request';
const PAGE_FETCH_RESPONSE = 'gwr:page-fetch-response';
const PROCESSING_OVERLAY_FADE_MS = 180;
const MIN_VISIBLE_CAPTURE_EDGE = 32;
const MIN_VISIBLE_CAPTURE_AREA = MIN_VISIBLE_CAPTURE_EDGE * MIN_VISIBLE_CAPTURE_EDGE;
const CONTAINER_CAPTURE_AREA_RATIO = 4;

const processingOverlayState = new WeakMap();

function appendLog(onLog, type, payload = {}) {
  if (typeof onLog === 'function') {
    onLog(type, payload);
  }
}

function emitPageImageProcessEvent({
  logger,
  onLog,
  level = 'info',
  consoleMessage,
  eventType,
  payload
}) {
  logger?.[level]?.(consoleMessage, payload);
  appendLog(onLog, eventType, payload);
}

function getErrorCandidateDiagnostics(error) {
  return Array.isArray(error?.candidateDiagnostics) ? error.candidateDiagnostics : null;
}

function getErrorCandidateDiagnosticsSummary(error) {
  return typeof error?.candidateDiagnosticsSummary === 'string'
    ? error.candidateDiagnosticsSummary
    : '';
}

function createPreviewCandidateProcessor(processWatermarkBlobImpl) {
  return async (candidate) => {
    const originalBlob = await candidate.getOriginalBlob();
    try {
      const processedResult = await processWatermarkBlobImpl(originalBlob);
      return {
        ...processedResult,
        sourceBlobType: originalBlob.type || '',
        sourceBlobSize: originalBlob.size || 0
      };
    } catch (error) {
      if (error && typeof error === 'object') {
        error.sourceBlobType = originalBlob.type || '';
        error.sourceBlobSize = originalBlob.size || 0;
      }
      throw error;
    }
  };
}

async function fetchBlobDirect(url) {
  const response = await fetch(url, {
    credentials: 'omit',
    redirect: 'follow'
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  return response.blob();
}

export async function fetchBlobFromBackground(url, fallbackFetchBlob = null) {
  if (typeof fallbackFetchBlob === 'function') {
    return fallbackFetchBlob(url);
  }
  return fetchBlobDirect(url);
}

let pageFetchRequestCounter = 0;

async function fetchBlobViaPageBridge(url, timeoutMs = 15000) {
  if (typeof window === 'undefined' || typeof window.postMessage !== 'function' || typeof window.addEventListener !== 'function') {
    throw new Error('Page fetch bridge unavailable');
  }

  const requestId = `gwr-page-fetch-${Date.now()}-${pageFetchRequestCounter += 1}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handleMessage);
      globalThis.clearTimeout(timeoutId);
    };

    const handleMessage = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== PAGE_FETCH_RESPONSE) return;
      if (event.data?.requestId !== requestId) return;

      cleanup();

      if (event.data?.ok === false) {
        reject(new Error(normalizeErrorMessage(event.data?.error, 'Page fetch failed')));
        return;
      }

      const blobMimeType = resolveFetchedImageMimeType(event.data?.mimeType, event.data?.buffer);
      resolve(new Blob([event.data.buffer], { type: blobMimeType }));
    };

    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error('Page fetch bridge timed out'));
    }, timeoutMs);

    window.addEventListener('message', handleMessage);
    window.postMessage({
      type: PAGE_FETCH_REQUEST,
      requestId,
      url
    }, '*');
  });
}

async function imageElementToBlob(imageElement) {
  const { width, height } = await waitForRenderableImageSize(imageElement);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2D canvas context unavailable');
  }
  context.drawImage(imageElement, 0, 0, width, height);
  return canvasToBlob(canvas);
}

function normalizeCaptureRect(rect) {
  if (!rect || typeof rect !== 'object') return null;

  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);

  if (![left, top, width, height].every(Number.isFinite)) {
    return null;
  }

  return {
    left,
    top,
    width: Math.max(0, width),
    height: Math.max(0, height)
  };
}

function getCaptureRectArea(rect) {
  if (!rect) return 0;
  return rect.width * rect.height;
}

function getViewportRect() {
  const viewport = globalThis.visualViewport;
  const width = Number(viewport?.width) || Math.max(window.innerWidth, 0);
  const height = Number(viewport?.height) || Math.max(window.innerHeight, 0);

  return {
    left: 0,
    top: 0,
    width: Math.max(0, width),
    height: Math.max(0, height)
  };
}

export function intersectCaptureRectWithViewport(rect, viewportRect = getViewportRect()) {
  const normalizedRect = normalizeCaptureRect(rect);
  const normalizedViewport = normalizeCaptureRect(viewportRect);
  if (!normalizedRect || !normalizedViewport) {
    return null;
  }

  const left = Math.max(normalizedRect.left, normalizedViewport.left);
  const top = Math.max(normalizedRect.top, normalizedViewport.top);
  const right = Math.min(
    normalizedRect.left + normalizedRect.width,
    normalizedViewport.left + normalizedViewport.width
  );
  const bottom = Math.min(
    normalizedRect.top + normalizedRect.height,
    normalizedViewport.top + normalizedViewport.height
  );

  return normalizeCaptureRect({
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  });
}

function isMeaningfulCaptureRect(rect) {
  return Boolean(rect)
    && rect.width >= MIN_VISIBLE_CAPTURE_EDGE
    && rect.height >= MIN_VISIBLE_CAPTURE_EDGE
    && getCaptureRectArea(rect) >= MIN_VISIBLE_CAPTURE_AREA;
}

function readRenderedImageFitStyle(imageElement) {
  const computedStyle = typeof globalThis.getComputedStyle === 'function'
    ? globalThis.getComputedStyle(imageElement)
    : null;
  const style = imageElement?.style || null;
  const objectFit = computedStyle?.objectFit || style?.objectFit || '';
  const objectPosition = computedStyle?.objectPosition || style?.objectPosition || '';

  return {
    objectFit: typeof objectFit === 'string' ? objectFit.trim().toLowerCase() : '',
    objectPosition: typeof objectPosition === 'string' ? objectPosition.trim().toLowerCase() : ''
  };
}

function parseObjectPositionAxis(token, remainingSpace) {
  if (!Number.isFinite(remainingSpace) || remainingSpace <= 0) {
    return 0;
  }

  const normalizedToken = typeof token === 'string' ? token.trim().toLowerCase() : '';
  if (!normalizedToken) {
    return remainingSpace / 2;
  }

  if (normalizedToken.endsWith('%')) {
    const percentage = Number.parseFloat(normalizedToken.slice(0, -1));
    if (Number.isFinite(percentage)) {
      return remainingSpace * (percentage / 100);
    }
  }

  if (normalizedToken.endsWith('px')) {
    const pixelOffset = Number.parseFloat(normalizedToken.slice(0, -2));
    if (Number.isFinite(pixelOffset)) {
      return Math.max(0, Math.min(remainingSpace, pixelOffset));
    }
  }

  if (normalizedToken === 'left' || normalizedToken === 'top') {
    return 0;
  }
  if (normalizedToken === 'right' || normalizedToken === 'bottom') {
    return remainingSpace;
  }
  if (normalizedToken === 'center') {
    return remainingSpace / 2;
  }

  return remainingSpace / 2;
}

function resolveRenderedImageContentRect(imageElement, imageRect) {
  const normalizedImageRect = normalizeCaptureRect(imageRect);
  if (!normalizedImageRect) {
    return null;
  }

  const naturalWidth = Number(imageElement?.naturalWidth) || 0;
  const naturalHeight = Number(imageElement?.naturalHeight) || 0;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return normalizedImageRect;
  }

  const { objectFit, objectPosition } = readRenderedImageFitStyle(imageElement);
  if (!objectFit || objectFit === 'fill') {
    return normalizedImageRect;
  }

  let renderedWidth = normalizedImageRect.width;
  let renderedHeight = normalizedImageRect.height;

  if (objectFit === 'contain' || objectFit === 'scale-down') {
    const containScale = Math.min(
      normalizedImageRect.width / naturalWidth,
      normalizedImageRect.height / naturalHeight
    );
    const nextWidth = naturalWidth * containScale;
    const nextHeight = naturalHeight * containScale;

    if (objectFit === 'scale-down') {
      renderedWidth = Math.min(normalizedImageRect.width, nextWidth);
      renderedHeight = Math.min(normalizedImageRect.height, nextHeight);
    } else {
      renderedWidth = nextWidth;
      renderedHeight = nextHeight;
    }
  } else if (objectFit === 'none') {
    renderedWidth = Math.min(normalizedImageRect.width, naturalWidth);
    renderedHeight = Math.min(normalizedImageRect.height, naturalHeight);
  } else {
    return normalizedImageRect;
  }

  const remainingHorizontalSpace = Math.max(0, normalizedImageRect.width - renderedWidth);
  const remainingVerticalSpace = Math.max(0, normalizedImageRect.height - renderedHeight);
  const [xToken = '50%', yToken = '50%'] = objectPosition.split(/\s+/).filter(Boolean);
  const offsetX = parseObjectPositionAxis(xToken, remainingHorizontalSpace);
  const offsetY = parseObjectPositionAxis(yToken, remainingVerticalSpace);

  return normalizeCaptureRect({
    left: normalizedImageRect.left + offsetX,
    top: normalizedImageRect.top + offsetY,
    width: renderedWidth,
    height: renderedHeight
  });
}

export function resolveVisibleCaptureRect(imageElement) {
  const imageRect = normalizeCaptureRect(imageElement?.getBoundingClientRect?.());
  const imageContentRect = resolveRenderedImageContentRect(imageElement, imageRect);
  const effectiveImageRect = isMeaningfulCaptureRect(imageContentRect)
    ? imageContentRect
    : imageRect;
  const containerRect = normalizeCaptureRect(
    getPreferredGeminiImageContainer(imageElement)?.getBoundingClientRect?.()
  );

  if (!isMeaningfulCaptureRect(effectiveImageRect)) {
    return containerRect || effectiveImageRect;
  }

  if (!isMeaningfulCaptureRect(containerRect)) {
    return effectiveImageRect;
  }

  const imageArea = getCaptureRectArea(effectiveImageRect);
  const containerArea = getCaptureRectArea(containerRect);
  if (
    containerArea >= imageArea * CONTAINER_CAPTURE_AREA_RATIO
    && (
      containerRect.width >= effectiveImageRect.width * 2
      || containerRect.height >= effectiveImageRect.height * 2
    )
  ) {
    return containerRect;
  }

  return effectiveImageRect;
}

function waitForNextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    globalThis.setTimeout(resolve, 16);
  });
}

function getRenderableImageSize(imageElement) {
  const width = Number(imageElement?.naturalWidth) || Number(imageElement?.width) || Number(imageElement?.clientWidth) || 0;
  const height = Number(imageElement?.naturalHeight) || Number(imageElement?.height) || Number(imageElement?.clientHeight) || 0;

  return { width, height };
}

export async function waitForRenderableImageSize(imageElement, timeoutMs = 1500) {
  let size = getRenderableImageSize(imageElement);
  if (size.width > 0 && size.height > 0) {
    return size;
  }

  if (typeof imageElement?.decode === 'function') {
    try {
      await imageElement.decode();
    } catch {
      // Ignore decode failures here and keep waiting for layout or load to settle.
    }
    size = getRenderableImageSize(imageElement);
    if (size.width > 0 && size.height > 0) {
      return size;
    }
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await waitForNextFrame();
    size = getRenderableImageSize(imageElement);
    if (size.width > 0 && size.height > 0) {
      return size;
    }
  }

  throw new Error('Image has no renderable size');
}

function hasConfirmedGeminiPreviewMeta(processedMeta) {
  return classifyGeminiAttributionFromWatermarkMeta(processedMeta).tier !== 'insufficient';
}

function isSafePreviewFallbackStrategy(strategy) {
  return strategy === 'rendered-capture';
}

function isBlobLike(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.size === 'number'
    && typeof value.type === 'string'
    && typeof value.arrayBuffer === 'function';
}

function summarizeCandidateDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return '';
  }

  return diagnostics
    .map((item) => {
      const parts = [item.strategy || 'unknown', item.status || 'unknown'];
      if (item.decisionTier) parts.push(`tier=${item.decisionTier}`);
      if (item.processorPath) parts.push(`processor=${item.processorPath}`);
      if (typeof item.sourceBlobSize === 'number') parts.push(`sourceSize=${item.sourceBlobSize}`);
      if (item.sourceBlobType) parts.push(`sourceType=${item.sourceBlobType}`);
      if (typeof item.processedBlobSize === 'number') parts.push(`processedSize=${item.processedBlobSize}`);
      if (item.processedBlobType) parts.push(`processedType=${item.processedBlobType}`);
      if (item.error) parts.push(`error=${item.error}`);
      return parts.join(',');
    })
    .join(' | ');
}

export function shouldSkipPreviewProcessingFailure(diagnostics = []) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return false;
  }

  const pageFetchFailure = diagnostics.find((item) => item?.strategy === 'page-fetch');
  const renderedCaptureFailure = diagnostics.find((item) => item?.strategy === 'rendered-capture');
  const pageFetchError = String(pageFetchFailure?.error || '');
  const renderedCaptureError = String(renderedCaptureFailure?.error || '');

  return pageFetchFailure?.status === 'error'
    && /failed to fetch image: 403/i.test(pageFetchError)
    && renderedCaptureFailure?.status === 'error'
    && /tainted canvases may not be exported/i.test(renderedCaptureError);
}

export async function resolvePreviewReplacementResult({
  candidates = [],
  processCandidate
}) {
  let lastError = null;
  let sawInsufficientCandidate = false;
  let fallbackResult = null;
  const diagnostics = [];

  for (const candidate of candidates) {
    try {
      const result = await processCandidate(candidate);
      const confirmed = hasConfirmedGeminiPreviewMeta(result?.processedMeta);
      const decisionTier = classifyGeminiAttributionFromWatermarkMeta(result?.processedMeta).tier || 'insufficient';
      diagnostics.push({
        strategy: candidate.strategy || '',
        status: confirmed ? 'confirmed' : 'insufficient',
        decisionTier,
        processorPath: typeof result?.processedMeta?.processorPath === 'string' ? result.processedMeta.processorPath : '',
        sourceBlobType: result?.sourceBlobType || '',
        sourceBlobSize: typeof result?.sourceBlobSize === 'number' ? result.sourceBlobSize : undefined,
        processedBlobType: result?.processedBlob?.type || '',
        processedBlobSize: typeof result?.processedBlob?.size === 'number' ? result.processedBlob.size : undefined
      });
      if (confirmed) {
        return {
          ...result,
          strategy: candidate.strategy || '',
          diagnostics,
          diagnosticsSummary: summarizeCandidateDiagnostics(diagnostics)
        };
      }
      sawInsufficientCandidate = true;
      if (isSafePreviewFallbackStrategy(candidate.strategy) && isBlobLike(result?.processedBlob)) {
        const nextFallbackResult = {
          ...result,
          strategy: candidate.strategy || '',
          diagnostics: [...diagnostics],
          diagnosticsSummary: summarizeCandidateDiagnostics(diagnostics)
        };

        if (!fallbackResult) {
          fallbackResult = nextFallbackResult;
        }
      }
    } catch (error) {
      lastError = error;
      diagnostics.push({
        strategy: candidate.strategy || '',
        status: 'error',
        sourceBlobType: typeof error?.sourceBlobType === 'string' ? error.sourceBlobType : '',
        sourceBlobSize: typeof error?.sourceBlobSize === 'number' ? error.sourceBlobSize : undefined,
        error: normalizeErrorMessage(error)
      });
    }
  }

  if (fallbackResult) {
    return fallbackResult;
  }

  if (lastError) {
    const wrappedError = new Error(normalizeErrorMessage(lastError, 'Preview candidate failed'));
    wrappedError.candidateDiagnostics = diagnostics;
    wrappedError.candidateDiagnosticsSummary = summarizeCandidateDiagnostics(diagnostics);
    throw wrappedError;
  }

  if (sawInsufficientCandidate) {
    const error = new Error('No confirmed Gemini preview candidate succeeded');
    error.candidateDiagnostics = diagnostics;
    error.candidateDiagnosticsSummary = summarizeCandidateDiagnostics(diagnostics);
    throw error;
  }

  const error = new Error('No preview candidate succeeded');
  error.candidateDiagnostics = diagnostics;
  error.candidateDiagnosticsSummary = summarizeCandidateDiagnostics(diagnostics);
  throw error;
}

export function buildPreviewReplacementCandidates({
  imageElement,
  sourceUrl = '',
  fetchPreviewBlob = fetchBlobViaPageBridge,
  captureRenderedImageBlob = imageElementToBlob
}) {
  const candidates = [];
  const normalizedPreviewUrl = sourceUrl
    ? normalizeGoogleusercontentImageUrl(sourceUrl)
    : '';

  if (typeof fetchPreviewBlob === 'function' && normalizedPreviewUrl) {
    candidates.push({
      strategy: 'page-fetch',
      getOriginalBlob: () => fetchPreviewBlob(normalizedPreviewUrl)
    });
  }

  if (typeof captureRenderedImageBlob === 'function') {
    candidates.push({
      strategy: 'rendered-capture',
      getOriginalBlob: () => captureRenderedImageBlob(imageElement)
    });
  }

  return candidates;
}

export async function processPreviewPageImageSource({
  sourceUrl,
  imageElement,
  fetchPreviewBlob = fetchBlobViaPageBridge,
  processWatermarkBlobImpl = processWatermarkBlob,
  captureRenderedImageBlob = imageElementToBlob
}) {
  try {
    const previewResult = await resolvePreviewReplacementResult({
      candidates: buildPreviewReplacementCandidates({
        imageElement,
        sourceUrl,
        fetchPreviewBlob,
        captureRenderedImageBlob
      }),
      processCandidate: createPreviewCandidateProcessor(processWatermarkBlobImpl)
    });

    return {
      skipped: false,
      processedBlob: previewResult.processedBlob,
      selectedStrategy: previewResult.strategy || '',
      candidateDiagnostics: previewResult.diagnostics || null,
      candidateDiagnosticsSummary: previewResult.diagnosticsSummary || ''
    };
  } catch (error) {
    const diagnostics = getErrorCandidateDiagnostics(error) || [];
    if (shouldSkipPreviewProcessingFailure(diagnostics)) {
      return {
        skipped: true,
        reason: 'preview-fetch-unavailable',
        candidateDiagnostics: diagnostics,
        candidateDiagnosticsSummary: getErrorCandidateDiagnosticsSummary(error)
      };
    }
    throw error;
  }
}

export async function processOriginalPageImageSource({
  sourceUrl,
  imageElement,
  fetchPreviewBlob = fetchBlobViaPageBridge,
  removeWatermarkFromBlobImpl = removeWatermarkFromBlob,
  captureRenderedImageBlob = imageElementToBlob,
  fetchBlobDirectImpl = fetchBlobDirect,
  validateBlob = loadImageFromBlob,
  fetchBlobFromBackgroundImpl = fetchBlobFromBackground
}) {
  const originalBlob = await acquireOriginalBlob({
    sourceUrl,
    image: imageElement,
    fetchBlobFromBackground: async (url) => fetchBlobFromBackgroundImpl(
      normalizeGoogleusercontentImageUrl(url),
      fetchPreviewBlob
    ),
    fetchBlobDirect: fetchBlobDirectImpl,
    captureRenderedImageBlob,
    validateBlob
  });

  return {
    skipped: false,
    processedBlob: await removeWatermarkFromBlobImpl(originalBlob),
    selectedStrategy: '',
    candidateDiagnostics: null,
    candidateDiagnosticsSummary: ''
  };
}

export async function processPageImageSource({
  sourceUrl,
  imageElement,
  fetchPreviewBlob = fetchBlobViaPageBridge,
  processWatermarkBlobImpl = processWatermarkBlob,
  removeWatermarkFromBlobImpl = removeWatermarkFromBlob,
  captureRenderedImageBlob = imageElementToBlob,
  fetchBlobDirectImpl = fetchBlobDirect,
  validateBlob = loadImageFromBlob,
  fetchBlobFromBackgroundImpl = fetchBlobFromBackground
}) {
  if (isGeminiPreviewAssetUrl(sourceUrl)) {
    return processPreviewPageImageSource({
      sourceUrl,
      imageElement,
      fetchPreviewBlob,
      processWatermarkBlobImpl,
      captureRenderedImageBlob
    });
  }

  return processOriginalPageImageSource({
    sourceUrl,
    imageElement,
    fetchPreviewBlob,
    removeWatermarkFromBlobImpl,
    captureRenderedImageBlob,
    fetchBlobDirectImpl,
    validateBlob,
    fetchBlobFromBackgroundImpl
  });
}

function addProcessableCandidateImage(candidates, imageElement) {
  if (isProcessableGeminiImageElement(imageElement)) {
    candidates.add(imageElement);
  }
}

export function collectCandidateImages(root) {
  const candidates = new Set();
  if (root instanceof HTMLImageElement) {
    addProcessableCandidateImage(candidates, root);
  }
  if (typeof root?.querySelectorAll === 'function') {
    for (const image of root.querySelectorAll(getGeminiImageQuerySelector())) {
      addProcessableCandidateImage(candidates, image);
    }
  }
  return [...candidates];
}

function hasRelevantDescendant(root) {
  if (!root || typeof root.querySelector !== 'function') {
    return false;
  }

  const containerSelector = getGeminiImageContainerSelector();
  if (root.querySelector(containerSelector)) {
    return true;
  }

  return Boolean(root.querySelector('img') && root.querySelector('button,[role="button"]'));
}

export function shouldScheduleMutationRoot(root) {
  if (!root || typeof root !== 'object') {
    return false;
  }

  const tagName = typeof root.tagName === 'string' ? root.tagName.toUpperCase() : '';
  if (!tagName) {
    return false;
  }

  if (tagName === 'IMG' || tagName === 'GENERATED-IMAGE') {
    return true;
  }

  const containerSelector = getGeminiImageContainerSelector();
  if (typeof root.matches === 'function' && root.matches(containerSelector)) {
    return true;
  }

  return hasRelevantDescendant(root);
}

export function shouldScheduleAttributeMutation(target, attributeName = '') {
  if (!target || typeof target !== 'object') {
    return false;
  }

  const normalizedAttributeName = typeof attributeName === 'string'
    ? attributeName.trim().toLowerCase()
    : '';
  if (!normalizedAttributeName) {
    return true;
  }

  if (normalizedAttributeName === 'data-gwr-stable-source') {
    return false;
  }

  if (normalizedAttributeName !== 'src' && normalizedAttributeName !== 'srcset') {
    return true;
  }

  return !isSelfWrittenProcessedImageSource(target);
}

export function isSelfWrittenProcessedImageSource(target) {
  const trackedObjectUrl = typeof target?.dataset?.[PAGE_IMAGE_OBJECT_URL_KEY] === 'string'
    ? target.dataset[PAGE_IMAGE_OBJECT_URL_KEY].trim()
    : '';
  if (!trackedObjectUrl) {
    return false;
  }

  const currentSrc = typeof target?.currentSrc === 'string' ? target.currentSrc.trim() : '';
  const src = typeof target?.src === 'string' ? target.src.trim() : '';
  return currentSrc === trackedObjectUrl || src === trackedObjectUrl;
}

export function handlePageImageMutations(mutations, {
  scheduleProcess,
  HTMLImageElementClass = globalThis.HTMLImageElement
} = {}) {
  if (typeof scheduleProcess !== 'function' || !Array.isArray(mutations) || mutations.length === 0) {
    return;
  }

  const hasImageElementClass = typeof HTMLImageElementClass === 'function';

  for (const mutation of mutations) {
    if (mutation?.type === 'attributes') {
      if (!hasImageElementClass || !(mutation.target instanceof HTMLImageElementClass)) {
        continue;
      }
      if (!shouldScheduleAttributeMutation(mutation.target, mutation.attributeName)) {
        continue;
      }
      scheduleProcess(mutation.target);
      continue;
    }

    if (mutation?.type !== 'childList' || !mutation.addedNodes) {
      continue;
    }

    for (const node of mutation.addedNodes) {
      if (shouldScheduleMutationRoot(node)) {
        scheduleProcess(node);
      }
    }
  }
}

function scheduleOnNextFrame(callback) {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
    return;
  }
  globalThis.setTimeout(callback, 16);
}

function doesRootContain(containerRoot, candidateRoot) {
  if (!containerRoot || !candidateRoot || containerRoot === candidateRoot) {
    return false;
  }

  if (typeof containerRoot.contains === 'function') {
    try {
      return containerRoot.contains(candidateRoot);
    } catch {
      return false;
    }
  }

  return false;
}

export function createRootBatchProcessor({
  processRoot,
  scheduleFlush = scheduleOnNextFrame
} = {}) {
  const pendingRoots = new Set();
  let scheduled = false;

  function flush() {
    scheduled = false;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    for (const root of roots) {
      processRoot(root);
    }
  }

  function schedule(root = document) {
    for (const pendingRoot of pendingRoots) {
      if (pendingRoot === root || doesRootContain(pendingRoot, root)) {
        return;
      }
    }

    for (const pendingRoot of [...pendingRoots]) {
      if (doesRootContain(root, pendingRoot)) {
        pendingRoots.delete(pendingRoot);
      }
    }

    pendingRoots.add(root);
    if (scheduled) return;
    scheduled = true;
    scheduleFlush(flush);
  }

  return {
    schedule,
    flush
  };
}

function createProcessingOverlayElement(createElement) {
  const overlay = createElement('div');
  overlay.dataset[PROCESSING_OVERLAY_DATA_KEY] = 'true';
  overlay.textContent = 'Processing...';

  if (overlay.style && typeof overlay.style === 'object') {
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      pointerEvents: 'none',
      borderRadius: 'inherit',
      background: 'rgba(17, 17, 17, 0.16)',
      backdropFilter: 'blur(2px)',
      color: 'rgba(255, 255, 255, 0.92)',
      fontSize: '13px',
      fontWeight: '500',
      letterSpacing: '0.02em',
      opacity: '1',
      transition: `opacity ${PROCESSING_OVERLAY_FADE_MS}ms ease`
    });
  }

  return overlay;
}

function buildProcessingFilter(previousFilter = '') {
  const tokens = [previousFilter.trim(), 'blur(4px)', 'brightness(0.78)'].filter(Boolean);
  return tokens.join(' ');
}

export function showProcessingOverlay(
  imageElement,
  {
    container = getPreferredGeminiImageContainer(imageElement) || imageElement?.parentElement || null,
    createElement = (tagName) => document.createElement(tagName),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis) || null
  } = {}
) {
  if (!imageElement || !container || typeof container.appendChild !== 'function') {
    return null;
  }

  const existingState = processingOverlayState.get(imageElement);
  if (existingState) {
    if (existingState.hideTimerId !== null && typeof clearTimeoutImpl === 'function') {
      clearTimeoutImpl(existingState.hideTimerId);
      existingState.hideTimerId = null;
      existingState.hideSequence += 1;
    }
    if (existingState.overlay?.style && typeof existingState.overlay.style === 'object') {
      existingState.overlay.style.opacity = '1';
    }
    return existingState.overlay;
  }

  const overlay = createProcessingOverlayElement(createElement);
  const previousFilter = typeof imageElement?.style?.filter === 'string' ? imageElement.style.filter : '';
  const previousContainerPosition = typeof container?.style?.position === 'string' ? container.style.position : '';
  const didOverrideContainerPosition = Boolean(
    container.style && (!container.style.position || container.style.position === 'static')
  );

  if (didOverrideContainerPosition) {
    container.style.position = 'relative';
  }
  container.appendChild(overlay);

  if (imageElement.style && typeof imageElement.style === 'object') {
    imageElement.style.filter = buildProcessingFilter(previousFilter);
  }
  if (imageElement.dataset) {
    imageElement.dataset[PROCESSING_VISUAL_DATA_KEY] = 'true';
  }

  processingOverlayState.set(imageElement, {
    overlay,
    container,
    previousFilter,
    previousContainerPosition,
    didOverrideContainerPosition,
    hideTimerId: null,
    hideSequence: 0
  });

  return overlay;
}

export function hideProcessingOverlay(
  imageElement,
  {
    removeImmediately = false,
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis) || null,
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis) || null
  } = {}
) {
  const state = processingOverlayState.get(imageElement);
  if (!state) return;
  const nextHideSequence = state.hideSequence + 1;
  state.hideSequence = nextHideSequence;

  const cleanup = () => {
    if (processingOverlayState.get(imageElement) !== state) {
      return;
    }
    if (state.hideSequence !== nextHideSequence) {
      return;
    }
    if (state.overlay?.parentNode && typeof state.overlay.parentNode.removeChild === 'function') {
      state.overlay.parentNode.removeChild(state.overlay);
    }
    if (imageElement?.style && typeof imageElement.style === 'object') {
      imageElement.style.filter = state.previousFilter;
    }
    if (imageElement?.dataset) {
      delete imageElement.dataset[PROCESSING_VISUAL_DATA_KEY];
    }
    if (
      state.didOverrideContainerPosition
      && state.container?.style
      && typeof state.container.style === 'object'
      && state.container.style.position === 'relative'
    ) {
      state.container.style.position = state.previousContainerPosition;
    }
    state.hideTimerId = null;
    processingOverlayState.delete(imageElement);
  };

  if (removeImmediately || typeof setTimeoutImpl !== 'function') {
    if (state.hideTimerId !== null && typeof clearTimeoutImpl === 'function') {
      clearTimeoutImpl(state.hideTimerId);
      state.hideTimerId = null;
    }
    cleanup();
    return;
  }

  if (state.hideTimerId !== null && typeof clearTimeoutImpl === 'function') {
    clearTimeoutImpl(state.hideTimerId);
  }
  if (state.overlay?.style && typeof state.overlay.style === 'object') {
    state.overlay.style.opacity = '0';
  }
  state.hideTimerId = setTimeoutImpl(cleanup, PROCESSING_OVERLAY_FADE_MS);
}

function revokeTrackedObjectUrl(imageElement) {
  const objectUrl = imageElement?.dataset?.[PAGE_IMAGE_OBJECT_URL_KEY];
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  delete imageElement.dataset[PAGE_IMAGE_OBJECT_URL_KEY];
}

function applySkippedImageState(imageElement) {
  imageElement.dataset[PAGE_IMAGE_STATE_KEY] = 'skipped';
  hideProcessingOverlay(imageElement, { removeImmediately: true });
}

function applyReadyImageState(imageElement, processedBlob) {
  const objectUrl = URL.createObjectURL(processedBlob);
  revokeTrackedObjectUrl(imageElement);
  imageElement.dataset[PAGE_IMAGE_OBJECT_URL_KEY] = objectUrl;
  imageElement.dataset[PAGE_IMAGE_STATE_KEY] = 'ready';
  imageElement.src = objectUrl;
  hideProcessingOverlay(imageElement);
}

function applyFailedImageState(imageElement) {
  imageElement.dataset[PAGE_IMAGE_STATE_KEY] = 'failed';
  hideProcessingOverlay(imageElement, { removeImmediately: true });
}

export function preparePageImageProcessing(imageElement, {
  processing = null,
  HTMLImageElementClass = globalThis.HTMLImageElement,
  isProcessableImage = isProcessableGeminiImageElement,
  resolveSourceUrl = resolveCandidateImageUrl,
  hideProcessingOverlayImpl = hideProcessingOverlay,
  revokeTrackedObjectUrlImpl = revokeTrackedObjectUrl,
  showProcessingOverlayImpl = showProcessingOverlay
} = {}) {
  if (typeof HTMLImageElementClass !== 'function' || !(imageElement instanceof HTMLImageElementClass)) {
    return null;
  }
  if (typeof isProcessableImage === 'function' && !isProcessableImage(imageElement)) {
    return null;
  }

  const sourceUrl = typeof resolveSourceUrl === 'function'
    ? String(resolveSourceUrl(imageElement) || '').trim()
    : '';
  if (!sourceUrl) {
    return null;
  }

  const dataset = imageElement.dataset || (imageElement.dataset = {});
  const lastSourceUrl = dataset[PAGE_IMAGE_SOURCE_KEY] || '';
  const lastState = dataset[PAGE_IMAGE_STATE_KEY] || '';
  if (lastSourceUrl === sourceUrl && lastState === 'ready') {
    return null;
  }
  if (typeof processing?.has === 'function' && processing.has(imageElement)) {
    return null;
  }

  if (lastSourceUrl && lastSourceUrl !== sourceUrl) {
    hideProcessingOverlayImpl(imageElement, { removeImmediately: true });
    revokeTrackedObjectUrlImpl(imageElement);
  }

  if (typeof processing?.add === 'function') {
    processing.add(imageElement);
  }

  dataset.gwrStableSource = sourceUrl;
  dataset[PAGE_IMAGE_SOURCE_KEY] = sourceUrl;
  dataset[PAGE_IMAGE_STATE_KEY] = 'processing';
  showProcessingOverlayImpl(imageElement);

  return {
    sourceUrl,
    normalizedUrl: normalizeGoogleusercontentImageUrl(sourceUrl),
    isPreviewSource: isGeminiPreviewAssetUrl(sourceUrl)
  };
}

export function emitPageImageProcessingStart({
  logger = console,
  onLog = null,
  sourceUrl,
  normalizedUrl,
  isPreviewSource = false
} = {}) {
  emitPageImageProcessEvent({
    logger,
    onLog,
    consoleMessage: '[Gemini Watermark Remover] page image process start',
    eventType: 'page-image-process-start',
    payload: {
      sourceUrl,
      normalizedUrl
    }
  });

  if (!isPreviewSource) {
    return;
  }

  emitPageImageProcessEvent({
    logger,
    onLog,
    consoleMessage: '[Gemini Watermark Remover] page image process strategy',
    eventType: 'page-image-process-strategy',
    payload: {
      sourceUrl,
      strategy: 'preview-candidate-fallback'
    }
  });
}

export function applyPageImageProcessingResult({
  imageElement,
  sourceUrl,
  normalizedUrl,
  isPreviewSource = false,
  sourceResult,
  logger = console,
  onLog = null
} = {}) {
  if (sourceResult?.skipped) {
    applySkippedImageState(imageElement);
    emitPageImageProcessEvent({
      logger,
      onLog,
      consoleMessage: '[Gemini Watermark Remover] page image process skipped',
      eventType: 'page-image-process-skipped',
      payload: {
        sourceUrl,
        normalizedUrl,
        reason: sourceResult.reason || 'preview-fetch-unavailable',
        candidateDiagnostics: sourceResult.candidateDiagnostics,
        candidateDiagnosticsSummary: sourceResult.candidateDiagnosticsSummary || ''
      }
    });
    return;
  }

  const processedBlob = sourceResult?.processedBlob;
  const selectedStrategy = sourceResult?.selectedStrategy || '';
  const candidateDiagnostics = sourceResult?.candidateDiagnostics || null;
  const candidateDiagnosticsSummary = sourceResult?.candidateDiagnosticsSummary || '';

  applyReadyImageState(imageElement, processedBlob);

  emitPageImageProcessEvent({
    logger,
    onLog,
    consoleMessage: '[Gemini Watermark Remover] page image process success',
    eventType: 'page-image-process-success',
    payload: {
      sourceUrl,
      normalizedUrl,
      strategy: selectedStrategy || (isPreviewSource ? 'preview-candidate' : 'default'),
      candidateDiagnostics,
      candidateDiagnosticsSummary,
      blobType: processedBlob?.type || '',
      blobSize: processedBlob?.size || 0
    }
  });
}

export function handlePageImageProcessingFailure({
  imageElement,
  sourceUrl,
  normalizedUrl,
  error,
  logger = console,
  onLog = null
} = {}) {
  emitPageImageProcessEvent({
    logger,
    onLog,
    level: 'warn',
    consoleMessage: '[Gemini Watermark Remover] page image process failed',
    eventType: 'page-image-process-failed',
    payload: {
      sourceUrl,
      normalizedUrl,
      error: normalizeErrorMessage(error),
      candidateDiagnostics: getErrorCandidateDiagnostics(error),
      candidateDiagnosticsSummary: getErrorCandidateDiagnosticsSummary(error)
    }
  });
  applyFailedImageState(imageElement);
}

export function buildPageImageSourceRequest({
  sourceUrl,
  imageElement,
  fetchPreviewBlob,
  processWatermarkBlobImpl,
  removeWatermarkFromBlobImpl
} = {}) {
  return {
    sourceUrl,
    imageElement,
    fetchPreviewBlob,
    processWatermarkBlobImpl,
    removeWatermarkFromBlobImpl,
    captureRenderedImageBlob: imageElementToBlob,
    fetchBlobDirectImpl: fetchBlobDirect,
    validateBlob: loadImageFromBlob,
    fetchBlobFromBackgroundImpl: fetchBlobFromBackground
  };
}

export function createPageImageReplacementController({
  logger = console,
  onLog = null,
  fetchPreviewBlob = fetchBlobViaPageBridge,
  processPageImageSourceImpl = processPageImageSource,
  processWatermarkBlobImpl = processWatermarkBlob,
  removeWatermarkFromBlobImpl = removeWatermarkFromBlob
} = {}) {
  const processing = new WeakSet();
  let observer = null;

  async function processImage(imageElement) {
    const context = preparePageImageProcessing(imageElement, { processing });
    if (!context) return;

    const { sourceUrl, normalizedUrl, isPreviewSource } = context;
    emitPageImageProcessingStart({
      logger,
      onLog,
      sourceUrl,
      normalizedUrl,
      isPreviewSource
    });

    try {
      const sourceResult = await processPageImageSourceImpl(buildPageImageSourceRequest({
        sourceUrl,
        imageElement,
        fetchPreviewBlob,
        processWatermarkBlobImpl,
        removeWatermarkFromBlobImpl
      }));

      applyPageImageProcessingResult({
        imageElement,
        logger,
        onLog,
        sourceUrl,
        normalizedUrl,
        isPreviewSource,
        sourceResult
      });
    } catch (error) {
      handlePageImageProcessingFailure({
        imageElement,
        logger,
        onLog,
        sourceUrl,
        normalizedUrl,
        error
      });
    } finally {
      processing.delete(imageElement);
    }
  }

  function processRoot(root = document) {
    for (const imageElement of collectCandidateImages(root)) {
      void processImage(imageElement);
    }
  }
  const batchProcessor = createRootBatchProcessor({ processRoot });
  const scheduleProcess = batchProcessor.schedule;

  function observe() {
    const root = document.body || document.documentElement;
    if (!root || observer) return;
    observer = new MutationObserver((mutations) => {
      handlePageImageMutations(mutations, {
        scheduleProcess,
        HTMLImageElementClass: HTMLImageElement
      });
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES
    });
  }

  function install() {
    processRoot(document);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        observe();
        scheduleProcess(document);
      }, { once: true });
      return;
    }
    observe();
  }

  function dispose() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  return {
    install,
    dispose,
    processRoot
  };
}

export function installPageImageReplacement(options = {}) {
  const controller = createPageImageReplacementController(options);
  controller.install();
  return controller;
}

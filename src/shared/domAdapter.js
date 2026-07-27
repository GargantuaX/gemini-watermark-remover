import { isGeminiGeneratedAssetUrl } from '../userscript/urlUtils.js';

const GEMINI_IMAGE_CONTAINER_SELECTOR = 'generated-image,.generated-image-container';
const GEMINI_FULLSCREEN_CONTAINER_SELECTOR = 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane';
const GEMINI_UPLOADER_PREVIEW_SELECTOR = '[data-test-id="image-preview"],uploader-file-preview,uploader-file-preview-container,.attachment-preview-wrapper,.file-preview-container';
const MIN_GEMINI_IMAGE_EDGE = 128;
const MAX_CONTAINER_SEARCH_DEPTH = 4;
const MIN_ACTION_BUTTONS = 3;
const GEMINI_DRAFT_ID_ATTRIBUTE = 'data-test-draft-id';

function normalizeGeminiAssetId(value, prefix) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith(prefix) || trimmed.length <= prefix.length) {
    return null;
  }
  return trimmed;
}

function parseGeminiAssetIdsFromJslog(jslog = '') {
  if (typeof jslog !== 'string' || jslog.length === 0) {
    return null;
  }

  const responseId = normalizeGeminiAssetId(jslog.match(/"((?:r|resp)_[^"]+)"/)?.[1] || null, 'r_');
  const conversationId = normalizeGeminiAssetId(jslog.match(/"((?:c|conv)_[^"]+)"/)?.[1] || null, 'c_');
  const draftId = normalizeGeminiAssetId(jslog.match(/"((?:rc|draft)_[^"]+)"/)?.[1] || null, 'rc_');

  if (!responseId && !conversationId && !draftId) {
    return null;
  }

  return {
    responseId,
    draftId,
    conversationId
  };
}

function getAttributeValue(element, attributeName) {
  if (!element || typeof element.getAttribute !== 'function') {
    return '';
  }
  return String(element.getAttribute(attributeName) || '').trim();
}

function getClosestElement(element, selector) {
  if (!element || typeof element.closest !== 'function') {
    return null;
  }
  return element.closest(selector);
}

function collectGeminiMetadataElements(img) {
  const elements = [];
  const seen = new Set();

  const pushElement = (element) => {
    if (!element || typeof element !== 'object' || seen.has(element)) return;
    seen.add(element);
    elements.push(element);
  };

  pushElement(img);
  pushElement(getClosestElement(img, 'single-image'));
  pushElement(getClosestElement(img, `[${GEMINI_DRAFT_ID_ATTRIBUTE}]`));
  pushElement(getClosestElement(img, GEMINI_IMAGE_CONTAINER_SELECTOR));

  let current = img?.parentElement || null;
  let depth = 0;
  while (current && depth < MAX_CONTAINER_SEARCH_DEPTH) {
    pushElement(current);
    current = current.parentElement || null;
    depth += 1;
  }

  return elements;
}

function getMediaEdgeSize(element) {
  const naturalWidth = Number(element?.naturalWidth) || 0;
  const naturalHeight = Number(element?.naturalHeight) || 0;
  const width = Number(element?.width) || 0;
  const height = Number(element?.height) || 0;
  const clientWidth = Number(element?.clientWidth) || 0;
  const clientHeight = Number(element?.clientHeight) || 0;

  return {
    width: Math.max(naturalWidth, width, clientWidth),
    height: Math.max(naturalHeight, height, clientHeight)
  };
}

function hasAnyGeminiAssetIds(assetIds) {
  return Boolean(assetIds?.responseId || assetIds?.draftId || assetIds?.conversationId);
}

function isBlobOrDataImageSource(sourceUrl) {
  return sourceUrl.startsWith('blob:') || sourceUrl.startsWith('data:');
}

function isInsideGeminiFullscreenContainer(img) {
  return Boolean(getClosestElement(img, GEMINI_FULLSCREEN_CONTAINER_SELECTOR));
}

function isGeminiUploaderPreviewImage(img) {
  return Boolean(getClosestElement(img, GEMINI_UPLOADER_PREVIEW_SELECTOR));
}

export function resolveCandidateImageUrl(img) {
  if (!img || typeof img !== 'object') return '';
  if (img?.dataset?.gwrPreviewImage === 'true') return '';
  const explicitSource = typeof img?.dataset?.gwrSourceUrl === 'string' ? img.dataset.gwrSourceUrl.trim() : '';
  if (explicitSource) return explicitSource;
  const stableSource = typeof img?.dataset?.gwrStableSource === 'string' ? img.dataset.gwrStableSource.trim() : '';
  if (stableSource) {
    const currentSrc = typeof img?.currentSrc === 'string' ? img.currentSrc.trim() : '';
    const src = typeof img?.src === 'string' ? img.src.trim() : '';
    if (currentSrc.startsWith('blob:') || currentSrc.startsWith('data:') || src.startsWith('blob:') || src.startsWith('data:')) {
      return stableSource;
    }
  }
  const currentSrc = typeof img?.currentSrc === 'string' ? img.currentSrc.trim() : '';
  if (currentSrc) return currentSrc;
  const src = typeof img?.src === 'string' ? img.src.trim() : '';
  return src;
}

function isGeminiEditorImage(img) {
  let current = img.parentElement;
  let depth = 0;
  while (current && depth < 5) {
    const className = (current.className || '');
    const dataTestId = (current.getAttribute('data-test-id') || '');
    const combined = `${typeof className === 'string' ? className : ''} ${dataTestId}`.toLowerCase();
    
    if (combined.includes('editor') || combined.includes('sketch') || combined.includes('inpainting')) {
      return true;
    }
    current = current.parentElement;
    depth += 1;
  }

  if (img.parentElement && img.parentElement.querySelector('canvas')) {
    return true;
  }

  const dialog = img.closest(GEMINI_FULLSCREEN_CONTAINER_SELECTOR);
  if (dialog) {
    const buttons = Array.from(dialog.querySelectorAll('button'));
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
      if (
        text === 'sketch' || aria.includes('sketch') ||
        text === 'намалювати' || aria.includes('намалювати') ||
        text === 'эскиз' || aria.includes('эскиз')
      ) {
        return true;
      }
    }
  }
  return false;
}

export function isProcessableGeminiImageElement(img) {
  if (!img || typeof img.closest !== 'function') return false;
  if (img?.dataset?.gwrPreviewImage === 'true') return false;
  if (isGeminiUploaderPreviewImage(img)) return false;
  if (isGeminiEditorImage(img)) return false;
  
  const knownContainer = img.closest(GEMINI_IMAGE_CONTAINER_SELECTOR);
  const sourceUrl = resolveCandidateImageUrl(img);
  if (isGeminiGeneratedAssetUrl(sourceUrl)) {
    if (knownContainer) return true;
    return hasMeaningfulGeminiImageSize(img);
  }

  if (
    knownContainer &&
    isBlobOrDataImageSource(sourceUrl)
  ) {
    if (isInsideGeminiFullscreenContainer(img)) {
      return true;
    }

    if (hasAnyGeminiAssetIds(extractGeminiImageAssetIds(img))) {
      return true;
    }
  }

  return shouldUseRenderedImageFallback(img);
}

export function isProcessableGeminiMediaElement(element) {
  if (!element) return false;
  if (element.tagName === 'CANVAS') {
    return shouldUseRenderedImageFallback(element);
  }
  return isProcessableGeminiImageElement(element);
}

export function getGeminiImageContainerSelector() {
  return GEMINI_IMAGE_CONTAINER_SELECTOR;
}

export function getGeminiImageQuerySelector() {
  return GEMINI_IMAGE_CONTAINER_SELECTOR
    .split(',')
    .map((selector) => `${selector.trim()} img`)
    .join(',');
}

function hasMeaningfulGeminiImageSize(img) {
  const { width, height } = getMediaEdgeSize(img);

  return width >= MIN_GEMINI_IMAGE_EDGE || height >= MIN_GEMINI_IMAGE_EDGE;
}

export function getPreferredGeminiImageContainer(img) {
  if (!img || typeof img !== 'object') return null;
  const knownContainer = typeof img.closest === 'function'
    ? img.closest(GEMINI_IMAGE_CONTAINER_SELECTOR)
    : null;
  if (knownContainer) return knownContainer;

  let current = img.parentElement || null;
  let depth = 0;
  while (current && depth < MAX_CONTAINER_SEARCH_DEPTH) {
    if (current.tagName && current.tagName !== 'IMG') {
      return current;
    }
    current = current.parentElement || null;
    depth += 1;
  }

  return img.parentElement || null;
}

export function extractGeminiImageAssetIds(img) {
  const assetIds = {
    responseId: null,
    draftId: null,
    conversationId: null
  };

  if (!img || typeof img !== 'object') {
    return assetIds;
  }

  const responseIdFromDataset = normalizeGeminiAssetId(
    typeof img?.dataset?.gwrResponseId === 'string' ? img.dataset.gwrResponseId : null,
    'r_'
  );
  if (responseIdFromDataset) {
    assetIds.responseId = responseIdFromDataset;
  }

  const draftIdFromDataset = normalizeGeminiAssetId(
    typeof img?.dataset?.gwrDraftId === 'string' ? img.dataset.gwrDraftId : null,
    'rc_'
  );
  if (draftIdFromDataset) {
    assetIds.draftId = draftIdFromDataset;
  }

  const conversationIdFromDataset = normalizeGeminiAssetId(
    typeof img?.dataset?.gwrConversationId === 'string' ? img.dataset.gwrConversationId : null,
    'c_'
  );
  if (conversationIdFromDataset) {
    assetIds.conversationId = conversationIdFromDataset;
  }

  for (const element of collectGeminiMetadataElements(img)) {
    if (!assetIds.draftId) {
      assetIds.draftId = normalizeGeminiAssetId(
        getAttributeValue(element, GEMINI_DRAFT_ID_ATTRIBUTE),
        'rc_'
      );
    }

    const parsed = parseGeminiAssetIdsFromJslog(getAttributeValue(element, 'jslog'));
    if (!parsed) continue;

    assetIds.responseId ||= parsed.responseId;
    assetIds.draftId ||= parsed.draftId;
    assetIds.conversationId ||= parsed.conversationId;

    if (assetIds.responseId && assetIds.draftId && assetIds.conversationId) {
      break;
    }
  }

  return assetIds;
}

export function hasNearbyActionCluster(img) {
  let current = img?.parentElement || null;
  let depth = 0;

  while (current && depth < MAX_CONTAINER_SEARCH_DEPTH) {
    const buttons = typeof current.querySelectorAll === 'function'
      ? current.querySelectorAll('button,[role="button"]')
      : [];
    if ((buttons?.length || 0) >= MIN_ACTION_BUTTONS) {
      return true;
    }
    current = current.parentElement || null;
    depth += 1;
  }

  return false;
}

export function shouldUseRenderedImageFallback(img) {
  return hasMeaningfulGeminiImageSize(img) && hasNearbyActionCluster(img);
}

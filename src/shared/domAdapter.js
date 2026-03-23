import { isGeminiGeneratedAssetUrl } from '../userscript/urlUtils.js';

const GEMINI_IMAGE_CONTAINER_SELECTOR = 'generated-image,.generated-image-container';
const MIN_GEMINI_IMAGE_EDGE = 128;
const MAX_CONTAINER_SEARCH_DEPTH = 4;
const MIN_ACTION_BUTTONS = 3;

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

export function isProcessableGeminiImageElement(img) {
  if (!img || typeof img.closest !== 'function') return false;
  if (img?.dataset?.gwrPreviewImage === 'true') return false;
  const sourceUrl = resolveCandidateImageUrl(img);
  if (isGeminiGeneratedAssetUrl(sourceUrl)) {
    if (img.closest(GEMINI_IMAGE_CONTAINER_SELECTOR)) return true;
    return hasMeaningfulGeminiImageSize(img);
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

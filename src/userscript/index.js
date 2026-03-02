import { WatermarkEngine } from '../core/watermarkEngine.js';

let engine = null;
const processingQueue = new Set();

const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

const canvasToBlob = (canvas, type = 'image/png') =>
  new Promise(resolve => canvas.toBlob(resolve, type));

const isValidGeminiImage = (img) => img.closest('generated-image,.generated-image-container') !== null;

const findGeminiImages = () =>
  [...document.querySelectorAll('img[src*="googleusercontent.com"]')].filter(isValidGeminiImage);

const fetchBlob = (url) => new Promise((resolve, reject) => {
  // use GM_xmlhttpRequest to fetch image blob to avoid cross-origin issue
  GM_xmlhttpRequest({
    method: 'GET',
    url,
    responseType: 'blob',
    onload: (response) => resolve(response.response),
    onerror: reject
  });
});

const replaceWithNormalSize = (src) => {
  // use normal size image to fit watermark
  return src.replace(/=s\d+(?=[-?#]|$)/, '=s0');
}

async function processImage(imgElement) {
  if (!engine || processingQueue.has(imgElement)) return;

  processingQueue.add(imgElement);
  imgElement.dataset.watermarkProcessed = 'processing';

  const originalSrc = imgElement.src;
  try {
    imgElement.src = '';
    const normalSizeBlob = await fetchBlob(replaceWithNormalSize(originalSrc));
    const normalSizeBlobUrl = URL.createObjectURL(normalSizeBlob);
    const normalSizeImg = await loadImage(normalSizeBlobUrl);
    const processedCanvas = await engine.removeWatermarkFromImage(normalSizeImg, { adaptiveMode: 'always' });
    const processedBlob = await canvasToBlob(processedCanvas);

    URL.revokeObjectURL(normalSizeBlobUrl);

    imgElement.src = URL.createObjectURL(processedBlob);
    imgElement.dataset.watermarkProcessed = 'true';

    console.log('[Gemini Watermark Remover] Processed image');
  } catch (error) {
    console.warn('[Gemini Watermark Remover] Failed to process image:', error);
    imgElement.dataset.watermarkProcessed = 'failed';
    imgElement.src = originalSrc;
  } finally {
    processingQueue.delete(imgElement);
  }
}

const processAllImages = () => {
  const images = findGeminiImages();
  if (images.length === 0) return;

  console.log(`[Gemini Watermark Remover] Found ${images.length} images to process`);
  images.forEach(processImage);
};

const setupMutationObserver = () => {
  new MutationObserver(debounce(processAllImages, 100))
    .observe(document.body, { childList: true, subtree: true });
  console.log('[Gemini Watermark Remover] MutationObserver active');
};

async function processImageBlob(blob) {
  const blobUrl = URL.createObjectURL(blob);
  const img = await loadImage(blobUrl);
  const canvas = await engine.removeWatermarkFromImage(img, { adaptiveMode: 'always' });
  URL.revokeObjectURL(blobUrl);
  return canvasToBlob(canvas);
}

// Only match gemini generated assets(copy & download), ignore user-upload previews.
const GEMINI_URL_PATTERN = /^https:\/\/lh3\.googleusercontent\.com\/rd-gg(?:-dl)?\/.+=s(?!0-d\?).*/;

// Intercept fetch requests to replace downloadable image with the watermark removed image
const { fetch: origFetch } = unsafeWindow;
unsafeWindow.fetch = async (...args) => {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  if (GEMINI_URL_PATTERN.test(url)) {
    console.log('[Gemini Watermark Remover] Intercepting:', url);

    const origUrl = replaceWithNormalSize(url);
    if (typeof args[0] === 'string') args[0] = origUrl;
    else if (args[0]?.url) args[0].url = origUrl;

    const response = await origFetch(...args);
    if (!engine || !response.ok) return response;

    try {
      const processedBlob = await processImageBlob(await response.blob());
      return new Response(processedBlob, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      console.warn('[Gemini Watermark Remover] Processing failed:', error);
      return response;
    }
  }

  return origFetch(...args);
};

(async function init() {
  try {
    console.log('[Gemini Watermark Remover] Initializing...');
    engine = await WatermarkEngine.create();

    processAllImages();
    setupMutationObserver();

    console.log('[Gemini Watermark Remover] Ready');
  } catch (error) {
    console.error('[Gemini Watermark Remover] Initialization failed:', error);
  }
})();

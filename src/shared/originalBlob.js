import { isGeminiGeneratedAssetUrl, isGeminiPreviewAssetUrl } from '../userscript/urlUtils.js';

export function shouldFetchBlobDirectly(sourceUrl) {
  return typeof sourceUrl === 'string'
    && (sourceUrl.startsWith('blob:') || sourceUrl.startsWith('data:'));
}

function shouldPreferRenderedCapture(sourceUrl) {
  return isGeminiPreviewAssetUrl(sourceUrl);
}

async function captureRenderedBlob({
  image,
  captureRenderedImageBlob
}) {
  if (typeof captureRenderedImageBlob !== 'function') {
    throw new Error('Rendered capture unavailable');
  }
  return captureRenderedImageBlob(image);
}

export async function acquireOriginalBlob({
  sourceUrl,
  image,
  fetchBlobFromBackground,
  fetchBlobDirect,
  captureRenderedImageBlob,
  validateBlob
}) {
  const normalizedSourceUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';

  if (shouldPreferRenderedCapture(normalizedSourceUrl)) {
    return captureRenderedBlob({
      image,
      captureRenderedImageBlob
    });
  }

  if (isGeminiGeneratedAssetUrl(normalizedSourceUrl)) {
    const blob = await fetchBlobFromBackground(normalizedSourceUrl);
    if (typeof validateBlob === 'function') {
      try {
        await validateBlob(blob);
      } catch {
        return captureRenderedBlob({
          image,
          captureRenderedImageBlob
        });
      }
    }
    return blob;
  }

  if (shouldFetchBlobDirectly(normalizedSourceUrl)) {
    return fetchBlobDirect(normalizedSourceUrl);
  }

  return captureRenderedBlob({
    image,
    captureRenderedImageBlob
  });
}

function isGoogleusercontentHost(hostname) {
  return hostname === 'googleusercontent.com' || hostname.endsWith('.googleusercontent.com');
}

// Keep Gemini asset path classification centralized here.
// We previously expanded generic asset handling from `gg/` to `gg-*`, but some
// older preview-only branches still hard-coded `^/gg/`, which broke tiered
// paths like `gg-premium/...`. We also need to keep `gg-*-dl` on the
// download/original-asset path instead of misclassifying it as a preview.
function classifyGeminiAssetPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return null;

  const firstSegment = pathname.split('/').filter(Boolean)[0] || '';
  if (!firstSegment) return null;

  if (firstSegment.startsWith('rd-')) {
    const variant = firstSegment.slice(3);
    return {
      family: 'rd',
      variant: variant.endsWith('-dl') ? variant.slice(0, -3) : variant,
      isPreview: false,
      isDownload: variant.endsWith('-dl')
    };
  }

  if (firstSegment === 'gg') {
    return {
      family: 'gg',
      variant: '',
      isPreview: true,
      isDownload: false
    };
  }

  if (!firstSegment.startsWith('gg-')) {
    return null;
  }

  const ggVariant = firstSegment.slice(3);
  // Gemini currently uses `*-dl` to indicate download/original asset routes.
  const isDownload = ggVariant === 'dl' || ggVariant.endsWith('-dl');
  const normalizedVariant = isDownload
    ? (ggVariant === 'dl' ? '' : ggVariant.slice(0, -3))
    : ggVariant;

  return {
    family: 'gg',
    variant: normalizedVariant,
    isPreview: !isDownload,
    isDownload
  };
}

function hasGeminiAssetPath(pathname) {
  return classifyGeminiAssetPath(pathname) !== null;
}

function hasGeminiPreviewAssetPath(pathname) {
  return classifyGeminiAssetPath(pathname)?.isPreview === true;
}

export function classifyGeminiAssetUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (!isGoogleusercontentHost(parsed.hostname)) {
      return null;
    }
    return classifyGeminiAssetPath(parsed.pathname);
  } catch {
    return null;
  }
}

export function isGeminiGeneratedAssetUrl(url) {
  return classifyGeminiAssetUrl(url) !== null;
}

export function isGeminiPreviewAssetUrl(url) {
  return classifyGeminiAssetUrl(url)?.isPreview === true;
}

export function normalizeGoogleusercontentImageUrl(url) {
  if (!isGeminiGeneratedAssetUrl(url)) return url;

  try {
    const parsed = new URL(url);
    if (!hasGeminiAssetPath(parsed.pathname)) {
      return url;
    }

    const path = parsed.pathname;
    const dimensionPairAtTail = /=w\d+-h\d+([^/]*)$/i;
    if (dimensionPairAtTail.test(path)) {
      parsed.pathname = path.replace(dimensionPairAtTail, '=s0$1');
      return parsed.toString();
    }

    const sizeTransformAtTail = /=(?:s|w|h)\d+([^/]*)$/i;
    if (sizeTransformAtTail.test(path)) {
      parsed.pathname = path.replace(sizeTransformAtTail, '=s0$1');
      return parsed.toString();
    }

    parsed.pathname = `${path}=s0`;
    return parsed.toString();
  } catch {
    return url;
  }
}

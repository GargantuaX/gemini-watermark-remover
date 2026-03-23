function buildHookRequestArgs(args, normalizedUrl) {
  const nextArgs = [...args];
  const input = nextArgs[0];

  if (typeof input === 'string') {
    nextArgs[0] = normalizedUrl;
    return nextArgs;
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    nextArgs[0] = new Request(normalizedUrl, input);
    return nextArgs;
  }

  nextArgs[0] = normalizedUrl;
  return nextArgs;
}

function hasHeaderValue(headersLike, headerName) {
  if (!headersLike) return false;
  const normalizedHeaderName = String(headerName || '').toLowerCase();

  if (typeof Headers !== 'undefined' && headersLike instanceof Headers) {
    return headersLike.get(normalizedHeaderName) === '1';
  }

  if (Array.isArray(headersLike)) {
    return headersLike.some(([name, value]) => String(name || '').toLowerCase() === normalizedHeaderName && String(value || '') === '1');
  }

  if (typeof headersLike === 'object') {
    for (const [name, value] of Object.entries(headersLike)) {
      if (String(name || '').toLowerCase() === normalizedHeaderName && String(value || '') === '1') {
        return true;
      }
    }
  }

  return false;
}

function shouldBypassHook(args) {
  const input = args[0];
  const init = args[1];

  if (init?.gwrBypass === true) {
    return true;
  }

  if (input && typeof input === 'object' && input.gwrBypass === true) {
    return true;
  }

  if (typeof Request !== 'undefined' && input instanceof Request && input.headers?.get('x-gwr-bypass') === '1') {
    return true;
  }

  return hasHeaderValue(init?.headers, 'x-gwr-bypass');
}

function buildProcessedResponse(response, blob) {
  const headers = new Headers(response.headers);
  if (blob.type) {
    headers.set('content-type', blob.type);
  }

  return new Response(blob, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function createGeminiDownloadFetchHook({
  originalFetch,
  isTargetUrl,
  normalizeUrl,
  processBlob,
  logger = console,
  cache = new Map()
}) {
  if (typeof originalFetch !== 'function') {
    throw new TypeError('originalFetch must be a function');
  }
  if (typeof isTargetUrl !== 'function') {
    throw new TypeError('isTargetUrl must be a function');
  }
  if (typeof normalizeUrl !== 'function') {
    throw new TypeError('normalizeUrl must be a function');
  }
  if (typeof processBlob !== 'function') {
    throw new TypeError('processBlob must be a function');
  }

  return async function geminiDownloadFetchHook(...args) {
    if (shouldBypassHook(args)) {
      return originalFetch(...args);
    }

    const input = args[0];
    const url = typeof input === 'string' ? input : input?.url;
    if (!isTargetUrl(url)) {
      return originalFetch(...args);
    }

    const normalizedUrl = normalizeUrl(url);
    const hookArgs = buildHookRequestArgs(args, normalizedUrl);
    const response = await originalFetch(...hookArgs);
    if (!response?.ok) {
      return response;
    }

    const fallbackResponse = typeof response.clone === 'function' ? response.clone() : response;

    try {
      let pendingBlob = cache.get(normalizedUrl);
      if (!pendingBlob) {
        pendingBlob = response.blob()
          .then((blob) => processBlob(blob, {
            url,
            normalizedUrl,
            response
          }))
          .finally(() => {
            if (cache.get(normalizedUrl) === pendingBlob) {
              cache.delete(normalizedUrl);
            }
          });
        cache.set(normalizedUrl, pendingBlob);
      }

      const processedBlob = await pendingBlob;
      return buildProcessedResponse(response, processedBlob);
    } catch (error) {
      logger?.warn?.('[Gemini Watermark Remover] Download hook processing failed:', error);
      return fallbackResponse;
    }
  };
}

export function installGeminiDownloadHook(targetWindow, options) {
  if (!targetWindow || typeof targetWindow !== 'object') {
    throw new TypeError('targetWindow must be an object');
  }

  const originalFetch = targetWindow.fetch;
  const hook = createGeminiDownloadFetchHook({
    ...options,
    originalFetch
  });

  targetWindow.fetch = hook;
  return hook;
}

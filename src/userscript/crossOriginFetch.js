export function parseMimeTypeFromResponseHeaders(responseHeaders) {
  if (typeof responseHeaders !== 'string' || responseHeaders.length === 0) {
    return '';
  }

  const lines = responseHeaders.split(/\r?\n/);
  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (name !== 'content-type') continue;
    return line.slice(separatorIndex + 1).trim().split(';')[0].trim().toLowerCase();
  }

  return '';
}

async function fetchBlobWithStandardFetch(fetchImpl, url) {
  const response = await fetchImpl(url, {
    credentials: 'omit',
    redirect: 'follow'
  });
  if (!response?.ok) {
    throw new Error(`Failed to fetch image: ${response?.status || 0}`);
  }
  return response.blob();
}

async function fetchBlobWithUserscriptRequest(gmRequest, url) {
  return new Promise((resolve, reject) => {
    gmRequest({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      onload: (response) => {
        const status = Number(response?.status) || 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`Failed to fetch image: ${status}`));
          return;
        }

        const mimeType = parseMimeTypeFromResponseHeaders(response?.responseHeaders) || 'image/png';
        resolve(new Blob([response.response], { type: mimeType }));
      },
      onerror: () => {
        reject(new Error('Failed to fetch image'));
      },
      ontimeout: () => {
        reject(new Error('Failed to fetch image: timeout'));
      }
    });
  });
}

export function createUserscriptBlobFetcher({
  gmRequest = globalThis.GM_xmlhttpRequest,
  fallbackFetch = globalThis.fetch?.bind(globalThis) || null
} = {}) {
  return async function fetchPreviewBlob(url) {
    if (typeof gmRequest === 'function') {
      return fetchBlobWithUserscriptRequest(gmRequest, url);
    }

    if (typeof fallbackFetch === 'function') {
      return fetchBlobWithStandardFetch(fallbackFetch, url);
    }

    throw new Error('Failed to fetch image');
  };
}

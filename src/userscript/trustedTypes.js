const USERSCRIPT_TRUSTED_TYPES_POLICY = 'gemini-watermark-remover';

export function toWorkerScriptUrl(url, env = globalThis) {
  const trustedTypesApi = env?.trustedTypes;
  if (!trustedTypesApi || typeof trustedTypesApi.createPolicy !== 'function') {
    return url;
  }

  try {
    const existingPolicy = typeof trustedTypesApi.getPolicy === 'function'
      ? trustedTypesApi.getPolicy(USERSCRIPT_TRUSTED_TYPES_POLICY)
      : null;
    const policy = existingPolicy || trustedTypesApi.createPolicy(
      USERSCRIPT_TRUSTED_TYPES_POLICY,
      { createScriptURL: (value) => value }
    );
    if (!policy || typeof policy.createScriptURL !== 'function') return null;
    return policy.createScriptURL(url);
  } catch {
    return null;
  }
}

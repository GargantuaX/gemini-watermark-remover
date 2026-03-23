function stringifyErrorPayload(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function normalizeErrorMessage(error, fallback = 'Unknown error') {
  if (error instanceof Error) {
    return error.message || fallback;
  }

  if (typeof error === 'string') {
    return error.trim() || fallback;
  }

  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }

    if (typeof error.error === 'string' && error.error.trim()) {
      return error.error.trim();
    }

    const status = Number.isFinite(error.status) ? String(error.status) : '';
    const statusText = typeof error.statusText === 'string' ? error.statusText.trim() : '';
    const combinedStatus = `${status} ${statusText}`.trim();
    if (combinedStatus) {
      return combinedStatus;
    }

    const serialized = stringifyErrorPayload(error);
    if (serialized && serialized !== '{}') {
      return serialized;
    }
  }

  return fallback;
}

export function buildErrorDebugInfo(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || ''
    };
  }

  if (error && typeof error === 'object') {
    return {
      message: normalizeErrorMessage(error),
      raw: stringifyErrorPayload(error)
    };
  }

  return {
    message: normalizeErrorMessage(error)
  };
}

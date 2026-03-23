import exifr from 'exifr';
import i18n from './i18n.js';
import { isOfficialOrKnownGeminiDimensions } from './core/geminiSizeCatalog.js';
import { classifyGeminiAttributionFromWatermarkMeta } from './core/watermarkDecisionPolicy.js';

function normalizeDimension(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const rounded = Math.round(numeric);
    return rounded > 0 ? rounded : null;
}

export function isLikelyGeminiDimensions(width, height) {
    const normalizedWidth = normalizeDimension(width);
    const normalizedHeight = normalizeDimension(height);
    if (!normalizedWidth || !normalizedHeight) return false;
    return isOfficialOrKnownGeminiDimensions(normalizedWidth, normalizedHeight);
}

function extractImageDimensions(exif) {
    const width =
        normalizeDimension(exif?.ImageWidth) ??
        normalizeDimension(exif?.ExifImageWidth) ??
        normalizeDimension(exif?.PixelXDimension);
    const height =
        normalizeDimension(exif?.ImageHeight) ??
        normalizeDimension(exif?.ExifImageHeight) ??
        normalizeDimension(exif?.PixelYDimension);
    return { width, height };
}

export function evaluateOriginalFromExif(exif) {
    const { width, height } = extractImageDimensions(exif);
    const isOriginal = Boolean(width && height);

    const credit = typeof exif?.Credit === 'string' ? exif.Credit.trim() : '';
    const isGoogleByCredit = credit.toLowerCase() === 'made with google ai';

    // Fallback for metadata-stripped exports: accept known Gemini output dimensions.
    const isGoogleByDimension = isOriginal && isLikelyGeminiDimensions(width, height);

    return {
        is_google: isGoogleByCredit || isGoogleByDimension,
        is_original: isOriginal
    };
}

export function loadImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export async function checkOriginal(file) {
    try {
        const exif = await exifr.parse(file, { xmp: true });
        return evaluateOriginalFromExif(exif);
    } catch {
        return { is_google: false, is_original: false };
    }
}

export function isLikelyGeminiByWatermarkMeta(
    watermarkMeta
) {
    return classifyGeminiAttributionFromWatermarkMeta(watermarkMeta).tier !== 'insufficient';
}

export function resolveOriginalValidation(validation, watermarkMeta) {
    const normalized = {
        is_google: Boolean(validation?.is_google),
        is_original: Boolean(validation?.is_original)
    };

    if (normalized.is_google) return normalized;
    if (!isLikelyGeminiByWatermarkMeta(watermarkMeta)) return normalized;

    return {
        ...normalized,
        is_google: true
    };
}

export function getOriginalStatus({ is_google, is_original }) {
    if (!is_google) return i18n.t('original.not_gemini');
    return i18n.t('original.pass');
}

const statusMessage = typeof document !== 'undefined'
    ? document.getElementById('statusMessage')
    : null;
export function setStatusMessage(message = '', type = '') {
    if (!statusMessage) return;
    statusMessage.textContent = message;
    statusMessage.style.display = message ? 'block' : 'none';
    const colorMap = { warn: 'text-warn', success: 'text-success' };
    statusMessage.classList.remove(...Object.values(colorMap));
    if (colorMap[type]) statusMessage.classList.add(colorMap[type]);
}

const loadingOverlay = typeof document !== 'undefined'
    ? document.getElementById('loadingOverlay')
    : null;
export function showLoading(text = null) {
    if (!loadingOverlay) return;
    loadingOverlay.style.display = 'flex';
    const textEl = loadingOverlay.querySelector('p');
    if (textEl && text) textEl.textContent = text;
}

export function hideLoading() {
    if (!loadingOverlay) return;
    loadingOverlay.style.display = 'none';
}

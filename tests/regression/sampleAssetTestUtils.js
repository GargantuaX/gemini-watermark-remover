import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

export function inferMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.webp') return 'image/webp';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return 'image/png';
}

export function isMissingPlaywrightExecutableError(error) {
    const message = typeof error?.message === 'string'
        ? error.message
        : String(error ?? '');
    return message.includes('Executable doesn\'t exist') ||
        message.includes('Executable does not exist') ||
        message.includes('download new browsers');
}

export async function exists(filePath) {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

export async function readImageDataUrl(filePath) {
    const buffer = await readFile(filePath);
    const mime = inferMimeType(filePath);
    return `data:${mime};base64,${buffer.toString('base64')}`;
}

export async function decodeDataUrlInPage(page, dataUrl) {
    const output = await page.evaluate(async (imageUrl) => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
            width: imageData.width,
            height: imageData.height,
            data: imageData.data
        };
    }, dataUrl);

    return {
        width: output.width,
        height: output.height,
        data: new Uint8ClampedArray(output.data)
    };
}

export async function decodeImageDataInPage(page, filePath) {
    return decodeDataUrlInPage(page, await readImageDataUrl(filePath));
}

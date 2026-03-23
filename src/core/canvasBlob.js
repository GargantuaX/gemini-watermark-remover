export async function canvasToBlob(canvas, type = 'image/png') {
    if (typeof canvas?.convertToBlob === 'function') {
        return await canvas.convertToBlob({ type });
    }

    if (typeof canvas?.toBlob === 'function') {
        return await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Failed to encode image blob'));
                }
            }, type);
        });
    }

    throw new Error('Canvas blob export API is unavailable');
}

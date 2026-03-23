export function createSyntheticAlphaMap(size = 96) {
    const alpha = new Float32Array(size * size);
    const c = (size - 1) / 2;
    const radius = size / 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - c) / radius;
            const dy = (y - c) / radius;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const diamond = Math.max(Math.abs(dx), Math.abs(dy));

            const core = Math.max(0, 1.0 - diamond * 1.65);
            const ring = Math.max(0, 0.22 - Math.abs(dist - 0.44)) * 2.4;

            alpha[y * size + x] = Math.min(1, core + ring);
        }
    }

    return alpha;
}

export function createPatternImageData(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            data[idx] = 40 + ((x * 17 + y * 7) % 140);
            data[idx + 1] = 35 + ((x * 9 + y * 19) % 145);
            data[idx + 2] = 30 + ((x * 23 + y * 11) % 150);
            data[idx + 3] = 255;
        }
    }

    return { width, height, data };
}

export function cloneTestImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

export function applySyntheticWatermark(imageData, alphaMap, position, layers = 1) {
    for (let i = 0; i < layers; i++) {
        for (let row = 0; row < position.width; row++) {
            for (let col = 0; col < position.width; col++) {
                const a = alphaMap[row * position.width + col];
                if (a <= 0.001) continue;

                const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
                for (let channel = 0; channel < 3; channel++) {
                    const original = imageData.data[idx + channel];
                    const blended = a * 255 + (1 - a) * original;
                    imageData.data[idx + channel] = Math.max(0, Math.min(255, Math.round(blended)));
                }
            }
        }
    }
}

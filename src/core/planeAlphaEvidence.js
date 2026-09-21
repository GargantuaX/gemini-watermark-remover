function median(values) {
    return values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function solvePlane(matrix, values) {
    const rows = matrix.map((row, index) => [...row, values[index]]);
    for (let column = 0; column < 3; column++) {
        let pivot = column;
        for (let row = column + 1; row < 3; row++) {
            if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
        }
        [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
        if (Math.abs(rows[column][column]) < 1e-10) return null;
        const divisor = rows[column][column];
        for (let index = column; index < 4; index++) rows[column][index] /= divisor;
        for (let row = 0; row < 3; row++) {
            if (row === column) continue;
            const factor = rows[row][column];
            for (let index = column; index < 4; index++) rows[row][index] -= factor * rows[column][index];
        }
    }
    return rows.map(row => row[3]);
}

// Source-only evidence for the confirmed flat-vector 96px profile. The model
// never fills pixels: the eventual candidate still performs ordinary inverse alpha.
export function measurePlaneAlphaEvidence(image, position, alphaMap) {
    const size = 96;
    if (!image?.data || alphaMap?.length !== size * size ||
        position?.width !== size || position.height !== size ||
        position.x < 32 || position.y < 32 ||
        position.x + size + 32 > image.width || position.y + size + 32 > image.height) return null;
    const read = (x, y) => {
        const offset = ((position.y + y) * image.width + position.x + x) * 4;
        return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    };
    const points = [];
    for (let y = -32; y < size + 32; y += 2) {
        for (let x = -32; x < size + 32; x += 2) {
            if (x >= 0 && x < size && y >= 0 && y < size) continue;
            points.push({ vector: [1, x / size, y / size], rgb: read(x, y) });
        }
    }
    const training = points.filter((_, index) => index % 2 === 0);
    const validation = points.filter((_, index) => index % 2 === 1);
    let coefficients = [0, 1, 2].map(channel => [median(training.map(point => point.rgb[channel])), 0, 0]);
    const predict = vector => coefficients.map(row => row.reduce((sum, value, index) => sum + value * vector[index], 0));
    const error = point => {
        const predicted = predict(point.vector);
        return point.rgb.reduce((sum, value, channel) => sum + Math.abs(value - predicted[channel]), 0) / 3;
    };
    for (let iteration = 0; iteration < 8; iteration++) {
        const errors = training.map(error);
        const scale = Math.max(2, median(errors) * 2);
        const matrix = Array.from({ length: 3 }, () => [0, 0, 0]);
        const values = Array.from({ length: 3 }, () => [0, 0, 0]);
        for (let index = 0; index < training.length; index++) {
            const point = training[index];
            const weight = Math.min(1, scale / Math.max(errors[index], 0.001)) ** 2;
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 3; column++) matrix[row][column] += weight * point.vector[row] * point.vector[column];
                for (let channel = 0; channel < 3; channel++) values[channel][row] += weight * point.vector[row] * point.rgb[channel];
            }
        }
        coefficients = values.map(value => solvePlane(matrix, value));
        if (coefficients.some(row => row === null)) return null;
    }
    const backgroundSupport = validation.filter(point => error(point) < 3).length / validation.length;
    if (backgroundSupport < 0.8) return null;
    const trials = [];
    for (let step = 0; step <= 24; step++) {
        const gain = step * 0.05;
        let matches = 0;
        let total = 0;
        let inlierError = 0;
        const quadrants = Array.from({ length: 4 }, () => ({ matches: 0, total: 0 }));
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const alpha = alphaMap[y * size + x];
                if (alpha < 0.1) continue;
                const background = predict([1, x / size, y / size]);
                if (Math.max(...background) > 245 || Math.min(...background) < 0) continue;
                const difference = read(x, y).reduce((sum, value, channel) => sum + Math.abs(
                    value - ((1 - alpha * gain) * background[channel] + alpha * gain * 255)
                ), 0) / 3;
                const quadrant = quadrants[(y >= size / 2 ? 2 : 0) + (x >= size / 2 ? 1 : 0)];
                total++;
                quadrant.total++;
                if (difference < 3) {
                    matches++;
                    quadrant.matches++;
                    inlierError += difference;
                }
            }
        }
        trials.push({ gain, fraction: matches / total, error: matches ? inlierError / matches : Infinity,
            quadrants: quadrants.map(quadrant => quadrant.matches / quadrant.total) });
    }
    trials.sort((left, right) => right.fraction - left.fraction || left.error - right.error);
    const best = trials[0];
    const zero = trials.find(trial => trial.gain === 0);
    if (best.gain !== 1 || best.fraction < 0.55 || zero.fraction >= 0.1 ||
        !best.quadrants.every(fraction => fraction >= 0.3)) return null;
    return { backgroundSupport, gain: best.gain, matchFraction: best.fraction,
        quadrantSupport: best.quadrants, zeroGainSupport: zero.fraction };
}

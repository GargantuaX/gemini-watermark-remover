// Estimate a white watermark's gain from neighboring source pixels. This is
// evidence for inverse-alpha candidates only; never synthesize replacement rows.
function quantile(values, fraction) {
    if (values.length === 0) return NaN;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}

export function measureRowAlphaEvidence(image, position, alphaMap) {
    if (!image?.data || !position || position.width !== 48 || position.height !== 48 ||
        alphaMap?.length !== 48 * 48 || position.x < 20 || position.y < 0 ||
        position.x + 68 > image.width || position.y + 48 > image.height) return null;
    const gains = [];
    const quadrants = [[], [], [], []];
    const points = [];
    let outsideError = 0;
    let outsideCount = 0;
    for (let row = 0; row < 48; row++) {
        for (let channel = 0; channel < 3; channel++) {
            const value = column => image.data[
                ((position.y + row) * image.width + position.x + column) * 4 + channel
            ];
            const left = quantile(Array.from({ length: 12 }, (_, i) => value(-20 + i)), 0.5);
            const right = quantile(Array.from({ length: 12 }, (_, i) => value(56 + i)), 0.5);
            const background = column => left + (right - left) * (column + 14.5) / 76;
            for (const column of [-8, -6, -4, -2, 48, 50, 52, 54]) {
                outsideError += Math.abs(value(column) - background(column));
                outsideCount++;
            }
            for (let column = 0; column < 48; column++) {
                const alpha = alphaMap[row * 48 + column];
                const reference = background(column);
                if (alpha < 0.05 || reference > 220) continue;
                const observed = value(column);
                const gain = (observed - reference) / ((255 - reference) * alpha);
                gains.push(gain);
                quadrants[(row >= 24 ? 2 : 0) + (column >= 24 ? 1 : 0)].push(gain);
                points.push({ observed, reference, alpha });
            }
        }
    }
    if (quadrants.some(values => values.length < 24)) return null;
    const gain = quantile(gains, 0.5);
    return {
        gain,
        spread: quantile(gains, 0.75) - quantile(gains, 0.25),
        quadrants: quadrants.map(values => quantile(values, 0.5)),
        outsideError: outsideError / outsideCount,
        fitError: points.reduce((sum, point) => sum + Math.abs(
            point.observed - point.reference - (255 - point.reference) * point.alpha * gain
        ), 0) / points.length
    };
}

export function supportsRowAlphaGain(evidence, gain = 0.6) {
    return evidence != null && Math.abs(evidence.gain - gain) <= 0.05 &&
        evidence.spread <= 0.08 && evidence.outsideError <= 4 && evidence.fitError <= 3 &&
        evidence.quadrants.every(value => Math.abs(value - gain) <= 0.08);
}

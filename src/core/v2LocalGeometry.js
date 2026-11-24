import { interpolateAlphaMap } from './adaptiveDetector.js';
import { getEmbeddedAlphaMap } from './embeddedAlphaMaps.js';

const MEDIUM_SIZE = 48;
const SMALL_SIZE = 36;
const BLUR_KERNEL = [1, 4, 6, 4, 1];
const FOLDS = [[0, 3], [1, 2]];
const WHOLE_PROFILE = [[0, 1, 2, 3]];
const profilesBySize = new Map();

function highPass(values, width, height) {
    const horizontal = new Float32Array(values.length);
    const filtered = new Float32Array(values.length);
    for (let y = 0; y < height; y++) {
        for (let x = 2; x < width - 2; x++) {
            const i = y * width + x;
            for (let k = 0; k < BLUR_KERNEL.length; k++) {
                horizontal[i] += BLUR_KERNEL[k] * values[i + k - 2] / 16;
            }
        }
    }
    for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
            const i = y * width + x;
            let smooth = 0;
            for (let k = 0; k < BLUR_KERNEL.length; k++) {
                smooth += BLUR_KERNEL[k] * horizontal[i + (k - 2) * width] / 16;
            }
            filtered[i] = values[i] - smooth;
        }
    }
    return filtered;
}

function rotate45(values, size) {
    const center = (size - 1) / 2;
    return values.map((_, i) => {
        const x = i % size - center;
        const y = Math.floor(i / size) - center;
        const sourceX = (x - y) * Math.SQRT1_2 + center;
        const sourceY = (x + y) * Math.SQRT1_2 + center;
        const left = Math.floor(sourceX);
        const top = Math.floor(sourceY);
        if (left < 0 || top < 0 || left + 1 >= size || top + 1 >= size) return 0;
        const dx = sourceX - left;
        const dy = sourceY - top;
        const j = top * size + left;
        return (1 - dy) * ((1 - dx) * values[j] + dx * values[j + 1]) +
            dy * ((1 - dx) * values[j + size] + dx * values[j + size + 1]);
    });
}

function createProbes(alpha, size) {
    const profile = highPass(alpha.map(value => -Math.log1p(-value)), size, size);
    const cutoff = Math.max(...profile.map(Math.abs)) * 0.05;
    const probes = [];
    for (let y = 2; y < size - 2; y++) {
        for (let x = 2; x < size - 2; x++) {
            const weight = profile[y * size + x];
            if (Math.abs(weight) < cutoff) continue;
            const quadrant = (x >= size / 2 ? 1 : 0) + (y >= size / 2 ? 2 : 0);
            probes.push({x, y, weight, quadrant});
        }
    }
    return probes;
}

function getProfiles(size) {
    if (!profilesBySize.has(size)) {
        const profiles = [getEmbeddedAlphaMap(MEDIUM_SIZE), getEmbeddedAlphaMap('36-v2')].map(alpha => {
            const scale = 0.5 / Math.max(...alpha);
            const resized = interpolateAlphaMap(alpha, Math.sqrt(alpha.length), size).map(value => value * scale);
            return {target: createProbes(resized, size), rotation: createProbes(rotate45(resized, size), size)};
        });
        profilesBySize.set(size, profiles);
    }
    return profilesBySize.get(size);
}

function measureSource(image, seed, maxRadius) {
    // Include pixels used by the furthest translated controls and the blur kernel.
    const centerX = seed.x + seed.width / 2;
    const centerY = seed.y + seed.height / 2;
    const reach = Math.ceil(MEDIUM_SIZE * 1.5 + maxRadius) + 3;
    const left = Math.max(0, Math.floor(centerX - reach));
    const top = Math.max(0, Math.floor(centerY - reach));
    const right = Math.min(image.width, Math.ceil(centerX + reach));
    const bottom = Math.min(image.height, Math.ceil(centerY + reach));
    const width = right - left;
    const height = bottom - top;
    const values = Float32Array.from({length: width * height}, (_, i) => {
        const index = ((top + Math.floor(i / width)) * image.width + left + i % width) * 4;
        return -(Math.log(Math.max(8, 255 - image.data[index])) +
            Math.log(Math.max(8, 255 - image.data[index + 1])) +
            Math.log(Math.max(8, 255 - image.data[index + 2]))) / 3;
    });
    return {left, top, width, values: highPass(values, width, height)};
}

function score(source, probes, x, y, groups = FOLDS) {
    const sums = Array.from({length: 4}, () => [0, 0, 0]);
    const start = (y - source.top) * source.width + x - source.left;
    for (const {x: dx, y: dy, weight, quadrant} of probes) {
        const pixel = source.values[start + dy * source.width + dx];
        const sum = sums[quadrant];
        sum[0] += pixel * weight;
        sum[1] += weight * weight;
        sum[2] += pixel * pixel;
    }
    return {
        allPositive: sums.every(sum => sum[0] > 0),
        folds: groups.map(group => {
            let dot = 0;
            let profilePower = 0;
            let sourcePower = 0;
            for (const quadrant of group) {
                const [quadrantDot, quadrantProfile, quadrantSource] = sums[quadrant];
                dot += quadrantDot;
                profilePower += quadrantProfile;
                sourcePower += quadrantSource;
            }
            return dot / Math.sqrt(profilePower * sourcePower) || 0;
        })
    };
}

function verifyAgainstControls(image, source, profile, position, target, groups = FOLDS) {
    const {x, y, width: size} = position;
    const rotation = score(source, profile.rotation, x, y, groups).folds;
    let margin = Math.min(...target.folds.map((value, fold) => value - rotation[fold]));
    if (margin <= 0) return null;
    for (const step of [Math.max(5, Math.round(size / 8)), Math.round(size / 4), size]) {
        for (const dx of [-step, 0, step]) {
            for (const dy of [-step, 0, step]) {
                if ((!dx && !dy) || x + dx < 0 || y + dy < 0 ||
                    x + dx + size > image.width || y + dy + size > image.height) continue;
                const control = score(source, profile.target, x + dx, y + dy, groups).folds;
                margin = Math.min(margin, ...target.folds.map((value, fold) => value - control[fold]));
                if (margin <= 0) return null;
            }
        }
    }
    return {margin, folds: target.folds};
}

export function verifyFixedV2WhiteSource(image, position, {requireLocalPeak = false} = {}) {
    const source = measureSource(image, position, 0);
    const {x, y, width} = position;
    return getProfiles(width).every(profile => {
        const target = score(source, profile.target, x, y, WHOLE_PROFILE);
        return target.folds[0] > 0 && (!requireLocalPeak ||
            verifyAgainstControls(image, source, profile, position, target, WHOLE_PROFILE) !== null);
    });
}

function isBetter(candidate, previous) {
    if (!previous) return true;
    return (candidate.score - previous.score || candidate.margin - previous.margin ||
        previous.position.x - candidate.position.x || previous.position.y - candidate.position.y ||
        previous.position.width - candidate.position.width) > 0;
}

export function findVerifiedV2LocalGeometry(image, seed) {
    const originalRadius = Math.ceil(seed.width / 4);
    const mediumRadius = Math.max(originalRadius, MEDIUM_SIZE / 4);
    const source = measureSource(image, seed, mediumRadius);
    let winner = null;
    let seedVerified = false;
    for (const size of new Set([seed.width, SMALL_SIZE, MEDIUM_SIZE])) {
        const radius = size === MEDIUM_SIZE ? mediumRadius : originalRadius;
        const profiles = getProfiles(size);
        const inset = Math.round((seed.width - size) / 2);
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                const x = seed.x + inset + dx;
                const y = seed.y + inset + dy;
                if (x < 0 || y < 0 || x + size > image.width || y + size > image.height) continue;
                const targets = profiles.map(profile => score(source, profile.target, x, y));
                if (!targets.every(target => target.allPositive)) continue;
                const position = {x, y, width: size, height: size};
                const checked = profiles.map((profile, i) => verifyAgainstControls(image, source, profile, position, targets[i]));
                if (checked.some(result => result === null)) continue;
                if (size === seed.width && x === seed.x && y === seed.y) seedVerified = true;
                const candidate = {position,
                    score: checked.flatMap(result => result.folds).reduce((sum, value) => sum + value, 0) / 4,
                    margin: Math.min(...checked.map(result => result.margin))};
                if (isBetter(candidate, winner)) winner = candidate;
            }
        }
    }
    return {position: winner?.position ?? null, seedVerified};
}

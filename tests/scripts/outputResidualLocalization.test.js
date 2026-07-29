import assert from 'node:assert/strict';
import test from 'node:test';

let outputLocalization = {};
try {
    outputLocalization = await import(
        '../../scripts/output-residual-localization.js'
    );
} catch {
    // The first TDD run intentionally precedes the implementation module.
}

function createDiamondAlphaMap(size) {
    const alphaMap = new Float64Array(size * size);
    const center = Math.floor(size / 2);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const distance =
                Math.abs(x - center) + Math.abs(y - center);
            alphaMap[y * size + x] =
                distance <= 4 ? 1 - distance / 5 : 0;
        }
    }
    return alphaMap;
}

function createResidualImage(alphaMap, size, {
    amplitude,
    shiftX = 0,
    shiftY = 0
}) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sourceX = x - shiftX;
            const sourceY = y - shiftY;
            const alpha =
                sourceX >= 0 &&
                sourceY >= 0 &&
                sourceX < size &&
                sourceY < size
                    ? alphaMap[sourceY * size + sourceX]
                    : 0;
            const value = 128 + amplitude * alpha;
            const offset = (y * size + x) * 4;
            data[offset] = value;
            data[offset + 1] = value;
            data[offset + 2] = value;
            data[offset + 3] = 255;
        }
    }
    return { width: size, height: size, data };
}

function createBroadGradientImage(size) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const value = 64 + x * 8;
            const offset = (y * size + x) * 4;
            data[offset] = value;
            data[offset + 1] = value;
            data[offset + 2] = value;
            data[offset + 3] = 255;
        }
    }
    return { width: size, height: size, data };
}

const DECOY_SHIFTS = [
    [-4, 0],
    [4, 0],
    [0, -4],
    [0, 4]
];

test('exact output-domain star outranks the same damage translated off-anchor', () => {
    assert.equal(
        typeof outputLocalization.measureOutputResidualLocalization,
        'function',
        'measureOutputResidualLocalization must be exported'
    );
    const size = 15;
    const alphaMap = createDiamondAlphaMap(size);
    const exact =
        outputLocalization.measureOutputResidualLocalization({
            imageData: createResidualImage(alphaMap, size, {
                amplitude: -48
            }),
            alphaMap,
            position: { x: 0, y: 0, width: size, height: size },
            decoyShifts: DECOY_SHIFTS
        });
    const translated =
        outputLocalization.measureOutputResidualLocalization({
            imageData: createResidualImage(alphaMap, size, {
                amplitude: -48,
                shiftX: 4
            }),
            alphaMap,
            position: { x: 0, y: 0, width: size, height: size },
            decoyShifts: DECOY_SHIFTS
        });

    assert.ok(exact.spatialProminence > translated.spatialProminence);
    assert.ok(exact.gradientProminence > translated.gradientProminence);
    assert.ok(exact.spatialProminence > 0.5);
});

test('localization is symmetric for light and dark star residuals', () => {
    assert.equal(
        typeof outputLocalization.measureOutputResidualLocalization,
        'function',
        'measureOutputResidualLocalization must be exported'
    );
    const size = 15;
    const alphaMap = createDiamondAlphaMap(size);
    const measure = (amplitude) =>
        outputLocalization.measureOutputResidualLocalization({
            imageData: createResidualImage(alphaMap, size, {
                amplitude
            }),
            alphaMap,
            position: { x: 0, y: 0, width: size, height: size },
            decoyShifts: DECOY_SHIFTS
        });

    const dark = measure(-48);
    const light = measure(48);

    assert.ok(
        Math.abs(dark.spatialProminence - light.spatialProminence) <
            0.02
    );
    assert.ok(
        Math.abs(dark.gradientProminence - light.gradientProminence) <
            0.02
    );
});

test('small anchor drift remains local while a far translation becomes a control', () => {
    const size = 15;
    const alphaMap = createDiamondAlphaMap(size);
    const decoyShifts = [
        [-8, 0],
        [-4, 0],
        [4, 0],
        [8, 0],
        [0, -8],
        [0, -4],
        [0, 4],
        [0, 8]
    ];
    const measure = (shiftX) =>
        outputLocalization.measureOutputResidualLocalization({
            imageData: createResidualImage(alphaMap, size, {
                amplitude: -48,
                shiftX
            }),
            alphaMap,
            position: { x: 0, y: 0, width: size, height: size },
            decoyShifts
        });

    const exact = measure(0);
    const near = measure(4);
    const far = measure(8);

    assert.ok(exact.spatialLocalProminence > 0.4);
    assert.ok(near.spatialLocalProminence > 0.4);
    assert.ok(
        near.spatialLocalProminence >
            far.spatialLocalProminence + 0.4
    );
    assert.ok(
        near.gradientLocalProminence >
            far.gradientLocalProminence + 0.2
    );
});

test('uniform output does not invent a localization ratio or percentile', () => {
    assert.equal(
        typeof outputLocalization.measureOutputResidualLocalization,
        'function',
        'measureOutputResidualLocalization must be exported'
    );
    const size = 15;
    const alphaMap = createDiamondAlphaMap(size);
    const result =
        outputLocalization.measureOutputResidualLocalization({
            imageData: createResidualImage(alphaMap, size, {
                amplitude: 0
            }),
            alphaMap,
            position: { x: 0, y: 0, width: size, height: size },
            decoyShifts: DECOY_SHIFTS
        });

    assert.equal(result.spatialTarget, 0);
    assert.equal(result.spatialRatio, null);
    assert.equal(result.spatialPercentile, null);
    assert.equal(result.gradientTarget, 0);
    assert.equal(result.gradientRatio, null);
    assert.equal(result.gradientPercentile, null);
    assert.equal(result.twoSidedEdgeTarget, 0);
    assert.equal(result.twoSidedEdgeRatio, null);
    assert.equal(result.twoSidedEdgePercentile, null);
});

test('two-sided edge localization does not cancel a dark alpha-shaped outline', () => {
    const size = 15;
    const alphaMap = createDiamondAlphaMap(size);
    const exact = outputLocalization.measureOutputResidualLocalization({
        imageData: createResidualImage(alphaMap, size, {
            amplitude: -48
        }),
        alphaMap,
        position: { x: 0, y: 0, width: size, height: size },
        decoyShifts: DECOY_SHIFTS
    });
    const translated = outputLocalization.measureOutputResidualLocalization({
        imageData: createResidualImage(alphaMap, size, {
            amplitude: -48,
            shiftX: 4
        }),
        alphaMap,
        position: { x: 0, y: 0, width: size, height: size },
        decoyShifts: DECOY_SHIFTS
    });

    assert.ok(exact.twoSidedEdgeTarget > 10);
    assert.ok(exact.twoSidedEdgeProminence > translated.twoSidedEdgeProminence);
    assert.ok(exact.twoSidedEdgeRatio > 1);
});

test('two-sided edge localization is symmetric for light and dark residuals', () => {
    const size = 15;
    const alphaMap = createDiamondAlphaMap(size);
    const measure = (amplitude) =>
        outputLocalization.measureOutputResidualLocalization({
            imageData: createResidualImage(alphaMap, size, { amplitude }),
            alphaMap,
            position: { x: 0, y: 0, width: size, height: size },
            decoyShifts: DECOY_SHIFTS
        });

    const dark = measure(-48);
    const light = measure(48);
    assert.ok(
        Math.abs(dark.twoSidedEdgeTarget - light.twoSidedEdgeTarget) < 0.1
    );
    assert.ok(
        Math.abs(
            dark.twoSidedEdgeProminence -
            light.twoSidedEdgeProminence
        ) < 0.1
    );
});

test('broad image gradient does not look alpha-edge localized', () => {
    const size = 15;
    const alphaMap = createDiamondAlphaMap(size);
    const result = outputLocalization.measureOutputResidualLocalization({
        imageData: createBroadGradientImage(size),
        alphaMap,
        position: { x: 0, y: 0, width: size, height: size },
        decoyShifts: DECOY_SHIFTS
    });

    assert.ok(result.twoSidedEdgeTarget > 0);
    assert.ok(result.twoSidedEdgeProminence < 1);
    assert.ok(result.twoSidedEdgeRatio < 1.2);
});

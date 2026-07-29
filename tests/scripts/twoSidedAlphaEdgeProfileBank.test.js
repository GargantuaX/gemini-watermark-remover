import assert from 'node:assert/strict';
import test from 'node:test';

let profileBank = {};
try {
    profileBank = await import(
        '../../scripts/two-sided-alpha-edge-profile-bank.js'
    );
} catch {
    // The first TDD run intentionally precedes the implementation module.
}

function createDiamondAlphaMap(size, radius) {
    const alphaMap = new Float64Array(size * size);
    const center = Math.floor(size / 2);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const distance =
                Math.abs(x - center) + Math.abs(y - center);
            alphaMap[y * size + x] =
                distance <= radius
                    ? 1 - distance / (radius + 1)
                    : 0;
        }
    }
    return alphaMap;
}

function createResidualImage(alphaMap, size, amplitude = -48) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let pixelIndex = 0; pixelIndex < size * size; pixelIndex++) {
        const value = 128 + amplitude * alphaMap[pixelIndex];
        const offset = pixelIndex * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
    }
    return { width: size, height: size, data };
}

const DECOY_SHIFTS = [
    [-6, 0],
    [6, 0],
    [0, -6],
    [0, 6]
];

test('matching alpha shape wins the pre-registered profile bank', () => {
    assert.equal(
        typeof profileBank.measureTwoSidedAlphaEdgeProfileBank,
        'function',
        'measureTwoSidedAlphaEdgeProfileBank must be exported'
    );
    const size = 21;
    const radius3 = createDiamondAlphaMap(size, 3);
    const result = profileBank.measureTwoSidedAlphaEdgeProfileBank({
        imageData: createResidualImage(radius3, size),
        position: { x: 0, y: 0, width: size, height: size },
        profiles: [
            { id: 'radius-5', alphaMap: createDiamondAlphaMap(size, 5) },
            { id: 'radius-3', alphaMap: radius3 }
        ],
        decoyShifts: DECOY_SHIFTS
    });

    assert.equal(result.primaryProfileId, 'radius-3');
    assert.ok(result.primaryScore > 1);
    assert.ok(
        result.trials.find((trial) => trial.id === 'radius-3')
            .medianDecoyRatio >
        result.trials.find((trial) => trial.id === 'radius-5')
            .medianDecoyRatio
    );
});

test('uniform output does not create a profile-bank winner', () => {
    const size = 21;
    const result = profileBank.measureTwoSidedAlphaEdgeProfileBank({
        imageData: createResidualImage(
            new Float64Array(size * size),
            size,
            0
        ),
        position: { x: 0, y: 0, width: size, height: size },
        profiles: [
            { id: 'radius-3', alphaMap: createDiamondAlphaMap(size, 3) },
            { id: 'radius-5', alphaMap: createDiamondAlphaMap(size, 5) }
        ],
        decoyShifts: DECOY_SHIFTS
    });

    assert.equal(result.primaryScore, null);
    assert.equal(result.primaryProfileId, null);
    assert.equal(result.secondaryScore, null);
    assert.equal(result.secondaryProfileId, null);
});

test('duplicate profile ids are rejected before scoring', () => {
    const size = 21;
    const alphaMap = createDiamondAlphaMap(size, 3);
    assert.throws(
        () => profileBank.measureTwoSidedAlphaEdgeProfileBank({
            imageData: createResidualImage(alphaMap, size),
            position: { x: 0, y: 0, width: size, height: size },
            profiles: [
                { id: 'duplicate', alphaMap },
                { id: 'duplicate', alphaMap }
            ],
            decoyShifts: DECOY_SHIFTS
        }),
        /profile ids must be unique/
    );
});

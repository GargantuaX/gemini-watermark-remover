import assert from 'node:assert/strict';
import test from 'node:test';

let disagreement = {};
try {
    disagreement = await import(
        '../../scripts/restoration-candidate-disagreement.js'
    );
} catch {
    // The first TDD run intentionally precedes the implementation module.
}

function createImage(values, width = 3, height = 1) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) {
        const value = values[index];
        const offset = index * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
    }
    return { width, height, data };
}

function measure(candidates, options = {}) {
    assert.equal(
        typeof disagreement.measureRestorationCandidateDisagreement,
        'function',
        'measureRestorationCandidateDisagreement must be exported'
    );
    return disagreement.measureRestorationCandidateDisagreement({
        candidates,
        alphaMap: new Float32Array([0, 0.1, 0.6]),
        position: { x: 0, y: 0, width: 3, height: 1 },
        evidenceTolerance: 0.05,
        ...options
    });
}

test('identical plausible restorations have zero support disagreement', () => {
    const candidates = [
        { id: 'a', evidenceCost: 0.1, imageData: createImage([10, 20, 30]) },
        { id: 'b', evidenceCost: 0.12, imageData: createImage([10, 20, 30]) }
    ];

    const result = measure(candidates);

    assert.equal(result.status, 'complete');
    assert.equal(result.plausibleCandidateCount, 2);
    assert.equal(result.supportPixelCount, 2);
    assert.equal(result.meanLumaRange, 0);
    assert.equal(result.edgeMeanLumaRange, 0);
    assert.equal(result.coreMeanLumaRange, 0);
});

test('differences outside alpha support do not create uncertainty', () => {
    const result = measure([
        { id: 'a', evidenceCost: 0.1, imageData: createImage([0, 20, 30]) },
        { id: 'b', evidenceCost: 0.1, imageData: createImage([255, 20, 30]) }
    ]);

    assert.equal(result.meanLumaRange, 0);
    assert.equal(result.maximumLumaRange, 0);
});

test('near-equivalent candidates that diverge in the support produce a literal range', () => {
    const result = measure([
        { id: 'a', evidenceCost: 0.1, imageData: createImage([10, 20, 30]) },
        { id: 'b', evidenceCost: 0.14, imageData: createImage([10, 30, 50]) }
    ]);

    assert.equal(result.meanLumaRange, 15);
    assert.equal(result.edgeMeanLumaRange, 10);
    assert.equal(result.coreMeanLumaRange, 20);
    assert.equal(result.maximumLumaRange, 20);
});

test('a poorly supported outlier is excluded before disagreement is measured', () => {
    const result = measure([
        { id: 'best', evidenceCost: 0.1, imageData: createImage([10, 20, 30]) },
        { id: 'near', evidenceCost: 0.12, imageData: createImage([10, 22, 32]) },
        { id: 'bad', evidenceCost: 0.3, imageData: createImage([10, 200, 250]) }
    ]);

    assert.deepEqual(result.plausibleCandidateIds, ['best', 'near']);
    assert.equal(result.meanLumaRange, 2);
});

test('candidate order cannot change disagreement or plausible membership', () => {
    const candidates = [
        { id: 'a', evidenceCost: 0.11, imageData: createImage([10, 20, 30]) },
        { id: 'b', evidenceCost: 0.1, imageData: createImage([10, 28, 44]) },
        { id: 'c', evidenceCost: 0.4, imageData: createImage([10, 255, 255]) }
    ];

    const forward = measure(candidates);
    const reverse = measure([...candidates].reverse());

    assert.deepEqual(reverse.plausibleCandidateIds, forward.plausibleCandidateIds);
    assert.equal(reverse.meanLumaRange, forward.meanLumaRange);
    assert.equal(reverse.alphaWeightedMeanLumaRange, forward.alphaWeightedMeanLumaRange);
});

import assert from 'node:assert/strict';
import test from 'node:test';

let groundTruthModule = null;
try {
    groundTruthModule = await import(
        '../../scripts/synthetic-residual-ground-truth.js'
    );
} catch {
    // RED: the ground-truth decomposition module does not exist yet.
}

function createFlatImageData(value = 100) {
    const data = new Uint8ClampedArray(2 * 2 * 4);
    for (let index = 0; index < 4; index++) {
        const offset = index * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
    }
    return { width: 2, height: 2, data };
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function addRgbError(imageData, pixelIndexes, delta) {
    for (const pixelIndex of pixelIndexes) {
        const offset = pixelIndex * 4;
        for (let channel = 0; channel < 3; channel++) {
            imageData.data[offset + channel] += delta;
        }
    }
}

test('decomposes a known positive watermark-shaped error from clean truth', () => {
    assert.equal(
        typeof groundTruthModule?.measureRestorationAgainstTruth,
        'function'
    );
    const truth = createFlatImageData();
    const candidate = cloneImageData(truth);
    addRgbError(candidate, [0, 1], 16);

    const measured = groundTruthModule.measureRestorationAgainstTruth({
        truthImageData: truth,
        candidateImageData: candidate,
        alphaMap: new Float32Array([0.5, 0.5, 0, 0]),
        position: { x: 0, y: 0, width: 2, height: 2 }
    });

    assert.ok(
        Math.abs(measured.template.signedAmplitude - 16 / 77.5) <
            1e-12
    );
    assert.equal(
        measured.template.underAmplitude,
        measured.template.signedAmplitude
    );
    assert.equal(measured.template.overAmplitude, 0);
    assert.ok(Math.abs(measured.roi.mae - 8) < 1e-12);
    assert.ok(
        Math.abs(measured.roi.rmse - Math.sqrt(128)) < 1e-12
    );
    assert.ok(
        Math.abs(measured.template.rmse - Math.sqrt(128)) < 1e-12
    );
    assert.ok(measured.orthogonal.rmse < 1e-12);
});

test('keeps negative template overshoot separate from under-removal', () => {
    const truth = createFlatImageData();
    const candidate = cloneImageData(truth);
    addRgbError(candidate, [0, 1], -16);

    const measured = groundTruthModule.measureRestorationAgainstTruth({
        truthImageData: truth,
        candidateImageData: candidate,
        alphaMap: new Float32Array([0.5, 0.5, 0, 0]),
        position: { x: 0, y: 0, width: 2, height: 2 }
    });

    assert.ok(
        Math.abs(measured.template.signedAmplitude + 16 / 77.5) <
            1e-12
    );
    assert.equal(measured.template.underAmplitude, 0);
    assert.equal(
        measured.template.overAmplitude,
        -measured.template.signedAmplitude
    );
    assert.ok(measured.orthogonal.rmse < 1e-12);
});

test('reports non-template content damage as orthogonal error', () => {
    const truth = createFlatImageData();
    const candidate = cloneImageData(truth);
    addRgbError(candidate, [2, 3], 10);

    const measured = groundTruthModule.measureRestorationAgainstTruth({
        truthImageData: truth,
        candidateImageData: candidate,
        alphaMap: new Float32Array([0.5, 0.5, 0, 0]),
        position: { x: 0, y: 0, width: 2, height: 2 }
    });

    assert.equal(measured.template.signedAmplitude, 0);
    assert.equal(measured.template.rmse, 0);
    assert.ok(
        Math.abs(measured.orthogonal.rmse - Math.sqrt(50)) < 1e-12
    );
});

test('forward compositing treats negative alpha as a black-logo component', () => {
    assert.equal(
        typeof groundTruthModule?.compositeKnownWatermark,
        'function'
    );
    const truth = createFlatImageData();
    const watermarked = groundTruthModule.compositeKnownWatermark({
        truthImageData: truth,
        alphaMap: new Float32Array([0.5, -0.1, 0, 0]),
        position: { x: 0, y: 0, width: 2, height: 2 }
    });

    assert.deepEqual(
        Array.from(watermarked.data.slice(0, 8)),
        [178, 178, 178, 255, 90, 90, 90, 255]
    );
    assert.deepEqual(
        Array.from(truth.data.slice(0, 8)),
        [100, 100, 100, 255, 100, 100, 100, 255]
    );
});

test('can use the observed forward delta as an independent empirical basis', () => {
    const truth = createFlatImageData();
    const watermarked = cloneImageData(truth);
    const candidate = cloneImageData(truth);
    addRgbError(watermarked, [0], 20);
    addRgbError(watermarked, [1], -10);
    addRgbError(candidate, [0], 10);
    addRgbError(candidate, [1], -5);

    const measured = groundTruthModule.measureRestorationAgainstTruth({
        truthImageData: truth,
        watermarkedImageData: watermarked,
        candidateImageData: candidate,
        position: { x: 0, y: 0, width: 2, height: 2 }
    });

    assert.equal(measured.template.basisSource, 'empirical-forward-delta');
    assert.ok(Math.abs(measured.template.signedAmplitude - 0.5) < 1e-12);
    assert.equal(measured.template.underAmplitude, 0.5);
    assert.equal(measured.template.overAmplitude, 0);
    assert.ok(Math.abs(measured.roi.mae - 3.75) < 1e-12);
    assert.ok(
        Math.abs(measured.template.rmse - Math.sqrt(31.25)) < 1e-12
    );
    assert.ok(measured.orthogonal.rmse < 1e-12);
});

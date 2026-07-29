import assert from 'node:assert/strict';
import test from 'node:test';

let classifier = {};
try {
    classifier = await import('../../scripts/shadow-logistic-classifier.js');
} catch {
    // The first TDD run intentionally precedes the implementation module.
}

function fit(rows, options = {}) {
    assert.equal(
        typeof classifier.fitStandardizedLogisticClassifier,
        'function',
        'fitStandardizedLogisticClassifier must be exported'
    );
    return classifier.fitStandardizedLogisticClassifier(rows, {
        featureNames: ['x'],
        iterations: 1200,
        learningRate: 0.08,
        l2: 0.1,
        ...options
    });
}

test('a fitted classifier ranks held-out positive evidence above negative evidence', () => {
    const model = fit([
        { label: 0, features: { x: -2 } },
        { label: 0, features: { x: -1 } },
        { label: 1, features: { x: 1 } },
        { label: 1, features: { x: 2 } }
    ]);

    const negative = classifier.predictLogisticProbability(model, {
        features: { x: -1.5 }
    });
    const positive = classifier.predictLogisticProbability(model, {
        features: { x: 1.5 }
    });

    assert.ok(positive > 0.8);
    assert.ok(negative < 0.2);
    assert.ok(positive > negative);
});

test('missing and constant features are imputed without producing NaN', () => {
    const model = fit([
        { label: 0, features: { x: null, constant: 7 } },
        { label: 0, features: { x: -1, constant: 7 } },
        { label: 1, features: { x: 1, constant: 7 } },
        { label: 1, features: { x: 2, constant: 7 } }
    ], {
        featureNames: ['x', 'constant']
    });

    const probability = classifier.predictLogisticProbability(model, {
        features: { x: null, constant: 7 }
    });

    assert.ok(Number.isFinite(probability));
    assert.ok(Number.isFinite(model.weights[0]));
    assert.ok(Number.isFinite(model.weights[1]));
});

test('prediction ignores a label attached to the scored record', () => {
    const model = fit([
        { label: 0, features: { x: -2 } },
        { label: 0, features: { x: -1 } },
        { label: 1, features: { x: 1 } },
        { label: 1, features: { x: 2 } }
    ]);
    const cleanLabel = classifier.predictLogisticProbability(model, {
        label: 0,
        features: { x: 0.5 }
    });
    const dirtyLabel = classifier.predictLogisticProbability(model, {
        label: 1,
        features: { x: 0.5 }
    });

    assert.equal(dirtyLabel, cleanLabel);
});

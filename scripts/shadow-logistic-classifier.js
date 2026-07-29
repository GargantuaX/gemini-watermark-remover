function median(values) {
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (sorted.length === 0) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function sigmoid(value) {
    if (value >= 0) {
        const inverse = Math.exp(-value);
        return 1 / (1 + inverse);
    }
    const exponential = Math.exp(value);
    return exponential / (1 + exponential);
}

function createFeatureTransform(rows, featureNames) {
    const medians = featureNames.map((name) =>
        median(rows.map((row) => row.features?.[name]))
    );
    const imputed = rows.map((row) => featureNames.map((name, index) => {
        const value = row.features?.[name];
        return Number.isFinite(value) ? value : medians[index];
    }));
    const means = featureNames.map((_, index) =>
        imputed.reduce((sum, values) => sum + values[index], 0) / imputed.length
    );
    const scales = featureNames.map((_, index) => {
        const variance = imputed.reduce((sum, values) => {
            const delta = values[index] - means[index];
            return sum + delta * delta;
        }, 0) / imputed.length;
        const scale = Math.sqrt(variance);
        return scale > Number.EPSILON ? scale : 1;
    });
    return { medians, means, scales };
}

function transformFeatures(row, model) {
    return model.featureNames.map((name, index) => {
        const value = row.features?.[name];
        const imputed = Number.isFinite(value) ? value : model.medians[index];
        return (imputed - model.means[index]) / model.scales[index];
    });
}

export function fitStandardizedLogisticClassifier(rows, {
    featureNames,
    iterations = 1500,
    learningRate = 0.05,
    l2 = 1
} = {}) {
    if (!Array.isArray(rows) || rows.length < 2) {
        throw new TypeError('rows must contain at least two training records');
    }
    if (!Array.isArray(featureNames) || featureNames.length === 0) {
        throw new TypeError('featureNames must contain at least one feature');
    }
    if (!Number.isInteger(iterations) || iterations <= 0) {
        throw new TypeError('iterations must be a positive integer');
    }
    if (!Number.isFinite(learningRate) || learningRate <= 0) {
        throw new TypeError('learningRate must be positive');
    }
    if (!Number.isFinite(l2) || l2 < 0) {
        throw new TypeError('l2 must be non-negative');
    }
    const positiveCount = rows.filter((row) => row.label === 1).length;
    const negativeCount = rows.filter((row) => row.label === 0).length;
    if (positiveCount === 0 || negativeCount === 0) {
        throw new TypeError('training rows must contain both binary labels');
    }

    const transform = createFeatureTransform(rows, featureNames);
    const model = {
        featureNames: [...featureNames],
        ...transform,
        weights: new Array(featureNames.length).fill(0),
        bias: 0
    };
    const transformedRows = rows.map((row) => ({
        label: row.label,
        features: transformFeatures(row, model),
        sampleWeight: row.label === 1
            ? rows.length / (2 * positiveCount)
            : rows.length / (2 * negativeCount)
    }));
    const totalWeight = transformedRows.reduce(
        (sum, row) => sum + row.sampleWeight,
        0
    );

    for (let iteration = 0; iteration < iterations; iteration++) {
        const weightGradients = new Array(featureNames.length).fill(0);
        let biasGradient = 0;
        for (const row of transformedRows) {
            const linear = model.weights.reduce(
                (sum, weight, index) => sum + weight * row.features[index],
                model.bias
            );
            const error = (sigmoid(linear) - row.label) * row.sampleWeight;
            biasGradient += error;
            for (let index = 0; index < weightGradients.length; index++) {
                weightGradients[index] += error * row.features[index];
            }
        }
        model.bias -= learningRate * biasGradient / totalWeight;
        for (let index = 0; index < model.weights.length; index++) {
            const gradient =
                weightGradients[index] / totalWeight +
                l2 * model.weights[index] / rows.length;
            model.weights[index] -= learningRate * gradient;
        }
    }
    return model;
}

export function predictLogisticProbability(model, row) {
    if (!model || !Array.isArray(model.weights)) {
        throw new TypeError('model must be fitted logistic classifier data');
    }
    const features = transformFeatures(row, model);
    const linear = model.weights.reduce(
        (sum, weight, index) => sum + weight * features[index],
        model.bias
    );
    return sigmoid(linear);
}

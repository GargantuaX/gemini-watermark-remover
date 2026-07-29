function assertImageData(imageData, name) {
    if (
        !imageData ||
        !Number.isInteger(imageData.width) ||
        !Number.isInteger(imageData.height) ||
        imageData.width <= 0 ||
        imageData.height <= 0 ||
        !imageData.data ||
        imageData.data.length !== imageData.width * imageData.height * 4
    ) {
        throw new TypeError(`${name} must be valid RGBA ImageData-like data`);
    }
}

function assertPosition(position, imageData) {
    if (
        !position ||
        !Number.isInteger(position.x) ||
        !Number.isInteger(position.y) ||
        !Number.isInteger(position.width) ||
        !Number.isInteger(position.height) ||
        position.x < 0 ||
        position.y < 0 ||
        position.width <= 0 ||
        position.height <= 0 ||
        position.x + position.width > imageData.width ||
        position.y + position.height > imageData.height
    ) {
        throw new RangeError('position must be an in-bounds integer rectangle');
    }
}

function assertForwardModel({
    truthImageData,
    alphaMap,
    position,
    alphaGain,
    logoValue
}) {
    assertImageData(truthImageData, 'truthImageData');
    assertPosition(position, truthImageData);
    if (
        !alphaMap ||
        alphaMap.length !== position.width * position.height
    ) {
        throw new RangeError(
            'alphaMap length must equal position.width * position.height'
        );
    }
    if (!Number.isFinite(alphaGain)) {
        throw new TypeError('alphaGain must be finite');
    }
    if (!Number.isFinite(logoValue)) {
        throw new TypeError('logoValue must be finite');
    }
}

function clampByte(value) {
    return Math.min(255, Math.max(0, Math.round(value)));
}

/**
 * Renders the known white-logo forward model onto a clean image.
 *
 * Negative alpha values follow the production convention: their magnitude is
 * composited as a black-logo component.
 */
export function compositeKnownWatermark({
    truthImageData,
    alphaMap,
    position,
    alphaGain = 1,
    logoValue = 255
}) {
    assertForwardModel({
        truthImageData,
        alphaMap,
        position,
        alphaGain,
        logoValue
    });

    const output = {
        width: truthImageData.width,
        height: truthImageData.height,
        data: new Uint8ClampedArray(truthImageData.data)
    };

    for (let localY = 0; localY < position.height; localY++) {
        for (let localX = 0; localX < position.width; localX++) {
            const alphaIndex = localY * position.width + localX;
            const rawAlpha = alphaMap[alphaIndex] * alphaGain;
            const alpha = Math.abs(rawAlpha);
            const componentLogoValue = rawAlpha < 0 ? 0 : logoValue;
            const pixelIndex =
                (position.y + localY) * truthImageData.width +
                position.x +
                localX;
            const dataOffset = pixelIndex * 4;

            for (let channel = 0; channel < 3; channel++) {
                const cleanValue = truthImageData.data[dataOffset + channel];
                output.data[dataOffset + channel] = clampByte(
                    cleanValue * (1 - alpha) +
                    componentLogoValue * alpha
                );
            }
        }
    }

    return output;
}

/**
 * Decomposes restoration error against clean pixel truth.
 *
 * The template component is the least-squares projection of candidate error
 * onto the known watermark forward-model direction. Positive amplitude is
 * under-removal; negative amplitude is over-removal. The remaining component
 * is watermark-orthogonal content damage.
 */
export function measureRestorationAgainstTruth({
    truthImageData,
    candidateImageData,
    watermarkedImageData = null,
    alphaMap,
    position,
    alphaGain = 1,
    logoValue = 255
}) {
    if (watermarkedImageData) {
        assertImageData(truthImageData, 'truthImageData');
        assertPosition(position, truthImageData);
        assertImageData(watermarkedImageData, 'watermarkedImageData');
        if (
            watermarkedImageData.width !== truthImageData.width ||
            watermarkedImageData.height !== truthImageData.height
        ) {
            throw new RangeError(
                'watermarkedImageData dimensions must match truthImageData'
            );
        }
    } else {
        assertForwardModel({
            truthImageData,
            alphaMap,
            position,
            alphaGain,
            logoValue
        });
    }
    assertImageData(candidateImageData, 'candidateImageData');
    if (
        candidateImageData.width !== truthImageData.width ||
        candidateImageData.height !== truthImageData.height
    ) {
        throw new RangeError(
            'candidateImageData dimensions must match truthImageData'
        );
    }

    let absoluteErrorSum = 0;
    let squaredErrorSum = 0;
    let errorTemplateDot = 0;
    let templateEnergy = 0;

    for (let localY = 0; localY < position.height; localY++) {
        for (let localX = 0; localX < position.width; localX++) {
            const rawAlpha = watermarkedImageData
                ? null
                : alphaMap[localY * position.width + localX] * alphaGain;
            const alpha = watermarkedImageData
                ? null
                : Math.abs(rawAlpha);
            const componentLogoValue = rawAlpha < 0 ? 0 : logoValue;
            const pixelIndex =
                (position.y + localY) * truthImageData.width +
                position.x +
                localX;
            const dataOffset = pixelIndex * 4;

            for (let channel = 0; channel < 3; channel++) {
                const cleanValue = truthImageData.data[dataOffset + channel];
                const error =
                    candidateImageData.data[dataOffset + channel] -
                    cleanValue;
                const templateDirection = watermarkedImageData
                    ? watermarkedImageData.data[dataOffset + channel] -
                        cleanValue
                    : (componentLogoValue - cleanValue) * alpha;

                absoluteErrorSum += Math.abs(error);
                squaredErrorSum += error * error;
                errorTemplateDot += error * templateDirection;
                templateEnergy += templateDirection * templateDirection;
            }
        }
    }

    const channelCount = position.width * position.height * 3;
    const signedAmplitude =
        templateEnergy > 0 ? errorTemplateDot / templateEnergy : 0;
    const projectedSquaredError =
        signedAmplitude * signedAmplitude * templateEnergy;
    const orthogonalSquaredError = Math.max(
        0,
        squaredErrorSum - projectedSquaredError
    );

    return {
        roi: {
            channelCount,
            mae: absoluteErrorSum / channelCount,
            rmse: Math.sqrt(squaredErrorSum / channelCount)
        },
        template: {
            signedAmplitude,
            underAmplitude: Math.max(0, signedAmplitude),
            overAmplitude: Math.max(0, -signedAmplitude),
            rmse: Math.sqrt(projectedSquaredError / channelCount),
            basisEnergy: templateEnergy,
            basisSource: watermarkedImageData
                ? 'empirical-forward-delta'
                : 'analytical-forward-model'
        },
        orthogonal: {
            rmse: Math.sqrt(orthogonalSquaredError / channelCount)
        }
    };
}

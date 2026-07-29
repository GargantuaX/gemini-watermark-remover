import { warpAlphaMap } from '../src/core/adaptiveDetector.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { compositeKnownWatermark } from './synthetic-residual-ground-truth.js';

export const REAL_PIPELINE_RESIDUAL_MODES = Object.freeze([
    'under-gain-0.78',
    'over-gain-1.12',
    'forward-power-0.86',
    'forward-warped',
    'inverse-shift-1--1'
]);

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function powerAlphaMap(alphaMap, exponent) {
    return Float32Array.from(alphaMap, (value) =>
        Math.sign(value) * Math.pow(Math.abs(value), exponent)
    );
}

function shiftedPosition(position, dx, dy, imageData) {
    const shifted = {
        ...position,
        x: position.x + dx,
        y: position.y + dy
    };
    if (
        shifted.x < 0 ||
        shifted.y < 0 ||
        shifted.x + shifted.width > imageData.width ||
        shifted.y + shifted.height > imageData.height
    ) {
        throw new RangeError('shifted inverse position must remain in bounds');
    }
    return shifted;
}

function validateInputs({ truthImageData, alphaMap, position }) {
    if (
        !truthImageData ||
        !Number.isInteger(truthImageData.width) ||
        !Number.isInteger(truthImageData.height) ||
        !truthImageData.data ||
        truthImageData.data.length !== truthImageData.width * truthImageData.height * 4
    ) {
        throw new TypeError('truthImageData must be valid RGBA ImageData-like data');
    }
    if (
        !position ||
        !Number.isInteger(position.x) ||
        !Number.isInteger(position.y) ||
        !Number.isInteger(position.width) ||
        !Number.isInteger(position.height) ||
        position.width !== position.height ||
        position.x < 0 ||
        position.y < 0 ||
        position.x + position.width > truthImageData.width ||
        position.y + position.height > truthImageData.height
    ) {
        throw new RangeError('position must be an in-bounds square');
    }
    if (!alphaMap || alphaMap.length !== position.width * position.height) {
        throw new RangeError('alphaMap length must match position area');
    }
}

export function mapReviewCropPositionToModelInput({
    crop,
    position,
    modelSize
}) {
    if (
        !crop ||
        !position ||
        !Number.isInteger(modelSize) ||
        modelSize <= 0 ||
        !Number.isFinite(crop.left) ||
        !Number.isFinite(crop.top) ||
        !Number.isFinite(crop.width) ||
        !Number.isFinite(crop.height) ||
        crop.width <= 0 ||
        crop.height <= 0
    ) {
        throw new TypeError('crop, position, and modelSize must define valid geometry');
    }
    const scale = Math.min(modelSize / crop.width, modelSize / crop.height);
    const paddingX = (modelSize - crop.width * scale) / 2;
    const paddingY = (modelSize - crop.height * scale) / 2;
    const mapped = {
        x: Math.round(paddingX + (position.x - crop.left) * scale),
        y: Math.round(paddingY + (position.y - crop.top) * scale),
        width: Math.round(position.width * scale),
        height: Math.round(position.height * scale)
    };
    if (
        mapped.width !== mapped.height ||
        mapped.x < 0 ||
        mapped.y < 0 ||
        mapped.x + mapped.width > modelSize ||
        mapped.y + mapped.height > modelSize
    ) {
        throw new RangeError('mapped watermark position must be an in-bounds square');
    }
    return mapped;
}

function createRoundTrip({
    truthImageData,
    forwardAlphaMap,
    inverseAlphaMap,
    forwardPosition,
    inversePosition,
    inverseAlphaGain
}) {
    const watermarkedImageData = compositeKnownWatermark({
        truthImageData,
        alphaMap: forwardAlphaMap,
        position: forwardPosition
    });
    const candidateImageData = cloneImageData(watermarkedImageData);
    removeWatermark(candidateImageData, inverseAlphaMap, inversePosition, {
        alphaGain: inverseAlphaGain
    });
    return {
        truthImageData,
        watermarkedImageData,
        candidateImageData,
        forwardPosition,
        inversePosition,
        inverseAlphaGain
    };
}

export function createExactRoundTrip({ truthImageData, alphaMap, position }) {
    validateInputs({ truthImageData, alphaMap, position });
    return createRoundTrip({
        truthImageData,
        forwardAlphaMap: alphaMap,
        inverseAlphaMap: alphaMap,
        forwardPosition: position,
        inversePosition: position,
        inverseAlphaGain: 1
    });
}

export function createRealPipelineResidualFailure({
    truthImageData,
    alphaMap,
    position,
    mode
}) {
    validateInputs({ truthImageData, alphaMap, position });
    if (!REAL_PIPELINE_RESIDUAL_MODES.includes(mode)) {
        throw new RangeError(`unknown real pipeline residual mode: ${mode}`);
    }

    let forwardAlphaMap = alphaMap;
    let inverseAlphaMap = alphaMap;
    let inversePosition = position;
    let inverseAlphaGain = 1;

    if (mode === 'under-gain-0.78') {
        inverseAlphaGain = 0.78;
    } else if (mode === 'over-gain-1.12') {
        inverseAlphaGain = 1.12;
    } else if (mode === 'forward-power-0.86') {
        forwardAlphaMap = powerAlphaMap(alphaMap, 0.86);
    } else if (mode === 'forward-warped') {
        forwardAlphaMap = warpAlphaMap(alphaMap, position.width, {
            dx: 0.45,
            dy: -0.35,
            scale: 1.025
        });
    } else if (mode === 'inverse-shift-1--1') {
        inversePosition = shiftedPosition(position, 1, -1, truthImageData);
    }

    return {
        mode,
        ...createRoundTrip({
            truthImageData,
            forwardAlphaMap,
            inverseAlphaMap,
            forwardPosition: position,
            inversePosition,
            inverseAlphaGain
        })
    };
}

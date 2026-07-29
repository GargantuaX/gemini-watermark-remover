import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
    assessAlphaBandHalo,
    assessCalibratedWatermarkResidualVisibility,
    assessRemovalDiffArtifacts,
    assessReferenceTextureAlignment,
    assessReferenceTextureAlignmentFromStats,
    assessWatermarkResidualVisibility,
    calculateNearBlackRatio,
    calculateNearWhiteRatio,
    classifyCalibratedResidualMetricRisk,
    cloneImageData
} from '../../src/core/restorationMetrics.js';
import { interpolateAlphaMap } from '../../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';
import { decodeImageDataInNode } from '../../scripts/sample-benchmark.js';
import { createSyntheticAlphaMap } from './syntheticWatermarkTestUtils.js';

test('cloneImageData should return a deep copy for plain image-like objects', () => {
    const original = {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255])
    };

    const cloned = cloneImageData(original);
    cloned.data[0] = 99;

    assert.notEqual(cloned.data, original.data);
    assert.equal(original.data[0], 10);
    assert.equal(cloned.width, original.width);
    assert.equal(cloned.height, original.height);
});

test('assessReferenceTextureAlignment should mark a darker flatter candidate as hard reject', () => {
    const width = 96;
    const height = 96;
    const referenceData = new Uint8ClampedArray(width * height * 4);
    const candidateData = new Uint8ClampedArray(width * height * 4);

    for (let i = 0; i < referenceData.length; i += 4) {
        referenceData[i + 3] = 255;
        candidateData[i + 3] = 255;
    }

    const referenceRegion = { x: 24, y: 0, width: 48, height: 48 };
    const position = { x: 24, y: 48, width: 48, height: 48 };

    for (let row = 0; row < 48; row++) {
        for (let col = 0; col < 48; col++) {
            const refIdx = ((referenceRegion.y + row) * width + (referenceRegion.x + col)) * 4;
            const posIdx = ((position.y + row) * width + (position.x + col)) * 4;
            const value = (row + col) % 2 === 0 ? 40 : 180;
            referenceData[refIdx] = value;
            referenceData[refIdx + 1] = value;
            referenceData[refIdx + 2] = value;
            candidateData[posIdx] = 18;
            candidateData[posIdx + 1] = 18;
            candidateData[posIdx + 2] = 18;
        }
    }

    const assessment = assessReferenceTextureAlignment({
        referenceImageData: { width, height, data: referenceData },
        candidateImageData: { width, height, data: candidateData },
        position
    });

    assert.equal(assessment.tooDark, true);
    assert.equal(assessment.tooFlat, true);
    assert.equal(assessment.hardReject, true);
    assert.ok(assessment.texturePenalty > 0, `texturePenalty=${assessment.texturePenalty}`);
});

test('assessReferenceTextureAlignmentFromStats should hard reject visibly darker candidates on flat backgrounds even when texture is preserved', () => {
    const assessment = assessReferenceTextureAlignmentFromStats({
        position: { x: 24, y: 48, width: 48, height: 48 },
        candidateTextureStats: {
            meanLum: 37,
            stdLum: 3.2
        },
        referenceImageData: {
            width: 96,
            height: 96,
            data: (() => {
                const data = new Uint8ClampedArray(96 * 96 * 4);
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = 42;
                    data[i + 1] = 42;
                    data[i + 2] = 42;
                    data[i + 3] = 255;
                }
                return data;
            })()
        }
    });

    assert.equal(assessment.tooDark, true);
    assert.equal(assessment.tooFlat, false);
    assert.equal(assessment.hardReject, true);
});

test('calculateNearBlackRatio should count only near-black pixels inside the target region', () => {
    const imageData = {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([
            0, 0, 0, 255,
            6, 6, 6, 255,
            4, 4, 4, 255,
            20, 20, 20, 255
        ])
    };

    const ratio = calculateNearBlackRatio(imageData, {
        x: 0,
        y: 0,
        width: 2,
        height: 2
    });

    assert.equal(ratio, 0.5);
});

test('calculateNearWhiteRatio should require every color channel to be near white', () => {
    const imageData = {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([
            255, 255, 255, 255,
            250, 250, 250, 255,
            255, 249, 255, 255,
            240, 255, 255, 255
        ])
    };

    const ratio = calculateNearWhiteRatio(imageData, {
        x: 0,
        y: 0,
        width: 2,
        height: 2
    });

    assert.equal(ratio, 0.5);
});

test('assessAlphaBandHalo should classify negative alpha by opacity magnitude', () => {
    const width = 12;
    const height = 12;
    const position = { x: 4, y: 4, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0, -0.2, -0.2, 0,
        -0.2, -0.3, -0.3, -0.2,
        -0.2, -0.3, -0.3, -0.2,
        0, -0.2, -0.2, 0
    ]);
    const imageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < imageData.data.length; index += 4) {
        imageData.data[index] = 80;
        imageData.data[index + 1] = 80;
        imageData.data[index + 2] = 80;
        imageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            if (Math.abs(alphaMap[row * position.width + col]) < 0.12) continue;
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            imageData.data[pixelIndex] = 68;
            imageData.data[pixelIndex + 1] = 68;
            imageData.data[pixelIndex + 2] = 68;
        }
    }

    const halo = assessAlphaBandHalo({
        imageData,
        position,
        alphaMap
    });

    assert.equal(halo.bandCount, 12);
    assert.ok(Math.abs(halo.bandMeanLum - 68) < 1e-9, `bandMeanLum=${halo.bandMeanLum}`);
    assert.ok(Math.abs(halo.outerMeanLum - 80) < 1e-9, `outerMeanLum=${halo.outerMeanLum}`);
    assert.ok(Math.abs(halo.deltaLum + 12) < 1e-9, `deltaLum=${halo.deltaLum}`);
});

test('assessRemovalDiffArtifacts should identify ideal inverse-alpha removal shape', () => {
    const width = 8;
    const height = 8;
    const position = { x: 2, y: 2, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0, 0.2, 0.2, 0,
        0.2, 0.5, 0.5, 0.2,
        0.2, 0.5, 0.5, 0.2,
        0, 0.2, 0.2, 0
    ]);
    const originalImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    const candidateImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < originalImageData.data.length; index += 4) {
        originalImageData.data[index] = 80;
        originalImageData.data[index + 1] = 80;
        originalImageData.data[index + 2] = 80;
        originalImageData.data[index + 3] = 255;
        candidateImageData.data[index] = 80;
        candidateImageData.data[index + 1] = 80;
        candidateImageData.data[index + 2] = 80;
        candidateImageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            const watermarked = Math.round(80 * (1 - alpha) + 255 * alpha);
            originalImageData.data[pixelIndex] = watermarked;
            originalImageData.data[pixelIndex + 1] = watermarked;
            originalImageData.data[pixelIndex + 2] = watermarked;
        }
    }

    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData,
        alphaMap,
        position,
        alphaGain: 1
    });

    assert.ok(artifacts.recomposeError < 0.01, `recomposeError=${artifacts.recomposeError}`);
    assert.ok(
        artifacts.diffTemplateCorrelation > 0.95,
        `diffTemplateCorrelation=${artifacts.diffTemplateCorrelation}`
    );
    assert.equal(artifacts.negativeDiffRatio, 0);
});

test('assessRemovalDiffArtifacts should recompose and correlate ideal dark-logo removal', () => {
    const width = 8;
    const height = 8;
    const position = { x: 2, y: 2, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0, -0.2, -0.2, 0,
        -0.2, -0.5, -0.5, -0.2,
        -0.2, -0.5, -0.5, -0.2,
        0, -0.2, -0.2, 0
    ]);
    const originalImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    const candidateImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < originalImageData.data.length; index += 4) {
        originalImageData.data[index] = 180;
        originalImageData.data[index + 1] = 180;
        originalImageData.data[index + 2] = 180;
        originalImageData.data[index + 3] = 255;
        candidateImageData.data[index] = 180;
        candidateImageData.data[index + 1] = 180;
        candidateImageData.data[index + 2] = 180;
        candidateImageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = Math.abs(alphaMap[row * position.width + col]);
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            const watermarked = Math.round(180 * (1 - alpha));
            originalImageData.data[pixelIndex] = watermarked;
            originalImageData.data[pixelIndex + 1] = watermarked;
            originalImageData.data[pixelIndex + 2] = watermarked;
        }
    }

    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData,
        alphaMap,
        position,
        alphaGain: 1
    });

    assert.ok(artifacts.recomposeError < 0.01, `recomposeError=${artifacts.recomposeError}`);
    assert.ok(
        artifacts.diffTemplateCorrelation > 0.95,
        `diffTemplateCorrelation=${artifacts.diffTemplateCorrelation}`
    );
    assert.ok(
        artifacts.signedDiffTemplateCorrelation > 0.95,
        `signedDiffTemplateCorrelation=${artifacts.signedDiffTemplateCorrelation}`
    );
    assert.equal(artifacts.oppositeDirectionDiffRatio, 0);
});

test('assessRemovalDiffArtifacts should count black and white clipping by per-pixel alpha polarity', () => {
    const width = 4;
    const height = 4;
    const position = { x: 1, y: 1, width: 2, height: 2 };
    const alphaMap = new Float32Array([
        0.5, -0.5,
        0.5, -0.5
    ]);
    const originalImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    const candidateImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < originalImageData.data.length; index += 4) {
        originalImageData.data[index] = 128;
        originalImageData.data[index + 1] = 128;
        originalImageData.data[index + 2] = 128;
        originalImageData.data[index + 3] = 255;
        candidateImageData.data[index] = 128;
        candidateImageData.data[index + 1] = 128;
        candidateImageData.data[index + 2] = 128;
        candidateImageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            const clippedValue = alphaMap[localIndex] < 0 ? 255 : 0;
            candidateImageData.data[pixelIndex] = clippedValue;
            candidateImageData.data[pixelIndex + 1] = clippedValue;
            candidateImageData.data[pixelIndex + 2] = clippedValue;
        }
    }

    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData,
        alphaMap,
        position,
        alphaGain: 1
    });

    assert.equal(artifacts.newlyClippedRatio, 1);
    assert.equal(artifacts.newlyBlackClippedRatio, 0.5);
    assert.equal(artifacts.newlyWhiteClippedRatio, 0.5);
});

test('assessRemovalDiffArtifacts should report opposite-direction diffs symmetrically without redefining negativeDiffRatio', () => {
    const createCase = ({ alpha, before, after }) => {
        const width = 3;
        const height = 3;
        const position = { x: 1, y: 1, width: 1, height: 1 };
        const originalImageData = {
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4)
        };
        const candidateImageData = {
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4)
        };

        for (let index = 0; index < originalImageData.data.length; index += 4) {
            originalImageData.data[index] = 128;
            originalImageData.data[index + 1] = 128;
            originalImageData.data[index + 2] = 128;
            originalImageData.data[index + 3] = 255;
            candidateImageData.data[index] = 128;
            candidateImageData.data[index + 1] = 128;
            candidateImageData.data[index + 2] = 128;
            candidateImageData.data[index + 3] = 255;
        }

        const pixelIndex = ((position.y * width) + position.x) * 4;
        for (let channel = 0; channel < 3; channel++) {
            originalImageData.data[pixelIndex + channel] = before;
            candidateImageData.data[pixelIndex + channel] = after;
        }

        return assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData,
            alphaMap: new Float32Array([alpha]),
            position,
            alphaGain: 1
        });
    };

    const whiteLogoWrongDirection = createCase({
        alpha: 0.5,
        before: 128,
        after: 160
    });
    const darkLogoWrongDirection = createCase({
        alpha: -0.5,
        before: 128,
        after: 96
    });

    assert.equal(whiteLogoWrongDirection.oppositeDirectionDiffRatio, 1);
    assert.equal(darkLogoWrongDirection.oppositeDirectionDiffRatio, 1);
    assert.equal(whiteLogoWrongDirection.negativeDiffRatio, 1);
    assert.equal(darkLogoWrongDirection.negativeDiffRatio, 0);
});

test('assessRemovalDiffArtifacts should charge equal opposite-polarity halo cost', () => {
    const createCase = (polarity) => {
        const width = 12;
        const height = 12;
        const position = { x: 4, y: 4, width: 4, height: 4 };
        const alphaMagnitudes = [
            0, 0.2, 0.2, 0,
            0.2, 0.3, 0.3, 0.2,
            0.2, 0.3, 0.3, 0.2,
            0, 0.2, 0.2, 0
        ];
        const alphaMap = new Float32Array(alphaMagnitudes.map((alpha) => alpha * polarity));
        const originalImageData = {
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4)
        };
        const candidateImageData = {
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4)
        };

        for (let index = 0; index < originalImageData.data.length; index += 4) {
            originalImageData.data[index] = 128;
            originalImageData.data[index + 1] = 128;
            originalImageData.data[index + 2] = 128;
            originalImageData.data[index + 3] = 255;
            candidateImageData.data[index] = 128;
            candidateImageData.data[index + 1] = 128;
            candidateImageData.data[index + 2] = 128;
            candidateImageData.data[index + 3] = 255;
        }

        for (let row = 0; row < position.height; row++) {
            for (let col = 0; col < position.width; col++) {
                const localIndex = row * position.width + col;
                if (alphaMagnitudes[localIndex] < 0.12) continue;
                const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
                const value = 128 - polarity * 12;
                for (let channel = 0; channel < 3; channel++) {
                    originalImageData.data[pixelIndex + channel] = value;
                    candidateImageData.data[pixelIndex + channel] = value;
                }
            }
        }

        return assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData,
            alphaMap,
            position,
            alphaGain: 1
        });
    };

    const whiteLogoOvershoot = createCase(1);
    const darkLogoOvershoot = createCase(-1);

    assert.ok(
        Math.abs(whiteLogoOvershoot.oppositeDirectionHaloLum - 12) < 1e-9,
        `white oppositeDirectionHaloLum=${whiteLogoOvershoot.oppositeDirectionHaloLum}`
    );
    assert.ok(
        Math.abs(darkLogoOvershoot.oppositeDirectionHaloLum - 12) < 1e-9,
        `dark oppositeDirectionHaloLum=${darkLogoOvershoot.oppositeDirectionHaloLum}`
    );
    assert.ok(
        Math.abs(whiteLogoOvershoot.visualArtifactCost - darkLogoOvershoot.visualArtifactCost) < 1e-9,
        `white=${whiteLogoOvershoot.visualArtifactCost}, dark=${darkLogoOvershoot.visualArtifactCost}`
    );
});

test('assessWatermarkResidualVisibility should flag bright alpha-band halos even when gradient is low', () => {
    const width = 12;
    const height = 12;
    const position = { x: 4, y: 4, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0, 0.2, 0.2, 0,
        0.2, 0.3, 0.3, 0.2,
        0.2, 0.3, 0.3, 0.2,
        0, 0.2, 0.2, 0
    ]);
    const imageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < imageData.data.length; index += 4) {
        imageData.data[index] = 80;
        imageData.data[index + 1] = 80;
        imageData.data[index + 2] = 80;
        imageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            if (alpha < 0.18) continue;
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            imageData.data[pixelIndex] = 92;
            imageData.data[pixelIndex + 1] = 92;
            imageData.data[pixelIndex + 2] = 92;
        }
    }

    const visibility = assessWatermarkResidualVisibility({
        imageData,
        position,
        alphaMap
    });

    assert.equal(visibility.visible, true);
    assert.equal(visibility.visiblePositiveHalo, true);
    assert.ok(visibility.positiveHaloLum >= 6, `positiveHaloLum=${visibility.positiveHaloLum}`);
});

test('assessWatermarkResidualVisibility should flag weak dark-polarity halos on low-texture backgrounds', () => {
    const width = 12;
    const height = 12;
    const position = { x: 4, y: 4, width: 4, height: 4 };
    const alphaMap = Float32Array.from([
        0, 0.2, 0.2, 0,
        0.2, 0.3, 0.3, 0.2,
        0.2, 0.3, 0.3, 0.2,
        0, 0.2, 0.2, 0
    ], (value) => -value);
    const imageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < imageData.data.length; index += 4) {
        imageData.data[index] = 80;
        imageData.data[index + 1] = 80;
        imageData.data[index + 2] = 80;
        imageData.data[index + 3] = 255;
    }
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            if (Math.abs(alphaMap[row * position.width + col]) < 0.18) continue;
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            imageData.data[pixelIndex] = 77;
            imageData.data[pixelIndex + 1] = 77;
            imageData.data[pixelIndex + 2] = 77;
        }
    }

    const visibility = assessWatermarkResidualVisibility({ imageData, position, alphaMap });

    assert.equal(visibility.visibleDarkPolarityHalo, true);
    assert.ok(
        visibility.darkPolarityHaloLum >= 1.75,
        `darkPolarityHaloLum=${visibility.darkPolarityHaloLum}`
    );
    assert.equal(visibility.positiveHaloLum, 0);
});

test('assessWatermarkResidualVisibility should not add a weak dark-polarity halo warning on textured backgrounds', () => {
    const width = 12;
    const height = 12;
    const position = { x: 4, y: 4, width: 4, height: 4 };
    const alphaMap = Float32Array.from([
        0, 0.2, 0.2, 0,
        0.2, 0.3, 0.3, 0.2,
        0.2, 0.3, 0.3, 0.2,
        0, 0.2, 0.2, 0
    ], (value) => -value);
    const imageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const value = x % 2 === 0 ? 40 : 160;
            const pixelIndex = (y * width + x) * 4;
            imageData.data[pixelIndex] = value;
            imageData.data[pixelIndex + 1] = value;
            imageData.data[pixelIndex + 2] = value;
            imageData.data[pixelIndex + 3] = 255;
        }
    }
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            if (Math.abs(alphaMap[row * position.width + col]) < 0.18) continue;
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            imageData.data[pixelIndex] -= 3;
            imageData.data[pixelIndex + 1] -= 3;
            imageData.data[pixelIndex + 2] -= 3;
        }
    }

    const visibility = assessWatermarkResidualVisibility({ imageData, position, alphaMap });

    assert.ok(visibility.halo.outerStdLum > 30, `outerStdLum=${visibility.halo.outerStdLum}`);
    assert.equal(visibility.visibleDarkPolarityHalo, false);
});

test('assessCalibratedWatermarkResidualVisibility should separate reviewed real dark-polarity candidates', async () => {
    const alpha48 = getEmbeddedAlphaMap(48);
    const alpha96 = getEmbeddedAlphaMap('96-20260520');
    const cases = [
        { id: 'd015-clean', size: 48, expectedVisible: false },
        { id: 'd071-clean', size: 96, expectedVisible: false },
        { id: 'd019-artifact', size: 96, expectedVisible: true },
        { id: 'd056-artifact', size: 48, expectedVisible: true },
        { id: 'd081-artifact', size: 48, expectedVisible: true },
        { id: 'd088-artifact', size: 48, expectedVisible: true },
        { id: 'd091-artifact', size: 52, expectedVisible: true }
    ];

    for (const item of cases) {
        const [originalImageData, imageData] = await Promise.all([
            decodeImageDataInNode(path.resolve(
                `tests/fixtures/dark-polarity-halo-${item.id}-source.png`
            )),
            decodeImageDataInNode(path.resolve(
                `tests/fixtures/dark-polarity-halo-${item.id}-candidate.png`
            ))
        ]);
        const baseAlphaMap = item.size === 96
            ? alpha96
            : item.size === 48
                ? alpha48
                : interpolateAlphaMap(alpha48, 48, item.size);
        const alphaMap = Float32Array.from(baseAlphaMap, (value) => -Math.abs(value));
        const visibility = assessCalibratedWatermarkResidualVisibility({
            imageData,
            originalImageData,
            position: { x: 4, y: 4, width: item.size, height: item.size },
            alphaMap,
            alphaGain: 1
        });

        assert.equal(
            visibility.visible,
            item.expectedVisible,
            `${item.id}: ${JSON.stringify(visibility)}`
        );
        assert.equal(
            visibility.visibleDarkPolarityHalo,
            item.expectedVisible,
            `${item.id}: darkPolarityHaloLum=${visibility.darkPolarityHaloLum}`
        );
    }
});

test('assessCalibratedWatermarkResidualVisibility should keep bright halos visible', () => {
    const width = 12;
    const height = 12;
    const position = { x: 4, y: 4, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0, 0.2, 0.2, 0,
        0.2, 0.3, 0.3, 0.2,
        0.2, 0.3, 0.3, 0.2,
        0, 0.2, 0.2, 0
    ]);
    const imageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < imageData.data.length; index += 4) {
        imageData.data[index] = 80;
        imageData.data[index + 1] = 80;
        imageData.data[index + 2] = 80;
        imageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            if (alpha < 0.18) continue;
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            imageData.data[pixelIndex] = 92;
            imageData.data[pixelIndex + 1] = 92;
            imageData.data[pixelIndex + 2] = 92;
        }
    }

    const visibility = assessCalibratedWatermarkResidualVisibility({
        imageData,
        position,
        alphaMap
    });

    assert.equal(visibility.rawVisible, true);
    assert.equal(visibility.visible, true);
    assert.equal(visibility.metricRisk, null);
});

test('assessCalibratedWatermarkResidualVisibility should keep flat clipped anti-template visible when gradient is strong', () => {
    const width = 12;
    const height = 12;
    const position = { x: 4, y: 4, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0.02, 0.16, 0.16, 0.02,
        0.16, 0.34, 0.34, 0.16,
        0.16, 0.34, 0.34, 0.16,
        0.02, 0.16, 0.16, 0.02
    ]);
    const originalImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    const imageData = cloneImageData(originalImageData);

    for (let index = 0; index < imageData.data.length; index += 4) {
        originalImageData.data[index] = 24;
        originalImageData.data[index + 1] = 24;
        originalImageData.data[index + 2] = 24;
        originalImageData.data[index + 3] = 255;
        imageData.data[index] = 0;
        imageData.data[index + 1] = 0;
        imageData.data[index + 2] = 0;
        imageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            const value = Math.round(5 * (1 - alpha / 0.34));
            imageData.data[pixelIndex] = value;
            imageData.data[pixelIndex + 1] = value;
            imageData.data[pixelIndex + 2] = value;
        }
    }

    const visibility = assessCalibratedWatermarkResidualVisibility({
        imageData,
        originalImageData,
        position,
        alphaMap
    });

    assert.equal(visibility.rawVisible, true);
    assert.equal(visibility.visibleSpatialResidual, true);
    assert.equal(visibility.visibleGradientResidual, true);
    assert.equal(visibility.visible, true);
    assert.equal(visibility.calibratedVisible, true);
    assert.equal(visibility.metricRisk, null);
});

test('classifyCalibratedResidualMetricRisk should not hide a flat clipped residual with strong gradient evidence', () => {
    const baseCase = {
        visibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: false,
            positiveHaloLum: 0
        },
        spatialScore: -0.31,
        gradientScore: 0.31,
        nearBlackRatio: 0.96,
        newlyClippedRatio: 0.22,
        visualArtifactCost: 0.4,
        hasOriginalImageData: true
    };
    const flatClippedRisk = classifyCalibratedResidualMetricRisk({
        ...baseCase,
        visibility: {
            ...baseCase.visibility,
            visibleGradientResidual: false
        }
    });
    const strongGradientRisk = classifyCalibratedResidualMetricRisk({
        ...baseCase,
        visibility: {
            ...baseCase.visibility,
            visibleGradientResidual: true
        }
    });

    assert.equal(flatClippedRisk, 'flat-clipped-low-texture-spatial-correlation');
    assert.equal(strongGradientRisk, null);
});

test('classifyCalibratedResidualMetricRisk should mark low-gradient positive spatial background collision', () => {
    const metricRisk = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: false,
            visibleGradientResidual: false,
            positiveHaloLum: 0
        },
        spatialScore: 0.176,
        gradientScore: 0.006,
        nearBlackRatio: 0,
        newlyClippedRatio: 0.001,
        visualArtifactCost: 0.051
    });

    assert.equal(metricRisk, 'positive-spatial-background-collision');
});

test('classifyCalibratedResidualMetricRisk should mark low-gradient positive halo background collision', () => {
    const metricRisk = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: true,
            visibleGradientResidual: false,
            positiveHaloLum: 29.63
        },
        spatialScore: 0.3,
        gradientScore: -0.018,
        nearBlackRatio: 0,
        newlyClippedRatio: 0,
        visualArtifactCost: 0.075
    });

    assert.equal(metricRisk, 'positive-halo-background-collision');
});

test('classifyCalibratedResidualMetricRisk should not suppress a polarity-aware dark halo', () => {
    const metricRisk = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: true,
            visibleGradientResidual: false,
            visibleDarkPolarityHalo: true,
            positiveHaloLum: 13.12
        },
        spatialScore: 0.3,
        gradientScore: -0.018,
        nearBlackRatio: 0,
        newlyClippedRatio: 0,
        visualArtifactCost: 0.075
    });

    assert.equal(metricRisk, null);
});

test('classifyCalibratedResidualMetricRisk should only suppress weak halo background collisions below the observed residual boundary', () => {
    const backgroundCollisions = [
        {
            positiveHaloLum: 9.932992,
            spatialScore: 0.01463,
            gradientScore: 0.007654,
            nearBlackRatio: 0,
            newlyClippedRatio: 0,
            visualArtifactCost: 0.01131
        },
        {
            positiveHaloLum: 7.244515,
            spatialScore: 0.084751,
            gradientScore: -0.004272,
            nearBlackRatio: 0.03255,
            newlyClippedRatio: 0.000434,
            visualArtifactCost: 0.0214
        },
        {
            positiveHaloLum: 7.514959,
            spatialScore: 0.062596,
            gradientScore: -0.05931,
            nearBlackRatio: 0,
            newlyClippedRatio: 0,
            visualArtifactCost: 0.01565
        }
    ];

    for (const sample of backgroundCollisions) {
        const metricRisk = classifyCalibratedResidualMetricRisk({
            visibility: {
                visible: true,
                visibleSpatialResidual: false,
                visiblePositiveHalo: true,
                visibleGradientResidual: false,
                positiveHaloLum: sample.positiveHaloLum
            },
            ...sample
        });

        assert.equal(metricRisk, 'weak-halo-background-collision');
    }

    const visibleResidual = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: false,
            visiblePositiveHalo: true,
            visibleGradientResidual: false,
            positiveHaloLum: 13.191124
        },
        spatialScore: -0.016491,
        gradientScore: 0.024673,
        nearBlackRatio: 0.0686,
        newlyClippedRatio: 0.005642,
        visualArtifactCost: 0.03162
    });

    assert.equal(visibleResidual, null);
});

test('classifyCalibratedResidualMetricRisk should narrowly suppress low-variance anti-template correlation', () => {
    const lowVarianceMetricRisk = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: false,
            visibleGradientResidual: false,
            positiveHaloLum: 0,
            halo: {
                bandStdLum: 0.544929,
                outerStdLum: 0.53659,
                deltaLum: -0.575071
            }
        },
        spatialScore: -0.423388,
        gradientScore: 0.042947,
        nearBlackRatio: 0,
        newlyClippedRatio: 0,
        visualArtifactCost: 0.108
    });
    const visibleOvershoot = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: false,
            visibleGradientResidual: false,
            positiveHaloLum: 0,
            halo: {
                bandStdLum: 12,
                outerStdLum: 15,
                deltaLum: -12
            }
        },
        spatialScore: -0.31,
        gradientScore: 0.04,
        nearBlackRatio: 0,
        newlyClippedRatio: 0,
        visualArtifactCost: 0.13
    });

    assert.equal(lowVarianceMetricRisk, 'flat-low-variance-spatial-correlation');
    assert.equal(visibleOvershoot, null);
});

test('classifyCalibratedResidualMetricRisk should suppress only nonlocalized negative spatial correlation', () => {
    const baseCase = {
        visibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: false,
            visibleGradientResidual: false,
            positiveHaloLum: 0
        },
        spatialScore: -0.206987,
        gradientScore: 0.033778,
        nearBlackRatio: 0,
        newlyClippedRatio: 0.000326,
        visualArtifactCost: 0.160546
    };
    const nonlocalizedMetricRisk = classifyCalibratedResidualMetricRisk({
        ...baseCase,
        spatialProminence: -0.169
    });
    const localizedResidual = classifyCalibratedResidualMetricRisk({
        ...baseCase,
        spatialProminence: 0.06
    });

    assert.equal(nonlocalizedMetricRisk, 'nonlocalized-spatial-background-collision');
    assert.equal(localizedResidual, null);
});

test('assessCalibratedWatermarkResidualVisibility should ignore one outlier localization control', () => {
    const size = 48;
    const width = size * 3;
    const height = size * 3;
    const position = {
        x: size * 2,
        y: size * 2,
        width: size,
        height: size
    };
    const alphaMap = createSyntheticAlphaMap(size);
    const createCandidate = (controlPositions) => {
        let seed = 123456789;
        const random = () => {
            seed = (1664525 * seed + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        const data = new Uint8ClampedArray(width * height * 4);
        for (let index = 0; index < data.length; index += 4) {
            const value = 40 + Math.floor(random() * 176);
            data[index] = value;
            data[index + 1] = value;
            data[index + 2] = value;
            data[index + 3] = 255;
        }

        const imprint = (region, strength) => {
            for (let row = 0; row < size; row++) {
                for (let col = 0; col < size; col++) {
                    const pixelIndex = ((region.y + row) * width + region.x + col) * 4;
                    const value = Math.max(
                        0,
                        Math.min(255, data[pixelIndex] - alphaMap[row * size + col] * strength)
                    );
                    data[pixelIndex] = value;
                    data[pixelIndex + 1] = value;
                    data[pixelIndex + 2] = value;
                }
            }
        };

        imprint(position, 30);
        for (const controlPosition of controlPositions) {
            imprint(controlPosition, 220);
        }

        return {
            width,
            height,
            data
        };
    };
    const outlierPosition = { x: 0, y: 0 };
    const secondBackgroundPosition = { x: 0, y: size * 2 };
    const oneOutlierImage = createCandidate([outlierPosition]);
    const repeatedBackgroundImage = createCandidate([
        outlierPosition,
        secondBackgroundPosition
    ]);
    const oneOutlier = assessCalibratedWatermarkResidualVisibility({
        imageData: oneOutlierImage,
        originalImageData: oneOutlierImage,
        position,
        alphaMap
    });
    const repeatedBackground = assessCalibratedWatermarkResidualVisibility({
        imageData: repeatedBackgroundImage,
        originalImageData: repeatedBackgroundImage,
        position,
        alphaMap
    });

    assert.equal(oneOutlier.rawVisible, true);
    assert.equal(oneOutlier.metricRisk, null);
    assert.equal(oneOutlier.visible, true);
    assert.ok(oneOutlier.spatialLocalization.controlScores.length >= 5);
    assert.ok(oneOutlier.spatialProminence >= 0.06, `prominence=${oneOutlier.spatialProminence}`);
    assert.equal(
        repeatedBackground.metricRisk,
        'nonlocalized-spatial-background-collision'
    );
    assert.equal(repeatedBackground.visible, false);
});

test('assessCalibratedWatermarkResidualVisibility should require at least three localization controls', () => {
    const size = 48;
    const width = size * 3;
    const height = size;
    const position = {
        x: size * 2,
        y: 0,
        width: size,
        height: size
    };
    const alphaMap = createSyntheticAlphaMap(size);
    let seed = 123456789;
    const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
        const value = 40 + Math.floor(random() * 176);
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
    }
    const imprint = (x, strength) => {
        for (let row = 0; row < size; row++) {
            for (let col = 0; col < size; col++) {
                const pixelIndex = (row * width + x + col) * 4;
                const value = Math.max(
                    0,
                    Math.min(255, data[pixelIndex] - alphaMap[row * size + col] * strength)
                );
                data[pixelIndex] = value;
                data[pixelIndex + 1] = value;
                data[pixelIndex + 2] = value;
            }
        }
    };
    imprint(position.x, 40);
    imprint(0, 220);
    imprint(size, 220);
    const imageData = {
        width,
        height,
        data
    };

    const visibility = assessCalibratedWatermarkResidualVisibility({
        imageData,
        originalImageData: imageData,
        position,
        alphaMap
    });

    assert.equal(visibility.rawVisible, true);
    assert.equal(visibility.spatialLocalization, null);
    assert.equal(visibility.spatialProminence, null);
    assert.equal(visibility.metricRisk, null);
    assert.equal(visibility.visible, true);
});

test('classifyCalibratedResidualMetricRisk should mark structured edge background collision', () => {
    const metricRisk = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: false,
            visiblePositiveHalo: true,
            visibleGradientResidual: false,
            positiveHaloLum: 21.57
        },
        spatialScore: 0.152,
        gradientScore: 0.21,
        nearBlackRatio: 0,
        newlyClippedRatio: 0,
        visualArtifactCost: 0.248
    });

    assert.equal(metricRisk, 'structured-edge-background-collision');
});

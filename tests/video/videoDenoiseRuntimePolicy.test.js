import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ALLENK_FDNCNN_RUNTIME_PROFILES,
    resolveAllenkFdncnnRuntimeProfile
} from '../../src/video/videoDenoiseRuntimePolicy.js';
import { resolveVideoWatermarkCandidates } from '../../src/video/videoWatermarkCatalog.js';

test('allenk FDnCNN runtime profiles should expose fixed-shape model contracts', () => {
    assert.deepEqual(ALLENK_FDNCNN_RUNTIME_PROFILES.map((profile) => profile.id), [
        'allenk-fdncnn-veo-text-23x10',
        'allenk-fdncnn-104',
        'allenk-fdncnn-200'
    ]);
    assert.deepEqual(ALLENK_FDNCNN_RUNTIME_PROFILES[0].inputShape, [1, 4, 74, 86]);
    assert.deepEqual(ALLENK_FDNCNN_RUNTIME_PROFILES[0].outputShape, [1, 3, 74, 86]);
    assert.match(ALLENK_FDNCNN_RUNTIME_PROFILES[0].modelUrl, /model_core_fp32_86x74\.onnx$/);
    assert.deepEqual(ALLENK_FDNCNN_RUNTIME_PROFILES[1].inputShape, [1, 4, 104, 104]);
    assert.deepEqual(ALLENK_FDNCNN_RUNTIME_PROFILES[1].outputShape, [1, 3, 104, 104]);
    assert.match(ALLENK_FDNCNN_RUNTIME_PROFILES[1].modelUrl, /model_core_fp32_104\.onnx$/);
    assert.deepEqual(ALLENK_FDNCNN_RUNTIME_PROFILES[2].inputShape, [1, 4, 200, 200]);
    assert.deepEqual(ALLENK_FDNCNN_RUNTIME_PROFILES[2].outputShape, [1, 3, 200, 200]);
    assert.match(ALLENK_FDNCNN_RUNTIME_PROFILES[2].modelUrl, /model_core_fp32_200\.onnx$/);
});

test('resolveAllenkFdncnnRuntimeProfile should use the rectangular Veo text model for 23x10 watermarks', () => {
    const profile = resolveAllenkFdncnnRuntimeProfile({ width: 23, height: 10 });

    assert.equal(profile.id, 'allenk-fdncnn-veo-text-23x10');
    assert.equal(profile.modelWidth, 86);
    assert.equal(profile.modelHeight, 74);
    assert.equal(profile.padding, 32);
    assert.deepEqual(profile.inputShape, [1, 4, 74, 86]);
});

test('resolveAllenkFdncnnRuntimeProfile should use the 104 model for small video watermarks', () => {
    const profile = resolveAllenkFdncnnRuntimeProfile({ width: 48, height: 48 });

    assert.equal(profile.id, 'allenk-fdncnn-104');
    assert.equal(profile.modelSize, 104);
    assert.equal(profile.padding, 28);
    assert.deepEqual(profile.inputShape, [1, 4, 104, 104]);
});

test('resolveAllenkFdncnnRuntimeProfile should keep compact 44px watermarks on the 104 model', () => {
    const profile = resolveAllenkFdncnnRuntimeProfile({ width: 44, height: 44 });

    assert.equal(profile.id, 'allenk-fdncnn-104');
    assert.equal(profile.padding, 30);
});

test('resolveAllenkFdncnnRuntimeProfile should keep 72px and unknown watermarks on the 200 model', () => {
    const standard = resolveAllenkFdncnnRuntimeProfile({ width: 72, height: 72 });
    const unknown = resolveAllenkFdncnnRuntimeProfile(null);

    assert.equal(standard.id, 'allenk-fdncnn-200');
    assert.equal(standard.padding, 64);
    assert.deepEqual(standard.inputShape, [1, 4, 200, 200]);
    assert.equal(unknown.id, 'allenk-fdncnn-200');
    assert.equal(unknown.padding, 64);
});

test('resolveAllenkFdncnnRuntimeProfile should cover every video catalog position type', () => {
    const cases = [
        {
            label: '1080p reference',
            width: 1920,
            height: 1080,
            expected: {
                'veo-1080p-standard': { profileId: 'allenk-fdncnn-200', size: 72, padding: 64 },
                'veo-1080p-inset': { profileId: 'allenk-fdncnn-200', size: 72, padding: 64 }
            }
        },
        {
            label: '720p explicit',
            width: 1280,
            height: 720,
            expected: {
                'veo-720p-3-inset': { profileId: 'allenk-fdncnn-104', size: 48, padding: 28 },
                'veo-720p-1-standard': { profileId: 'allenk-fdncnn-104', size: 48, padding: 28 },
                'veo-720p-2-compact': { profileId: 'allenk-fdncnn-104', size: 44, padding: 30 }
            }
        },
        {
            label: 'scaled down reference',
            width: 960,
            height: 540,
            expected: {
                'veo-1080p-standard': { profileId: 'allenk-fdncnn-104', size: 36, padding: 34 },
                'veo-1080p-inset': { profileId: 'allenk-fdncnn-104', size: 36, padding: 34 }
            }
        },
        {
            label: 'scaled up reference',
            width: 3840,
            height: 2160,
            expected: {
                'veo-1080p-standard': { profileId: 'allenk-fdncnn-200', size: 144, padding: 28 },
                'veo-1080p-inset': { profileId: 'allenk-fdncnn-200', size: 144, padding: 28 },
                'veo-3840x2160-davinci-160': { profileId: 'allenk-fdncnn-200', size: 160, padding: 20 }
            }
        },
        {
            label: 'minimum clamped reference',
            width: 96,
            height: 96,
            expected: {
                'veo-1080p-standard': { profileId: 'allenk-fdncnn-104', size: 24, padding: 40 },
                'veo-1080p-inset': { profileId: 'allenk-fdncnn-104', size: 24, padding: 40 }
            }
        }
    ];

    for (const testCase of cases) {
        const candidates = resolveVideoWatermarkCandidates(testCase.width, testCase.height);
        assert.deepEqual(
            candidates.map((candidate) => candidate.id).sort(),
            Object.keys(testCase.expected).sort(),
            testCase.label
        );

        for (const candidate of candidates) {
            const profile = resolveAllenkFdncnnRuntimeProfile(candidate);
            const expected = testCase.expected[candidate.id];

            assert.equal(candidate.width, expected.size, `${testCase.label} ${candidate.id} size`);
            assert.equal(candidate.height, expected.size, `${testCase.label} ${candidate.id} height`);
            assert.equal(profile.id, expected.profileId, `${testCase.label} ${candidate.id} profile`);
            assert.equal(profile.padding, expected.padding, `${testCase.label} ${candidate.id} padding`);
            assert.ok(
                candidate.width + profile.padding * 2 <= profile.modelSize,
                `${testCase.label} ${candidate.id} should fit the selected model contract`
            );
        }
    }
});

test('resolveAllenkFdncnnRuntimeProfile should route oversized scaled watermarks to the largest adapter-backed model', () => {
    const candidates = resolveVideoWatermarkCandidates(7680, 4320);
    const standard = candidates.find((candidate) => candidate.id === 'veo-1080p-standard');
    const inset = candidates.find((candidate) => candidate.id === 'veo-1080p-inset');

    assert.equal(standard.size, 288);
    assert.equal(inset.size, 288);

    for (const candidate of [standard, inset]) {
        const profile = resolveAllenkFdncnnRuntimeProfile(candidate);

        assert.equal(profile.id, 'allenk-fdncnn-200');
        assert.equal(profile.padding, 0);
        assert.ok(candidate.width > profile.modelSize);
    }
});

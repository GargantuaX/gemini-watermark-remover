import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createVideoUiPresetVerificationSummary,
    parseCliArgs,
    resolveVideoUiPresetVerificationExitCode,
    resolveVideoUiPresetVerificationPaths
} from '../../scripts/verify-video-ui-preset-output.js';

test('resolveVideoUiPresetVerificationPaths should derive stable artifact paths from input video', () => {
    const paths = resolveVideoUiPresetVerificationPaths({
        inputPath: 'Z:\\fixtures\\project\\src\\assets\\video-samples\\20260615-2.mp4',
        outputDir: 'Z:\\fixtures\\project\\.artifacts\\video-ui-preset-verification'
    });

    assert.match(paths.outputPath, /20260615-2-ui-preset\.mp4$/);
    assert.match(paths.reportPath, /20260615-2-verification\.json$/);
    assert.match(paths.exportReportPath, /20260615-2-export-report\.json$/);
    assert.match(paths.residualReportPath, /20260615-2-residual-report\.json$/);
});

test('createVideoUiPresetVerificationSummary should combine export and residual gate evidence', () => {
    const summary = createVideoUiPresetVerificationSummary({
        inputPath: 'source.mp4',
        outputPath: 'out.mp4',
        exportReport: {
            outputPath: 'out.mp4',
            bytes: 1234,
            resultState: {
                statusTone: 'success',
                statusText: 'AI 去水印已完成'
            },
            presetState: {
                denoiseBackend: 'allenk-fdncnn-browser-spike',
                edgeDenoiseStrength: 1.8,
                videoBitrateMbps: 12,
                allowLowConfidence: true
            }
        },
        residualReport: {
            outputPath: 'residual.json',
            fixedAnchor: {
                candidateId: 'veo-720p-3-inset'
            },
            verdict: {
                action: 'pass',
                reason: 'fixed-anchor-residual-low',
                originalMeanConfidence: 0.7283,
                currentMeanConfidence: 0.0182,
                reductionRatio: 0.975010298
            }
        }
    });

    assert.equal(summary.status, 'pass');
    assert.equal(summary.fixedAnchor.candidateId, 'veo-720p-3-inset');
    assert.equal(summary.export.preset.denoiseBackend, 'allenk-fdncnn-browser-spike');
    assert.equal(summary.residual.verdict.reductionRatio, 0.975010298);
});

test('parseCliArgs should support fail-on-residual verification mode', () => {
    const parsed = parseCliArgs([
        '--input',
        'source.mp4',
        '--output',
        'out.mp4',
        '--timestamps',
        '1,2.5,4',
        '--fail-on-residual',
        '--no-screenshots'
    ]);

    assert.equal(parsed.inputPath, 'source.mp4');
    assert.equal(parsed.outputPath, 'out.mp4');
    assert.deepEqual(parsed.timestamps, [1, 2.5, 4]);
    assert.equal(parsed.failOnResidual, true);
    assert.equal(parsed.screenshots, false);
});

test('resolveVideoUiPresetVerificationExitCode should fail non-pass residual verdicts when requested', () => {
    assert.equal(resolveVideoUiPresetVerificationExitCode({ residual: { verdict: { action: 'pass' } } }, { failOnResidual: true }), 0);
    assert.equal(resolveVideoUiPresetVerificationExitCode({ residual: { verdict: { action: 'needs-review' } } }, { failOnResidual: true }), 1);
    assert.equal(resolveVideoUiPresetVerificationExitCode({ residual: { verdict: { action: 'needs-review' } } }, { failOnResidual: false }), 0);
});

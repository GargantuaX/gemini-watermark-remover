import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    createVideoAlphaPolicyEvidenceSummary,
    renderVideoAlphaPolicyEvidenceMarkdown,
    writeVideoAlphaPolicyEvidenceReport
} from '../../scripts/create-video-alpha-policy-evidence-report.js';

function report({ awareness = 'raw', material = 0, warning = 0, improved = 1 } = {}) {
    return {
        path: `Z:\\fixtures\\project\\.artifacts\\video-crop-benchmark-alpha-policy035-standard${awareness === 'raw' ? '' : `-${awareness}`}\\latest-summary.json`,
        bitrate: 'standard',
        awareness,
        generatedAt: '2026-06-11T00:00:00.000Z',
        summary: {
            comparedCases: 1,
            improvedCases: improved,
            materialRegressedCases: material,
            warningRegressedCases: warning
        },
        cases: [
            {
                baselineId: 'case-a',
                variantId: 'case-a-alpha-policy035',
                improvedBuckets: improved ? ['active'] : [],
                materialRegressedBuckets: material ? ['lowBody'] : [],
                warningRegressedBuckets: warning ? ['edge'] : [],
                neutralBuckets: [],
                riskNotes: [],
                deltas: {}
            }
        ]
    };
}

test('createVideoAlphaPolicyEvidenceSummary should reject aware material regressions', () => {
    const summary = createVideoAlphaPolicyEvidenceSummary({
        reports: [
            report({ awareness: 'candidate-aware', material: 1 }),
            report({ awareness: 'expected-aware' })
        ]
    });

    assert.equal(summary.decision.status, 'reject');
    assert.equal(summary.total.materialRegressedCases, 1);
});

test('createVideoAlphaPolicyEvidenceSummary should keep raw-only material regression as candidate-aware human review', () => {
    const summary = createVideoAlphaPolicyEvidenceSummary({
        reports: [
            report({ awareness: 'raw', material: 1 }),
            report({ awareness: 'candidate-aware', material: 0, warning: 1 }),
            { ...report({ awareness: 'expected-aware', material: 0 }), bitrate: '12mbps' }
        ]
    });
    const markdown = renderVideoAlphaPolicyEvidenceMarkdown(summary);

    assert.equal(summary.decision.status, 'candidate-aware-human-review');
    assert.equal(summary.total.comparedCases, 3);
    assert.equal(summary.total.materialRegressedCases, 1);
    assert.match(markdown, /raw-benchmark-has-material-regression/);
    assert.match(markdown, /standard\/candidate-aware/);
});

test('createVideoAlphaPolicyEvidenceSummary should send warning-only evidence to human review', () => {
    const summary = createVideoAlphaPolicyEvidenceSummary({
        reports: [
            report({ awareness: 'candidate-aware', warning: 1 }),
            { ...report({ awareness: 'expected-aware' }), bitrate: '12mbps' }
        ]
    });

    assert.equal(summary.decision.status, 'human-review');
    assert.equal(summary.total.warningRegressedCases, 1);
});

test('writeVideoAlphaPolicyEvidenceReport should read benchmark summaries and write markdown', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-alpha-policy-evidence');
    await rm(artifactRoot, { recursive: true, force: true });
    await mkdir(artifactRoot, { recursive: true });
    const rawPath = path.join(artifactRoot, 'video-crop-benchmark-alpha-policy035-standard', 'latest-summary.json');
    const awarePath = path.join(artifactRoot, 'video-crop-benchmark-alpha-policy035-standard-candidate-aware', 'latest-summary.json');
    const outputPath = path.join(artifactRoot, 'report.json');
    const markdownPath = path.join(artifactRoot, 'report.md');
    await mkdir(path.dirname(rawPath), { recursive: true });
    await mkdir(path.dirname(awarePath), { recursive: true });
    await writeFile(rawPath, JSON.stringify({
        generatedAt: '2026-06-11T00:00:00.000Z',
        variantComparisons: [
            {
                status: 'compared',
                baselineId: 'case-a',
                variantId: 'case-a-alpha-policy035',
                currentProfile: { denoiseBackend: 'none', alphaEdgePolicy: 'standard045-inset035' },
                deltas: {
                    active: { verdict: 'improved' },
                    edge: { verdict: 'neutral' },
                    lowBody: { verdict: 'regressed' },
                    highBody: { verdict: 'neutral' }
                }
            }
        ]
    }), 'utf8');
    await writeFile(awarePath, JSON.stringify({
        generatedAt: '2026-06-11T00:00:00.000Z',
        variantComparisons: [
            {
                status: 'compared',
                baselineId: 'case-a',
                variantId: 'case-a-alpha-policy035',
                currentProfile: { denoiseBackend: 'none', alphaEdgePolicy: 'standard045-inset035' },
                riskNotes: [{ severity: 'warning', bucket: 'lowBody' }],
                deltas: {
                    active: { verdict: 'improved' },
                    edge: { verdict: 'neutral' },
                    lowBody: { verdict: 'regressed' },
                    highBody: { verdict: 'neutral' }
                }
            }
        ]
    }), 'utf8');

    const result = await writeVideoAlphaPolicyEvidenceReport({
        reportPaths: [rawPath, awarePath],
        outputPath,
        markdownPath
    });
    const saved = JSON.parse(await readFile(outputPath, 'utf8'));
    const markdown = await readFile(markdownPath, 'utf8');

    assert.equal(result.decision.status, 'candidate-aware-human-review');
    assert.equal(saved.total.comparedCases, 2);
    assert.match(markdown, /Video Alpha Policy Evidence Report/);
    assert.match(markdown, /candidate-aware-human-review/);
});

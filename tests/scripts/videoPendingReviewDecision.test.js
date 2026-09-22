import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    createPendingReviewDecision,
    createVideoPendingReviewDecision
} from '../../scripts/create-video-pending-review-decision.js';

function reviewPack() {
    return {
        delivery: {
            status: 'review-only',
            ready: true,
            bestCandidate: {
                profileLabel: 'alphaEdgePolicy=standard045-inset035',
                decision: 'candidate-aware-human-review'
            }
        },
        temporal: {
            cases: [{ id: 'case-a-temporal' }]
        },
        comparisons: [
            { caseId: 'case-a', kind: 'roi', outputPath: 'case-a-roi.mp4' },
            { caseId: 'case-a', kind: 'full', outputPath: 'case-a-full.mp4' }
        ],
        checklist: [
            'ROI is cleaner than baseline',
            'Full frame remains stable'
        ]
    };
}

test('createPendingReviewDecision should seed a pending review decision from a review pack', () => {
    const decision = createPendingReviewDecision({
        reviewPack: reviewPack(),
        reviewHtmlPath: 'Z:\\fixtures\\project\\.artifacts\\alpha\\review.html',
        decisionPath: '.artifacts/alpha/decision.pending.json'
    });

    assert.equal(decision.decision, 'pending');
    assert.equal(decision.deliveryStatus, 'review-only');
    assert.equal(decision.temporalStatus, 'available');
    assert.equal(decision.candidate, 'alphaEdgePolicy=standard045-inset035');
    assert.equal(decision.videos.length, 2);
    assert.equal(decision.checklist.length, 2);
    assert.equal(decision.checklist[0].checked, false);
});

test('createVideoPendingReviewDecision should write decision seed and pending report', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-pending-review-decision');
    await rm(artifactRoot, { recursive: true, force: true });
    await mkdir(artifactRoot, { recursive: true });
    const reviewPackPath = path.join(artifactRoot, 'review-pack.json');
    const reviewHtmlPath = path.join(artifactRoot, 'review.html');
    const decisionPath = path.join(artifactRoot, 'decision.pending.json');
    const outputPath = path.join(artifactRoot, 'decision-report.json');
    const markdownPath = path.join(artifactRoot, 'decision-report.md');
    await writeFile(reviewPackPath, `${JSON.stringify(reviewPack(), null, 2)}\n`, 'utf8');
    await writeFile(reviewHtmlPath, '<!doctype html><title>Review</title>\n', 'utf8');

    const result = await createVideoPendingReviewDecision({
        reviewPackPath,
        reviewHtmlPath,
        decisionPath,
        outputPath,
        markdownPath
    });
    const seed = JSON.parse(await readFile(decisionPath, 'utf8'));
    const report = JSON.parse(await readFile(outputPath, 'utf8'));
    const markdown = await readFile(markdownPath, 'utf8');

    assert.equal(result.status, 'pending');
    assert.deepEqual(result.blockers, []);
    assert.equal(seed.template, true);
    assert.equal(seed.videos.length, 2);
    assert.equal(report.status, 'pending');
    assert.equal(report.reviewMode, 'polish-comparison');
    assert.deepEqual(report.warnings, ['decision-pending', 'review-only-polish-comparison', 'decision-checklist-incomplete']);
    assert.match(markdown, /Video Review Decision Report/);
});

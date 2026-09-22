import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createVideoGoalStatusSummary,
    renderVideoGoalStatusMarkdown
} from '../../scripts/create-video-goal-status-report.js';

function lane(overrides = {}) {
    return {
        id: 'current025',
        title: 'Current Candidate 0.25',
        status: 'ready-for-visual-review',
        temporalStatus: 'pass',
        reviewStatus: 'needs-polish',
        nextAction: 'run-light-polish-pass-before-default-review',
        checklist: { total: 5, checked: 1, unchecked: 4, allChecked: false },
        ready: true,
        bestCandidate: 'canvas-temporal-match-delta-stabilize, strength=0.25',
        comparisons: 4,
        temporalCases: 4,
        assets: [
            { name: 'reviewHtml', path: 'review.html', exists: true },
            { name: 'decisionJson', path: 'decision.json', exists: true }
        ],
        missingAssets: [],
        ...overrides
    };
}

function dashboard(overrides = {}) {
    return {
        generatedAt: '2026-06-11T00:00:00.000Z',
        outputPath: 'Z:\\fixtures\\project\\.artifacts\\video-delivery-dashboard\\latest-video-dashboard.html',
        lanes: [
            lane(),
            lane({
                id: 'polish020',
                title: 'Light Polish 0.20',
                status: 'review-only',
                temporalStatus: 'available',
                reviewStatus: 'needs-polish',
                checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false },
                temporalCases: 6
            }),
            lane({
                id: 'sweep018022',
                title: 'Strength Sweep',
                status: 'review-only',
                temporalStatus: 'available',
                reviewStatus: 'needs-polish',
                checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false },
                temporalCases: 10
            })
        ],
        missingAssets: [],
        ...overrides
    };
}

test('createVideoGoalStatusSummary should keep goal incomplete without human acceptance', () => {
    const report = createVideoGoalStatusSummary(dashboard());
    const markdown = renderVideoGoalStatusMarkdown(report);

    assert.equal(report.status, 'incomplete');
    assert.equal(report.complete, false);
    assert.equal(report.nextAction, 'collect-human-review-acceptance');
    assert.ok(report.blockers.includes('human-review-acceptance-missing'));
    assert.equal(report.requirements.find((item) => item.id === 'viewable-review-artifacts').satisfied, true);
    assert.equal(report.requirements.find((item) => item.id === 'current-candidate-ready-for-visual-review').satisfied, true);
    assert.equal(report.requirements.find((item) => item.id === 'human-acceptance-recorded').satisfied, false);
    assert.match(markdown, /human-acceptance-recorded/);
    assert.match(markdown, /needs-polish/);
});

test('createVideoGoalStatusSummary should complete when a lane is accepted with a full checklist', () => {
    const accepted = dashboard({
        lanes: [
            lane({
                reviewStatus: 'accepted-for-default-review',
                nextAction: 'promote-to-default-strategy-review',
                checklist: { total: 5, checked: 5, unchecked: 0, allChecked: true }
            }),
            lane({
                id: 'polish020',
                title: 'Light Polish 0.20',
                status: 'review-only',
                temporalStatus: 'available',
                reviewStatus: 'needs-polish',
                checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false },
                temporalCases: 6
            }),
            lane({
                id: 'sweep018022',
                title: 'Strength Sweep',
                status: 'review-only',
                temporalStatus: 'available',
                reviewStatus: 'needs-polish',
                checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false },
                temporalCases: 10
            })
        ]
    });
    const report = createVideoGoalStatusSummary(accepted);

    assert.equal(report.status, 'complete');
    assert.equal(report.complete, true);
    assert.equal(report.nextAction, 'mark-goal-complete');
    assert.deepEqual(report.blockers, []);
});

test('createVideoGoalStatusSummary should accept alpha policy review decisions', () => {
    const accepted = dashboard({
        lanes: [
            lane(),
            lane({
                id: 'polish020',
                title: 'Light Polish 0.20',
                status: 'review-only',
                temporalStatus: 'available',
                reviewStatus: 'needs-polish',
                checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false },
                temporalCases: 6
            }),
            lane({
                id: 'alphaPolicy035',
                title: 'Alpha Policy 0.35',
                status: 'review-only',
                temporalStatus: 'available',
                reviewStatus: 'prefer-alpha-policy035-candidate',
                nextAction: 'promote-alpha-policy035-to-default-candidate-review',
                checklist: { total: 5, checked: 5, unchecked: 0, allChecked: true },
                comparisons: 6,
                temporalCases: 3,
                bestCandidate: 'alphaEdgePolicy=standard045-inset035'
            })
        ]
    });
    const report = createVideoGoalStatusSummary(accepted);

    assert.equal(report.status, 'complete');
    assert.equal(report.complete, true);
    assert.deepEqual(report.blockers, []);
});

test('createVideoGoalStatusSummary should record verified delivery bundle evidence', () => {
    const report = createVideoGoalStatusSummary(dashboard(), {
        verification: {
            status: 'ready-for-human-review',
            outputPath: 'Z:\\fixtures\\project\\.artifacts\\video-delivery-bundle\\latest-verification-report.json',
            markdownPath: 'Z:\\fixtures\\project\\.artifacts\\video-delivery-bundle\\latest-verification-report.md',
            summary: {
                checks: 51,
                passed: 51,
                failed: 0
            }
        }
    });
    const verificationRequirement = report.requirements.find((item) => item.id === 'delivery-bundle-verified');

    assert.equal(report.status, 'incomplete');
    assert.equal(report.complete, false);
    assert.equal(report.requirements.length, 6);
    assert.equal(verificationRequirement.satisfied, true);
    assert.equal(verificationRequirement.evidence.failed, 0);
    assert.ok(report.blockers.includes('human-review-acceptance-missing'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    createVideoDeliveryBundleReport,
    createVideoDeliveryBundleSummary,
    renderVideoDeliveryBundleMarkdown
} from '../../scripts/create-video-delivery-bundle.js';
import { createVideoReviewDecisionSummary } from '../../scripts/create-video-review-decision-report.js';

function lane(overrides = {}) {
    return {
        id: 'current025',
        status: 'ready-for-visual-review',
        temporalStatus: 'pass',
        reviewStatus: 'needs-polish',
        checklist: { total: 5, checked: 1, unchecked: 4, allChecked: false },
        nextAction: 'run-light-polish-pass-before-default-review',
        missingAssets: 0,
        ...overrides
    };
}

function goalReport(overrides = {}) {
    return {
        status: 'incomplete',
        complete: false,
        nextAction: 'collect-human-review-acceptance',
        blockers: ['human-review-acceptance-missing'],
        outputPath: 'Z:\\fixtures\\project\\.artifacts\\video-goal-status\\latest-report.json',
        markdownPath: 'Z:\\fixtures\\project\\.artifacts\\video-goal-status\\latest-report.md',
        requirements: [
            { id: 'viewable-review-artifacts', satisfied: true },
            { id: 'human-acceptance-recorded', satisfied: false }
        ],
        lanes: [
            lane(),
            lane({ id: 'polish020', status: 'review-only', temporalStatus: 'available', checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false } }),
            lane({ id: 'sweep018022', status: 'review-only', temporalStatus: 'available', checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false } })
        ],
        ...overrides
    };
}

function dashboardReport(overrides = {}) {
    return {
        outputPath: 'Z:\\fixtures\\project\\.artifacts\\video-delivery-dashboard\\latest-video-dashboard.html',
        reportPath: 'Z:\\fixtures\\project\\.artifacts\\video-delivery-dashboard\\latest-video-dashboard.json',
        lanes: 3,
        readyLanes: 3,
        missingAssets: 0,
        ...overrides
    };
}

function dashboardDetail(overrides = {}) {
    return {
        lanes: [
            {
                id: 'current025',
                title: 'Current Candidate 0.25',
                reviewStatus: 'needs-polish',
                checklist: { total: 5, checked: 1, unchecked: 4, allChecked: false },
                assets: [
                    { name: 'reviewHtml', path: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-pack\\latest-review-index.html' },
                    { name: 'decisionReport', path: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-pack\\latest-review-decision-report.md' },
                    { name: 'decisionJson', path: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-pack\\latest-review-decision-report.json' }
                ]
            }
        ],
        ...overrides
    };
}

test('createVideoDeliveryBundleSummary should surface incomplete human acceptance blocker', () => {
    const report = {
        outputPath: 'bundle.json',
        markdownPath: 'bundle.md',
        ...createVideoDeliveryBundleSummary({
            dashboardReport: dashboardReport(),
            goalReport: goalReport(),
            dashboardDetail: dashboardDetail(),
            dashboardScreenshot: {
                outputPath: 'Z:\\fixtures\\project\\.artifacts\\video-delivery-dashboard\\latest-video-dashboard.png',
                reportPath: 'Z:\\fixtures\\project\\.artifacts\\video-delivery-dashboard\\latest-video-dashboard-screenshot.json',
                generatedAt: '2026-06-11T16:25:47.992Z'
            }
        })
    };
    const markdown = renderVideoDeliveryBundleMarkdown(report);

    assert.equal(report.status, 'incomplete');
    assert.equal(report.complete, false);
    assert.equal(report.nextAction, 'collect-human-review-acceptance');
    assert.ok(report.blockers.includes('human-review-acceptance-missing'));
    assert.equal(report.dashboard.readyLanes, 3);
    assert.match(report.dashboard.screenshotPath, /latest-video-dashboard\.png/);
    assert.match(report.dashboard.screenshotReportPath, /latest-video-dashboard-screenshot\.json/);
    assert.equal(report.goalStatus.satisfiedRequirements, 1);
    assert.equal(report.acceptance.status, 'pending-human-review');
    assert.equal(report.acceptance.lanes[0].suggestedDecision, 'accept');
    assert.match(report.acceptance.lanes[0].command, /pnpm report:video-review-decision/);
    assert.equal(report.decisionTemplates.length, 0);
    assert.match(markdown, /Video Delivery Bundle/);
    assert.match(markdown, /Human Acceptance Gate/);
    assert.match(markdown, /Dashboard screenshot/);
    assert.match(markdown, /human-review-acceptance-missing/);
    assert.match(markdown, /current025/);
    assert.match(markdown, /1\/5/);
});

test('createVideoDeliveryBundleSummary should suggest alpha policy review decisions for alpha lane', () => {
    const report = createVideoDeliveryBundleSummary({
        dashboardReport: dashboardReport({ lanes: 4, readyLanes: 4 }),
        goalReport: goalReport({
            lanes: [
                lane(),
                lane({
                    id: 'alphaPolicy035',
                    title: 'Alpha Policy 0.35',
                    status: 'review-only',
                    temporalStatus: 'available',
                    reviewStatus: 'pending',
                    checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false }
                })
            ]
        }),
        dashboardDetail: dashboardDetail({
            lanes: [
                {
                    id: 'alphaPolicy035',
                    title: 'Alpha Policy 0.35',
                    reviewStatus: 'pending',
                    checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false },
                    assets: [
                        { name: 'reviewHtml', path: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-policy035-review\\review-pack\\latest-review-index.html' },
                        { name: 'decisionReport', path: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-policy035-review\\review-pack\\latest-alpha-policy-review-decision-report.md' },
                        { name: 'decisionJson', path: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-policy035-review\\review-pack\\latest-alpha-policy-review-decision-report.json' }
                    ]
                }
            ]
        })
    });

    assert.equal(report.acceptance.lanes.find((item) => item.id === 'alphaPolicy035')?.suggestedDecision, 'prefer-alpha-policy035');
});

test('createVideoDeliveryBundleSummary should preserve completed goal status', () => {
    const report = createVideoDeliveryBundleSummary({
        dashboardReport: dashboardReport(),
        goalReport: goalReport({
            status: 'complete',
            complete: true,
            nextAction: 'mark-goal-complete',
            blockers: [],
            requirements: [
                { id: 'viewable-review-artifacts', satisfied: true },
                { id: 'human-acceptance-recorded', satisfied: true }
            ],
            lanes: [
                lane({
                    reviewStatus: 'accepted-for-default-review',
                    checklist: { total: 5, checked: 5, unchecked: 0, allChecked: true }
                })
            ]
        }),
        dashboardDetail: dashboardDetail()
    });

    assert.equal(report.status, 'complete');
    assert.equal(report.complete, true);
    assert.equal(report.nextAction, 'mark-goal-complete');
    assert.deepEqual(report.blockers, []);
    assert.equal(report.goalStatus.satisfiedRequirements, 2);
    assert.equal(report.acceptance.status, 'accepted');
});

async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createLaneArtifacts(root, id, {
    status = 'review-only',
    temporalStatus = null,
    reviewStatus = 'needs-polish',
    nextAction = 'run-narrow-polish-sweep-before-default-review',
    checked = 0,
    total = 5,
    comparisons = 4,
    temporalCases = 4
} = {}) {
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    const reviewHtmlPath = path.join(dir, 'review.html');
    const screenshotPath = path.join(dir, 'screenshot.png');
    const reviewPackPath = path.join(dir, 'review-pack.json');
    const deliveryReportPath = path.join(dir, 'delivery-report.json');
    const decisionJsonPath = path.join(dir, 'decision.json');
    const decisionReportPath = path.join(dir, 'decision.md');
    const comparisonVideoPath = path.join(dir, 'comparison.mp4');
    await writeFile(reviewHtmlPath, '<!doctype html><title>Review</title>\n', 'utf8');
    await writeFile(screenshotPath, 'fake png placeholder\n', 'utf8');
    await writeFile(decisionReportPath, '# Decision\n', 'utf8');
    await writeFile(comparisonVideoPath, 'fake mp4 placeholder\n', 'utf8');
    await writeJson(reviewPackPath, {
        delivery: {
            status,
            ready: true,
            blockers: [],
            bestCandidate: {
                profileLabel: `${id} candidate`,
                decision: 'human-review'
            }
        },
        comparisons: Array.from({ length: comparisons }, (_, index) => ({
            id: `${id}-comparison-${index}`,
            caseId: `${id}-case-${Math.floor(index / 2)}`,
            kind: index % 2 === 0 ? 'full' : 'roi',
            outputPath: comparisonVideoPath
        })),
        temporal: {
            cases: Array.from({ length: temporalCases }, (_, index) => ({ id: `${id}-temporal-${index}` }))
        },
        checklist: [
            `${id} ROI looks usable`,
            `${id} full frame has no distracting damage`
        ]
    });
    await writeJson(deliveryReportPath, {
        status,
        ready: true,
        temporal: { status: temporalStatus },
        blockers: [],
        gate: {
            bestCandidate: {
                profileLabel: `${id} candidate`,
                decision: 'human-review'
            }
        }
    });
    await writeJson(decisionJsonPath, {
        status: reviewStatus,
        nextAction,
        checklist: {
            total,
            checked,
            unchecked: total - checked,
            allChecked: checked === total
        },
        warnings: [],
        blockers: []
    });
    return {
        id,
        title: id,
        subtitle: 'Temporary lane',
        reviewHtmlPath,
        screenshotPath,
        reviewPackPath,
        deliveryReportPath,
        decisionReportPath,
        decisionJsonPath,
        primaryAction: 'Review lane.'
    };
}

test('createVideoDeliveryBundleReport should rebuild dashboard and goal reports before writing bundle', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-delivery-bundle');
    await rm(artifactRoot, { recursive: true, force: true });
    const lanes = [
        await createLaneArtifacts(artifactRoot, 'current025', {
            status: 'ready-for-visual-review',
            temporalStatus: 'pass',
            nextAction: 'run-light-polish-pass-before-default-review',
            checked: 1
        }),
        await createLaneArtifacts(artifactRoot, 'polish020'),
        await createLaneArtifacts(artifactRoot, 'sweep018022')
    ];

    const outputPath = path.join(artifactRoot, 'bundle.json');
    const markdownPath = path.join(artifactRoot, 'bundle.md');
    const dashboardOutputPath = path.join(artifactRoot, 'dashboard.html');
    const dashboardReportPath = path.join(artifactRoot, 'dashboard.json');
    const goalOutputPath = path.join(artifactRoot, 'goal.json');
    const goalMarkdownPath = path.join(artifactRoot, 'goal.md');
    const dashboardScreenshotPath = path.join(artifactRoot, 'dashboard.png');
    const dashboardScreenshotReportPath = path.join(artifactRoot, 'dashboard-screenshot.json');
    const decisionTemplateDir = path.join(artifactRoot, 'decision-templates');
    const quickstartOutputPath = path.join(artifactRoot, 'quickstart.md');
    const quickstartJsonPath = path.join(artifactRoot, 'quickstart.json');
    const quickstartHtmlPath = path.join(artifactRoot, 'quickstart.html');
    const quickstartScreenshotPath = path.join(artifactRoot, 'quickstart.png');
    const quickstartScreenshotReportPath = path.join(artifactRoot, 'quickstart-screenshot.json');
    const verificationOutputPath = path.join(artifactRoot, 'verification.json');
    const verificationMarkdownPath = path.join(artifactRoot, 'verification.md');
    const dashboardScreenshotGenerator = async ({ htmlPath, outputPath, reportPath }) => {
        await writeFile(outputPath, 'fake dashboard png placeholder\n', 'utf8');
        const report = {
            generatedAt: '2026-06-11T16:25:47.992Z',
            htmlPath,
            outputPath,
            reportPath,
            viewport: { width: 1440, height: 1200 },
            documentSize: { scrollWidth: 1440, scrollHeight: 1800, clientWidth: 1440, clientHeight: 1200 },
            fullPage: true
        };
        await writeJson(reportPath, report);
        return report;
    };

    const report = await createVideoDeliveryBundleReport({
        outputPath,
        markdownPath,
        dashboardOutputPath,
        dashboardReportPath,
        dashboardScreenshotPath,
        dashboardScreenshotReportPath,
        dashboardScreenshotGenerator,
        goalOutputPath,
        goalMarkdownPath,
        decisionTemplateDir,
        quickstartOutputPath,
        quickstartJsonPath,
        quickstartHtmlPath,
        quickstartScreenshotPath,
        quickstartScreenshotReportPath,
        verificationOutputPath,
        verificationMarkdownPath,
        verifyMedia: false,
        dashboardLanes: lanes
    });
    const saved = JSON.parse(await readFile(outputPath, 'utf8'));
    const markdown = await readFile(markdownPath, 'utf8');
    const quickstart = JSON.parse(await readFile(quickstartJsonPath, 'utf8'));
    const currentTemplate = JSON.parse(await readFile(path.join(decisionTemplateDir, 'current025.decision.template.json'), 'utf8'));

    assert.equal(report.status, 'incomplete');
    assert.equal(report.nextAction, 'collect-human-review-acceptance');
    assert.equal(report.dashboard.missingAssets, 0);
    assert.equal(report.dashboard.screenshotPath, dashboardScreenshotPath);
    assert.equal(report.dashboard.screenshotReportPath, dashboardScreenshotReportPath);
    assert.equal(report.goalStatus.satisfiedRequirements, 5);
    assert.equal(report.goalStatus.requirementCount, 6);
    assert.equal(report.acceptance.status, 'pending-human-review');
    assert.equal(report.decisionTemplates.length, 3);
    assert.equal(report.decisionTemplates[0].decision, 'pending');
    assert.equal(currentTemplate.template, true);
    assert.equal(currentTemplate.decision, 'pending');
    assert.equal(currentTemplate.laneId, 'current025');
    assert.equal(currentTemplate.suggestedDecision, 'accept');
    assert.deepEqual(currentTemplate.suggestedDecisionOptions, ['accept', 'needs-polish', 'reject']);
    assert.ok(currentTemplate.acceptedStatuses.includes('prefer-alpha-policy035-candidate'));
    assert.equal(currentTemplate.checklist.length, 2);
    assert.equal(currentTemplate.videos.length, 4);
    assert.match(report.acceptance.lanes[0].decisionTemplatePath, /current025\.decision\.template\.json/);
    assert.match(report.acceptance.lanes[0].command, /pnpm report:video-review-decision/);
    assert.match(report.acceptance.lanes[0].command, /current025\.decision\.template\.json/);
    assert.ok(report.blockers.includes('human-review-acceptance-missing'));
    assert.equal(saved.dashboard.outputPath, dashboardOutputPath);
    assert.equal(saved.dashboard.screenshotPath, dashboardScreenshotPath);
    assert.equal(saved.quickstart.outputPath, quickstartOutputPath);
    assert.equal(saved.quickstart.jsonPath, quickstartJsonPath);
    assert.equal(saved.quickstart.htmlPath, quickstartHtmlPath);
    assert.equal(saved.quickstart.screenshotPath, quickstartScreenshotPath);
    assert.equal(saved.quickstart.screenshotReportPath, quickstartScreenshotReportPath);
    assert.equal(saved.verification.outputPath, verificationOutputPath);
    assert.equal(saved.verification.markdownPath, verificationMarkdownPath);
    assert.equal(saved.verification.status, 'ready-for-human-review');
    assert.equal(saved.verification.failed, 0);
    assert.equal(saved.acceptance.lanes.length, 3);
    assert.equal(saved.decisionTemplates.length, 3);
    assert.equal(quickstart.lanes.length, 3);
    assert.equal(quickstart.lanes[0].suggestedDecision, 'accept');
    assert.match(markdown, /Video Delivery Bundle/);
    assert.match(markdown, /Human Acceptance Gate/);
    assert.match(markdown, /Acceptance quickstart/);
    assert.match(markdown, /Acceptance quickstart HTML/);
    assert.match(markdown, /Acceptance quickstart screenshot/);
    assert.match(markdown, /Bundle verification status/);
    assert.match(markdown, /Decision templates/);
    assert.match(markdown, /current025/);
});

test('createVideoDeliveryBundleReport should write self-describing alpha decision template', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-delivery-bundle-alpha-template');
    await rm(artifactRoot, { recursive: true, force: true });
    const lanes = [
        await createLaneArtifacts(artifactRoot, 'current025', {
            status: 'ready-for-visual-review',
            temporalStatus: 'pass',
            checked: 1
        }),
        await createLaneArtifacts(artifactRoot, 'alphaPolicy035', {
            status: 'review-only',
            comparisons: 6,
            temporalCases: 3
        })
    ];
    const decisionTemplateDir = path.join(artifactRoot, 'decision-templates');

    await createVideoDeliveryBundleReport({
        outputPath: path.join(artifactRoot, 'bundle.json'),
        markdownPath: path.join(artifactRoot, 'bundle.md'),
        dashboardOutputPath: path.join(artifactRoot, 'dashboard.html'),
        dashboardReportPath: path.join(artifactRoot, 'dashboard.json'),
        dashboardScreenshotPath: path.join(artifactRoot, 'dashboard.png'),
        dashboardScreenshotReportPath: path.join(artifactRoot, 'dashboard-screenshot.json'),
        dashboardScreenshotGenerator: async ({ htmlPath, outputPath, reportPath }) => {
            await writeFile(outputPath, 'fake dashboard png placeholder\n', 'utf8');
            const report = { generatedAt: '2026-06-11T16:25:47.992Z', htmlPath, outputPath, reportPath };
            await writeJson(reportPath, report);
            return report;
        },
        goalOutputPath: path.join(artifactRoot, 'goal.json'),
        goalMarkdownPath: path.join(artifactRoot, 'goal.md'),
        decisionTemplateDir,
        quickstartOutputPath: path.join(artifactRoot, 'quickstart.md'),
        quickstartJsonPath: path.join(artifactRoot, 'quickstart.json'),
        quickstartHtmlPath: path.join(artifactRoot, 'quickstart.html'),
        quickstartScreenshotPath: path.join(artifactRoot, 'quickstart.png'),
        quickstartScreenshotReportPath: path.join(artifactRoot, 'quickstart-screenshot.json'),
        verificationOutputPath: path.join(artifactRoot, 'verification.json'),
        verificationMarkdownPath: path.join(artifactRoot, 'verification.md'),
        verifyMedia: false,
        dashboardLanes: lanes
    });
    const alphaTemplate = JSON.parse(await readFile(path.join(decisionTemplateDir, 'alphaPolicy035.decision.template.json'), 'utf8'));

    assert.equal(alphaTemplate.laneId, 'alphaPolicy035');
    assert.equal(alphaTemplate.suggestedDecision, 'prefer-alpha-policy035');
    assert.deepEqual(alphaTemplate.suggestedDecisionOptions, ['prefer-alpha-policy035', 'prefer-current', 'needs-more-polish', 'reject-both']);
    assert.ok(alphaTemplate.acceptedStatuses.includes('prefer-alpha-policy035-candidate'));
    assert.equal(alphaTemplate.decision, 'pending');
    assert.equal(alphaTemplate.videos.length, 6);
});

test('createVideoDeliveryBundleReport should use valid suggested decisions for sweep templates', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-delivery-bundle-sweep-template');
    await rm(artifactRoot, { recursive: true, force: true });
    const lanes = [
        await createLaneArtifacts(artifactRoot, 'current025', {
            status: 'ready-for-visual-review',
            temporalStatus: 'pass',
            checked: 1
        }),
        await createLaneArtifacts(artifactRoot, 'sweep018022', {
            status: 'review-only'
        })
    ];
    const decisionTemplateDir = path.join(artifactRoot, 'decision-templates');

    await createVideoDeliveryBundleReport({
        outputPath: path.join(artifactRoot, 'bundle.json'),
        markdownPath: path.join(artifactRoot, 'bundle.md'),
        dashboardOutputPath: path.join(artifactRoot, 'dashboard.html'),
        dashboardReportPath: path.join(artifactRoot, 'dashboard.json'),
        dashboardScreenshotPath: path.join(artifactRoot, 'dashboard.png'),
        dashboardScreenshotReportPath: path.join(artifactRoot, 'dashboard-screenshot.json'),
        dashboardScreenshotGenerator: async ({ htmlPath, outputPath, reportPath }) => {
            await writeFile(outputPath, 'fake dashboard png placeholder\n', 'utf8');
            const report = { generatedAt: '2026-06-11T16:25:47.992Z', htmlPath, outputPath, reportPath };
            await writeJson(reportPath, report);
            return report;
        },
        goalOutputPath: path.join(artifactRoot, 'goal.json'),
        goalMarkdownPath: path.join(artifactRoot, 'goal.md'),
        decisionTemplateDir,
        quickstartOutputPath: path.join(artifactRoot, 'quickstart.md'),
        quickstartJsonPath: path.join(artifactRoot, 'quickstart.json'),
        quickstartHtmlPath: path.join(artifactRoot, 'quickstart.html'),
        quickstartScreenshotPath: path.join(artifactRoot, 'quickstart.png'),
        quickstartScreenshotReportPath: path.join(artifactRoot, 'quickstart-screenshot.json'),
        verificationOutputPath: path.join(artifactRoot, 'verification.json'),
        verificationMarkdownPath: path.join(artifactRoot, 'verification.md'),
        verifyMedia: false,
        dashboardLanes: lanes
    });
    const sweepTemplate = JSON.parse(await readFile(path.join(decisionTemplateDir, 'sweep018022.decision.template.json'), 'utf8'));

    assert.equal(sweepTemplate.suggestedDecision, 'prefer-strength018');
    assert.deepEqual(sweepTemplate.suggestedDecisionOptions, [
        'prefer-strength018',
        'prefer-strength022',
        'prefer-light',
        'prefer-current',
        'needs-more-polish',
        'reject-both'
    ]);
});

test('createVideoDeliveryBundleReport suggested decision options should be parser-recognized', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-delivery-bundle-decision-options');
    await rm(artifactRoot, { recursive: true, force: true });
    const lanes = [
        await createLaneArtifacts(artifactRoot, 'current025', {
            status: 'ready-for-visual-review',
            temporalStatus: 'pass',
            checked: 1
        }),
        await createLaneArtifacts(artifactRoot, 'polish020'),
        await createLaneArtifacts(artifactRoot, 'sweep018022'),
        await createLaneArtifacts(artifactRoot, 'alphaPolicy035', {
            status: 'review-only',
            comparisons: 6,
            temporalCases: 3
        })
    ];
    const decisionTemplateDir = path.join(artifactRoot, 'decision-templates');

    await createVideoDeliveryBundleReport({
        outputPath: path.join(artifactRoot, 'bundle.json'),
        markdownPath: path.join(artifactRoot, 'bundle.md'),
        dashboardOutputPath: path.join(artifactRoot, 'dashboard.html'),
        dashboardReportPath: path.join(artifactRoot, 'dashboard.json'),
        dashboardScreenshotPath: path.join(artifactRoot, 'dashboard.png'),
        dashboardScreenshotReportPath: path.join(artifactRoot, 'dashboard-screenshot.json'),
        dashboardScreenshotGenerator: async ({ htmlPath, outputPath, reportPath }) => {
            await writeFile(outputPath, 'fake dashboard png placeholder\n', 'utf8');
            const report = { generatedAt: '2026-06-11T16:25:47.992Z', htmlPath, outputPath, reportPath };
            await writeJson(reportPath, report);
            return report;
        },
        goalOutputPath: path.join(artifactRoot, 'goal.json'),
        goalMarkdownPath: path.join(artifactRoot, 'goal.md'),
        decisionTemplateDir,
        quickstartOutputPath: path.join(artifactRoot, 'quickstart.md'),
        quickstartJsonPath: path.join(artifactRoot, 'quickstart.json'),
        quickstartHtmlPath: path.join(artifactRoot, 'quickstart.html'),
        quickstartScreenshotPath: path.join(artifactRoot, 'quickstart.png'),
        quickstartScreenshotReportPath: path.join(artifactRoot, 'quickstart-screenshot.json'),
        verificationOutputPath: path.join(artifactRoot, 'verification.json'),
        verificationMarkdownPath: path.join(artifactRoot, 'verification.md'),
        verifyMedia: false,
        dashboardLanes: lanes
    });

    for (const laneId of ['current025', 'polish020', 'sweep018022', 'alphaPolicy035']) {
        const template = JSON.parse(await readFile(path.join(decisionTemplateDir, `${laneId}.decision.template.json`), 'utf8'));
        for (const decision of template.suggestedDecisionOptions) {
            const report = createVideoReviewDecisionSummary({
                ...template,
                decision,
                checklist: template.checklist.map((item) => ({ ...item, checked: true }))
            });
            assert.notEqual(report.decision, 'pending', `${laneId} option ${decision} should be recognized`);
            assert.notEqual(report.status, 'invalid', `${laneId} option ${decision} should not be invalid`);
        }
    }
});

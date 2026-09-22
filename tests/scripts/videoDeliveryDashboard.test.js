import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    createVideoDeliveryDashboard,
    renderVideoDeliveryDashboardHtml
} from '../../scripts/create-video-delivery-dashboard.js';

test('renderVideoDeliveryDashboardHtml should render lanes links and temporal rows', () => {
    const html = renderVideoDeliveryDashboardHtml({
        generatedAt: '2026-06-11T00:00:00.000Z',
        outputPath: 'Z:\\fixtures\\project\\.artifacts\\video-delivery-dashboard\\latest-video-dashboard.html',
        lanes: [
            {
                id: 'current025',
                title: 'Current Candidate 0.25',
                subtitle: 'Default visual-review candidate',
                reviewHtmlPath: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-pack\\latest-review-index.html',
                screenshotPath: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-pack\\latest-review-index.png',
                reviewPackPath: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-pack\\latest-review-pack.json',
                deliveryReportPath: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\delivery-gate\\latest-delivery-report.json',
                decisionTemplatePath: 'Z:\\fixtures\\project\\.artifacts\\video-delivery-bundle\\decision-templates\\current025.decision.template.json',
                decisionReportPath: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-pack\\latest-review-decision-report.md',
                decisionJsonPath: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-pack\\latest-review-decision-report.json',
                primaryAction: 'Accept current preset only after checklist is fully checked.',
                summary: {
                    status: 'ready-for-visual-review',
                    ready: true,
                    bestCandidate: 'canvas-temporal-match-delta-stabilize, strength=0.25',
                    candidateDecision: 'promote-default-candidate',
                    comparisons: 4,
                    temporalCases: 2,
                    blockers: []
                },
                deliverySummary: {
                    status: 'ready-for-visual-review',
                    ready: true,
                    temporalStatus: 'pass',
                    blockers: []
                },
                decisionSummary: {
                    status: 'needs-polish',
                    nextAction: 'run-light-polish-pass-before-default-review',
                    checklist: { checked: 1, total: 5 }
                },
                reviewPack: {
                    temporal: {
                        cases: [
                            {
                                id: 'deaee69b-auto-relocated',
                                meanSameJitter: 9.3522,
                                meanMatchedJitter: 10.4506,
                                worsenedRatio: 0.4274
                            }
                        ]
                    }
                }
            },
            {
                id: 'sweep018022',
                title: 'Strength Sweep',
                subtitle: 'Compare 0.18, 0.20, 0.22, and 0.25',
                reviewHtmlPath: 'Z:\\fixtures\\project\\.artifacts\\video-light-polish-sweep018022\\review-pack\\latest-sweep-review-index.html',
                reviewPackPath: 'Z:\\fixtures\\project\\.artifacts\\video-light-polish-sweep018022\\review-pack\\latest-sweep-review-pack.json',
                gateReportPath: 'Z:\\fixtures\\project\\.artifacts\\video-light-polish-sweep018022\\gate\\latest-report.md',
                decisionReportPath: 'Z:\\fixtures\\project\\.artifacts\\video-light-polish-sweep018022\\review-pack\\latest-sweep-review-decision-report.md',
                primaryAction: 'Promote 0.18 or 0.22 only if the sweep page is clearly better by eye.',
                summary: {
                    status: 'review-only',
                    ready: true,
                    bestCandidate: 'strength sweep 0.18 / 0.20 / 0.22 / 0.25',
                    candidateDecision: 'human-review',
                    comparisons: 4,
                    temporalCases: 10,
                    blockers: []
                },
                reviewPack: {
                    temporal: {
                        cases: Array.from({ length: 20 }, (_, index) => ({
                            id: index === 0 ? 'e1997e6e-strength018' : `sweep-case-${index}`,
                            aggregate: {
                                meanSameJitter: 10.3378 + index,
                                meanMatchedJitter: 14.0055 + index,
                                worsenedRatio: 0.4049
                            }
                        }))
                    }
                }
            },
            {
                id: 'alphaPolicy035',
                title: 'Alpha Policy 0.35',
                subtitle: 'Candidate-aware alpha edge policy review',
                reviewHtmlPath: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-policy035-review\\review-pack\\latest-review-index.html',
                reviewPackPath: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-policy035-review\\review-pack\\latest-review-pack.json',
                gateReportPath: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-policy-evidence\\latest-report.md',
                decisionReportPath: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-policy035-review\\review-pack\\latest-alpha-policy-review-decision-report.md',
                decisionJsonPath: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-policy035-review\\review-pack\\latest-alpha-policy-review-decision-report.json',
                primaryAction: 'Use only if it is visibly cleaner than current 0.25.',
                diagnosticLinks: [
                    {
                        label: 'Known flaw diagnostics',
                        path: 'Z:\\fixtures\\project\\.artifacts\\video-policy035-default-review\\user-flaw-diagnostics\\latest.json'
                    },
                    {
                        label: 'Rejected shape gate',
                        path: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-shape-candidate-gate\\manual-shape-validated\\latest-report.md'
                    }
                ],
                summary: {
                    status: 'review-only',
                    ready: true,
                    bestCandidate: 'alphaEdgePolicy=standard045-inset035',
                    candidateDecision: 'candidate-aware-human-review',
                    candidateEvidence: {
                        reportPath: 'Z:\\fixtures\\project\\.artifacts\\video-alpha-policy-evidence\\latest-report.json',
                        reports: 6,
                        comparedCases: 18,
                        improvedCases: 12,
                        materialRegressedCases: 1,
                        warningRegressedCases: 2
                    },
                    comparisons: 6,
                    temporalCases: 3,
                    blockers: []
                },
                decisionSummary: {
                    status: 'pending',
                    nextAction: 'collect-human-review-decision',
                    checklist: { checked: 0, total: 5 }
                },
                reviewPack: {
                    temporal: {
                        cases: [
                            {
                                id: '4d420881-alpha-policy035-12mbps',
                                meanSameJitter: 17.4563,
                                meanMatchedJitter: 21.6213,
                                worsenedRatio: 0.4052
                            }
                        ]
                    }
                }
            }
        ]
    });

    assert.match(html, /Video Delivery Dashboard/);
    assert.match(html, /human acceptance pending/);
    assert.match(html, /Current Candidate 0\.25/);
    assert.match(html, /Strength Sweep/);
    assert.match(html, /canvas-temporal-match-delta-stabilize, strength=0\.25/);
    assert.match(html, /strength sweep 0\.18 \/ 0\.20 \/ 0\.22 \/ 0\.25/);
    assert.match(html, /Review status/);
    assert.match(html, /Decision command/);
    assert.match(html, /data-copy-command=/);
    assert.match(html, />Copy<\/button>/);
    assert.match(html, /navigator\.clipboard/);
    assert.match(html, /button\.textContent = 'Copied'/);
    assert.match(html, /needs-polish/);
    assert.match(html, /run-light-polish-pass-before-default-review/);
    assert.match(html, /pnpm report:video-review-decision -- --decision/);
    assert.match(html, /1\/5/);
    assert.match(html, /Decision JSON/);
    assert.match(html, /Decision template/);
    assert.match(html, /deaee69b-auto-relocated/);
    assert.match(html, /e1997e6e-strength018/);
    assert.match(html, /sweep-case-19/);
    assert.match(html, /4d420881-alpha-policy035-12mbps/);
    assert.match(html, /Alpha Policy 0\.35/);
    assert.match(html, /pill warn"><span>evidence<\/span><strong>candidate-aware-human-review/);
    assert.match(html, /pill good"><span>evidence<\/span><strong>promote-default-candidate/);
    assert.match(html, /6 reports, 18 cases, 12 improved, 1 material, 2 warning/);
    assert.match(html, /Evidence report/);
    assert.match(html, /\.\.\/video-alpha-policy-evidence\/latest-report\.json/);
    assert.match(html, /Diagnostics/);
    assert.match(html, /Known flaw diagnostics/);
    assert.match(html, /manual-shape-validated\/latest-report\.md/);
    assert.match(html, /10\.3378/);
    assert.match(html, /\.\.\/video-boundary-gradient-auto\/review-pack\/latest-review-index\.html/);
    assert.match(html, /\.\.\/video-light-polish-sweep018022\/review-pack\/latest-sweep-review-index\.html/);
    assert.match(html, /pnpm report:video-polish-sweep-review-pack/);
    assert.match(html, /pnpm report:video-alpha-policy-review-pack/);
    assert.match(html, /pnpm report:video-pending-review-decision/);
});

test('createVideoDeliveryDashboard should write machine-readable asset report', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-delivery-dashboard');
    await rm(artifactRoot, { recursive: true, force: true });
    await mkdir(artifactRoot, { recursive: true });
    const reviewHtmlPath = path.join(artifactRoot, 'review.html');
    const reviewPackPath = path.join(artifactRoot, 'review-pack.json');
    const decisionTemplatePath = path.join(artifactRoot, 'decision.template.json');
    const decisionReportPath = path.join(artifactRoot, 'decision-report.md');
    const outputPath = path.join(artifactRoot, 'dashboard.html');
    const reportPath = path.join(artifactRoot, 'dashboard.json');
    await writeFile(reviewHtmlPath, '<!doctype html><title>Review</title>\n', 'utf8');
    await writeFile(decisionTemplatePath, '{"decision":"pending"}\n', 'utf8');
    await writeFile(decisionReportPath, '# Decision\n', 'utf8');
    await writeFile(reviewPackPath, JSON.stringify({
        generatedAt: '2026-06-11T00:00:00.000Z',
        delivery: {
            status: 'review-only',
            ready: true,
            blockers: [],
            bestCandidate: {
                profileLabel: 'test candidate',
                decision: 'human-review',
                evidence: {
                    decision: {
                        status: 'human-review',
                        reason: 'fixture'
                    },
                    total: {
                        reports: 2,
                        comparedCases: 5,
                        improvedCases: 3,
                        materialRegressedCases: 0,
                        warningRegressedCases: 1
                    },
                    reportPath: path.join(artifactRoot, 'evidence.json')
                }
            }
        },
        temporal: {
            cases: [
                {
                    id: 'test-temporal-case',
                    aggregate: {
                        meanSameJitter: 1.5,
                        meanMatchedJitter: 1.75,
                        worsenedRatio: 0.25
                    }
                }
            ]
        },
        comparisons: []
    }), 'utf8');

    const result = await createVideoDeliveryDashboard({
        outputPath,
        reportPath,
        lanes: [
            {
                id: 'test',
                title: 'Test Lane',
                subtitle: 'Temporary lane',
                reviewHtmlPath,
                screenshotPath: path.join(artifactRoot, 'missing.png'),
                reviewPackPath,
                decisionTemplatePath,
                decisionReportPath,
                decisionJsonPath: reviewPackPath,
                primaryAction: 'Review test lane.'
            }
        ]
    });
    const report = JSON.parse(await readFile(reportPath, 'utf8'));

    assert.equal(result.lanes, 1);
    assert.equal(result.readyLanes, 1);
    assert.equal(result.missingAssets, 1);
    assert.equal(report.lanes[0].assets.length, 6);
    assert.equal(report.lanes[0].missingAssets[0].name, 'screenshot');
    assert.equal(report.lanes[0].decisionTemplatePath, decisionTemplatePath);
    assert.equal(report.lanes[0].candidateDecision, 'human-review');
    assert.deepEqual(report.lanes[0].candidateEvidence, {
        status: 'human-review',
        reason: 'fixture',
        reportPath: path.join(artifactRoot, 'evidence.json'),
        reports: 2,
        comparedCases: 5,
        improvedCases: 3,
        materialRegressedCases: 0,
        warningRegressedCases: 1
    });
    assert.deepEqual(report.lanes[0].diagnosticLinks, []);
    assert.match(report.lanes[0].decisionCommand, /pnpm report:video-review-decision -- --decision/);
    assert.match(report.lanes[0].decisionCommand, /decision\.template\.json/);
    assert.equal(report.lanes[0].assets.some((asset) => asset.name === 'decisionTemplate' && asset.exists), true);
    assert.equal(report.missingAssets[0].laneId, 'test');
    assert.equal(report.lanes[0].reviewStatus, null);
    assert.equal(report.lanes[0].nextAction, null);
    assert.equal(report.temporalRows.length, 1);
    assert.deepEqual(report.temporalRows[0], {
        laneId: 'test',
        lane: 'Test Lane',
        id: 'test-temporal-case',
        same: 1.5,
        matched: 1.75,
        worsened: 0.25
    });
});

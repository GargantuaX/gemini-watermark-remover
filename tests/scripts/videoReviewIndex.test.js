import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    createVideoReviewIndex,
    renderVideoReviewIndexHtml
} from '../../scripts/create-video-review-index.js';

test('renderVideoReviewIndexHtml should embed review videos snapshots and temporal gate', () => {
    const outputPath = 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-pack\\latest-review-index.html';
    const html = renderVideoReviewIndexHtml({
        outputPath,
        reviewPack: {
            generatedAt: '2026-06-11T00:00:00.000Z',
            delivery: {
                status: 'ready-for-visual-review',
                ready: true,
                blockers: [],
                benchmark: { total: 4, rendered: 4, failed: 0 },
                bestCandidate: {
                    profileLabel: 'canvas-temporal-match-delta-stabilize, strength=0.25',
                    decision: 'promote-default-candidate'
                }
            },
            temporal: {
                matchRadius: 2,
                cases: [
                    {
                        id: 'deaee69b-auto-relocated',
                        pairCount: 4,
                        meanSameJitter: 9.3522,
                        meanMatchedJitter: 10.4506,
                        improvement: -1.0984,
                        worsenedRatio: 0.4274,
                        sheetPath: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\temporal-residual\\deaee69b-auto-relocated-temporal-residual.png'
                    }
                ]
            },
            comparisons: [
                {
                    caseId: 'deaee69b',
                    kind: 'roi',
                    outputPath: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\comparison\\deaee69b-roi-4up.mp4',
                    snapshotPath: 'Z:\\fixtures\\project\\.artifacts\\video-boundary-gradient-auto\\review-snapshots\\deaee69b-roi-contact.png',
                    cropBox: { x: 1676, y: 836, width: 200, height: 200 },
                    probe: {
                        exists: true,
                        video: { width: 640, height: 640, frameRate: '24fps', duration: 10 }
                    }
                }
            ],
            checklist: ['ROI looks clean']
        },
        deliveryReport: {
            temporal: {
                status: 'pass',
                comparisons: [
                    {
                        candidateId: 'deaee69b-auto-relocated',
                        baselineId: 'deaee69b',
                        delta: {
                            meanSameJitter: 0.1581,
                            meanMatchedJitter: 0.0789,
                            worsenedRatio: -0.0235
                        }
                    }
                ]
            }
        }
    });

    assert.match(html, /data-action="play-all"/);
    assert.match(html, /data-action="seek-all" data-time="4"/);
    assert.match(html, /data-action="seek-all" data-time="9\.5"/);
    assert.match(html, /data-action="speed"/);
    assert.match(html, /data-action="decision"/);
    assert.match(html, /data-action="notes"/);
    assert.match(html, /data-action="export-decision"/);
    assert.match(html, /localStorage\.setItem\(storageKey/);
    assert.match(html, /video-review-decision-/);
    assert.match(html, /button\.dataset\.time/);
    assert.match(html, /document\.querySelectorAll\('\.review-video'\)/);
    assert.match(html, /<video class="review-video" controls preload="metadata"/);
    assert.match(html, /\.\.\/comparison\/deaee69b-roi-4up\.mp4/);
    assert.match(html, /\.\.\/review-snapshots\/deaee69b-roi-contact\.png/);
    assert.match(html, /Temporal Gate/);
    assert.match(html, /0\.1581/);
    assert.match(html, /ROI looks clean/);
});

test('renderVideoReviewIndexHtml should support custom review title and decision labels', () => {
    const html = renderVideoReviewIndexHtml({
        outputPath: 'Z:\\fixtures\\project\\.artifacts\\video-light-polish-strength020\\review-pack\\latest-review-index.html',
        reviewPack: {
            title: 'Video Light Polish Review',
            subtitle: 'Compare current 0.25 with backup 0.20',
            generatedAt: '2026-06-11T01:00:00.000Z',
            delivery: {
                status: 'review-only',
                ready: true,
                bestCandidate: {
                    profileLabel: '0.20 backup against 0.25 current',
                    decision: 'human-review'
                }
            },
            comparisons: [],
            decisionOptions: [
                { value: 'pending', label: 'Pending' },
                { value: 'prefer-current', label: 'Prefer current 0.25' },
                { value: 'prefer-light', label: 'Prefer lighter 0.20' }
            ]
        }
    });

    assert.match(html, /<title>Video Light Polish Review<\/title>/);
    assert.match(html, /Compare current 0\.25 with backup 0\.20/);
    assert.match(html, /value="prefer-current">Prefer current 0\.25/);
    assert.match(html, /value="prefer-light">Prefer lighter 0\.20/);
    assert.doesNotMatch(html, /Accept current preset/);
});

test('createVideoReviewIndex should report review-pack temporal lab cases', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-review-index');
    await rm(artifactRoot, { recursive: true, force: true });
    await mkdir(artifactRoot, { recursive: true });
    const reviewPackPath = path.join(artifactRoot, 'review-pack.json');
    const outputPath = path.join(artifactRoot, 'index.html');
    await writeFile(reviewPackPath, JSON.stringify({
        title: 'Temporal Lab Review',
        generatedAt: '2026-06-11T00:00:00.000Z',
        delivery: {
            ready: true,
            bestCandidate: { profileLabel: 'policy035', decision: 'human-review' }
        },
        temporal: {
            matchRadius: 2,
            cases: [
                {
                    id: 'case-a',
                    pairCount: 4,
                    meanSameJitter: 9,
                    meanMatchedJitter: 10,
                    improvement: -1,
                    worsenedRatio: 0.4,
                    sheetPath: path.join(artifactRoot, 'case-a.png')
                }
            ]
        },
        comparisons: []
    }, null, 2), 'utf8');

    const report = await createVideoReviewIndex({ reviewPackPath, outputPath });
    const html = await readFile(outputPath, 'utf8');

    assert.equal(report.temporalStatus, null);
    assert.equal(report.temporalCases, 1);
    assert.match(html, /Temporal Lab/);
    assert.match(html, /case-a/);
});

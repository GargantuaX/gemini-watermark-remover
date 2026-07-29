import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assessCollectionEligibility,
    buildBlindReviewAssignments,
    assessScoringEligibility
} from '../../scripts/confirmatory-cleanliness-validation.js';

test('collection eligibility rejects an overlapping 24-hour pilot despite enough unique images', () => {
    const result = assessCollectionEligibility({
        priorWindowEndUtc: '2026-07-28T01:50:50.981Z',
        collectionWindowStartUtc: '2026-07-27T16:50:29.256Z',
        collectionWindowEndUtc: '2026-07-28T16:50:29.256Z',
        minimumWindowHours: 72,
        uniqueImageCount: 100,
        minimumUniqueImageCount: 80
    });

    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, [
        'collection-window-overlaps-prior-evaluation-window',
        'collection-window-shorter-than-preregistered-minimum'
    ]);
    assert.equal(result.collectionWindowHours, 24);
    assert.equal(
        result.earliestEligibleWindowEndUtc,
        '2026-07-31T01:50:50.982Z'
    );
});

test('collection eligibility accepts a non-overlapping 72-hour window with 80 unique images', () => {
    const result = assessCollectionEligibility({
        priorWindowEndUtc: '2026-07-28T01:50:50.981Z',
        collectionWindowStartUtc: '2026-07-28T01:50:50.982Z',
        collectionWindowEndUtc: '2026-07-31T01:50:50.982Z',
        minimumWindowHours: 72,
        uniqueImageCount: 80,
        minimumUniqueImageCount: 80
    });

    assert.equal(result.eligible, true);
    assert.deepEqual(result.reasons, []);
});

test('collection eligibility rejects fewer than 80 unique images', () => {
    const result = assessCollectionEligibility({
        priorWindowEndUtc: '2026-07-28T01:50:50.981Z',
        collectionWindowStartUtc: '2026-07-28T01:50:50.982Z',
        collectionWindowEndUtc: '2026-07-31T01:50:50.982Z',
        minimumWindowHours: 72,
        uniqueImageCount: 79,
        minimumUniqueImageCount: 80
    });

    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, [
        'fewer-than-preregistered-unique-images'
    ]);
});

test('blind review assignments expose only anonymous assets and empty decisions', () => {
    const records = [
        {
            recordId: 'source-a',
            sourceSha256: 'a'.repeat(64),
            blindAssetPath: 'rows/B001.png',
            fileName: 'secret-a.png',
            programClassification: 'fail',
            metricValues: { primary: 9.2 }
        },
        {
            recordId: 'source-b',
            sourceSha256: 'b'.repeat(64),
            blindAssetPath: 'rows/B002.png',
            fileName: 'secret-b.png',
            programClassification: 'pass',
            metricValues: { primary: 0.1 }
        },
        {
            recordId: 'source-c',
            sourceSha256: 'c'.repeat(64),
            blindAssetPath: 'rows/B003.png',
            fileName: 'secret-c.png',
            programClassification: 'pass',
            metricValues: { primary: 0.2 }
        }
    ];

    const result = buildBlindReviewAssignments({
        records,
        reviewerIds: ['reviewer-a', 'reviewer-b'],
        seed: 'frozen-seed'
    });

    assert.equal(result.privateRecords.length, 3);
    assert.equal(result.assignments.length, 2);
    assert.notDeepEqual(
        result.assignments[0].decisions.map((item) => item.blindId),
        result.assignments[1].decisions.map((item) => item.blindId)
    );
    for (const assignment of result.assignments) {
        assert.deepEqual(Object.keys(assignment).sort(), [
            'decisions',
            'reviewerId',
            'schemaVersion'
        ]);
        for (const decision of assignment.decisions) {
            assert.deepEqual(Object.keys(decision).sort(), [
                'blindAssetPath',
                'blindId',
                'confidence',
                'contentDamage',
                'notes',
                'outputClean'
            ]);
            assert.equal(decision.outputClean, null);
            assert.equal(decision.contentDamage, null);
            assert.equal(decision.confidence, null);
            assert.equal(decision.notes, '');
        }
        const serialized = JSON.stringify(assignment);
        assert.equal(serialized.includes('secret-'), false);
        assert.equal(serialized.includes('programClassification'), false);
        assert.equal(serialized.includes('metricValues'), false);
        assert.equal(serialized.includes('sourceSha256'), false);
    }
});

test('scoring eligibility requires two independent reviews', () => {
    const baseReview = {
        frozen: true,
        decisions: [
            { blindId: 'B001', outputClean: true, contentDamage: false },
            { blindId: 'B002', outputClean: false, contentDamage: false }
        ]
    };

    assert.deepEqual(
        assessScoringEligibility({
            expectedBlindIds: ['B001', 'B002'],
            reviews: [{ reviewerId: 'reviewer-a', ...baseReview }],
            minimumIndependentReviewers: 2
        }).reasons,
        ['fewer-than-required-independent-reviewers']
    );

    const eligible = assessScoringEligibility({
        expectedBlindIds: ['B001', 'B002'],
        reviews: [
            { reviewerId: 'reviewer-a', ...baseReview },
            { reviewerId: 'reviewer-b', ...baseReview }
        ],
        minimumIndependentReviewers: 2
    });
    assert.equal(eligible.eligible, true);
    assert.deepEqual(eligible.reasons, []);
});

test('scoring eligibility rejects reviewer labels that are not frozen', () => {
    const result = assessScoringEligibility({
        expectedBlindIds: ['B001'],
        reviews: [
            {
                reviewerId: 'reviewer-a',
                frozen: false,
                decisions: [
                    {
                        blindId: 'B001',
                        outputClean: true,
                        contentDamage: false
                    }
                ]
            },
            {
                reviewerId: 'reviewer-b',
                frozen: true,
                decisions: [
                    {
                        blindId: 'B001',
                        outputClean: true,
                        contentDamage: false
                    }
                ]
            }
        ],
        minimumIndependentReviewers: 2
    });

    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, ['review-labels-not-frozen']);
});

test('scoring eligibility rejects missing or incomplete blind decisions', () => {
    const result = assessScoringEligibility({
        expectedBlindIds: ['B001', 'B002'],
        reviews: [
            {
                reviewerId: 'reviewer-a',
                frozen: true,
                decisions: [
                    {
                        blindId: 'B001',
                        outputClean: true,
                        contentDamage: false
                    }
                ]
            },
            {
                reviewerId: 'reviewer-b',
                frozen: true,
                decisions: [
                    {
                        blindId: 'B001',
                        outputClean: null,
                        contentDamage: false
                    },
                    {
                        blindId: 'B002',
                        outputClean: false,
                        contentDamage: false
                    }
                ]
            }
        ],
        minimumIndependentReviewers: 2
    });

    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, ['review-labels-incomplete']);
});

import { createHash } from 'node:crypto';

function parseUtc(value, name) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
        throw new TypeError(`${name} must be a valid UTC timestamp`);
    }
    return parsed;
}

export function assessCollectionEligibility({
    priorWindowEndUtc,
    collectionWindowStartUtc,
    collectionWindowEndUtc,
    minimumWindowHours,
    uniqueImageCount,
    minimumUniqueImageCount
}) {
    const priorEnd = parseUtc(priorWindowEndUtc, 'priorWindowEndUtc');
    const collectionStart = parseUtc(
        collectionWindowStartUtc,
        'collectionWindowStartUtc'
    );
    const collectionEnd = parseUtc(
        collectionWindowEndUtc,
        'collectionWindowEndUtc'
    );
    const collectionWindowHours =
        (collectionEnd - collectionStart) / 3_600_000;
    const reasons = [];
    if (collectionStart <= priorEnd) {
        reasons.push('collection-window-overlaps-prior-evaluation-window');
    }
    if (collectionWindowHours < minimumWindowHours) {
        reasons.push(
            'collection-window-shorter-than-preregistered-minimum'
        );
    }
    if (uniqueImageCount < minimumUniqueImageCount) {
        reasons.push('fewer-than-preregistered-unique-images');
    }
    return {
        eligible: reasons.length === 0,
        reasons,
        collectionWindowHours,
        earliestEligibleWindowEndUtc: new Date(
            priorEnd + minimumWindowHours * 3_600_000 + 1
        ).toISOString()
    };
}

function stableRank(seed, namespace, value) {
    return createHash('sha256')
        .update(`${seed}\0${namespace}\0${value}`)
        .digest('hex');
}

function rankedCopy(items, seed, namespace, identity) {
    return [...items].sort((left, right) =>
        stableRank(seed, namespace, identity(left)).localeCompare(
            stableRank(seed, namespace, identity(right))
        )
    );
}

export function buildBlindReviewAssignments({
    records,
    reviewerIds,
    seed
}) {
    const blindedRecords = rankedCopy(
        records,
        seed,
        'blind-id',
        (record) => record.recordId
    ).map((record, index) => ({
        blindId: `B${String(index + 1).padStart(3, '0')}`,
        ...record
    }));
    const privateRecords = blindedRecords.map((record) => ({ ...record }));
    const assignments = reviewerIds.map((reviewerId) => ({
        schemaVersion: 1,
        reviewerId,
        decisions: rankedCopy(
            blindedRecords,
            seed,
            `reviewer:${reviewerId}`,
            (record) => record.blindId
        ).map((record) => ({
            blindId: record.blindId,
            blindAssetPath: record.blindAssetPath,
            outputClean: null,
            contentDamage: null,
            confidence: null,
            notes: ''
        }))
    }));
    return { privateRecords, assignments };
}

export function assessScoringEligibility({
    expectedBlindIds,
    reviews,
    minimumIndependentReviewers
}) {
    const reasons = [];
    const reviewerIds = new Set(reviews.map((review) => review.reviewerId));
    if (reviewerIds.size < minimumIndependentReviewers) {
        reasons.push('fewer-than-required-independent-reviewers');
    }
    if (reviews.some((review) => review.frozen !== true)) {
        reasons.push('review-labels-not-frozen');
    }
    const expected = [...expectedBlindIds].sort();
    const incomplete = reviews.some((review) => {
        const decisions = review.decisions ?? [];
        const actual = decisions.map((decision) => decision.blindId).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) return true;
        return decisions.some(
            (decision) =>
                typeof decision.outputClean !== 'boolean' ||
                typeof decision.contentDamage !== 'boolean'
        );
    });
    if (incomplete) reasons.push('review-labels-incomplete');
    return { eligible: reasons.length === 0, reasons };
}

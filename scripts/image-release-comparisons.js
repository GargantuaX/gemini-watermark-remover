// Release comparisons preserve frozen inputs and historical observations. Quality labels are observations, not verdicts.
const DIGEST = /^[a-f0-9]{64}$/;
const VERDICTS = new Set(['current-better', 'historical-better', 'equivalent', 'unclear']);
const PROVENANCE = new Set(['verified-original', 'edited-export', 'unknown']);

export function verifyReleaseComparisons(validation = {}, inventory = {}) {
    const blockers = [];
    const observations = [];
    const fail = reason => blockers.push(reason);
    const checkInventory = (actual, expected, count, key, label) => {
        if (!Array.isArray(expected) || expected.length !== count) {
            fail(`${label}-frozen-inventory-missing`);
            return;
        }
        const expectedRows = new Map(expected.map(row => [row[key], row]));
        if (expectedRows.size !== count) fail(`${label}-frozen-inventory-invalid`);
        for (const row of actual ?? []) {
            const original = expectedRows.get(row?.[key]);
            if (!original || original.fileName !== row.fileName || original.inputSha256 !== row.inputSha256) fail(`${label}-frozen-inventory-mismatch`);
        }
    };
    const rows = validation.curated?.rows;
    checkInventory(rows, inventory.curated, 424, 'fileName', 'curated');
    if (!Array.isArray(rows) || rows.length !== 424) fail('curated-inventory-incomplete');
    const inputs = new Map();
    for (const row of rows ?? []) {
        if (!row?.fileName || inputs.has(row.fileName)) {
            fail('curated-inventory-duplicate-or-invalid');
            continue;
        }
        inputs.set(row.fileName, row);
        const frozen = inventory.curated?.find(item => item.fileName === row.fileName);
        if (!DIGEST.test(frozen?.beforeSha256 ?? '') || row.before?.sha256 !== frozen.beforeSha256) fail('curated-published-baseline-mismatch');
        if (![row.inputSha256, row.before?.sha256, row.after?.sha256].every(value => DIGEST.test(value ?? ''))) fail('curated-digest-invalid');
        if (typeof row.after?.applied !== 'boolean' || row.after?.error !== null || ![false, null].includes(row.after?.retryRecommended)) fail('curated-processing-not-verified');
    }

    // The 36 contrast cases are members of the same frozen 424-image set.
    const contrast = validation.contrast?.rows;
    checkInventory(contrast, inventory.contrast, 36, 'id', 'contrast');
    if (!Array.isArray(contrast) || contrast.length !== 36) fail('contrast-inventory-incomplete');
    const contrastIds = new Set();
    for (const row of contrast ?? []) {
        if (!row?.id || contrastIds.has(row.id)) fail('contrast-inventory-duplicate-or-invalid');
        contrastIds.add(row?.id);
        const input = inputs.get(row?.fileName);
        if (!input || input.inputSha256 !== row.inputSha256 || input.before?.sha256 !== row.beforeSha256 || input.after?.sha256 !== row.afterSha256) fail('contrast-comparison-mismatch');
    }

    // Every changed output needs an explicit review against the published
    // baseline, including edited and unknown-source inputs. Exclusion is not
    // a way to hide a newly introduced regression.
    const reviews = new Map();
    for (const review of validation.changedOutputReviews ?? []) {
        if (!review?.fileName || reviews.has(review.fileName)) fail('changed-review-duplicate-or-invalid');
        reviews.set(review?.fileName, review);
        const input = inputs.get(review?.fileName);
        if (!input || review.inputSha256 !== input.inputSha256 || review.beforeSha256 !== input.before?.sha256 || review.afterSha256 !== input.after?.sha256) fail('changed-review-stale');
        if (!['improved', 'equivalent', 'regressed', 'unclear'].includes(review?.verdict) || !review.note?.trim()) fail('changed-review-incomplete');
        if (review.verdict === 'regressed' || review.verdict === 'unclear') fail('changed-output-not-accepted');
    }
    for (const input of inputs.values()) {
        if (input.before?.sha256 !== input.after?.sha256 && !reviews.has(input.fileName)) fail('changed-output-unreviewed');
    }

    // Preserve the original 69-image historical study. Updating the release
    // baseline must not erase its unfavorable or uncertain observations.
    const historical = validation.historicalReview?.rows;
    checkInventory(historical, inventory.historical, 69, 'fileName', 'historical');
    if (!Array.isArray(historical) || historical.length !== 69) fail('historical-review-incomplete');
    const historicalNames = new Set();
    for (const row of historical ?? []) {
        if (!row?.fileName || historicalNames.has(row.fileName)) fail('historical-review-duplicate-or-invalid');
        historicalNames.add(row?.fileName);
        const input = inputs.get(row?.fileName);
        if (!input || row.inputSha256 !== input.inputSha256 || row.currentSha256 !== input.after?.sha256) fail('historical-review-current-output-mismatch');
        if (![row.historicalSha256, row.reviewedSha256].every(value => DIGEST.test(value ?? '')) || !VERDICTS.has(row.verdict)) fail('historical-review-original-evidence-incomplete');
        if (!PROVENANCE.has(row.provenance)) fail('historical-review-provenance-missing');
        if (row.provenance === 'edited-export' && !row.sourceEvidence?.trim()) fail('edited-exclusion-without-evidence');
        let verdict = row.verdict;
        if (row.reviewedSha256 !== row.currentSha256) {
            const followUp = row.currentReview;
            if (followUp?.afterSha256 !== row.currentSha256 || !VERDICTS.has(followUp?.verdict) || !followUp?.note?.trim()) fail('historical-follow-up-missing');
            verdict = followUp?.verdict;
        }
        if (verdict === 'historical-better' || verdict === 'unclear') {
            if (!row.followUp?.trim()) fail('historical-unresolved-observation-undocumented');
            if (row.provenance === 'verified-original') fail('supported-historical-regression-unresolved');
            else observations.push({ fileName: row.fileName, provenance: row.provenance, verdict, followUp: row.followUp });
        }
    }
    return { ok: blockers.length === 0, blockers: [...new Set(blockers)], observations };
}

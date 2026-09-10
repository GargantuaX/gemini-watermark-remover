import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyReleaseComparisons } from '../../scripts/image-release-comparisons.js';
import { IMAGE_RELEASE_SOURCE_PATHS, verifyImageReleaseEvidence } from '../../scripts/image-release-evidence.js';
const sha = value => createHash('sha256').update(value).digest('hex');
function evidence() {
    const rows = Array.from({ length: 424 }, (_, i) => ({
        fileName: `sample-${i}.png`, inputSha256: sha(`input-${i}`),
        before: { sha256: sha(`output-${i}`) },
        after: { sha256: sha(`output-${i}`), applied: true, error: null, retryRecommended: false }
    }));
    return {
        curated: { rows },
        contrast: { rows: rows.slice(0, 36).map((row, i) => ({ id: `contrast-${i}`, fileName: row.fileName, inputSha256: row.inputSha256, beforeSha256: row.before.sha256, afterSha256: row.after.sha256 })) },
        changedOutputReviews: [],
        historicalReview: { rows: rows.slice(0, 69).map(row => ({ fileName: row.fileName, inputSha256: row.inputSha256, historicalSha256: sha(`historical-${row.fileName}`), reviewedSha256: row.after.sha256, currentSha256: row.after.sha256, verdict: 'current-better', provenance: 'unknown' })) }
    };
}

test('accept complete unchanged comparisons without requiring a historical outcome count', () => {
    assert.deepEqual(verify(evidence()), { ok: true, blockers: [], observations: [] });
});

test('reject a missing or duplicated image even when a summary claims 424', () => {
    const value = evidence();
    value.curated.total = 424;
    value.curated.rows.pop();
    assert.ok(verify(value).blockers.includes('curated-inventory-incomplete'));
    value.curated.rows.push(value.curated.rows[0]);
    assert.ok(verify(value).blockers.includes('curated-inventory-duplicate-or-invalid'));
});

test('require a matching review for every new output and reject regressed or unclear verdicts', () => {
    const value = evidence();
    const row = value.curated.rows[100];
    row.after.sha256 = sha('changed');
    assert.ok(verify(value).blockers.includes('changed-output-unreviewed'));
    const review = { fileName: row.fileName, inputSha256: row.inputSha256, beforeSha256: row.before.sha256, afterSha256: row.after.sha256, verdict: 'improved', note: 'Visible edge residual is reduced; background line remains intact.' };
    value.changedOutputReviews.push(review);
    assert.equal(verify(value).ok, true);
    review.afterSha256 = sha('stale');
    assert.ok(verify(value).blockers.includes('changed-review-stale'));
    review.afterSha256 = row.after.sha256;
    for (const verdict of ['regressed', 'unclear']) {
        review.verdict = verdict;
        assert.ok(verify(value).blockers.includes('changed-output-not-accepted'));
    }
});

test('keep unknown historical findings visible and block confirmed supported regressions', () => {
    const value = evidence();
    const row = value.historicalReview.rows[0];
    row.verdict = 'historical-better';
    assert.ok(verify(value).blockers.includes('historical-unresolved-observation-undocumented'));
    row.followUp = 'Original download provenance is unavailable; retain for investigation, not as a passing original.';
    assert.equal(verify(value).observations.length, 1);
    assert.equal(verify(value).ok, true);
    row.provenance = 'verified-original';
    assert.ok(verify(value).blockers.includes('supported-historical-regression-unresolved'));
    row.provenance = 'edited-export';
    assert.ok(verify(value).blockers.includes('edited-exclusion-without-evidence'));
});

test('require follow-up evidence when the current output differs from the historical review', () => {
    const value = evidence();
    const row = value.historicalReview.rows[0];
    row.reviewedSha256 = sha('previously-reviewed');
    assert.ok(verify(value).blockers.includes('historical-follow-up-missing'));
    row.currentReview = { afterSha256: row.currentSha256, verdict: 'current-better', note: 'Rechecked the corrected output against the frozen historical crop.' };
    assert.equal(verify(value).ok, true);
});

test('reject stale contrast membership, malformed hashes, and unverified processing', () => {
    const value = evidence();
    value.contrast.rows[0].inputSha256 = sha('wrong-input');
    value.curated.rows[100].inputSha256 = 'bad';
    value.curated.rows[100].after.error = 'processing failed';
    const result = verify(value);
    assert.ok(result.blockers.includes('contrast-comparison-mismatch'));
    assert.ok(result.blockers.includes('curated-digest-invalid'));
    assert.ok(result.blockers.includes('curated-processing-not-verified'));
});

function inventory() {
    const source = evidence();
    return {
        curated: source.curated.rows.map(row => ({fileName:row.fileName,inputSha256:row.inputSha256,beforeSha256:row.before.sha256})),
        contrast: source.contrast.rows.map(row => ({id:row.id,fileName:row.fileName,inputSha256:row.inputSha256})),
        historical: source.historicalReview.rows.map(row => ({fileName:row.fileName,inputSha256:row.inputSha256}))
    };
}
function verify(value) { return verifyReleaseComparisons(value, inventory()); }

test('reject replacing a historical review with a different input while preserving the count', () => {
    const value = evidence();
    const input = value.curated.rows[100];
    value.historicalReview.rows[0] = {...value.historicalReview.rows[0],fileName:input.fileName,inputSha256:input.inputSha256,currentSha256:input.after.sha256,reviewedSha256:input.after.sha256};
    assert.ok(verify(value).blockers.includes('historical-frozen-inventory-mismatch'));
});

test('reject rewriting the frozen published output to hide an unreviewed change', () => {
    const value = evidence();
    value.curated.rows[100].before.sha256 = sha('rewritten-baseline');
    value.curated.rows[100].after.sha256 = sha('rewritten-baseline');
    assert.ok(verify(value).blockers.includes('curated-published-baseline-mismatch'));
});

test('schema two requires complete source, baseline, inventory, package and automated evidence', () => {
    const sourceFiles = IMAGE_RELEASE_SOURCE_PATHS.map(path => ({path,sha256:sha(path)}));
    const baseline = {version:'1.0.41',ref:'v1.0.41',commit:'a'.repeat(40),sourceFiles};
    const releasePackage = {version:'1.0.42',sha256:sha('package'),size:100};
    const value = {schemaVersion:2,releaseScope:'image-defaults',version:'1.0.42',provenance:{sourceFiles,baseline,inventorySha256:sha('inventory')},releasePackage,validation:{...evidence(),automated:{fullTest:{ok:true,passed:100,failed:0},sdkSmoke:{ok:true,passed:8,failed:0},build:{ok:true},extensionPackage:{ok:true}}}};
    const current = {version:'1.0.42',sourceHashes:new Map(sourceFiles.map(row=>[row.path,row.sha256])),baseline:{...baseline,sourceHashes:new Map(sourceFiles.map(row=>[row.path,row.sha256]))},inventory:inventory(),inventorySha256:sha('inventory'),releasePackage,outOfScopeChangedFiles:[]};
    assert.equal(verifyImageReleaseEvidence(value,current).ok,true);
    const added = structuredClone(value);
    added.provenance.sourceFiles = [...added.provenance.sourceFiles];
    added.provenance.baseline.sourceFiles = [...added.provenance.baseline.sourceFiles];
    added.provenance.sourceFiles.push({path:'src/core/newEvidence.js',sha256:sha('new source')});
    added.provenance.baseline.sourceFiles.push({path:'src/core/newEvidence.js',sha256:null});
    const withAdded = {...current,sourceHashes:new Map([...current.sourceHashes,['src/core/newEvidence.js',sha('new source')]]),baseline:{...current.baseline,sourceHashes:new Map([...current.baseline.sourceHashes,['src/core/newEvidence.js',null]])}};
    assert.equal(verifyImageReleaseEvidence(added,withAdded).ok,true);
    withAdded.baseline.sourceHashes.set('src/core/newEvidence.js',sha('existing source'));
    assert.ok(verifyImageReleaseEvidence(added,withAdded).blockers.includes('image-evidence-baseline-source-mismatch:src/core/newEvidence.js'));
    const missing = structuredClone(value);
    missing.provenance.sourceFiles=[];
    assert.equal(verifyImageReleaseEvidence(missing,current).ok,false);
    const stale = structuredClone(value);
    stale.provenance.baseline.commit='b'.repeat(40);
    stale.provenance.inventorySha256=sha('stale');
    stale.releasePackage.sha256=sha('different-package');
    stale.validation.automated.fullTest.failed=1;
    const blockers=verifyImageReleaseEvidence(stale,current).blockers;
    for(const expected of ['image-evidence-published-baseline-mismatch','image-evidence-inventory-hash-mismatch','image-evidence-package-hash-mismatch','image-evidence-fullTest-results-incomplete']) assert.ok(blockers.includes(expected));
});

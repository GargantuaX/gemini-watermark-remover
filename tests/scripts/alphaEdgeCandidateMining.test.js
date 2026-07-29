import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as candidateMining from '../../scripts/mine-alpha-edge-review-candidates.js';

test('parses phase-shifted sampling and exclusion report paths', () => {
    const parsed = candidateMining.parseArgs([
        '--stratum-phase',
        '0.125',
        '--exclude-reports',
        'first.json,second.json'
    ]);

    assert.equal(parsed.stratumPhase, 0.125);
    assert.deepEqual(parsed.excludeReportPaths, [
        path.resolve('first.json'),
        path.resolve('second.json')
    ]);
});

test('phase-shifted stratified sampling selects a different point in every stratum', () => {
    assert.equal(
        typeof candidateMining.stratifiedCandidateOrder,
        'function',
        'stratifiedCandidateOrder must be exported'
    );
    const candidates = Array.from({ length: 12 }, (_, id) => ({ id }));

    const early = candidateMining
        .stratifiedCandidateOrder(candidates, 3, 0.125)
        .slice(0, 3)
        .map(({ id }) => id);
    const middle = candidateMining
        .stratifiedCandidateOrder(candidates, 3, 0.5)
        .slice(0, 3)
        .map(({ id }) => id);
    const late = candidateMining
        .stratifiedCandidateOrder(candidates, 3, 0.875)
        .slice(0, 3)
        .map(({ id }) => id);

    assert.deepEqual(early, [0, 4, 8]);
    assert.deepEqual(middle, [2, 6, 10]);
    assert.deepEqual(late, [3, 7, 11]);
});

test('content exclusion skips reviewed hashes and backfills the requested count', async (t) => {
    assert.equal(
        typeof candidateMining.selectUniqueCandidatesByContent,
        'function',
        'selectUniqueCandidatesByContent must be exported'
    );
    const tempDir = await mkdtemp(
        path.join(os.tmpdir(), 'alpha-edge-candidate-mining-')
    );
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const contents = ['alpha', 'reviewed', 'charlie'];
    const candidates = [];
    for (const [index, content] of contents.entries()) {
        const filePath = path.join(tempDir, `${index}.txt`);
        await writeFile(filePath, content);
        candidates.push({
            fileName: `${index}.txt`,
            filePath
        });
    }
    const reviewedHash = createHash('sha256')
        .update(contents[1])
        .digest('hex');

    const selection =
        await candidateMining.selectUniqueCandidatesByContent(
            candidates,
            2,
            new Set([reviewedHash])
        );

    assert.deepEqual(
        selection.candidates.map(({ fileName }) => fileName),
        ['0.txt', '2.txt']
    );
    assert.equal(selection.audit.selectedUniqueCount, 2);
    assert.equal(selection.audit.excludedCountBeforeLimit, 1);
    assert.equal(selection.audit.excluded[0].fileName, '1.txt');
});

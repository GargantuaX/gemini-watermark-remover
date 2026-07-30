import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildExternalBenchmarkLabelTemplate,
    selectExternalBenchmarkReviewRecords
} from '../../scripts/render-strong-located-review-sheet.js';

test('all-content review selects one canonical record per hash', () => {
    const report = {
        results: [
            { fileName: 'a.png', contentSha256: 'same', paths: ['a.png', 'b.png'] },
            { fileName: 'b.png', contentSha256: 'same', paths: ['a.png', 'b.png'] },
            { fileName: 'c.png', contentSha256: 'other', paths: ['c.png'] }
        ]
    };

    assert.deepEqual(
        selectExternalBenchmarkReviewRecords(report, { allUniqueContent: true })
            .map((item) => item.fileName),
        ['a.png', 'c.png']
    );
});

test('label template expands reviewed content decisions to every path', () => {
    const template = buildExternalBenchmarkLabelTemplate([{
        sha256: 'a'.repeat(64),
        paths: ['a.png', 'b.png']
    }], 'recent-online-20260729');

    assert.equal(template.version, 1);
    assert.equal(template.datasetId, 'recent-online-20260729');
    assert.deepEqual(Object.keys(template.samples), ['a.png', 'b.png']);
    assert.equal(template.samples['a.png'].sha256, 'a'.repeat(64));
    assert.equal(template.samples['a.png'].label, null);
});

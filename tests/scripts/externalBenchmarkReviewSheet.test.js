import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

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

test('review-sheet CLI rejects unknown arguments and every missing option value during parsing', () => {
    const unknown = spawnSync(process.execPath, [
        'scripts/render-strong-located-review-sheet.js',
        '--unknown-option'
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown argument: --unknown-option/);

    for (const option of ['--report', '--out-dir', '--sample-root', '--label-template']) {
        const missing = spawnSync(process.execPath, [
            'scripts/render-strong-located-review-sheet.js',
            option
        ], { cwd: path.resolve('.'), encoding: 'utf8' });
        assert.notEqual(missing.status, 0, option);
        assert.match(missing.stderr, new RegExp(`${option} requires a value`), option);
    }
});

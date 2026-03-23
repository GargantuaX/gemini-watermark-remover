import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('development preview and userscript runtime should both use shared watermark engine entry', () => {
    const appSource = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
    const userscriptEntrySource = readFileSync(new URL('../../src/userscript/index.js', import.meta.url), 'utf8');
    const userscriptRuntimeSource = readFileSync(new URL('../../src/userscript/processingRuntime.js', import.meta.url), 'utf8');

    assert.match(
        appSource,
        /from '\.\/core\/watermarkEngine\.js'/,
        'preview app should import shared watermark engine'
    );
    assert.match(
        userscriptEntrySource,
        /from '\.\/processingRuntime\.js'/,
        'userscript entry should delegate processing to shared runtime module'
    );
    assert.match(
        userscriptRuntimeSource,
        /from '\.\.\/core\/watermarkEngine\.js'/,
        'userscript runtime should import shared watermark engine'
    );
    assert.doesNotMatch(
        appSource,
        /from '\.\/core\/watermarkProcessor\.js'/,
        'preview app should not bypass shared engine'
    );
    assert.doesNotMatch(
        userscriptRuntimeSource,
        /from '\.\.\/core\/watermarkProcessor\.js'/,
        'userscript runtime should not bypass shared engine'
    );
});

test('website worker bundle and userscript inline worker should both build from the shared worker entry', () => {
    const buildScript = readFileSync(new URL('../../build.js', import.meta.url), 'utf8');

    const workerEntryOccurrences = buildScript.match(/entryPoints:\s*\['src\/workers\/watermarkWorker\.js'\]/g) ?? [];
    assert.equal(
        workerEntryOccurrences.length,
        2,
        'build should reuse the same worker entry for the website worker bundle and userscript inline worker'
    );
});

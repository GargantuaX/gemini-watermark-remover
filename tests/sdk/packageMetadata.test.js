import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package metadata should be publish-friendly for third-party sdk consumers', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

    assert.equal(packageJson.sideEffects, false);
    assert.ok(Array.isArray(packageJson.files), 'package files whitelist should exist');
    assert.ok(packageJson.files.includes('src/core/'), 'src/core/ should be published for sdk exports');
    assert.ok(packageJson.files.includes('src/sdk/'), 'src/sdk/ should be published for sdk exports');
    assert.ok(packageJson.files.includes('README.md'), 'README.md should be published');
    assert.ok(packageJson.files.includes('README_zh.md'), 'README_zh.md should be published');
    assert.ok(packageJson.files.includes('LICENSE'), 'LICENSE should be published');
    assert.equal(packageJson.files.includes('src/assets/'), false, 'src/assets/ should not be published');
    assert.equal(packageJson.files.includes('tests/'), false, 'tests/ should not be published');
    assert.equal(packageJson.files.includes('public/'), false, 'public/ should not be published');
});

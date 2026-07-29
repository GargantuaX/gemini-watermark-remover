import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package metadata should be publish-friendly for third-party sdk consumers', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

    assert.equal(packageJson.sideEffects, false);
    assert.ok(Array.isArray(packageJson.files), 'package files whitelist should exist');
    assert.ok(packageJson.files.includes('src/core/'), 'src/core/ should be published for sdk exports');
    assert.ok(packageJson.files.includes('src/sdk/'), 'src/sdk/ should be published for sdk exports');
    assert.ok(packageJson.files.includes('src/runtime/'), 'src/runtime/ should be published for runtime exports');
    assert.ok(packageJson.files.includes('src/shared/'), 'src/shared/ should be published for runtime exports');
    assert.ok(packageJson.files.includes('src/userscript/'), 'src/userscript/ should be published for userscript runtime exports');
    assert.ok(packageJson.files.includes('README.md'), 'README.md should be published');
    assert.ok(packageJson.files.includes('README_zh.md'), 'README_zh.md should be published');
    assert.ok(packageJson.files.includes('LICENSE'), 'LICENSE should be published');
    assert.equal(packageJson.files.includes('src/page/'), false, 'src/page/ should not be published without a public entrypoint');
    assert.equal(packageJson.files.includes('src/assets/'), false, 'src/assets/ should not be published');
    assert.equal(packageJson.files.includes('tests/'), false, 'tests/ should not be published');
    assert.equal(packageJson.files.includes('public/'), false, 'public/ should not be published');
    assert.equal(packageJson.dependencies?.sharp, undefined, 'browser sdk consumers should not install sharp as a hard dependency');
    assert.equal(
        packageJson.peerDependencies?.sharp,
        '^0.34.5 || ^0.35.0',
        'sharp should support the CLI codec versions verified by consumer smoke tests'
    );
    assert.equal(packageJson.peerDependenciesMeta?.sharp?.optional, true, 'sharp peer should be optional');
});

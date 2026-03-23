import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

test('package should expose a dedicated sdk smoke script for publish validation', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

    assert.equal(typeof packageJson.scripts?.['test:sdk-smoke'], 'string');
    assert.match(packageJson.scripts['test:sdk-smoke'], /tests\/sdk\/consumerRuntime\.test\.js/);
    assert.match(packageJson.scripts['test:sdk-smoke'], /tests\/sdk\/typescriptConsumer\.test\.js/);
    assert.match(packageJson.scripts['test:sdk-smoke'], /tests\/sdk\/packagePack\.test\.js/);
});

test('ci workflow should run sdk smoke validation as an explicit step', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

    assert.match(workflow, /name:\s+SDK publish smoke/i);
    assert.match(workflow, /run:\s+pnpm test:sdk-smoke/i);
});

test('repository should ship a minimal TypeScript sdk consumer example', async () => {
    const packageJsonUrl = new URL('../../examples/sdk-consumer-ts/package.json', import.meta.url);
    const tsconfigUrl = new URL('../../examples/sdk-consumer-ts/tsconfig.json', import.meta.url);
    const consumerUrl = new URL('../../examples/sdk-consumer-ts/consumer.ts', import.meta.url);

    await access(packageJsonUrl, fsConstants.F_OK);
    await access(tsconfigUrl, fsConstants.F_OK);
    await access(consumerUrl, fsConstants.F_OK);

    const consumerSource = await readFile(consumerUrl, 'utf8');
    assert.match(consumerSource, /from 'gemini-watermark-remover'/);
    assert.match(consumerSource, /from 'gemini-watermark-remover\/node'/);
});

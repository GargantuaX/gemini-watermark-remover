import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    assessConfirmatoryCollectionRun,
    buildConfirmatoryCollectionCommand,
    createDirectNetworkEnv
} from '../../scripts/run-confirmatory-cleanliness-collection.js';

const scriptPath = fileURLToPath(
    new URL('../../scripts/run-confirmatory-cleanliness-collection.js', import.meta.url)
);
const fakeCollectorPath = fileURLToPath(
    new URL('../fixtures/fake-confirmatory-sample-collector.js', import.meta.url)
);
const testArtifactRoot = path.resolve(
    '.artifacts/test-tmp/confirmatory-cleanliness-collection'
);

test('confirmatory collection execution is blocked before the exclusive 72-hour boundary', () => {
    const result = assessConfirmatoryCollectionRun({
        nowUtc: '2026-07-31T01:50:50.981Z',
        priorWindowEndUtc: '2026-07-28T01:50:50.981Z',
        minimumWindowHours: 72,
        execute: true,
        outputDirectoryEntryCount: 0
    });

    assert.equal(result.action, 'blocked');
    assert.deepEqual(result.reasons, [
        'confirmatory-window-not-yet-eligible'
    ]);
    assert.equal(
        result.earliestEligibleWindowEndUtc,
        '2026-07-31T01:50:50.982Z'
    );
});

test('confirmatory collection stays report-only unless execution is explicit', () => {
    const result = assessConfirmatoryCollectionRun({
        nowUtc: '2026-07-31T01:50:50.982Z',
        priorWindowEndUtc: '2026-07-28T01:50:50.981Z',
        minimumWindowHours: 72,
        execute: false,
        outputDirectoryEntryCount: 0
    });

    assert.equal(result.action, 'report-only');
    assert.deepEqual(result.reasons, []);
});

test('confirmatory collection execution rejects a non-empty output directory', () => {
    const result = assessConfirmatoryCollectionRun({
        nowUtc: '2026-07-31T01:50:50.982Z',
        priorWindowEndUtc: '2026-07-28T01:50:50.981Z',
        minimumWindowHours: 72,
        execute: true,
        outputDirectoryEntryCount: 1
    });

    assert.equal(result.action, 'blocked');
    assert.deepEqual(result.reasons, ['output-directory-not-empty']);
});

test('confirmatory collection command freezes the preregistered sample shape', () => {
    const command = buildConfirmatoryCollectionCommand({
        pythonExecutable: 'python3.12',
        collectorPath: 'fixtures/fetch_recent_online_samples.py',
        outputRoot: '.artifacts/confirmatory'
    });

    assert.equal(command.executable, 'python3.12');
    assert.deepEqual(command.args, [
        'fixtures/fetch_recent_online_samples.py',
        '--since-hours',
        '72',
        '--candidate-limit',
        '5000',
        '--gemini-image-limit',
        '96',
        '--gemini-video-limit',
        '0',
        '--bad-feedback-limit-per-source',
        '0',
        '--output-root',
        '.artifacts/confirmatory'
    ]);
});

test('direct network environment removes every inherited proxy variable', () => {
    const result = createDirectNetworkEnv({
        PATH: 'test-path',
        HTTP_PROXY: 'http://proxy-a',
        HTTPS_PROXY: 'http://proxy-b',
        ALL_PROXY: 'socks5://proxy-c',
        http_proxy: 'http://proxy-d',
        https_proxy: 'http://proxy-e',
        all_proxy: 'socks5://proxy-f',
        NO_PROXY: 'localhost',
        no_proxy: 'localhost'
    });

    assert.deepEqual(result, {
        PATH: 'test-path',
        NO_PROXY: '*',
        no_proxy: '*'
    });
});

test('collection CLI defaults to report-only without creating the output directory', () => {
    mkdirSync(testArtifactRoot, { recursive: true });
    const directory = mkdtempSync(path.join(testArtifactRoot, 'report-only-'));
    const outputRoot = path.join(directory, 'samples');
    const preregistrationPath = path.join(directory, 'preregistration.json');
    writeFileSync(
        preregistrationPath,
        JSON.stringify({
            sampling: {
                windowStartExclusiveUtc: '2000-01-01T00:00:00.000Z',
                minimumWindowHours: 72
            }
        })
    );
    const result = spawnSync(
        process.execPath,
        [
            scriptPath,
            '--preregistration',
            preregistrationPath,
            '--output-root',
            outputRoot
        ],
        { encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).readiness.action, 'report-only');
    assert.equal(existsSync(outputRoot), false);
});

test('collection CLI blocks explicit execution when the output directory is non-empty', () => {
    mkdirSync(testArtifactRoot, { recursive: true });
    const directory = mkdtempSync(path.join(testArtifactRoot, 'non-empty-'));
    const outputRoot = path.join(directory, 'samples');
    const preregistrationPath = path.join(directory, 'preregistration.json');
    writeFileSync(
        preregistrationPath,
        JSON.stringify({
            sampling: {
                windowStartExclusiveUtc: '2000-01-01T00:00:00.000Z',
                minimumWindowHours: 72
            }
        })
    );
    mkdirSync(outputRoot);
    writeFileSync(path.join(outputRoot, 'existing.txt'), 'occupied\n');
    const result = spawnSync(
        process.execPath,
        [
            scriptPath,
            '--execute',
            '--preregistration',
            preregistrationPath,
            '--output-root',
            outputRoot
        ],
        { encoding: 'utf8' }
    );

    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.readiness.action, 'blocked');
    assert.equal(
        report.readiness.reasons.includes('output-directory-not-empty'),
        true
    );
});

test('collection CLI executes the frozen command with a direct network environment', () => {
    mkdirSync(testArtifactRoot, { recursive: true });
    const directory = mkdtempSync(path.join(testArtifactRoot, 'execute-'));
    const outputRoot = path.join(directory, 'samples');
    const preregistrationPath = path.join(directory, 'preregistration.json');
    writeFileSync(
        preregistrationPath,
        JSON.stringify({
            sampling: {
                windowStartExclusiveUtc: '2000-01-01T00:00:00.000Z',
                minimumWindowHours: 72
            }
        })
    );
    const result = spawnSync(
        process.execPath,
        [
            scriptPath,
            '--execute',
            '--preregistration',
            preregistrationPath,
            '--python',
            process.execPath,
            '--collector',
            fakeCollectorPath,
            '--output-root',
            outputRoot
        ],
        {
            encoding: 'utf8',
            env: {
                ...process.env,
                HTTP_PROXY: 'http://proxy-a',
                HTTPS_PROXY: 'http://proxy-b',
                ALL_PROXY: 'socks5://proxy-c',
                http_proxy: 'http://proxy-d',
                https_proxy: 'http://proxy-e',
                all_proxy: 'socks5://proxy-f'
            }
        }
    );

    assert.equal(result.status, 0, result.stderr);
    const received = JSON.parse(
        readFileSync(path.join(outputRoot, 'received.json'), 'utf8')
    );
    assert.equal(received.args.includes('--since-hours'), true);
    assert.equal(received.args.includes('72'), true);
    assert.deepEqual(received.proxyEnvironment, {
        HTTP_PROXY: null,
        HTTPS_PROXY: null,
        ALL_PROXY: null,
        http_proxy: null,
        https_proxy: null,
        all_proxy: null,
        NO_PROXY: '*',
        no_proxy: '*'
    });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as verification from '../../scripts/verify-github-issue.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'verify-github-issue.js');

test('issue verification CLI exposes a help entry point without contacting GitHub', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--help'], {
        cwd: repoRoot,
        encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pnpm issue:verify -- --issue <number>/);
    assert.match(result.stdout, /--comment/);
});

test('parseIssueVerificationArgs accepts pnpm forwarding and keeps publication opt-in', () => {
    assert.equal(typeof verification.parseIssueVerificationArgs, 'function');
    const parsed = verification.parseIssueVerificationArgs([
        '--',
        '--issue', '120',
        '--repo', 'GargantuaX/gemini-watermark-remover',
        '--baseline', '.artifacts/baseline.json'
    ]);

    assert.equal(parsed.issue, 120);
    assert.equal(parsed.repo, 'GargantuaX/gemini-watermark-remover');
    assert.equal(parsed.comment, false);
    assert.match(parsed.baseline, /\.artifacts[\\/]baseline\.json$/);
});

test('extractGithubReleaseReferences finds and decodes linked GitHub releases once', () => {
    assert.equal(typeof verification.extractGithubReleaseReferences, 'function');
    const references = verification.extractGithubReleaseReferences(`
Samples: https://github.com/esfomeado/gwr-bug-samples/releases/tag/v1
Duplicate: https://github.com/esfomeado/gwr-bug-samples/releases/tag/v1
Encoded: https://github.com/acme/assets/releases/tag/issue%2F120
    `);

    assert.deepEqual(references, [
        {
            owner: 'esfomeado',
            repo: 'gwr-bug-samples',
            tag: 'v1',
            url: 'https://github.com/esfomeado/gwr-bug-samples/releases/tag/v1'
        },
        {
            owner: 'acme',
            repo: 'assets',
            tag: 'issue/120',
            url: 'https://github.com/acme/assets/releases/tag/issue%2F120'
        }
    ]);
});

test('inspectReleaseAssets verifies cached image bytes and reports missing or mismatched assets', async () => {
    assert.equal(typeof verification.inspectReleaseAssets, 'function');
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gwr-issue-verification-'));
    try {
        const goodBytes = Buffer.from('verified-image');
        await writeFile(path.join(tempRoot, 'good.png'), goodBytes);
        await writeFile(path.join(tempRoot, 'bad.jpg'), 'wrong-bytes');
        const goodDigest = createHash('sha256').update(goodBytes).digest('hex');

        const inspected = await verification.inspectReleaseAssets([
            { name: 'good.png', digest: `sha256:${goodDigest}` },
            { name: 'bad.jpg', digest: `sha256:${'0'.repeat(64)}` },
            { name: 'missing.webp', digest: `sha256:${'1'.repeat(64)}` },
            { name: 'notes.txt', digest: `sha256:${'2'.repeat(64)}` }
        ], tempRoot);

        assert.deepEqual(inspected.map(({ name, status }) => ({ name, status })), [
            { name: 'good.png', status: 'verified' },
            { name: 'bad.jpg', status: 'mismatch' },
            { name: 'missing.webp', status: 'missing' }
        ]);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test('renderIssueVerificationComment reports evidence without claiming the issue is fixed', () => {
    assert.equal(typeof verification.renderIssueVerificationComment, 'function');
    const markdown = verification.renderIssueVerificationComment({
        issue: { number: 120, title: '[Bug] Watermark not removed', url: 'https://github.test/issues/120' },
        source: {
            kind: 'release',
            url: 'https://github.com/esfomeado/gwr-bug-samples/releases/tag/v1',
            verifiedAssetCount: 14,
            imageAssetCount: 14
        },
        report: {
            dataset: { mode: 'assumed-watermarked', contentSetSha256: 'abc123' },
            summary: {
                total: 14,
                passCount: 3,
                failCount: 11,
                excludedCount: 0,
                buckets: { pass: 3, 'residual-edge': 11 }
            },
            metrics: {
                watermarkDetectionRecall: { numerator: 14, denominator: 14, rate: 1 },
                watermarkEndToEndPassRate: { numerator: 3, denominator: 14, rate: 0.2143 }
            }
        }
    });

    assert.match(markdown, /14\/14/);
    assert.match(markdown, /3\/14/);
    assert.match(markdown, /assumed-watermarked/);
    assert.match(markdown, /不会自动关闭 issue/);
    assert.doesNotMatch(markdown, /已修复/);
    assert.ok(markdown.includes('[#120 \\[Bug\\] Watermark not removed]('));
});

test('runIssueVerification only invokes gh issue comment when --comment is explicit', async () => {
    assert.equal(typeof verification.runIssueVerification, 'function');
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gwr-issue-verification-run-'));
    await mkdir(path.join(tempRoot, 'samples'));
    const calls = [];
    const execFile = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === 'repo' && args[1] === 'view') {
            return { stdout: 'GargantuaX/gemini-watermark-remover\n', stderr: '' };
        }
        if (args[0] === 'issue' && args[1] === 'view') {
            return {
                stdout: JSON.stringify({
                    number: 120,
                    title: 'Watermark remains',
                    url: 'https://github.test/issues/120',
                    body: 'local samples are supplied',
                    state: 'OPEN'
                }),
                stderr: ''
            };
        }
        if (args[0] === 'issue' && args[1] === 'comment') {
            return { stdout: 'https://github.test/comment/1\n', stderr: '' };
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };
    const benchmarkRunner = async ({ outputPath }) => {
        await writeFile(outputPath, `${JSON.stringify({
            dataset: { mode: 'assumed-watermarked', contentSetSha256: 'content-hash' },
            summary: { total: 1, passCount: 0, failCount: 1, excludedCount: 0, buckets: { 'residual-edge': 1 } },
            metrics: {
                watermarkDetectionRecall: { numerator: 1, denominator: 1, rate: 1 },
                watermarkEndToEndPassRate: { numerator: 0, denominator: 1, rate: 0 }
            }
        }, null, 2)}\n`);
    };

    try {
        const baseOptions = {
            issue: 120,
            repo: null,
            sampleRoot: path.join(tempRoot, 'samples'),
            outputDir: path.join(tempRoot, 'output'),
            baseline: null,
            comment: false
        };
        await verification.runIssueVerification(baseOptions, { execFile, benchmarkRunner, cwd: repoRoot });
        assert.equal(calls.some(({ args }) => args[0] === 'issue' && args[1] === 'comment'), false);

        await verification.runIssueVerification({ ...baseOptions, comment: true }, {
            execFile,
            benchmarkRunner,
            cwd: repoRoot
        });
        assert.equal(calls.filter(({ args }) => args[0] === 'issue' && args[1] === 'comment').length, 1);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test('runIssueVerification safely resumes an interrupted release download', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gwr-issue-verification-resume-'));
    const imageBytes = Buffer.from('release-image');
    const digest = createHash('sha256').update(imageBytes).digest('hex');
    const execFile = async (_command, args) => {
        if (args[0] === 'issue' && args[1] === 'view') {
            return {
                stdout: JSON.stringify({
                    number: 120,
                    title: 'Interrupted download',
                    url: 'https://github.test/issues/120',
                    body: 'https://github.com/acme/samples/releases/tag/v1',
                    state: 'OPEN'
                }),
                stderr: ''
            };
        }
        if (args[0] === 'api') {
            return {
                stdout: JSON.stringify({
                    id: 1,
                    assets: [{ name: 'sample.png', digest: `sha256:${digest}` }]
                }),
                stderr: ''
            };
        }
        if (args[0] === 'release' && args[1] === 'download') {
            assert.ok(args.includes('--clobber'), 'resume must tolerate a file appearing after cache inspection');
            const destination = args[args.indexOf('--dir') + 1];
            await writeFile(path.join(destination, 'sample.png'), imageBytes);
            return { stdout: '', stderr: '' };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
    };
    const benchmarkRunner = async ({ outputPath }) => {
        await writeFile(outputPath, `${JSON.stringify({
            dataset: { mode: 'assumed-watermarked', contentSetSha256: digest },
            summary: { total: 1, passCount: 1, failCount: 0, excludedCount: 0, buckets: { pass: 1 } },
            metrics: {}
        })}\n`);
    };

    try {
        const result = await verification.runIssueVerification({
            issue: 120,
            repo: 'owner/project',
            sampleRoot: null,
            outputDir: tempRoot,
            baseline: null,
            comment: false
        }, { execFile, benchmarkRunner, cwd: repoRoot });
        assert.equal(result.source.verifiedAssetCount, 1);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
});

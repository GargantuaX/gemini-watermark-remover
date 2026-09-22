import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { resolvePublishedBaseline, EXPECTED_BASELINE_COMMIT, EXPECTED_INTEGRATION_SRC_TREE,
    verifyTrackedProductionAndManifest, verifyCoreVideoIntegrationEvidence,
    verifyReleaseArtifacts, verifyCandidateLiveCi, resolveArtifactCi } from '../../scripts/video-fix-release-evidence.js';
import { parseCliArgs } from '../../scripts/check-video-fix-release-evidence.js';
const head = 'a'.repeat(40);
const sha = text => createHash('sha256').update(text).digest('hex');
const run = { databaseId: 123, headSha: head, status: 'completed', conclusion: 'success' };
const candidateCi = { commitSha: head, ciRun: run, classification: { ok: true } };
async function temp(t) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gwr-gate-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}
test('published baseline rejects another tag or shifted commit', () => {
    const execFn = (_, args) => args[0] === 'rev-parse' ? EXPECTED_BASELINE_COMMIT : JSON.stringify({ version: '1.0.43' });
    assert.equal(resolvePublishedBaseline({ execFn }).ok, true);
    assert.equal(resolvePublishedBaseline({ baseTag: 'v1.0.44', execFn }).ok, false);
    assert.equal(resolvePublishedBaseline({ execFn: () => head }).ok, false);
});
test('manifest checks actual working-tree package and rejects source tree drift', async t => {
    const cwd = await temp(t);
    const base = { version: '1.0.43', scripts: { build: 'node build.js' }, exports: './src/sdk/index.js' };
    const current = { ...base, version: '1.0.44' };
    let sourceTree = EXPECTED_INTEGRATION_SRC_TREE;
    const git = (_, args) => {
        if (args[0] === 'rev-parse') return args[1] === 'HEAD:src' ? sourceTree : EXPECTED_BASELINE_COMMIT;
        if (args[0] === 'diff') return 'src/video/videoWatermarkDetector.js\n';
        if (args[0] === 'status') return '';
        if (args[0] === 'show') return JSON.stringify(args[1] === 'HEAD:package.json' ? current : base);
        throw new Error('Unexpected Git command');
    };
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify(current));
    assert.equal(verifyTrackedProductionAndManifest({ cwd, execFn: git }).ok, true);
    sourceTree = head;
    assert.equal(verifyTrackedProductionAndManifest({ cwd, execFn: git }).ok, false);
    sourceTree = EXPECTED_INTEGRATION_SRC_TREE;
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ ...current, exports: './other.js' }));
    assert.ok(verifyTrackedProductionAndManifest({ cwd, execFn: git }).blockers.includes('video-fix-package-field-drift:exports'));
});
test('CI requires actual HEAD, returned run, and clean build/workflow inputs', async () => {
    const git = status => (_, args) => args[0] === 'rev-parse' ? head : status;
    const success = async () => ({ classification: { ok: true }, run });
    assert.equal((await verifyCandidateLiveCi({ execFn: git(''), checkGithubCiFn: success })).ok, true);
    for (const result of [null, { classification: { ok: true }, run: { ...run, headSha: 'b'.repeat(40) } }, { classification: { ok: false }, run }]) {
        assert.equal((await verifyCandidateLiveCi({ execFn: git(''), checkGithubCiFn: async () => result })).ok, false);
    }
    for (const file of ['build.js', '.github/workflows/ci.yml', 'package.json', 'src/core/a.js']) {
        assert.equal((await verifyCandidateLiveCi({ execFn: git(` M ${file}\n`), checkGithubCiFn: success })).ok, false);
    }
});
test('nonempty replacement TGZ and jointly forged ZIP metadata fail CI artifact comparison', async t => {
    const cwd = await temp(t);
    const filename = 'gemini-watermark-remover-extension-v1.0.44.zip';
    const tgzName = 'pilio-gemini-watermark-remover-1.0.44.tgz';
    const metadata = { version: '1.0.44', file: filename, sha256: sha('trusted zip'), size: 11 };
    async function writeZip(root, content, meta) {
        await mkdir(path.join(root, 'release'), { recursive: true });
        await writeFile(path.join(root, 'release', filename), content);
        await writeFile(path.join(root, 'release', filename + '.sha256.txt'), meta.sha256 + '  ' + filename);
        await writeFile(path.join(root, 'release/latest-extension.json'), JSON.stringify(meta));
    }
    await writeZip(cwd, 'trusted zip', metadata);
    const tgzPath = path.join(cwd, tgzName);
    await writeFile(tgzPath, 'trusted tgz');
    const downloadArtifact = async (id, dir) => {
        assert.equal(id, run.databaseId);
        await writeZip(dir, 'trusted zip', metadata);
        await mkdir(path.join(dir, '.artifacts/release-candidate'), { recursive: true });
        await writeFile(path.join(dir, '.artifacts/release-candidate', tgzName), 'trusted tgz');
    };
    const args = { cwd, tgzPath, candidateCi, downloadArtifact };
    assert.equal((await verifyReleaseArtifacts(args)).ok, true);
    await writeFile(tgzPath, 'arbitrary nonempty file');
    assert.ok((await verifyReleaseArtifacts(args)).blockers.includes('video-fix-tgz-not-current-ci-artifact'));
    await writeFile(tgzPath, 'trusted tgz');
    await writeZip(cwd, 'forged zip', { ...metadata, sha256: sha('forged zip'), size: 10 });
    assert.ok((await verifyReleaseArtifacts(args)).blockers.includes('video-fix-extension-not-current-ci-artifact'));
    assert.equal((await verifyReleaseArtifacts({ ...args, candidateCi: null })).ok, false);
    assert.equal((await verifyReleaseArtifacts({ ...args, downloadArtifact: async () => {} })).ok, false);
});
test('missing and fabricated core reviews fail without local sample dependencies', async t => {
    const integrationDir = await temp(t);
    assert.equal((await verifyCoreVideoIntegrationEvidence({ integrationDir })).ok, false);
    await writeFile(path.join(integrationDir, 'reviewer-verification.json'), '[]');
    await writeFile(path.join(integrationDir, 'report.md'), 'Everything passed');
    await writeFile(path.join(integrationDir, 'ordinary-browser-results.json'), '{}');
    const result = await verifyCoreVideoIntegrationEvidence({ integrationDir });
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some(b => b.startsWith('video-fix-reviewer-verification-hash-tampered')));
});
test('CLI rejects failure bypasses and unknown or incomplete arguments', () => {
    assert.throws(() => parseCliArgs(['--no-fail-closed']), /Unknown argument/);
    assert.throws(() => parseCliArgs(['--candidate-sha', head]), /Unknown argument/);
    assert.throws(() => parseCliArgs(['--tgz-path']), /Missing value/);
});

test('recorded build reuse requires identical inputs and verified CI run identity', async t => {
    const cwd = await temp(t);
    await mkdir(path.join(cwd, 'release/evidence'), { recursive: true });
    await writeFile(path.join(cwd, 'release/evidence/v1.0.44-video-build.json'), JSON.stringify({ commit: head, runId: 123 }));
    const args = { cwd, candidateCi, execFn: () => '', checkGithubCiFn: async () => ({ classification: { ok: true }, run }) };
    assert.equal((await resolveArtifactCi(args)).ciRun.databaseId, 123);
    await assert.rejects(resolveArtifactCi({ ...args, execFn: () => 'src/core/a.js' }), /inputs differ/);
    await assert.rejects(resolveArtifactCi({ ...args, checkGithubCiFn: async () => ({ classification: { ok: true }, run: { ...run, databaseId: 456 } }) }), /not verified/);
    await assert.rejects(resolveArtifactCi({ ...args, checkGithubCiFn: async () => null }), /not verified/);
});

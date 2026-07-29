import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, cwd) {
    return spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        shell: false
    });
}

function runPnpm(args, cwd) {
    if (process.platform === 'win32') {
        return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm', ...args], cwd);
    }
    return run('pnpm', args, cwd);
}

function assertCommandSucceeded(result, label) {
    assert.equal(
        result.status,
        0,
        `${label} failed\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`
    );
}

test('release-triggered npm publish command should work from a detached tag checkout', async (t) => {
    const workflow = await readFile(
        new URL('../../.github/workflows/publish-npm.yml', import.meta.url),
        'utf8'
    );
    const publishStep = workflow.match(
        /run:\s+pnpm publish "\.\/\$\{\{\s*steps\.release\.outputs\.tarball\s*\}\}" --access public(?<extraArgs>[^\r\n]*)/
    );
    assert.ok(publishStep, 'publish workflow should expose the expected tarball publish command');

    const workspace = await mkdtemp(path.join(tmpdir(), 'gwr-detached-publish-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));

    await writeFile(
        path.join(workspace, 'package.json'),
        JSON.stringify({ name: 'gwr-detached-publish-smoke', version: '0.0.0', files: ['index.js'] })
    );
    await writeFile(path.join(workspace, 'index.js'), 'export {};\n');

    const setupGitCommands = [
        ['init', '-b', 'main'],
        ['config', 'user.email', 'release-test@example.invalid'],
        ['config', 'user.name', 'Release Test']
    ];
    for (const args of setupGitCommands) {
        assertCommandSucceeded(run('git', args, workspace), `git ${args.join(' ')}`);
    }

    const pack = runPnpm(['pack', '--pack-destination', workspace], workspace);
    assertCommandSucceeded(pack, 'pnpm pack');

    const tarball = path.join(workspace, 'gwr-detached-publish-smoke-0.0.0.tgz');
    const commitGitCommands = [
        ['add', 'package.json', 'index.js', path.basename(tarball)],
        ['commit', '-m', 'fixture'],
        ['checkout', '--detach', 'HEAD']
    ];
    for (const args of commitGitCommands) {
        assertCommandSucceeded(run('git', args, workspace), `git ${args.join(' ')}`);
    }

    const extraArgs = publishStep.groups.extraArgs.trim().split(/\s+/).filter(Boolean);
    const publish = runPnpm(
        ['publish', tarball, '--access', 'public', '--dry-run', ...extraArgs],
        workspace
    );

    assertCommandSucceeded(publish, 'detached pnpm publish --dry-run');
});

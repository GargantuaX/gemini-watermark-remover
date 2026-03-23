import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';

const ROOT_DIR = process.cwd();
const WINDOWS_SHELL = process.env.ComSpec || 'cmd.exe';

export function runCommand(command, args, cwd = ROOT_DIR) {
    const result = spawnSync(
        process.platform === 'win32' && command === 'pnpm' ? WINDOWS_SHELL : command,
        process.platform === 'win32' && command === 'pnpm'
            ? ['/d', '/s', '/c', command, ...args]
            : args,
        {
            cwd,
            encoding: 'utf8'
        }
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const details = [result.stdout, result.stderr]
            .filter(Boolean)
            .join('\n')
            .trim();
        throw new Error(details || `${command} failed`);
    }

    return result;
}

export async function packProjectTarball(destinationDir, cwd = ROOT_DIR) {
    runCommand('pnpm', ['pack', '--pack-destination', destinationDir], cwd);
    const packedFiles = await readdir(destinationDir);

    if (packedFiles.length !== 1) {
        throw new Error(`expected exactly one tarball, got ${packedFiles.join(', ')}`);
    }

    return path.join(destinationDir, packedFiles[0]);
}

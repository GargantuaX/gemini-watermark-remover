import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_OUTPUT = path.resolve('.artifacts/release-image-quality/automated-results.json');
export const IMAGE_RELEASE_VALIDATION_COMMANDS = Object.freeze([
    { id: 'fullTest', args: ['test:serial'], parseNodeTests: true },
    { id: 'sdkSmoke', args: ['test:sdk-smoke'], parseNodeTests: true },
    { id: 'build', args: ['build'] },
    { id: 'extensionPackage', args: ['package:extension'] }
]);

function readCount(text, label) {
    const match = String(text).match(new RegExp(`(?:#|ℹ)\\s*${label}\\s+(\\d+)`, 'i'));
    return match ? Number(match[1]) : null;
}

export function parseNodeTestSummary(text) {
    const summary = {
        total: readCount(text, 'tests'),
        passed: readCount(text, 'pass'),
        failed: readCount(text, 'fail'),
        skipped: readCount(text, 'skipped')
    };
    if (Object.values(summary).some((value) => !Number.isInteger(value))) {
        throw new Error('Unable to parse Node test summary');
    }
    return summary;
}

export function resolvePnpmInvocation(platform = process.platform, comSpec = process.env.ComSpec) {
    if (platform === 'win32') {
        return {
            command: comSpec || 'cmd.exe',
            prefixArgs: ['/d', '/s', '/c', 'pnpm']
        };
    }
    return { command: 'pnpm', prefixArgs: [] };
}

export async function runImageReleaseValidation({ outputPath = DEFAULT_OUTPUT } = {}) {
    const report = { generatedAt: new Date().toISOString() };

    for (const entry of IMAGE_RELEASE_VALIDATION_COMMANDS) {
        const invocation = resolvePnpmInvocation();
        const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...entry.args], {
            cwd: process.cwd(),
            encoding: 'utf8',
            shell: false,
            maxBuffer: 64 * 1024 * 1024
        });
        if (result.error) {
            throw result.error;
        }
        const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        report[entry.id] = {
            ok: result.status === 0,
            ...(entry.parseNodeTests ? parseNodeTestSummary(combined) : {})
        };
        if (result.status !== 0) {
            await mkdir(path.dirname(outputPath), { recursive: true });
            await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
            throw new Error(`${entry.id} failed with exit code ${result.status}`);
        }
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const outputIndex = process.argv.indexOf('--output');
    const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : DEFAULT_OUTPUT;
    runImageReleaseValidation({ outputPath }).then(() => {
        console.log(`image release validation: ${outputPath}`);
    }).catch((error) => {
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}

export { DEFAULT_OUTPUT };

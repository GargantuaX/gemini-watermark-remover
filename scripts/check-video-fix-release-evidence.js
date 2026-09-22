import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { checkVideoFixReleaseEvidence } from './video-fix-release-evidence.js';

export function parseCliArgs(argv) {
    const parsed = {
        reportPath: path.resolve('.artifacts/video-fix-gate-report.md'),
        quiet: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--base-tag') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('Missing value for --base-tag');
            }
            parsed.baseTag = argv[++i];
        } else if (arg === '--report') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('Missing value for --report');
            }
            parsed.reportPath = path.resolve(argv[++i]);
        } else if (arg === '--integration-dir') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('Missing value for --integration-dir');
            }
            parsed.integrationDir = path.resolve(argv[++i]);
        } else if (arg === '--tgz-path') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('Missing value for --tgz-path');
            }
            parsed.tgzPath = path.resolve(argv[++i]);
        } else if (arg === '--latest-extension') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('Missing value for --latest-extension');
            }
            parsed.latestExtensionPath = path.resolve(argv[++i]);
        } else if (arg === '--quiet') {
            parsed.quiet = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return parsed;
}

export async function runCheckVideoFixReleaseEvidence(options = {}) {
    const result = await checkVideoFixReleaseEvidence(options);

    if (options.reportPath) {
        await mkdir(path.dirname(options.reportPath), { recursive: true });
        await writeFile(options.reportPath, result.markdownReport, 'utf8');
    }

    if (!options.quiet) {
        console.log(`Video-fix release quality gate: ${result.ok ? 'PASS' : 'FAIL / BLOCKED'}`);
        if (options.reportPath) {
            console.log(`Report written to: ${options.reportPath}`);
        }
        if (result.blockers.length > 0) {
            console.log('Remaining gate blockers:');
            for (const blocker of result.blockers) {
                console.error(`  - ${blocker}`);
            }
        }
    }

    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    let args;
    try {
        args = parseCliArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`CLI argument error: ${error.message}`);
        process.exit(1);
    }

    const result = await runCheckVideoFixReleaseEvidence(args);
    if (!result.ok) {
        process.exitCode = 1;
    }
}

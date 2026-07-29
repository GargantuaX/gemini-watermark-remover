import { spawnSync } from 'node:child_process';
import {
    existsSync,
    readFileSync,
    readdirSync,
    statSync
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROXY_ENV_KEYS = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy'
];

export function assessConfirmatoryCollectionRun({
    nowUtc,
    priorWindowEndUtc,
    minimumWindowHours,
    execute,
    outputDirectoryEntryCount
}) {
    const earliestEligibleWindowEnd =
        Date.parse(priorWindowEndUtc) +
        minimumWindowHours * 3_600_000 +
        1;
    const reasons = [];
    if (Date.parse(nowUtc) < earliestEligibleWindowEnd) {
        reasons.push('confirmatory-window-not-yet-eligible');
    }
    if (outputDirectoryEntryCount > 0) {
        reasons.push('output-directory-not-empty');
    }
    return {
        action: execute
            ? reasons.length === 0
                ? 'execute'
                : 'blocked'
            : 'report-only',
        reasons,
        earliestEligibleWindowEndUtc: new Date(
            earliestEligibleWindowEnd
        ).toISOString()
    };
}

export function buildConfirmatoryCollectionCommand({
    pythonExecutable,
    collectorPath,
    outputRoot
}) {
    return {
        executable: pythonExecutable,
        args: [
            collectorPath,
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
            outputRoot
        ]
    };
}

export function createDirectNetworkEnv(environment) {
    const result = { ...environment };
    for (const key of PROXY_ENV_KEYS) delete result[key];
    result.NO_PROXY = '*';
    result.no_proxy = '*';
    return result;
}

function parseArgs(argv) {
    const parsed = {
        execute: false,
        preregistrationPath: path.resolve(
            '.artifacts/prospective-online-samples-20260728-evaluation/next-time-slice-preregistration.json'
        ),
        collectorPath:
            'D:\\Project\\sample-files\\scripts\\fetch_recent_online_samples.py',
        pythonExecutable: 'python',
        outputRoot: path.resolve(
            '.artifacts/prospective-online-samples-confirmatory-after-20260728T015050Z'
        )
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--execute') {
            parsed.execute = true;
        } else if (arg === '--preregistration') {
            parsed.preregistrationPath = path.resolve(args.shift());
        } else if (arg === '--collector') {
            parsed.collectorPath = path.resolve(args.shift());
        } else if (arg === '--python') {
            parsed.pythonExecutable = args.shift();
        } else if (arg === '--output-root') {
            parsed.outputRoot = path.resolve(args.shift());
        }
    }
    return parsed;
}

function getOutputDirectoryEntryCount(outputRoot) {
    if (!existsSync(outputRoot)) return 0;
    if (!statSync(outputRoot).isDirectory()) return 1;
    return readdirSync(outputRoot).length;
}

export function runConfirmatoryCollectionCli(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const preregistration = JSON.parse(
        readFileSync(options.preregistrationPath, 'utf8')
    );
    const readiness = assessConfirmatoryCollectionRun({
        nowUtc: new Date().toISOString(),
        priorWindowEndUtc:
            preregistration.sampling.windowStartExclusiveUtc,
        minimumWindowHours: preregistration.sampling.minimumWindowHours,
        execute: options.execute,
        outputDirectoryEntryCount: getOutputDirectoryEntryCount(
            options.outputRoot
        )
    });
    const command = buildConfirmatoryCollectionCommand({
        pythonExecutable: options.pythonExecutable,
        collectorPath: options.collectorPath,
        outputRoot: options.outputRoot
    });
    console.log(
        JSON.stringify(
            {
                readiness,
                preregistrationPath: options.preregistrationPath,
                outputRoot: options.outputRoot,
                command
            },
            null,
            2
        )
    );
    if (readiness.action === 'report-only') return 0;
    if (readiness.action === 'blocked') return 2;
    const child = spawnSync(command.executable, command.args, {
        cwd: process.cwd(),
        env: createDirectNetworkEnv(process.env),
        stdio: 'inherit'
    });
    if (child.error) throw child.error;
    return child.status ?? 1;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    try {
        process.exitCode = runConfirmatoryCollectionCli();
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}

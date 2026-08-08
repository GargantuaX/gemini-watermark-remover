#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);
const IMAGE_ASSET_PATTERN = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const BENCHMARK_SCRIPT = 'scripts/run-external-gemini-watermark-sample-benchmark.js';

export const HELP_TEXT = `Usage:
  pnpm issue:verify -- --issue <number> [options]

Options:
  --repo <owner/repo>       GitHub repository (defaults to current repository)
  --sample-root <path>      Reuse a local sample directory instead of release assets
  --output-dir <path>       Override the artifact directory
  --baseline <path>         Compare with an existing benchmark report
  --comment                 Publish the generated comment draft to the issue
  --help                    Show this help
`;

function readOptionValue(args, index, option) {
    const value = args[index + 1];
    if (!value || value === '--' || value.startsWith('--')) {
        throw new Error(`${option} requires a value`);
    }
    return value;
}

export function parseIssueVerificationArgs(argv = process.argv.slice(2)) {
    const parsed = {
        issue: null,
        repo: null,
        sampleRoot: null,
        outputDir: null,
        baseline: null,
        comment: false,
        help: false
    };
    const args = argv.filter((arg) => arg !== '--');

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else if (arg === '--comment') {
            parsed.comment = true;
        } else if (arg === '--issue') {
            const value = readOptionValue(args, index, arg);
            parsed.issue = Number(value);
            index += 1;
        } else if (arg === '--repo') {
            parsed.repo = readOptionValue(args, index, arg);
            index += 1;
        } else if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(readOptionValue(args, index, arg));
            index += 1;
        } else if (arg === '--output-dir') {
            parsed.outputDir = path.resolve(readOptionValue(args, index, arg));
            index += 1;
        } else if (arg === '--baseline') {
            parsed.baseline = path.resolve(readOptionValue(args, index, arg));
            index += 1;
        } else {
            throw new Error(`unknown option: ${arg}`);
        }
    }

    if (!parsed.help && (!Number.isInteger(parsed.issue) || parsed.issue <= 0)) {
        throw new Error('--issue must be a positive integer');
    }
    if (parsed.repo && !/^[^/\s]+\/[^/\s]+$/.test(parsed.repo)) {
        throw new Error('--repo must use owner/repo format');
    }
    return parsed;
}

export function extractGithubReleaseReferences(body = '') {
    const pattern = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/tag\/([^\s)<>'"]+)/gi;
    const references = [];
    const seen = new Set();
    for (const match of body.matchAll(pattern)) {
        const url = match[0].replace(/[.,;:!?]+$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        const parsed = new URL(url);
        const [, owner, repo, , , encodedTag] = parsed.pathname.split('/');
        references.push({
            owner,
            repo,
            tag: decodeURIComponent(encodedTag),
            url
        });
    }
    return references;
}

async function fileExists(filePath) {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function sha256File(filePath) {
    const bytes = await readFile(filePath);
    return createHash('sha256').update(bytes).digest('hex');
}

function expectedSha256(digest) {
    const match = /^sha256:([a-f0-9]{64})$/i.exec(digest ?? '');
    return match ? match[1].toLowerCase() : null;
}

function validateAssetName(name) {
    if (!name || path.basename(name) !== name || name === '.' || name === '..') {
        throw new Error(`unsafe release asset name: ${name}`);
    }
}

export async function inspectReleaseAssets(assets, sampleRoot) {
    const imageAssets = assets.filter(({ name }) => IMAGE_ASSET_PATTERN.test(name ?? ''));
    const results = [];
    for (const asset of imageAssets) {
        validateAssetName(asset.name);
        const filePath = path.join(sampleRoot, asset.name);
        const expectedDigest = expectedSha256(asset.digest);
        if (!await fileExists(filePath)) {
            results.push({ ...asset, filePath, expectedDigest, actualDigest: null, status: 'missing' });
            continue;
        }
        const actualDigest = await sha256File(filePath);
        const status = expectedDigest === null
            ? 'unverified'
            : actualDigest === expectedDigest ? 'verified' : 'mismatch';
        results.push({ ...asset, filePath, expectedDigest, actualDigest, status });
    }
    return results;
}

async function resolveCurrentRepo(execFile) {
    const { stdout } = await execFile('gh', [
        'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'
    ], { encoding: 'utf8' });
    return stdout.trim();
}

async function fetchIssue(execFile, repo, issueNumber) {
    const { stdout } = await execFile('gh', [
        'issue', 'view', String(issueNumber), '--repo', repo,
        '--json', 'number,title,url,body,state'
    ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout);
}

async function fetchRelease(execFile, reference) {
    const endpoint = `repos/${reference.owner}/${reference.repo}/releases/tags/${encodeURIComponent(reference.tag)}`;
    const { stdout } = await execFile('gh', ['api', endpoint], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
    });
    return JSON.parse(stdout);
}

async function prepareReleaseSamples({ execFile, reference, sampleRoot }) {
    const release = await fetchRelease(execFile, reference);
    const assets = (release.assets ?? []).filter(({ name }) => IMAGE_ASSET_PATTERN.test(name ?? ''));
    if (assets.length === 0) {
        throw new Error(`release has no supported image assets: ${reference.url}`);
    }
    await mkdir(sampleRoot, { recursive: true });

    let inspection = await inspectReleaseAssets(assets, sampleRoot);
    for (const asset of inspection.filter(({ status }) => status === 'missing' || status === 'mismatch')) {
        if (asset.status === 'mismatch') {
            await rm(asset.filePath, { force: true });
        }
        await execFile('gh', [
            'release', 'download', reference.tag,
            '--repo', `${reference.owner}/${reference.repo}`,
            '--pattern', asset.name,
            '--dir', sampleRoot,
            '--clobber'
        ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    }

    inspection = await inspectReleaseAssets(assets, sampleRoot);
    const invalid = inspection.filter(({ status }) => status === 'missing' || status === 'mismatch');
    if (invalid.length > 0) {
        throw new Error(`release asset verification failed: ${invalid.map(({ name, status }) => `${name}=${status}`).join(', ')}`);
    }
    return { release, assets: inspection };
}

function formatRatio(metric) {
    if (!metric) return 'n/a';
    return `${metric.numerator ?? 0}/${metric.denominator ?? 0}`;
}

function escapeMarkdownLinkText(value) {
    return String(value ?? '').replace(/([\\\[\]])/g, '\\$1');
}

export function renderIssueVerificationComment({ issue, source, report }) {
    const summary = report.summary ?? {};
    const metrics = report.metrics ?? {};
    const bucketSummary = Object.entries(summary.buckets ?? {})
        .map(([name, count]) => `${name}=${count}`)
        .join(', ') || 'none';
    const sourceLine = source.kind === 'release'
        ? `[GitHub Release](${source.url})（SHA-256 已核验 ${source.verifiedAssetCount}/${source.imageAssetCount} 个图片资源）`
        : `本地样本目录（未进行 GitHub Release 摘要核验）`;

    return `## 自动复核结果

- Issue: [#${issue.number} ${escapeMarkdownLinkText(issue.title)}](${issue.url})
- 样本来源: ${sourceLine}
- 数据集模式: \`${report.dataset?.mode ?? 'unknown'}\`
- 内容集合 SHA-256: \`${report.dataset?.contentSetSha256 ?? 'unknown'}\`
- 检测覆盖: ${formatRatio(metrics.watermarkDetectionRecall)}
- 端到端通过: ${formatRatio(metrics.watermarkEndToEndPassRate)}
- 基准汇总: pass=${summary.passCount ?? 0}, fail=${summary.failCount ?? 0}, excluded=${summary.excludedCount ?? 0}, total=${summary.total ?? 0}
- 失败分类: ${bucketSummary}

这是可复现的自动化证据；\`assumed-watermarked\` 数据不等同于人工标注的发布门禁。该命令不会自动关闭 issue，仍需结合可视化审查判断后续状态。
`;
}

async function runExternalBenchmark({ execFile, cwd, sampleRoot, outputPath, markdownPath, resultsCsvPath, failuresCsvPath, baseline }) {
    const args = [
        BENCHMARK_SCRIPT,
        '--sample-root', sampleRoot,
        '--output', outputPath,
        '--markdown', markdownPath,
        '--results-csv', resultsCsvPath,
        '--failures-csv', failuresCsvPath,
        '--assume-watermarked'
    ];
    if (baseline) args.push('--baseline', baseline);
    await execFile(process.execPath, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024
    });
}

function defaultOutputDir(cwd, repo, issueNumber) {
    const safeRepo = repo.replace(/[^a-z0-9._-]+/gi, '-');
    return path.join(cwd, '.artifacts', 'github-issues', `${safeRepo}-issue-${issueNumber}`);
}

export async function runIssueVerification(options, dependencies = {}) {
    const execFile = dependencies.execFile ?? execFileAsync;
    const benchmarkRunner = dependencies.benchmarkRunner ?? runExternalBenchmark;
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());
    const repo = options.repo ?? await resolveCurrentRepo(execFile);
    const issue = await fetchIssue(execFile, repo, options.issue);
    const outputDir = path.resolve(options.outputDir ?? defaultOutputDir(cwd, repo, issue.number));
    await mkdir(outputDir, { recursive: true });

    let sampleRoot;
    let source;
    if (options.sampleRoot) {
        sampleRoot = path.resolve(options.sampleRoot);
        source = { kind: 'local', sampleRoot };
    } else {
        const references = extractGithubReleaseReferences(issue.body);
        if (references.length === 0) {
            throw new Error('issue body has no GitHub Release link; pass --sample-root explicitly');
        }
        const reference = references[0];
        sampleRoot = path.join(outputDir, 'samples', `${reference.owner}-${reference.repo}-${reference.tag.replace(/[^a-z0-9._-]+/gi, '-')}`);
        const prepared = await prepareReleaseSamples({ execFile, reference, sampleRoot });
        source = {
            kind: 'release',
            url: reference.url,
            owner: reference.owner,
            repo: reference.repo,
            tag: reference.tag,
            releaseId: prepared.release.id ?? null,
            imageAssetCount: prepared.assets.length,
            verifiedAssetCount: prepared.assets.filter(({ status }) => status === 'verified').length,
            unverifiedAssetCount: prepared.assets.filter(({ status }) => status === 'unverified').length,
            assets: prepared.assets.map(({ name, expectedDigest, actualDigest, status }) => ({
                name,
                expectedDigest,
                actualDigest,
                status
            }))
        };
    }

    const outputPath = path.join(outputDir, 'benchmark-report.json');
    const markdownPath = path.join(outputDir, 'benchmark-report.md');
    const resultsCsvPath = path.join(outputDir, 'benchmark-results.csv');
    const failuresCsvPath = path.join(outputDir, 'benchmark-failures.csv');
    await benchmarkRunner({
        execFile,
        cwd,
        sampleRoot,
        outputPath,
        markdownPath,
        resultsCsvPath,
        failuresCsvPath,
        baseline: options.baseline
    });

    const report = JSON.parse(await readFile(outputPath, 'utf8'));
    const commentMarkdown = renderIssueVerificationComment({ issue, source, report });
    const commentPath = path.join(outputDir, 'comment.md');
    await writeFile(commentPath, commentMarkdown, 'utf8');

    const result = {
        generatedAt: new Date().toISOString(),
        repo,
        issue,
        source,
        sampleRoot,
        outputDir,
        artifacts: {
            report: outputPath,
            markdown: markdownPath,
            resultsCsv: resultsCsvPath,
            failuresCsv: failuresCsvPath,
            comment: commentPath
        },
        summary: report.summary,
        metrics: report.metrics,
        commentPublished: false,
        commentUrl: null
    };

    if (options.comment) {
        const { stdout } = await execFile('gh', [
            'issue', 'comment', String(issue.number), '--repo', repo, '--body-file', commentPath
        ], { encoding: 'utf8' });
        result.commentPublished = true;
        result.commentUrl = stdout.trim() || null;
    }

    const manifestPath = path.join(outputDir, 'latest.json');
    result.artifacts.manifest = manifestPath;
    await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
}

async function main() {
    const options = parseIssueVerificationArgs();
    if (options.help) {
        process.stdout.write(HELP_TEXT);
        return;
    }
    const result = await runIssueVerification(options);
    const summary = result.summary ?? {};
    process.stdout.write(`issue: ${result.repo}#${result.issue.number}\n`);
    process.stdout.write(`summary: pass=${summary.passCount ?? 0} fail=${summary.failCount ?? 0} total=${summary.total ?? 0}\n`);
    process.stdout.write(`artifacts: ${result.outputDir}\n`);
    process.stdout.write(result.commentPublished
        ? `comment: ${result.commentUrl ?? 'published'}\n`
        : `comment draft: ${result.artifacts.comment}\n`);
}

const isDirectRun = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
    main().catch((error) => {
        console.error(error?.stack ?? error);
        process.exitCode = 1;
    });
}

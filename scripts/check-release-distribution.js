import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/release-distribution/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/release-distribution/latest-report.md');

const DEFAULTS = Object.freeze({
  packageJson: 'package.json',
  repo: 'GargantuaX/gemini-watermark-remover',
  npmPackage: '@pilio/gemini-watermark-remover',
  siteBaseUrl: 'https://geminiwatermarkremover.io',
  chromeExtensionId: 'cjlmnfcfnofnglkphbcdclbpimdjkmdf'
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

async function fetchText(url, init = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        'user-agent': 'gemini-watermark-remover-release-distribution-check',
        ...(init.headers || {})
      }
    });
    const text = await response.text();
    return {
      url,
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      error: null
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      headers: {},
      text: '',
      error: error?.cause?.message || error?.message || String(error)
    };
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetchText(url, init);
  let json = null;
  try {
    json = JSON.parse(response.text);
  } catch {
    json = null;
  }
  return {
    ...response,
    json
  };
}

async function fetchTextWithPowerShellFallback(url, init = {}) {
  const primary = await fetchText(url, init);
  if (primary.ok || process.platform !== 'win32') {
    return {
      ...primary,
      transport: 'fetch'
    };
  }

  try {
    const { stdout } = await execFileAsync('curl.exe', [
      '-L',
      '--max-time',
      '30',
      '--silent',
      '--show-error',
      url
    ], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    return {
      url,
      ok: true,
      status: 200,
      headers: {},
      text: stdout,
      error: primary.error ? `fetch failed: ${primary.error}` : null,
      transport: 'curl'
    };
  } catch (curlError) {
    primary.error = [
      primary.error ? `fetch failed: ${primary.error}` : null,
      `curl fallback failed: ${curlError?.message || String(curlError)}`
    ].filter(Boolean).join('; ');
  }

  try {
    const command = [
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8;',
      '$ErrorActionPreference = "Stop";',
      '$r = Invoke-WebRequest -UseBasicParsing -Uri $env:GWR_RELEASE_CHECK_URL;',
      '@{ status = $r.StatusCode; content = $r.Content } | ConvertTo-Json -Compress'
    ].join(' ');
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GWR_RELEASE_CHECK_URL: url
      },
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout);
    const status = Number(parsed.status);
    return {
      url,
      ok: status >= 200 && status < 300,
      status,
      headers: {},
      text: String(parsed.content || ''),
      error: primary.error ? `fetch failed: ${primary.error}` : null,
      transport: 'powershell'
    };
  } catch (error) {
    return {
      ...primary,
      error: [
        primary.error || null,
        `powershell fallback failed: ${error?.message || String(error)}`
      ].filter(Boolean).join('; '),
      transport: 'fetch'
    };
  }
}

async function fetchBuffer(url, init = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        'user-agent': 'gemini-watermark-remover-release-distribution-check',
        ...(init.headers || {})
      }
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      url,
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      size: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      error: null
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      headers: {},
      size: null,
      sha256: null,
      error: error?.cause?.message || error?.message || String(error)
    };
  }
}

function extractUserscriptVersion(text = '') {
  return text.match(/^\s*\/\/\s+@version\s+(.+?)\s*$/m)?.[1]?.trim() || null;
}

function extractChromeUpdateVersion(xml = '') {
  return xml.match(/<updatecheck\b[^>]*\bversion="([^"]+)"/)?.[1] || null;
}

function assetNames(release) {
  return Array.isArray(release?.assets)
    ? release.assets.map((asset) => asset?.name).filter(Boolean).sort()
    : [];
}

function expectedAssetNames(version) {
  return [
    `gemini-watermark-remover-extension-v${version}.zip`,
    `gemini-watermark-remover-extension-v${version}.zip.sha256.txt`,
    'gemini-watermark-remover.user.js',
    'latest-extension.json',
    `pilio-gemini-watermark-remover-${version}.tgz`
  ].sort();
}

function compareSets(actual = [], expected = []) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((item) => !actualSet.has(item)),
    extra: actual.filter((item) => !expectedSet.has(item))
  };
}

function checkVersion(id, actual, expected, { waiting = false } = {}) {
  if (actual === expected) {
    return {
      id,
      status: 'ok',
      expected,
      actual,
      blocker: null
    };
  }
  return {
    id,
    status: waiting ? 'waiting' : 'blocked',
    expected,
    actual,
    blocker: waiting ? `${id}-not-propagated` : `${id}-version-mismatch`
  };
}

function deriveOverall(checks) {
  const blockers = checks
    .filter((check) => check.status === 'blocked')
    .map((check) => check.blocker)
    .filter(Boolean);
  const waiting = checks
    .filter((check) => check.status === 'waiting')
    .map((check) => check.blocker)
    .filter(Boolean);
  return {
    status: blockers.length ? 'blocked' : waiting.length ? 'waiting' : 'ok',
    blockers,
    waiting,
    allMatched: blockers.length === 0 && waiting.length === 0
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Release Distribution Check');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Expected version: ${report.expectedVersion}`);
  lines.push(`Overall: ${report.overall.status}`);
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('| Surface | Status | Expected | Actual | Note |');
  lines.push('|---|---|---|---|---|');
  for (const check of report.checks) {
    lines.push(`| ${check.id} | ${check.status} | ${check.expected ?? '-'} | ${check.actual ?? '-'} | ${check.blocker ?? '-'} |`);
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push(`- GitHub release: ${report.evidence.githubRelease.url}`);
  lines.push(`- npm registry: ${report.evidence.npm.url}`);
  lines.push(`- site userscript: ${report.evidence.siteUserscript.url}`);
  lines.push(`- site latest extension: ${report.evidence.siteLatestExtension.url}`);
  lines.push(`- site extension zip: ${report.evidence.siteExtensionZip.url || '-'}`);
  lines.push(`- Chrome update endpoint: ${report.evidence.chromeUpdate.url}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function createReport({
  packageJson = DEFAULTS.packageJson,
  repo = DEFAULTS.repo,
  npmPackage = DEFAULTS.npmPackage,
  siteBaseUrl = DEFAULTS.siteBaseUrl,
  chromeExtensionId = DEFAULTS.chromeExtensionId,
  version = null
} = {}) {
  const pkg = await readJson(packageJson);
  const expectedVersion = version || pkg.version;
  if (!expectedVersion) throw new Error('Missing expected version.');

  const encodedNpmPackage = npmPackage.replace('/', '%2F');
  const githubReleaseUrl = `https://api.github.com/repos/${repo}/releases/tags/v${expectedVersion}`;
  const npmUrl = `https://registry.npmjs.org/${encodedNpmPackage}`;
  const siteUserscriptUrl = `${siteBaseUrl}/userscript/gemini-watermark-remover.user.js`;
  const siteLatestExtensionUrl = `${siteBaseUrl}/downloads/latest-extension.json`;
  const chromeUpdateUrl = `https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=120.0&acceptformat=crx2,crx3&x=id%3D${chromeExtensionId}%26uc`;

  const [
    githubRelease,
    npmRegistry,
    siteUserscript,
    siteLatestExtension,
    chromeUpdate
  ] = await Promise.all([
    fetchJson(githubReleaseUrl),
    fetchJson(npmUrl),
    fetchText(siteUserscriptUrl),
    fetchJson(siteLatestExtensionUrl),
    fetchTextWithPowerShellFallback(chromeUpdateUrl)
  ]);

  const releaseAssetNames = assetNames(githubRelease.json);
  const releaseAssets = compareSets(releaseAssetNames, expectedAssetNames(expectedVersion));
  const npmLatest = npmRegistry.json?.['dist-tags']?.latest || null;
  const siteUserscriptVersion = extractUserscriptVersion(siteUserscript.text);
  const siteLatestExtensionVersion = siteLatestExtension.json?.version || null;
  const siteExtensionFile = siteLatestExtension.json?.file || null;
  const siteExtensionZipUrl = siteExtensionFile
    ? `${siteBaseUrl}/downloads/${siteExtensionFile}`
    : null;
  const siteExtensionZip = siteExtensionZipUrl
    ? await fetchBuffer(siteExtensionZipUrl)
    : null;
  const chromeVersion = extractChromeUpdateVersion(chromeUpdate.text);

  const checks = [
    checkVersion('local-package', pkg.version, expectedVersion),
    {
      id: 'github-release',
      status: githubRelease.ok && isObject(githubRelease.json) ? 'ok' : 'blocked',
      expected: `v${expectedVersion}`,
      actual: githubRelease.json?.tag_name || `http-${githubRelease.status}`,
      blocker: githubRelease.ok ? null : 'github-release-missing'
    },
    {
      id: 'github-release-assets',
      status: releaseAssets.missing.length === 0 ? 'ok' : 'blocked',
      expected: expectedAssetNames(expectedVersion).join(', '),
      actual: releaseAssetNames.join(', '),
      blocker: releaseAssets.missing.length ? 'github-release-assets-missing' : null,
      missing: releaseAssets.missing,
      extra: releaseAssets.extra
    },
    checkVersion('npm-latest', npmLatest, expectedVersion),
    checkVersion('site-userscript', siteUserscriptVersion, expectedVersion),
    checkVersion('site-latest-extension', siteLatestExtensionVersion, expectedVersion),
    (() => {
      const ok = Boolean(
        siteExtensionZip?.ok &&
        siteExtensionZip.sha256 === siteLatestExtension.json?.sha256 &&
        siteExtensionZip.size === siteLatestExtension.json?.size
      );
      return {
      id: 'site-extension-zip',
      status: ok ? 'ok' : 'blocked',
      expected: `${siteLatestExtension.json?.sha256 || '-'} / ${siteLatestExtension.json?.size || '-'}`,
      actual: siteExtensionZip
        ? `${siteExtensionZip.sha256} / ${siteExtensionZip.size}`
        : null,
      blocker: ok ? null : siteExtensionZip?.ok ? 'site-extension-zip-integrity-mismatch' : 'site-extension-zip-missing'
      };
    })(),
    checkVersion('chrome-web-store-update', chromeVersion, expectedVersion, { waiting: true })
  ];

  return {
    generatedAt: new Date().toISOString(),
    expectedVersion,
    inputs: {
      packageJson: path.resolve(packageJson),
      repo,
      npmPackage,
      siteBaseUrl,
      chromeExtensionId
    },
    overall: deriveOverall(checks),
    checks,
    evidence: {
      githubRelease: {
        url: githubReleaseUrl,
        status: githubRelease.status,
        tagName: githubRelease.json?.tag_name || null,
        assets: releaseAssetNames,
        missingAssets: releaseAssets.missing,
        extraAssets: releaseAssets.extra
      },
      npm: {
        url: npmUrl,
        status: npmRegistry.status,
        latest: npmLatest
      },
      siteUserscript: {
        url: siteUserscriptUrl,
        status: siteUserscript.status,
        version: siteUserscriptVersion,
        length: siteUserscript.text.length
      },
      siteLatestExtension: {
        url: siteLatestExtensionUrl,
        status: siteLatestExtension.status,
        json: siteLatestExtension.json
      },
      siteExtensionZip: {
        url: siteExtensionZipUrl,
        status: siteExtensionZip?.status || null,
        size: siteExtensionZip?.size || null,
        sha256: siteExtensionZip?.sha256 || null,
        error: siteExtensionZip?.error || null
      },
      chromeUpdate: {
        url: chromeUpdateUrl,
        status: chromeUpdate.status,
        version: chromeVersion,
        transport: chromeUpdate.transport || null,
        error: chromeUpdate.error || null,
        xml: chromeUpdate.text
      }
    }
  };
}

function parseCliArgs(argv) {
  const args = {
    outputPath: DEFAULT_OUTPUT_PATH,
    markdownPath: DEFAULT_MARKDOWN_PATH,
    failOnMismatch: false,
    version: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      args.outputPath = argv[++index] || args.outputPath;
    } else if (arg === '--markdown') {
      args.markdownPath = argv[++index] || args.markdownPath;
    } else if (arg === '--version') {
      args.version = argv[++index] || null;
    } else if (arg === '--fail-on-mismatch') {
      args.failOnMismatch = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/check-release-distribution.js [options]

Options:
  --version <version>       Expected version. Defaults to package.json version.
  --output <path>           Default: .artifacts/release-distribution/latest-report.json
  --markdown <path>         Default: .artifacts/release-distribution/latest-report.md
  --fail-on-mismatch        Exit non-zero unless every public surface matches.
`);
}

async function writeReport(args) {
  const report = await createReport(args);
  await mkdir(path.dirname(path.resolve(args.outputPath)), { recursive: true });
  await mkdir(path.dirname(path.resolve(args.markdownPath)), { recursive: true });
  await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(args.markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  writeReport(args)
    .then((report) => {
      console.log(`json: ${path.resolve(args.outputPath)}`);
      console.log(`markdown: ${path.resolve(args.markdownPath)}`);
      console.log(`expectedVersion: ${report.expectedVersion}`);
      console.log(`overall: ${report.overall.status}`);
      for (const check of report.checks) {
        console.log(`${check.id}: ${check.status} (actual=${check.actual ?? '-'})`);
      }
      if (args.failOnMismatch && !report.overall.allMatched) {
        const blockers = [
          ...report.overall.blockers,
          ...report.overall.waiting
        ];
        console.error(`distribution mismatch: ${blockers.join(', ')}`);
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exit(1);
    });
}

export {
  createReport,
  extractChromeUpdateVersion,
  renderMarkdown
};

import path from 'node:path';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import { chromium } from 'playwright';

const ROOT_DIR = process.cwd();
const PUBLIC_DIR = path.resolve(ROOT_DIR, 'public');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4174;
const DEFAULT_PROXY_SERVER = 'http://127.0.0.1:7890';
const TM_STORE_URL = 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo';

export const DEFAULT_TAMPERMONKEY_PROFILE_DIR = path.resolve(ROOT_DIR, '.chrome-debug/tampermonkey-profile');
export const DEFAULT_TAMPERMONKEY_REPORT_PATH = path.resolve(ROOT_DIR, '.artifacts/tampermonkey-smoke/latest.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
};

function assertPort(value, flagName) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${flagName} must be a valid TCP port`);
  }
  return parsed;
}

export function parseTampermonkeySmokeCliArgs(argv = []) {
  const args = [...argv];
  const first = args[0] || '';
  const mode = first === 'setup' || first === 'run'
    ? args.shift()
    : 'run';

  const parsed = {
    mode,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    profileDir: DEFAULT_TAMPERMONKEY_PROFILE_DIR,
    reportPath: DEFAULT_TAMPERMONKEY_REPORT_PATH,
    proxyServer: DEFAULT_PROXY_SERVER,
    keepOpen: false
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--host') {
      parsed.host = String(args.shift() || DEFAULT_HOST).trim() || DEFAULT_HOST;
      continue;
    }
    if (arg === '--port') {
      parsed.port = assertPort(args.shift(), '--port');
      continue;
    }
    if (arg === '--profile') {
      parsed.profileDir = path.resolve(ROOT_DIR, args.shift() || parsed.profileDir);
      continue;
    }
    if (arg === '--report') {
      parsed.reportPath = path.resolve(ROOT_DIR, args.shift() || parsed.reportPath);
      continue;
    }
    if (arg === '--proxy') {
      const value = String(args.shift() || '').trim();
      parsed.proxyServer = /^(off|none)$/i.test(value) ? '' : (value || DEFAULT_PROXY_SERVER);
      continue;
    }
    if (arg === '--keep-open') {
      parsed.keepOpen = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveChromeExecutablePath(env = process.env) {
  if (env.GWR_DEBUG_EXECUTABLE_PATH) {
    return env.GWR_DEBUG_EXECUTABLE_PATH;
  }

  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
      ]
    : [];

  return candidates.find((candidate) => candidate && existsSync(candidate)) || '';
}

export function buildTampermonkeySmokeChromeArgs({
  profileDir = DEFAULT_TAMPERMONKEY_PROFILE_DIR,
  proxyServer = DEFAULT_PROXY_SERVER,
  port = 9226,
  targetUrl = 'about:blank'
} = {}) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking'
  ];

  if (proxyServer) {
    args.push(`--proxy-server=${proxyServer}`);
    args.push('--proxy-bypass-list=localhost;127.0.0.1');
  }

  if (targetUrl) {
    args.push(targetUrl);
  }

  return args;
}

async function startProbeServer({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const createProbeServer = () => createServer(async (req, res) => {
    try {
      const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const requestPath = rawPath === '/' ? '/tampermonkey-worker-probe.html' : rawPath;
      const targetPath = path.resolve(PUBLIC_DIR, `.${requestPath}`);

      if (!targetPath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      const body = await readFile(targetPath);
      const ext = path.extname(targetPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(error?.message || error));
    }
  });

  let nextPort = port;
  while (nextPort < port + 20) {
    const server = createProbeServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(nextPort, host, resolve);
      });

      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : nextPort;
      return {
        server,
        baseUrl: `http://${host}:${resolvedPort}`
      };
    } catch (error) {
      server.close();
      if (error?.code !== 'EADDRINUSE') {
        throw error;
      }
      nextPort += 1;
    }
  }

  throw new Error(`Unable to bind probe server on ${host}:${port}-${port + 19}`);
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

export function shouldReuseProbePage(currentUrl = '', nextUrl = '') {
  try {
    const current = new URL(String(currentUrl || ''));
    const next = new URL(String(nextUrl || ''));
    return current.origin === next.origin
      && current.pathname === next.pathname
      && current.pathname.endsWith('/tampermonkey-worker-probe.html');
  } catch {
    return false;
  }
}

async function waitForCdpReady(port, timeoutMs = 15000) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return endpoint;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Timed out waiting for Chrome DevTools endpoint on port ${port}`);
}

async function launchChromeWithProfile({ profileDir, proxyServer, port, targetUrl }) {
  mkdirSync(profileDir, { recursive: true });
  const executablePath = resolveChromeExecutablePath(process.env);
  if (!executablePath) {
    throw new Error('未找到可用的 Chrome 可执行文件，请设置 GWR_DEBUG_EXECUTABLE_PATH');
  }

  const chromeProcess = spawn(executablePath, buildTampermonkeySmokeChromeArgs({
    profileDir,
    proxyServer,
    port,
    targetUrl
  }), {
    cwd: ROOT_DIR,
    stdio: 'ignore',
    windowsHide: false
  });

  try {
    const endpoint = await waitForCdpReady(port);
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('Connected to Chrome DevTools but no browser context is available');
    }

    return {
      browser,
      context,
      chromeProcess,
      async close() {
        await browser.close().catch(() => {});
        if (!chromeProcess.killed) {
          chromeProcess.kill();
        }
      }
    };
  } catch (error) {
    if (!chromeProcess.killed) {
      chromeProcess.kill();
    }
    throw error;
  }
}

function printSetupInstructions({ profileDir, baseUrl }) {
  console.log(`固定 Profile: ${profileDir}`);
  console.log(`Chrome Web Store: ${TM_STORE_URL}`);
  console.log(`本地 Probe 页面: ${baseUrl}/tampermonkey-worker-probe.html?setup=1`);
  console.log(`本地 Probe Userscript: ${baseUrl}/tampermonkey-worker-probe.user.js`);
  console.log('请在这个固定 profile 里手动完成以下步骤:');
  console.log('1. 用 pnpm probe:tm:profile 打开正常 Chrome，而不是自动化窗口');
  console.log('2. 安装 Tampermonkey');
  console.log('3. 如 Chrome 提示，请开启 Developer mode / Allow User Scripts');
  console.log('4. 打开本地 .user.js 地址并安装 probe 脚本');
  console.log('5. 保留这个 profile，后续自动化都复用它');
  console.log('注意: 自动化窗口会显示“Chrome 正受到自动测试软件的控制”，商店安装会被禁用。');
  console.log('完成后按 Ctrl+C 退出 setup 模式。');
}

async function waitForProbeCompletion(page, timeoutMs = 15000) {
  await page.waitForFunction(
    () => window.__gwrTampermonkeyProbeState?.completed === true,
    { timeout: timeoutMs }
  );

  return cloneSerializable(await page.evaluate(() => window.__gwrTampermonkeyProbeState || null));
}

async function openProbePage(page, targetUrl) {
  if (shouldReuseProbePage(page.url(), targetUrl)) {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    return page;
  }

  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });
  return page;
}

function ensureReportDirectory(reportPath) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
}

function persistReport(reportPath, payload) {
  ensureReportDirectory(reportPath);
  writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function runTampermonkeySmoke(options = {}) {
  const mode = options.mode || 'run';
  const host = options.host || DEFAULT_HOST;
  const port = options.port || DEFAULT_PORT;
  const profileDir = options.profileDir
    ? path.resolve(ROOT_DIR, options.profileDir)
    : DEFAULT_TAMPERMONKEY_PROFILE_DIR;
  const reportPath = options.reportPath
    ? path.resolve(ROOT_DIR, options.reportPath)
    : DEFAULT_TAMPERMONKEY_REPORT_PATH;
  const proxyServer = typeof options.proxyServer === 'string'
    ? options.proxyServer
    : DEFAULT_PROXY_SERVER;
  const keepOpen = Boolean(options.keepOpen);
  const closeOnSuccess = options.closeOnSuccess !== false;

  const { server, baseUrl } = await startProbeServer({ host, port });
  const debugPort = port + 1000;
  const session = await launchChromeWithProfile({
    profileDir,
    proxyServer,
    port: debugPort,
    targetUrl: `${baseUrl}/tampermonkey-worker-probe.html?boot=1`
  });
  const pages = session.context.pages();
  const page = pages[0] || await session.context.newPage();

  try {
    if (mode === 'setup') {
      await page.goto(`${baseUrl}/tampermonkey-worker-probe.html?setup=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
      printSetupInstructions({ profileDir, baseUrl });
      const storePage = await session.context.newPage();
      void storePage.goto(TM_STORE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      }).catch(() => {});
      await new Promise(() => {});
    }

    await openProbePage(page, `${baseUrl}/tampermonkey-worker-probe.html?ts=${Date.now()}`);
    const probeState = await waitForProbeCompletion(page);
    const report = {
      ...probeState,
      mode,
      baseUrl,
      profileDir,
      proxyServer,
      reportPath,
      capturedAt: new Date().toISOString()
    };

    persistReport(reportPath, report);

    if (!report.userscriptDetected) {
      throw new Error(
        `未检测到 Tampermonkey probe userscript。先运行 "pnpm probe:tm:setup" 并在固定 profile ${profileDir} 中手动安装 Tampermonkey 和本地 probe 脚本。`
      );
    }
    if (report.pageDirectBlobWorker?.ok !== false) {
      throw new Error('Probe page direct Blob Worker did not fail under the worker-src policy');
    }
    if (report.userscriptSandboxWorker?.ok !== true) {
      throw new Error(`Tampermonkey sandbox worker probe failed: ${report.userscriptSandboxWorker?.message || 'unknown error'}`);
    }
    if (report.bridgeRoundtrip?.ok !== true) {
      throw new Error(`Tampermonkey bridge roundtrip failed: ${report.bridgeRoundtrip?.error || 'unknown error'}`);
    }

    if (!keepOpen && closeOnSuccess) {
      await session.close();
      await new Promise((resolve) => server.close(resolve));
    }

    return report;
  } catch (error) {
    if (!keepOpen) {
      await session.close().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
    }
    throw error;
  }
}

async function runCli() {
  const options = parseTampermonkeySmokeCliArgs(process.argv.slice(2));
  try {
    const report = await runTampermonkeySmoke(options);
    console.log(`probe report: ${report.reportPath}`);
    console.log(JSON.stringify({
      pageDirectBlobWorker: report.pageDirectBlobWorker,
      userscriptSandboxWorker: report.userscriptSandboxWorker,
      bridgeRoundtrip: report.bridgeRoundtrip
    }, null, 2));
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}

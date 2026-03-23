import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_TAMPERMONKEY_PROFILE_DIR
} from './tampermonkey-smoke.js';

export const DEFAULT_TAMPERMONKEY_STORE_URL = 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo';
export const DEFAULT_PROXY_SERVER = 'http://127.0.0.1:7890';
export const DEFAULT_CDP_PORT = 9226;

function assertPort(value, flagName) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${flagName} must be a valid TCP port`);
  }
  return parsed;
}

export function parseOpenTampermonkeyProfileCliArgs(argv = []) {
  const args = [...argv];
  const parsed = {
    profileDir: DEFAULT_TAMPERMONKEY_PROFILE_DIR,
    proxyServer: DEFAULT_PROXY_SERVER,
    cdpPort: DEFAULT_CDP_PORT,
    targetUrl: DEFAULT_TAMPERMONKEY_STORE_URL
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--profile') {
      parsed.profileDir = path.resolve(process.cwd(), args.shift() || parsed.profileDir);
      continue;
    }
    if (arg === '--proxy') {
      const value = String(args.shift() || '').trim();
      parsed.proxyServer = /^(off|none)$/i.test(value) ? '' : (value || DEFAULT_PROXY_SERVER);
      continue;
    }
    if (arg === '--cdp-port') {
      parsed.cdpPort = assertPort(args.shift(), '--cdp-port');
      continue;
    }
    if (arg === '--url') {
      parsed.targetUrl = String(args.shift() || parsed.targetUrl).trim() || parsed.targetUrl;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export function buildTampermonkeyProfileLaunchArgs({
  profileDir = DEFAULT_TAMPERMONKEY_PROFILE_DIR,
  proxyServer = DEFAULT_PROXY_SERVER,
  cdpPort = DEFAULT_CDP_PORT,
  targetUrl = DEFAULT_TAMPERMONKEY_STORE_URL
} = {}) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`
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

export function resolveChromeExecutablePath(env = process.env) {
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

export function openTampermonkeyProfile(options = {}) {
  const executablePath = resolveChromeExecutablePath(process.env);
  if (!executablePath) {
    throw new Error('未找到可用的 Chrome 可执行文件，请设置 GWR_DEBUG_EXECUTABLE_PATH');
  }

  const args = buildTampermonkeyProfileLaunchArgs(options);
  const child = spawn(executablePath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  return {
    executablePath,
    args
  };
}

function runCli() {
  const options = parseOpenTampermonkeyProfileCliArgs(process.argv.slice(2));
  const launched = openTampermonkeyProfile(options);
  console.log(`Chrome 已打开，固定 profile: ${options.profileDir}`);
  console.log(`目标页面: ${options.targetUrl}`);
  console.log(`代理: ${options.proxyServer || 'disabled'}`);
  console.log(`CDP 端口: ${options.cdpPort}`);
  console.log(`可执行文件: ${launched.executablePath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}

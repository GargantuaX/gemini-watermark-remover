import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGE_SCRIPT = fileURLToPath(
  new URL('../../scripts/package-extension-release.js', import.meta.url)
);

async function readText(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

async function readBinary(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url));
}

async function createPackagedExtensionFixture() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'gwr-extension-package-official-'));
  await mkdir(path.join(tempDir, 'dist'), { recursive: true });
  await cp(
    path.join(PROJECT_ROOT, 'dist', 'extension'),
    path.join(tempDir, 'dist', 'extension'),
    { recursive: true }
  );
  const packageBuild = spawnSync(process.execPath, [PACKAGE_SCRIPT], {
    cwd: tempDir,
    encoding: 'utf8'
  });
  assert.equal(packageBuild.status, 0, packageBuild.stderr || packageBuild.stdout);
  return tempDir;
}

test('production build should emit a MV3 extension that packages the shared userscript runtime', async () => {
  const build = spawnSync('pnpm', ['build'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });

  assert.equal(build.status, 0, build.stderr || build.stdout);

  const manifest = JSON.parse(await readText('dist/extension/manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Gemini Watermark Remover Local');
  assert.equal(manifest.short_name, 'GWR Local');
  assert.equal(manifest.action.default_title, 'Gemini Watermark Remover Local');
  assert.match(manifest.version_name, new RegExp(`^${manifest.version.replaceAll('.', '\\.')}\\+local\\.`));
  assert.match(manifest.description, /local test build/);
  assert.equal(manifest.icons['16'], 'assets/icon-16.png');
  assert.equal(manifest.icons['32'], 'assets/icon-32.png');
  assert.equal(manifest.icons['48'], 'assets/icon-48.png');
  assert.equal(manifest.icons['128'], 'assets/icon-128.png');
  assert.equal(manifest.action.default_icon['16'], 'assets/icon-16.png');
  assert.equal(manifest.action.default_icon['32'], 'assets/icon-32.png');
  assert.equal(manifest.action.default_icon['48'], 'assets/icon-48.png');
  assert.equal(manifest.action.default_icon['128'], 'assets/icon-128.png');
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.deepEqual(
    manifest.content_scripts.map((script) => script.world || 'ISOLATED'),
    ['MAIN', 'ISOLATED']
  );
  assert.equal(manifest.background.service_worker, 'service-worker.js');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.ok(manifest.host_permissions.includes('https://*.googleusercontent.com/*'));

  assert.equal(existsSync(new URL('../../dist/extension/content-main.js', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/isolated-bridge.js', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/service-worker.js', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/popup.html', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/popup.css', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/popup.js', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/assets/icon-16.png', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/assets/icon-32.png', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/assets/icon-48.png', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/assets/icon-128.png', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/assets/logo-shape.svg', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension/assets/github.svg', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../dist/extension-local', import.meta.url)), false);
  assert.equal(existsSync(new URL('../../dist/releases', import.meta.url)), false);

  const contentMain = await readText('dist/extension/content-main.js');
  assert.match(contentMain, /Gemini Watermark Remover/);
  assert.match(contentMain, /GM_xmlhttpRequest/);

  const popupHtml = await readText('dist/extension/popup.html');
  assert.match(popupHtml, /<html lang="en">/);
  assert.match(popupHtml, /https:\/\/geminiwatermarkremover\.io\//);
  assert.match(popupHtml, /https:\/\/pilio\.ai\/image-watermark-remover/);
  assert.match(popupHtml, /Online Gemini watermark remover/);
  assert.match(popupHtml, /Remove any image watermark/);
  assert.match(popupHtml, /Report an issue on GitHub/);
  assert.match(popupHtml, /https:\/\/github\.com\/GargantuaX\/gemini-watermark-remover\/issues/);
  assert.match(popupHtml, /assets\/github\.svg/);
  assert.match(popupHtml, /assets\/logo-shape\.svg/);
  assert.match(popupHtml, /enable-toggle/);
  assert.match(popupHtml, /popup\.js/);

  const popupScript = await readText('dist/extension/popup.js');
  assert.match(popupScript, /globalThis\.chrome/);
  assert.match(popupScript, /storage\?\.local/);
  assert.match(popupScript, /tabs\?\.reload/);
  assert.match(popupScript, /gwrEnabled/);
});

test('extension package should replace the local debug manifest with the official release manifest', async () => {
  const releaseBefore = await readText('release/latest-extension.json');
  const tempDir = await createPackagedExtensionFixture();
  try {
    const latest = JSON.parse(
      await readFile(path.join(tempDir, 'release', 'latest-extension.json'), 'utf8')
    );
    assert.equal(latest.name, 'gemini-watermark-remover-extension');
    assert.equal(latest.source, 'dist/extension');
    assert.equal(existsSync(path.join(tempDir, 'release', 'latest-extension-local.json')), false);

    const zipText = (
      await readFile(path.join(tempDir, 'release', latest.file))
    ).toString('utf8');
    assert.match(zipText, /"name": "Gemini Watermark Remover"/);
    assert.match(zipText, /"short_name": "GWR"/);
    assert.match(zipText, /"default_title": "Gemini Watermark Remover"/);
    assert.doesNotMatch(zipText, /Gemini Watermark Remover Local/);
    assert.doesNotMatch(zipText, /local test build/);
    assert.doesNotMatch(zipText, /version_name/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  assert.equal(
    await readText('release/latest-extension.json'),
    releaseBefore,
    'packaging tests must not overwrite repository release metadata'
  );
});

test('extension package should be deterministic across repeated runs', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'gwr-extension-package-'));
  try {
    const extensionDir = path.join(tempDir, 'dist', 'extension');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      path.join(extensionDir, 'manifest.json'),
      `${JSON.stringify({
        manifest_version: 3,
        name: 'Gemini Watermark Remover Local',
        short_name: 'GWR Local',
        description: 'Local test build (local test build)',
        version: '9.9.9',
        version_name: '9.9.9+local.test',
        action: {
          default_title: 'Gemini Watermark Remover Local'
        }
      }, null, 2)}\n`
    );
    await writeFile(path.join(extensionDir, 'content-main.js'), 'console.log("fixture");\n');

    const scriptPath = fileURLToPath(new URL('../../scripts/package-extension-release.js', import.meta.url));
    const first = spawnSync(process.execPath, [scriptPath], {
      cwd: tempDir,
      encoding: 'utf8'
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstLatest = JSON.parse(await readFile(path.join(tempDir, 'release', 'latest-extension.json'), 'utf8'));
    const firstZip = await readFile(path.join(tempDir, 'release', firstLatest.file));

    await new Promise((resolve) => setTimeout(resolve, 2200));

    const second = spawnSync(process.execPath, [scriptPath], {
      cwd: tempDir,
      encoding: 'utf8'
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondLatest = JSON.parse(await readFile(path.join(tempDir, 'release', 'latest-extension.json'), 'utf8'));
    const secondZip = await readFile(path.join(tempDir, 'release', secondLatest.file));

    assert.equal(secondLatest.sha256, firstLatest.sha256);
    assert.deepEqual(secondZip, firstZip);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('production build should preserve packaged extension release artifacts', async () => {
  const latestBefore = await readText('release/latest-extension.json');
  const latest = JSON.parse(latestBefore);
  const zipBefore = await readBinary(`release/${latest.file}`);
  const checksumBefore = await readBinary(`release/${latest.file}.sha256.txt`);

  const build = spawnSync('pnpm', ['build'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  assert.equal(existsSync(new URL(`../../release/${latest.file}`, import.meta.url)), true);
  assert.equal(existsSync(new URL(`../../release/${latest.file}.sha256.txt`, import.meta.url)), true);
  assert.equal(existsSync(new URL('../../release/latest-extension.json', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../release/latest-extension-local.json', import.meta.url)), false);
  assert.equal(await readText('release/latest-extension.json'), latestBefore);
  assert.deepEqual(await readBinary(`release/${latest.file}`), zipBefore);
  assert.deepEqual(
    await readBinary(`release/${latest.file}.sha256.txt`),
    checksumBefore
  );
});

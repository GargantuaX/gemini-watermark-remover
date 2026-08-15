import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EXTENSION_DIR = path.resolve('dist/extension');
const RELEASE_DIR = path.resolve('release');
const PACKAGE_BASE_NAME = 'gemini-watermark-remover-extension';
const WEB_STORE_PACKAGE_BASE_NAME = `${PACKAGE_BASE_NAME}-web-store`;
const ZIP_ENTRY_TIMESTAMP = new Date(1980, 0, 1, 0, 0, 0);

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath, relativePath));
      continue;
    }
    files.push({ absolutePath, relativePath });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = toDosDateTime(ZIP_ENTRY_TIMESTAMP);

  for (const entry of entries) {
    const fileName = Buffer.from(entry.name.replaceAll('\\', '/'));
    const data = entry.data;
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, fileName, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, fileName);

    offset += localHeader.length + fileName.length + data.length;
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function createInstallDocs(version, { packageBaseName = PACKAGE_BASE_NAME } = {}) {
  const english = `# Gemini Watermark Remover Chrome Extension v${version}

## Install

1. Extract this zip file.
2. Open \`chrome://extensions\`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the extracted \`${packageBaseName}\` folder.

## Update

Download the new zip, replace the extracted folder, then click Reload on the extension card.

## Privacy

The extension runs on Gemini pages only. It processes generated image previews, copy actions, and download actions in the browser. It does not collect accounts, prompts, chats, or personal data. It may request Gemini and Googleusercontent image assets so the image can be processed locally.
`;

  const chinese = `# Gemini Watermark Remover Chrome 插件 v${version}

## 安装

1. 解压这个 zip 文件。
2. 打开 \`chrome://extensions\`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择解压后的 \`${packageBaseName}\` 文件夹。

## 更新

下载新版 zip，替换已解压的文件夹，然后在扩展卡片上点击“重新加载”。

## 隐私说明

插件只在 Gemini 页面运行，会在浏览器内处理生成图片的预览、复制和下载动作。插件不收集账号、提示词、聊天内容或个人数据。为完成本地处理，插件可能会请求 Gemini 和 Googleusercontent 的图片资源。
`;

  return { english, chinese };
}

function createOfficialManifest(localManifest) {
  const manifest = structuredClone(localManifest);
  manifest.name = 'Gemini Watermark Remover';
  manifest.short_name = 'GWR';
  manifest.description = manifest.description.replace(/\s+\(local test build\)$/, '');
  manifest.action = {
    ...manifest.action,
    default_title: 'Gemini Watermark Remover'
  };
  delete manifest.version_name;
  return manifest;
}

function removeStaleLocalReleaseArtifacts() {
  if (!existsSync(RELEASE_DIR)) return;
  for (const entry of readdirSync(RELEASE_DIR, { withFileTypes: true })) {
    if (entry.name === 'latest-extension-local.json' || entry.name.startsWith('gemini-watermark-remover-extension-local-')) {
      rmSync(path.join(RELEASE_DIR, entry.name), { recursive: true });
    }
  }
}

function packageExtensionRelease({
  extensionDir,
  packageBaseName,
  latestFile,
  source,
  archiveRoot = packageBaseName,
  includeInstallDocs = true
}) {
  if (!existsSync(extensionDir)) {
    throw new Error(`${source} does not exist. Run pnpm build first.`);
  }

  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = readJson(manifestPath);
  const version = manifest.version;
  if (!version) {
    throw new Error(`${source}/manifest.json is missing version.`);
  }
  const officialManifest = createOfficialManifest(manifest);

  const fileEntries = listFiles(extensionDir).map((file) => ({
    name: archiveRoot ? `${archiveRoot}/${file.relativePath}` : file.relativePath,
    data:
      file.relativePath === 'manifest.json'
        ? Buffer.from(`${JSON.stringify(officialManifest, null, 2)}\n`)
        : readFileSync(file.absolutePath)
  }));

  if (includeInstallDocs) {
    const installDocs = createInstallDocs(version, { packageBaseName });
    fileEntries.push(
      { name: `${archiveRoot}/INSTALL.md`, data: Buffer.from(installDocs.english) },
      { name: `${archiveRoot}/INSTALL_zh.md`, data: Buffer.from(installDocs.chinese) }
    );
  }

  const zipName = `${packageBaseName}-v${version}.zip`;
  const zipPath = path.join(RELEASE_DIR, zipName);
  const zipBuffer = createZip(fileEntries);
  writeFileSync(zipPath, zipBuffer);

  const sha256 = createHash('sha256').update(zipBuffer).digest('hex');
  writeFileSync(path.join(RELEASE_DIR, `${zipName}.sha256.txt`), `${sha256}  ${zipName}\n`);

  const latest = {
    name: packageBaseName,
    version,
    file: zipName,
    sha256,
    size: statSync(zipPath).size,
    source
  };
  if (latestFile) {
    writeFileSync(path.join(RELEASE_DIR, latestFile), `${JSON.stringify(latest, null, 2)}\n`);
  }

  console.log(`Packaged ${zipName}`);
  console.log(`sha256 ${sha256}`);
  return latest;
}

mkdirSync(RELEASE_DIR, { recursive: true });
removeStaleLocalReleaseArtifacts();

packageExtensionRelease({
  extensionDir: EXTENSION_DIR,
  packageBaseName: PACKAGE_BASE_NAME,
  latestFile: 'latest-extension.json',
  source: 'dist/extension'
});

packageExtensionRelease({
  extensionDir: EXTENSION_DIR,
  packageBaseName: WEB_STORE_PACKAGE_BASE_NAME,
  source: 'dist/extension',
  archiveRoot: '',
  includeInstallDocs: false
});

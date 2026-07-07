import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

import { packProjectTarball, runCommand } from './testUtils.js';

const REQUIRED_DIST_PACKAGE_FILES = [
    'package/dist/video-preview.html',
    'package/dist/video-app.js',
    'package/dist/models/allenk-fdncnn/onnx-manifest.json',
    'package/dist/models/allenk-fdncnn/model_core_fp32_86x74.onnx',
    'package/dist/models/allenk-fdncnn/model_core_fp32_104.onnx',
    'package/dist/models/allenk-fdncnn/model_core_fp32_200.onnx',
    'package/dist/onnxruntime/ort-wasm-simd-threaded.js',
    'package/dist/onnxruntime/ort-wasm-simd-threaded.wasm',
    'package/dist/onnxruntime/ort-wasm-simd-threaded.asyncify.mjs',
    'package/dist/onnxruntime/ort-wasm-simd-threaded.asyncify.wasm'
];

async function createPackageListing(destinationDir) {
    await rm(destinationDir, { recursive: true, force: true });
    await mkdir(destinationDir, { recursive: true });
    const tarballPath = await packProjectTarball(destinationDir);
    return runCommand('tar', ['-tf', tarballPath]).stdout
        .split(/\r?\n/)
        .filter(Boolean);
}

test('pnpm pack should publish sdk entrypoints without shipping test fixtures', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-pack-'));
    try {
        const packDir = path.join(tempDir, 'package');
        let listing = await createPackageListing(packDir);
        const missingDistFiles = REQUIRED_DIST_PACKAGE_FILES.filter((item) => !listing.includes(item));
        if (missingDistFiles.length > 0) {
            runCommand('pnpm', ['build']);
            listing = await createPackageListing(packDir);
        }

        assert.ok(listing.includes('package/package.json'));
        assert.ok(listing.includes('package/src/sdk/index.js'));
        assert.ok(listing.includes('package/src/sdk/browser.js'));
        assert.ok(listing.includes('package/src/sdk/image-data.js'));
        assert.ok(listing.includes('package/src/sdk/node.js'));
        assert.ok(listing.includes('package/src/sdk/video.js'));
        assert.ok(listing.includes('package/src/sdk/video.d.ts'));
        assert.ok(listing.includes('package/src/runtime/browser.js'));
        assert.ok(listing.includes('package/src/runtime/browser.d.ts'));
        assert.ok(listing.includes('package/src/runtime/userscript.js'));
        assert.ok(listing.includes('package/src/runtime/userscript.d.ts'));
        assert.ok(listing.includes('package/src/core/watermarkProcessor.js'));
        assert.ok(listing.includes('package/src/core/canvasBlob.js'));
        assert.ok(listing.includes('package/src/shared/imageProcessing.js'));
        assert.ok(listing.includes('package/src/cli/gwrCli.js'));
        assert.ok(listing.includes('package/src/cli/gwrRemoveCommand.js'));
        assert.ok(listing.includes('package/src/userscript/pageProcessBridge.js'));
        assert.ok(listing.includes('package/src/userscript/pageProcessorRuntime.js'));
        assert.ok(listing.includes('package/src/userscript/processingRuntime.js'));
        assert.ok(listing.includes('package/src/userscript/runtimeFlags.js'));
        assert.ok(listing.includes('package/src/userscript/trustedTypes.js'));
        for (const requiredFile of REQUIRED_DIST_PACKAGE_FILES) {
            assert.ok(listing.includes(requiredFile), `expected packed tarball to include ${requiredFile}`);
        }
        assert.equal(listing.includes('package/dist/models/allenk-fdncnn/model_core_fp32_87x74.onnx'), false);
        assert.equal(listing.some((item) => item.includes('ort-wasm-simd-threaded.jsep')), false);
        assert.ok(listing.includes('package/bin/gwr.mjs'));
        assert.ok(listing.includes('package/skills/gemini-watermark-remover/SKILL.md'));
        assert.ok(listing.includes('package/skills/gemini-watermark-remover/agents/openai.yaml'));
        assert.ok(listing.includes('package/skills/gemini-watermark-remover/references/usage.md'));
        assert.ok(listing.includes('package/skills/gemini-watermark-remover/references/inputs-and-outputs.md'));
        assert.ok(listing.includes('package/skills/gemini-watermark-remover/references/limitations.md'));
        assert.ok(listing.includes('package/skills/gemini-watermark-remover/scripts/run.mjs'));
        assert.ok(listing.includes('package/README.md'));
        assert.ok(listing.includes('package/LICENSE'));
        assert.equal(listing.some((item) => item.startsWith('package/tests/')), false);
        assert.equal(listing.some((item) => item.startsWith('package/public/')), false);
        assert.equal(listing.some((item) => item.startsWith('package/src/assets/')), false);
        assert.equal(listing.some((item) => item.startsWith('package/src/page/')), false);
        assert.equal(listing.some((item) => item.startsWith('package/src/worker/')), false);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

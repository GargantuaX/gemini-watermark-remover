[中文文档](README_zh.md)

> 🔥 Tired of Gemini watermarks? Try the more powerful **GPT Image 2** at [pilio.ai](https://pilio.ai) — free for a limited time.

# Gemini Watermark Remover — Lossless Watermark Removal Tool

An open-source tool to **remove Gemini watermarks** from AI-generated images with high-fidelity, reproducible results on supported outputs. Built with pure JavaScript, the engine uses a mathematically exact **Reverse Alpha Blending** algorithm instead of unpredictable AI inpainting.

> **🚀 Looking for the `Online Gemini Watermark Remover (Recommended)`? Try [geminiwatermarkremover.io](https://geminiwatermarkremover.io/)** — free, no install, works directly in your browser.
>
> 💡 Got watermarks that Gemini Watermark Remover can't handle? Try the general-purpose AI watermark remover: [pilio.ai/image-watermark-remover](https://pilio.ai/image-watermark-remover)

<p align="center">
  <a href="https://geminiwatermarkremover.io/"><img src="https://img.shields.io/badge/🛠️_Online_Tool-geminiwatermarkremover.io-blue?style=for-the-badge" alt="Online Tool"></a>&nbsp;
  <a href="https://geminiwatermarkremover.io/video"><img src="https://img.shields.io/badge/🎬_Video_Remover-New!-ff6b6b?style=for-the-badge" alt="Video Watermark Remover"></a>&nbsp;
  <a href="https://chromewebstore.google.com/detail/gemini-watermark-remover/cjlmnfcfnofnglkphbcdclbpimdjkmdf"><img src="https://img.shields.io/badge/🧩_Chrome_Extension-Install-blueviolet?style=for-the-badge" alt="Chrome Extension"></a>&nbsp;
  <a href="https://geminiwatermarkremover.io/userscript/gemini-watermark-remover.user.js"><img src="https://img.shields.io/badge/🐒_Userscript-Install-green?style=for-the-badge" alt="Userscript"></a>&nbsp;
  <a href="https://pilio.ai/image-watermark-remover"><img src="https://img.shields.io/badge/🧹_General_Remover-pilio.ai-gray?style=for-the-badge" alt="General Watermark Remover"></a>
</p>

<p align="center">
  <img src="https://count.getloli.com/@gemini-watermark-remover?name=gemini-watermark-remover&theme=minecraft&padding=7&offset=0&align=top&scale=1&pixelated=1&darkmode=auto" width="400">
</p>

## Features

- ✅ **100% Local Processing** - All image processing happens locally in your browser or on your machine. Nothing is uploaded.
- ✅ **Mathematical Precision** - Based on the Reverse Alpha Blending formula, not "hallucinating" AI models.
- ✅ **Auto-Detection** - Automatically identifies watermark size and position using Gemini's known output catalog and local anchor search.
- ✅ **Flexible Usage** - Online tool for quick use, Chrome extension or userscript for seamless Gemini page integration, CLI and Skill for scripting and automation.
- ✅ **Video Support** - Remove watermarks from Gemini-generated videos at [geminiwatermarkremover.io/video](https://geminiwatermarkremover.io/video).
- ✅ **Cross-Platform** - Works in modern browsers (Chrome, Firefox, Safari, Edge) and Node.js environments.

## Gemini Watermark Removal Examples

<details open>
<summary>Click to Expand/Collapse Examples</summary>

| Original Image | Watermark Removed |
| :---: | :----: |
| <img src="docs/demo-before.webp" width="400"> | <img src="docs/demo-after.webp" width="400"> |

</details>

## ⚠️ Disclaimer

> [!WARNING]
>  **USE AT YOUR OWN RISK**
>
> This tool modifies image files. While it is designed to work reliably, unexpected results may occur due to:
> - Variations in Gemini's watermark implementation
> - Corrupted or unusual image formats
> - Edge cases not covered by testing
>
> The author assumes no responsibility for any data loss, image corruption, or unintended modifications. By using this tool, you acknowledge that you understand these risks.

> [!NOTE]
> **Note**: Disable any fingerprint defender extensions (e.g., Canvas Fingerprint Defender) to avoid processing errors. https://github.com/GargantuaX/gemini-watermark-remover/issues/3

## How to Remove Gemini Watermarks

### Online Gemini Watermark Remover (Recommended)

For all users — the fastest and easiest way to remove Gemini watermarks from images:

1. Open **[geminiwatermarkremover.io](https://geminiwatermarkremover.io/)**.
2. Drag and drop or click to select your Gemini-generated image.
3. The engine will automatically process and remove the watermark.
4. Download the cleaned image.

### Online Video Watermark Remover (New!)

For Gemini-generated **videos** with visible watermarks:

1. Open **[geminiwatermarkremover.io/video](https://geminiwatermarkremover.io/video)**.
2. Upload or drag-and-drop your Gemini-generated video.
3. The tool will automatically detect and remove the watermark from the video.
4. Download the cleaned video.

> **Note**: Video watermark removal runs entirely in your browser — no files are uploaded to any server.

### Chrome Extension

Use this if you do not want a userscript manager but still want automatic Gemini page integration for previews, copy, and download actions.

1. Open [Gemini Watermark Remover on the Chrome Web Store](https://chromewebstore.google.com/detail/gemini-watermark-remover/cjlmnfcfnofnglkphbcdclbpimdjkmdf).
2. Click **Add to Chrome** and confirm the install.
3. Open Gemini. The extension will automatically process supported Gemini images.

The popup includes an "Enable on Gemini" toggle. If Gemini becomes slow, behaves unexpectedly, or you need to troubleshoot the page, turn the toggle off and refresh Gemini.

Chrome Web Store installs update automatically. If the Web Store is not reachable in your network, the matching verified zip (`gemini-watermark-remover-extension-v*.zip`) remains available from [GitHub Releases](https://github.com/GargantuaX/gemini-watermark-remover/releases/latest) and the official website download entry for manual unpacked installation.

### Userscript

1. Install a userscript manager (e.g., Tampermonkey or Greasemonkey).
2. Open [gemini-watermark-remover.user.js](https://geminiwatermarkremover.io/userscript/gemini-watermark-remover.user.js).
3. The script will install automatically.
4. Navigate to Gemini conversation pages.
5. Eligible Gemini preview images on the page are replaced in place after processing.
6. Gemini's native "Copy Image" and "Download Image" actions also return processed results.

Current userscript boundaries:

- no injected per-image controls
- no popup UI or bulk action surface
- page previews and native copy/download flows are both processed when the source image is reachable
- preview images keep the original visible while processing, with a subdued `Processing...` overlay
- if preview processing fails, the original page image stays visible and usable

### Skill

For workflows that involve AI coding agents:

- `skills/gemini-watermark-remover/` contains a packaged Skill that agents can discover and invoke.
- Install it with `skills.sh` using:

```bash
pnpm dlx skills add GargantuaX/gemini-watermark-remover --skill gemini-watermark-remover
```

- Add flags like `--agent`, `--yes`, or `--copy` only if your local setup needs them.
- Usage:

```bash
node skills/gemini-watermark-remover/scripts/run.mjs remove <input> --output <file>
```

- See [`SKILL.md`](skills/gemini-watermark-remover/SKILL.md) for agent integration details.

### CLI

For scripting, CI, and local batch workflows, use the direct CLI:

```bash
# repo-local
node bin/gwr.mjs remove <input> --output <file>

# installed globally
gwr remove <input> [--output <file> | --out-dir <dir>] [--overwrite] [--json]
```

Video exports default to the repository's calibrated 12 Mbps AVC profile. For a
quality-sensitive source, request a higher encoder target explicitly:

```bash
gwr remove input.mp4 --output clean.mp4 --video-bitrate-mbps 20
```

The CLI reports video frame progress on stderr. `--video-timeout-ms` is an
inactivity timeout: an export may run longer than that value as long as frames
continue to advance.

If you do not have `gwr` installed globally, use:

```bash
pnpm dlx @pilio/gemini-watermark-remover remove <input> --output <file>
```

The default CLI file decoder/encoder uses `sharp`. SDK consumers that only use browser or `ImageData` APIs do not need it. If you use the CLI file path in your own project, install `sharp` alongside this package:

```bash
pnpm add sharp
```

### Can't Remove Your Watermark?

This tool targets Gemini's visible watermark (the semi-transparent logo in the bottom-right corner). If your image watermark doesn't match a known Gemini format, or you need to remove other types of image watermarks, try the general-purpose AI watermark remover:

👉 **[pilio.ai/image-watermark-remover](https://pilio.ai/image-watermark-remover)**

### Developer Preview

The repository still keeps a local internal preview harness at `/dev-preview.html` for single-image comparison, copy, and download verification.

- This is a retained internal debugging surface, not the public product website.
- The root path `/` now only redirects users toward the official website, the userscript artifact, and the internal preview page.
- Public-facing usage should prefer the official website or the userscript instead of this local preview harness.

## Development

```bash
# Install dependencies
pnpm install

# Development build
pnpm dev

# Production build
pnpm build

# Local static serving
pnpm serve
```

Notes:

- The root path `/` is now a lightweight entry page that points to the official website, the userscript artifact, and the retained internal preview page.
- The internal browser preview harness lives at `/dev-preview.html`, is now kept as a static Chinese-only single-image compare harness for local algorithm/UI debugging, and no longer maintains public-facing locale or theme-switching features.
- `pnpm dev` / `pnpm serve` still host the userscript, probe pages, and these static assets.
- For GitHub issues with Release-hosted samples, `pnpm issue:verify -- --issue <number>` reuses the `gh` login, caches and verifies the samples, and generates a reviewable comment draft. See [GitHub issue sample verification](docs/github-issue-verification.zh.md).

### Tampermonkey Debugging on macOS

For the repo's fixed-profile workflow on macOS:

```bash
# Build the latest userscript
pnpm build

# Start a local dist server if needed
pnpm dev

# Open the fixed Chrome profile with remote debugging enabled
./scripts/open-fixed-chrome-profile.sh --url https://gemini.google.com/app
```

Notes:

- the fixed profile lives under `.chrome-debug/tampermonkey-profile`
- default CDP port is `9226`
- default proxy is `http://127.0.0.1:7890`; disable it with `--proxy off` if not needed
- reinstall the latest userscript from the active local `pnpm dev` server
- `pnpm dev` starts probing from `http://127.0.0.1:4173/` and auto-increments if that port is already occupied
- if you are following a previously captured debugging session, its port may differ; trust the current `pnpm dev` output instead of hardcoding `4173`

## SDK Usage (Advanced / Internal)

The package root still exposes an SDK, but this path is intended for advanced or internal integration scenarios:

```javascript
import {
  createWatermarkEngine,
  removeWatermarkFromImage,
  removeWatermarkFromImageData,
  removeWatermarkFromImageDataSync,
} from '@pilio/gemini-watermark-remover';
```

Use the pure-data API when you already have decoded `ImageData`:

```javascript
const result = await removeWatermarkFromImageData(imageData, {
  adaptiveMode: 'auto',
});

console.log(result.meta.decisionTier);
```

Use the browser image API when you have an `HTMLImageElement` or `HTMLCanvasElement`:

```javascript
const { canvas, meta } = await removeWatermarkFromImage(imageElement);
document.body.append(canvas);
console.log(meta.applied, meta.decisionTier);
```

If you need to process many images, reuse a single engine instance so alpha maps stay cached:

```javascript
const engine = await createWatermarkEngine();
const first = await removeWatermarkFromImageData(imageDataA, { engine });
const second = await removeWatermarkFromImageData(imageDataB, { engine });
```

For Node.js integrations, use the dedicated subpath and inject your own decoder/encoder:

```javascript
import { removeWatermarkFromBuffer } from '@pilio/gemini-watermark-remover/node';

const result = await removeWatermarkFromBuffer(inputBuffer, {
  mimeType: 'image/png',
  decodeImageData: yourDecodeFn,
  encodeImageData: yourEncodeFn,
});
```

## Runtime Requirements

### Web And Userscript

- modern Chrome / Firefox / Safari / Edge class browser
- ES modules
- Canvas API
- Async/Await
- TypedArray (`Float32Array`, `Uint8ClampedArray`)
- for the website copy button: `navigator.clipboard.write(...)` and `ClipboardItem`

### CLI And Skill

- a local Node.js runtime capable of running this package
- `sharp` installed when using the default CLI file decoder/encoder
- filesystem access for local input/output paths
- for repo-local usage:

```bash
node bin/gwr.mjs remove <input> --output <file>
node skills/gemini-watermark-remover/scripts/run.mjs remove <input> --output <file>
```

- for distributed Skill usage, the local environment must be able to execute the packaged `gwr` CLI boundary

## Testing

```bash
# Run all tests
pnpm test
```

Regression tests include image fixtures from `src/assets/samples/`.
Source samples stay in git.
Naming and retention rules for those fixtures are documented in `src/assets/samples/README.md`.
Complex preview/download validation notes are documented in `docs/complex-figure-verification-checklist.md`.
Local files under `src/assets/samples/fix/` are optional snapshot outputs for manual regression checks and are intentionally not tracked by git.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for release history and [RELEASE.md](RELEASE.md) for the local release checklist. The latest post-release closeout is documented in [docs/release-1.0.29-post-release.md](docs/release-1.0.29-post-release.md).

## How Gemini Watermark Removal Works

### The Gemini Watermarking Process

Gemini applies watermarks using standard alpha compositing:

$$watermarked = \alpha \cdot logo + (1 - \alpha) \cdot original$$

Where:
- `watermarked`: The pixel value with the watermark.
- `α`: The Alpha channel value (0.0 - 1.0).
- `logo`: The watermark logo color value (White = 255).
- `original`: The raw, original pixel value we want to recover.

### The Reverse Solution

To remove the watermark, we solve for `original`:

$$original = \frac{watermarked - \alpha \cdot logo}{1 - \alpha}$$

By capturing the watermark on a known solid background, we reconstruct the exact Alpha map and apply the inverse formula to restore the original pixels with zero loss.

## Detection Rules

The engine uses layered detection to locate and verify watermarks:

1. **Size catalog lookup** — matches image dimensions against Gemini's known output sizes to predict watermark size and position.
2. **Local anchor search** — refines the predicted position by scanning pixel data around the expected watermark region.
3. **Restoration validation** — confirms the detected watermark is real before applying removal, avoiding false positives.

Default watermark configurations:

| Condition | Watermark Size | Right Margin | Bottom Margin |
| :--- | :--- | :--- | :--- |
| Larger Gemini outputs | 96×96 | 64px | 64px |
| Smaller Gemini outputs | 48×48 | 32px | 32px |

## Project Structure

```text
gemini-watermark-remover/
├── bin/                   # Published CLI entrypoint (`gwr`)
├── public/
│   ├── index.html         # Entry page for official site / userscript / internal preview
│   ├── dev-preview.html   # Internal browser preview harness kept for local debugging
│   └── tampermonkey-worker-probe.*  # Probe pages for userscript/debug flows
├── skills/
│   └── gemini-watermark-remover/    # Distributable agent skill bundle
├── src/
│   ├── assets/            # Calibration assets and regression samples
│   ├── cli/               # CLI argument parsing and file workflows
│   ├── core/              # Watermark math, scoring, and restoration
│   ├── page/              # Page-side runtime for Gemini page integration
│   ├── sdk/               # Advanced/internal SDK surface
│   ├── shared/            # Shared DOM, blob, and session helpers
│   ├── userscript/        # Userscript entrypoints and browser hooks
│   ├── workers/           # Worker runtime
│   ├── app.js             # Internal single-image preview harness entry point
│   └── utils.js           # Shared browser helpers for the internal preview page
├── tests/                 # Unit, regression, packaging, and smoke tests
├── scripts/               # Local automation and debug launchers
├── dist/                  # Build output directory
├── build.js               # Build script
└── package.json
```

## Architecture Overview

- `src/core/` contains watermark detection, candidate selection, restoration metrics, and the reverse-alpha removal pipeline.
- `src/userscript/`, `src/page/`, and `src/shared/` implement the real Gemini page integration, including preview replacement plus copy/download interception.
- `src/cli/` and `bin/gwr.mjs` expose file-oriented local automation.
- `skills/gemini-watermark-remover/` provides a distributable Skill that stays on the CLI boundary instead of importing repository internals directly.
- `src/sdk/` remains available for advanced/internal integrations, but it is no longer the primary public entrypoint.

---

## Limitations

- Only removes **Gemini visible watermarks** <small>(the semi-transparent logo in bottom-right)</small>
- Supports both **image** and **video** watermark removal — video processing is available via the [online tool](https://geminiwatermarkremover.io/video)
- Does not remove invisible/steganographic watermarks. <small>[(Learn more about SynthID)](https://support.google.com/gemini/answer/16722517)</small>
- Designed for Gemini's current visible watermark pattern <small>(validated against this repo through April 2026)</small>

## Legal Disclaimer

This project is released under the **MIT License**.

The removal of watermarks may have legal implications depending on your jurisdiction and the intended use of the images. Users are solely responsible for ensuring their use of this tool complies with applicable laws, terms of service, and intellectual property rights.

The author does not condone or encourage the misuse of this tool for copyright infringement, misrepresentation, or any other unlawful purposes.

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM THE USE OF THIS SOFTWARE.**

## Credits

This project is a JavaScript port of the [Gemini Watermark Tool](https://github.com/allenk/GeminiWatermarkTool) by Allen Kuo ([@allenk](https://github.com/allenk)).

The Reverse Alpha Blending method and calibrated watermark masks are based on the original work © 2024 AllenK (Kwyshell), licensed under MIT License.

## Related Links

- [Gemini Watermark Tool](https://github.com/allenk/GeminiWatermarkTool)
- [Removing Gemini AI Watermarks: A Deep Dive into Reverse Alpha Blending](https://allenkuo.medium.com/removing-gemini-ai-watermarks-a-deep-dive-into-reverse-alpha-blending-bbbd83af2a3f)

## License

[MIT License](./LICENSE)

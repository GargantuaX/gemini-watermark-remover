# Gemini Watermark Remover

Remove watermarks from Gemini AI-generated images using **Reverse Alpha Blending** — a mathematically exact algorithm, not AI inpainting. 100% local processing, nothing is uploaded.

## Quick Start

```bash
# Install dependencies (npm or pnpm)
npm install
# or: pnpm install

# Start dev server with live rebuild (http://localhost:4173)
npm start
```

That's it. Open your browser at `http://localhost:4173`.

## Other Commands

```bash
# Production build (outputs to dist/)
npm run build

# Serve the production build locally
npm run serve

# CLI — remove watermark from a file
node bin/gwr.mjs remove input.png --output output.png
```

## How It Works

Gemini applies watermarks using alpha compositing:

```
watermarked = α × logo + (1 - α) × original
```

By capturing the watermark on a known background, we reconstruct the exact alpha map and invert the formula:

```
original = (watermarked - α × logo) / (1 - α)
```

This gives pixel-perfect restoration with zero hallucination.

## Watermark Detection

| Image size | Watermark | Position |
|---|---|---|
| Larger Gemini outputs | 96×96 px | 64px from bottom-right |
| Smaller Gemini outputs | 48×48 px | 32px from bottom-right |

## SDK Usage

```javascript
import { removeWatermarkFromImageDataSync } from './src/sdk/index.js';

const result = removeWatermarkFromImageDataSync(imageData);
console.log(result.meta.applied, result.meta.decisionTier);
```

Node.js:

```javascript
import { removeWatermarkFromFile } from './src/sdk/node.js';

const result = await removeWatermarkFromFile('input.png', { outputPath: 'output.png' });
```

## Userscript

The build also outputs a Tampermonkey userscript at `dist/userscript/gemini-watermark-remover.user.js`.

Install it in Tampermonkey to automatically remove watermarks from images directly on [gemini.google.com](https://gemini.google.com).

## Limitations

- Only removes Gemini's visible semi-transparent logo watermark
- Does not remove invisible/steganographic watermarks (SynthID)

## License

[MIT](./LICENSE) — Credits to [Allen Kuo](https://github.com/allenk) for the original Reverse Alpha Blending method.

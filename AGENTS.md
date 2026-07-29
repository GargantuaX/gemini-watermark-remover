# AGENTS.md

## Best-Effort Product Principle

- Treat best-effort processing as the minimum product guarantee: when the input is available and processing can run, return the best result the current system can produce.
- A result with visible residuals or minor imperfections is preferable to returning the unchanged input or no result.
- Low confidence, incomplete catalog coverage, or a quality warning should not by themselves block output. Use the most plausible validated/fallback strategy, produce the result, and surface the uncertainty as non-blocking metadata or UI copy.
- Do not tell users to refresh or retry when repeating the same action is not expected to change the outcome. Retry guidance is allowed only when there is a concrete, recoverable state change and the user can take an actionable step.
- Reserve hard failure for cases where processing truly cannot run or no usable input/output can be produced; do not use failure as a substitute for a best-effort result.

## Debug Workflow

### Allenk Upstream Reference

- The local fork of allenk/GeminiWatermarkTool is at `${GWR_ALLENK_ROOT}`.
- Local-only path variables are configured in `.env`; use `.env.example` as the public template.
- When learning or comparing upstream watermark catalog specs, alpha maps, video rules, FDnCNN behavior, or CLI behavior, prefer this local fork over temporary clones or remote README-only assumptions.
- Treat upstream specs as candidate priors until they are verified against this repo's sample scoring, crop sheets, and output residual gates.

### Data-Driven Watermark Investigation

- When user-provided samples show obvious watermarks being skipped or poorly removed, treat the first task as pattern discovery, not threshold tuning.
- Derive the watermark geometry and rendering rules from the samples before changing removal heuristics:
  - exact anchor position (`x/y`, right/bottom margins)
  - watermark size and aspect
  - subpixel offset / scale drift
  - alpha map shape and alpha strength
  - background-dependent compositing behavior
- Build batch reports and visual artifacts from the sample set:
  - full image list with dimensions and scores
  - bottom-right crop sheets
  - candidate-position overlays when debugging detection
  - before/after crops for every changed strategy
- Prefer improving candidate localization and alpha estimation over loosening safety/protection gates.
- Safety gates are a final fallback. If a visible watermark is skipped, first ask whether the selected position/size/alpha candidate is wrong or incomplete.
- Do not generalize from a single image when the user supplied a sample set. Cluster samples by size, anchor, background, and residual behavior, then make the smallest algorithm change supported by that cluster.
- When residual artifacts remain after mathematically valid inverse alpha removal, do not assume stronger inpaint, preview-only priors, or subpixel sweeps are safe production fixes. First verify whether the real alpha edge profile / antialiasing model differs from the current template, and keep any visual cleanup evidence-gated.

## Deployment Note

- The active local/debugging build surface is the generated `dist/` directory.
- Keep deployment assumptions aligned with the current repo contents.

### Gemini Image Size / Watermark Catalog

Use this catalog when checking watermark size and anchor regressions against Gemini image outputs.

Current code expectation:

- `0.5K` preview outputs use a `48x48` watermark with `32px` right/bottom margins.
- `1K`, `2K`, and `4K` preview/full outputs use a `96x96` watermark with `64px` right/bottom margins.
- New reported anchor type: exact `1K` / `2K` / `4K` catalog sizes also consider a secondary `96x96` candidate with `192px` right/bottom margins. Keep the canonical `64px` anchor first; the `192px` anchor must remain evidence-gated by candidate validation.
- Known confirmed local exception: `2816x1536` uses `96x96` with `192px` right/bottom margins (`2k-new-margin` in `src/core/geminiSizeCatalog.js`).
- The local catalog also keeps a confirmed `1408x768` 16:9 `1K` variant.

#### Gemini 3.1 Flash Image Preview

| Aspect ratio | 512 resolution | 0.5K tokens | 1K resolution | 1K tokens | 2K resolution | 2K tokens | 4K resolution | 4K tokens |
|---|---|---:|---|---:|---|---:|---|---:|
| **1:1** | 512x512 | 747 | 1024x1024 | 1120 | 2048x2048 | 1680 | 4096x4096 | 2520 |
| **1:4** | 256x1024 | 747 | 512x2048 | 1120 | 1024x4096 | 1680 | 2048x8192 | 2520 |
| **1:8** | 192x1536 | 747 | 384x3072 | 1120 | 768x6144 | 1680 | 1536x12288 | 2520 |
| **2:3** | 424x632 | 747 | 848x1264 | 1120 | 1696x2528 | 1680 | 3392x5056 | 2520 |
| **3:2** | 632x424 | 747 | 1264x848 | 1120 | 2528x1696 | 1680 | 5056x3392 | 2520 |
| **3:4** | 448x600 | 747 | 896x1200 | 1120 | 1792x2400 | 1680 | 3584x4800 | 2520 |
| **4:1** | 1024x256 | 747 | 2048x512 | 1120 | 4096x1024 | 1680 | 8192x2048 | 2520 |
| **4:3** | 600x448 | 747 | 1200x896 | 1120 | 2400x1792 | 1680 | 4800x3584 | 2520 |
| **4:5** | 464x576 | 747 | 928x1152 | 1120 | 1856x2304 | 1680 | 3712x4608 | 2520 |
| **5:4** | 576x464 | 747 | 1152x928 | 1120 | 2304x1856 | 1680 | 4608x3712 | 2520 |
| **8:1** | 1536x192 | 747 | 3072x384 | 1120 | 6144x768 | 1680 | 12288x1536 | 2520 |
| **9:16** | 384x688 | 747 | 768x1376 | 1120 | 1536x2752 | 1680 | 3072x5504 | 2520 |
| **16:9** | 688x384 | 747 | 1376x768 | 1120 | 2752x1536 | 1680 | 5504x3072 | 2520 |
| **21:9** | 792x168 | 747 | 1584x672 | 1120 | 3168x1344 | 1680 | 6336x2688 | 2520 |

#### Gemini 3 Pro Image Preview

| Aspect ratio | 1K resolution | 1K tokens | 2K resolution | 2K tokens | 4K resolution | 4K tokens |
|---|---|---:|---|---:|---|---:|
| **1:1** | 1024x1024 | 1120 | 2048x2048 | 1120 | 4096x4096 | 2000 |
| **2:3** | 848x1264 | 1120 | 1696x2528 | 1120 | 3392x5056 | 2000 |
| **3:2** | 1264x848 | 1120 | 2528x1696 | 1120 | 5056x3392 | 2000 |
| **3:4** | 896x1200 | 1120 | 1792x2400 | 1120 | 3584x4800 | 2000 |
| **4:3** | 1200x896 | 1120 | 2400x1792 | 1120 | 4800x3584 | 2000 |
| **4:5** | 928x1152 | 1120 | 1856x2304 | 1120 | 3712x4608 | 2000 |
| **5:4** | 1152x928 | 1120 | 2304x1856 | 1120 | 4608x3712 | 2000 |
| **9:16** | 768x1376 | 1120 | 1536x2752 | 1120 | 3072x5504 | 2000 |
| **16:9** | 1376x768 | 1120 | 2752x1536 | 1120 | 5504x3072 | 2000 |
| **21:9** | 1584x672 | 1120 | 3168x1344 | 1120 | 6336x2688 | 2000 |

#### Gemini 2.5 Flash Image

| Aspect ratio | Resolution | Tokens |
|---|---|---:|
| 1:1 | 1024x1024 | 1290 |
| 2:3 | 832x1248 | 1290 |
| 3:2 | 1248x832 | 1290 |
| 3:4 | 864x1184 | 1290 |
| 4:3 | 1184x864 | 1290 |
| 4:5 | 896x1152 | 1290 |
| 5:4 | 1152x896 | 1290 |
| 9:16 | 768x1344 | 1290 |
| 16:9 | 1344x768 | 1290 |
| 21:9 | 1536x672 | 1290 |

### Fixed Tampermonkey / Gemini Environment

- Fixed Chrome profile: `.chrome-debug/tampermonkey-profile`
- Fixed CDP port: `9226`
- Default proxy: `http://127.0.0.1:7890`
- Production userscript artifact: `dist/userscript/gemini-watermark-remover.user.js`

Platform notes:

- macOS launcher uses `/usr/bin/open -na "Google Chrome.app" --args ...`
- macOS default Chrome app lookup:
  - `/Applications/Google Chrome.app`
  - `~/Applications/Google Chrome.app`
- Override Chrome location on any platform with `GWR_DEBUG_EXECUTABLE_PATH`

### Open the Fixed Profile

- Shell launcher: `./scripts/open-fixed-chrome-profile.sh`
- Node launcher: `node scripts/open-tampermonkey-profile.js --cdp-port 9226`
- CMD launcher: `.\scripts\open-fixed-chrome-profile.cmd`
- PowerShell launcher: `.\scripts\open-fixed-chrome-profile.ps1`

Default behavior:

- Reuse the fixed Chrome profile
- Open remote debugging on port `9226`
- Use the local proxy
- The plain Node launcher opens the Tampermonkey Chrome Web Store page by default unless `--url` is passed
- The shell wrapper opens the local probe page on `http://127.0.0.1:4173/tampermonkey-worker-probe.html` by default and still forwards extra args
- The current CMD/PowerShell wrappers are fixed shortcuts to the same local probe page; they do not forward additional CLI args

macOS quick path:

1. Run `pnpm build`
2. Start the local artifact server, for example `pnpm dev`
3. Open the fixed profile with `./scripts/open-fixed-chrome-profile.sh --url https://gemini.google.com/app`
4. If you do not want the repo's default proxy, pass `--proxy off`

### One-Time Manual Setup

Do this only once in the fixed profile:

1. Install Tampermonkey.
2. Enable `Allow User Scripts` in Chrome extension details.
3. Keep Developer Mode enabled.
4. Install `public/tampermonkey-worker-probe.user.js` when local probe validation is needed.
5. Install or reinstall the production userscript from the current local build server when validating the latest build.
   - Use the active local build server URL printed by `pnpm dev`
   - `pnpm dev` starts probing from `http://127.0.0.1:4173/` and will auto-increment if that port is occupied
   - A previously confirmed request-layer debugging session used `http://127.0.0.1:4317/userscript/gemini-watermark-remover.user.js`, but do not assume that is still current

### Local Build and Services

- Production build: `pnpm build`
- Local dist server: `pnpm dev`, `pnpm serve`, or the active local build server for this worktree
- Default `pnpm dev` start port: `http://127.0.0.1:4173/`
- Actual active dev server port may be higher; always trust the current `pnpm dev` console output
- Probe smoke test: `pnpm probe:tm`
- Installed userscript freshness check: `pnpm probe:tm:freshness`
- Open fixed profile: `pnpm probe:tm:profile`

Current `pnpm probe:tm` behavior:

- in `run` mode it now attempts a Tampermonkey userscript freshness preflight first
- if freshness returns `stale`, `probe:tm` must fail before running the worker/bridge smoke page
- if the freshness preflight context itself is unavailable, for example:
  - fixed `9226` profile is not open
  - the CDP endpoint is unavailable
  - the editor is mid-navigation
  then the preflight is recorded as `skipped` and the smoke flow continues
- this keeps stale installs fail-fast without making `probe:tm` hard-depend on a manually opened editor page

### Installed Userscript Freshness Check

When real-page behavior does not match the current worktree, verify the installed userscript body, not just the script name or `@version`.

- Same `@version` does not guarantee the fixed profile is running the latest build.
- A stale Tampermonkey script can still show:
  - `[Gemini Watermark Remover] Initializing...`
  - `[Gemini Watermark Remover] Ready`
  - while silently missing newer request-layer fixes such as the download sticky intent window
- Preferred check:
  1. Open the Tampermonkey editor for `Gemini NanoBanana 图片水印移除`
  2. Run `pnpm probe:tm:freshness`
  3. Read `.artifacts/tampermonkey-freshness/latest.json`
- If you just reinstalled the userscript and the check still reports `stale`, refresh the already-open Tampermonkey editor page once, then run `pnpm probe:tm:freshness` again.
- Current command behavior:
  - exits `0` when the installed userscript exactly matches the local `dist/userscript/gemini-watermark-remover.user.js`
  - exits `1` when the installed userscript is stale or mismatched
  - compares full normalized source hashes, not just `@version`
  - also reports whether expected markers are missing
- Current report path:
  - `.artifacts/tampermonkey-freshness/latest.json`
- Manual fallback if needed:
  1. Compare the installed source against `dist/userscript/gemini-watermark-remover.user.js`
  2. Confirm the installed source contains the expected newer markers before continuing real-page debugging
     - `DEFAULT_DOWNLOAD_STICKY_WINDOW_MS`
     - `downloadStickyUntil`
     - `getActionContextFromIntentGate(intentGate = null, candidate = null)`
  3. Refresh the real Gemini page after the fixed profile is updated

### Real Gemini Page Validation

Target page:

- `https://gemini.google.com/app`

Minimum validation flow:

1. Run `pnpm build`
2. Reinstall the latest userscript in the fixed profile
3. Open the real Gemini page
4. Check that the console shows:
   - `[Gemini Watermark Remover] Initializing...`
   - `[Gemini Watermark Remover] Ready`
5. If bridge validation is needed, trigger from page side:
   - `gwr:userscript-process-request`
   - Expect `gwr:userscript-process-response`

Current confirmed request-layer behavior on the fixed profile:

- `copy` can populate the strict original binding path through real `rd-gg` asset fetches and then place a processed `image/png` onto the clipboard
- `download` stays on Gemini's native `c8o8Fe -> gg-dl -> rd-gg-dl` export flow; the userscript does not cancel the click
- the userscript keeps explicit download intent alive for Gemini download asset URLs long enough to catch late `rd-gg-dl` requests on the native chain
- If the original URL binding is unavailable when the required download/original request arrives, the action must fail closed with:
  - `无法获取原图，请刷新页面后重试`
- A successful real-page full-size download currently produces:
  - a browser `download` event
  - a blob-backed saved file such as `Gemini_Generated_Image_vusbaevusbaevusb.png`
  - local detector result `skipReason=no-watermark-detected`

### Real-Page Pixel Verification

- Single image compare: `pnpm probe:real-page:compare`
- All ready images on the current Gemini page: `pnpm probe:real-page:compare --all`
- Latest batch summary:
  - `.artifacts/real-page-pixel-compare/latest-summary.json`
- Complex-figure validation checklist:
  - `docs/complex-figure-verification-checklist.md`

Use this when page-level screenshots are not enough and you need original blob pixel metrics for `before/after`.

Do not rely on hardcoded sample counts here. Treat `.artifacts/real-page-pixel-compare/latest-summary.json` as the source of truth for the current worktree.

Current checked local summary in this worktree:

- artifact timestamp: `2026-04-06T07:25:13.120Z`
- `total = 1`
- the recorded ready image landed at:
  - `afterSpatial ~= -0.2707`
  - `afterGradient ~= 0.1075`

Historical multi-image baselines from earlier fixed-profile sessions should be treated as dated reference points, not as the current expected batch shape.

### Current Preview Display Path

Current production expectation for real Gemini preview display is:

- keep request-layer preview interception enabled as an early processing source and observability point
- do not assume Gemini's final displayed `blob:` image is fully controlled by the page `fetch` hook chain
- keep `src/shared/pageImageReplacement.js` as the production display path for preview replacement
- treat request-layer preview handling as supportive, but rely on page-level replacement to guarantee the user-visible preview is actually de-watermarked

Current real-page success signal for preview display:

- the displayed image reaches:
  - `data-gwr-page-image-state=ready`
  - `data-gwr-watermark-object-url=blob:...`
- detector on that processed overlay blob reports:
  - `skipReason=no-watermark-detected`

### Confirmed Performance Pitfalls

When the user reports "this version became much slower", check these first before touching the core algorithm:

1. Page runtime / page bridge did not actually install into the real Gemini page.
   - Symptom:
     - Real page silently falls back to the userscript sandbox / slow main-thread path.
     - Earlier bad runs showed `removeWatermarkMs` on the order of `11s ~ 13s` for a single preview image.
   - Verify:
     - Reinstall the latest userscript from the current active build server
       - use the actual userscript URL from the active `pnpm dev` server
       - the server starts probing from `http://127.0.0.1:4173/` and may auto-increment
     - Refresh the real page
     - Confirm console reaches `Initializing...` and `Ready`
     - Confirm preview images continue to `page image process success`

2. Preview queue blocked by a `blob:` image that is not renderable yet.
   - Symptom:
     - One image gets stuck at `state=processing`
     - The element often has `complete=false`, `naturalWidth=0`, `naturalHeight=0`
     - Later images stop progressing because the serial queue is effectively wedged
   - Current fix:
     - `src/shared/pageImageReplacement.js` now waits for renderability and retries instead of processing immediately
   - If this regresses, inspect the waiting / retry path before changing watermark math

3. Preview-anchor cleanup accidentally doing expensive work that is not adopted.
   - Symptom:
     - Main thread is busy, but output source does not include a successful `+subpixel`
     - Earlier bad runs showed `subpixelRefinementMs ~= 80ms ~ 115ms` on strong preview samples with no accepted subpixel shift
   - Current fix:
     - preview-anchor cleanup no longer runs the expensive subpixel refinement path
     - It relies on cheaper preview edge cleanup instead
   - Rule:
     - Do not re-enable preview-anchor subpixel search unless you have a real fixture that proves the accepted result is both safer and materially better

### Confirmed Quality / Performance Tradeoff

For strong real-page preview samples, the current strategy is:

- Skip expensive preview-anchor subpixel refinement
- Use stronger preview edge cleanup only when:
  - the image is a preview-anchor style match
  - spatial residual is already low enough to be safe
  - gradient residual is still strong enough to justify cleanup

Why this exists:

- It lowers strong-sample real-page residual gradient from roughly `0.53` to roughly `0.30`
- It keeps preview-anchor cleanup latency low by avoiding no-op subpixel sweeps
- It accepts some spatial drift to stay within a safe residual envelope rather than overfitting and risking content damage

### Confirmed Download / Copy Integration Constraint

Do not re-enable the old active direct-download click hook in production.

Confirmed real-page failure mode on `https://gemini.google.com/u/1/app/d3cd7d14852ecd3b?pageId=none`:

- When the userscript intercepts `下载完整尺寸的图片` at capture time and calls `preventDefault()/stopImmediatePropagation()`, Gemini's own download flow is blocked before it can issue its native `c8o8Fe` / `rd-gg-dl` chain.
- In that state, the userscript only has the earlier history bootstrap bindings from `hNvQHb`.
- Current real `hNvQHb` bindings are mostly preview-style `gg/...=s0` URLs, not the final native download URL.
- Falling back to those preview bindings makes the userscript attempt its own fetch path too early, which previously surfaced as:
  - `Original image is unavailable for download processing`
  - or `Failed to fetch image: 403`
  - followed by the user-facing retry alert

There is a second real-page failure mode to keep in mind even after removing the active click hook:

- Gemini's native full-size download chain can be much slower than the base intent window.
- On the 2026-04-04 fixed-profile trace:
  - `c8o8Fe` request started about `+50ms` after click
  - `c8o8Fe` response returned about `+22.4s`
  - final `rd-gg-dl ... image/png` arrived about `+23.9s`
- A plain `5000ms` intent window expires far too early, so the passive request hook stops processing before the final full-size image request appears.

Current correct production shape:

- keep the intent gate for copy / download gestures
- keep Gemini RPC discovery hooks (`hNvQHb`, `c8o8Fe`, related batchexecute responses)
- keep generated-asset fetch interception for the native request flow
- let Gemini continue its own click handling
- do not block the button just to start a parallel userscript-only download path
- keep a download-specific sticky intent window for Gemini download asset URLs
  - current default: `30000ms`
  - release it after terminal success/failure so it does not leak across actions

Current confirmed real-page result with the passive native chain plus sticky download intent:

- `下载完整尺寸的图片` produced a browser `download` event
- the resulting download used a blob URL generated from the page flow
- the saved file was `3136 x 1344`, about `5.4MB`, sha256 `4e945813779b58a5eda0f01f7973c924210477a84ae1d3826138f57b60eb691f`
- local detector on that downloaded file reported:
  - `skipReason = no-watermark-detected`
  - `originalSpatialScore ~= -0.4096`
  - `originalGradientScore ~= 0.0826`
- no `无法获取原图，请刷新页面后重试` alert appeared
- `复制图片` wrote an `image/png` item to the clipboard without a failure alert
- the request-layer verification report path is session-specific; do not assume an older dated artifact still exists in the current worktree

### Worker Debug Flow

For reproduction only. This is not the default production path.

1. In the real page DevTools, run:
   - `localStorage.setItem('__gwr_force_inline_worker__', '1')`
2. Refresh `https://gemini.google.com/app/...`
3. Inspect console logs

Current confirmed result:

- The real Gemini page can attempt to start the inline worker.
- The worker crashes during startup because of CSP / runtime restrictions.
- Production must stay on the main-thread path by default.
- The force flag is for debugging only.

### Worker Success / Failure Criteria

Do not treat `new Worker(blobUrl)` returning without an immediate throw as proof that the worker is usable.

Current correct criteria:

- If `[Gemini Watermark Remover] Worker acceleration enabled` appears, that only means startup was attempted.
- The worker is only considered usable if the startup handshake succeeds.
- If `[Gemini Watermark Remover] Worker initialization failed, using main thread: ...` appears, safe fallback has happened.
- After fallback, the page should still continue with:
  - `page image process start`
  - `page image process strategy`
  - `page image process success`

### Known Constraints

- Direct `new Worker(blobUrl)` from Tampermonkey DOM sandbox is not reliable in the current environment.
- The real Gemini page has CSP restrictions, so worker assumptions must not be based on probe-page success.
- Runtime flags must be read across `unsafeWindow`; reading only the userscript sandbox `globalThis/localStorage` is insufficient.

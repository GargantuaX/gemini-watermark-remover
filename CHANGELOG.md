# Changelog

## 1.0.38 - 2026-08-11

### Video CLI and SDK

- Estimate total video frames from duration and the sampled frame rate instead of treating the capped metadata probe as the full video. CLI and SDK progress totals now reflect the complete export more accurately.
- Treat `--video-timeout-ms` as an inactivity timeout, independent from the fixed Playwright page setup timeout. Long exports may run past the configured interval while frames continue to advance, while genuinely stalled exports still fail with actionable progress context.
- Report throttled video phase, percentage, frame-count, and AI reuse progress on stderr; expose the existing encoder bitrate control through `--video-bitrate-mbps`; and publish the progress callback contract in the TypeScript declarations.

### Verification

- Added unit, CLI, browser-level SDK, TypeScript consumer, and video metadata regressions covering inactivity resets, true stalls, frame estimates, progress forwarding, output throttling, bitrate validation, and option forwarding.
- Revalidated the production build and complete automated test suite after merging PRs #135 and #137.
- Processed a 240-frame repository video with a 60-second inactivity timeout: the export completed in 61.9 seconds because progress continued through 240/240 frames. A 100 ms timeout failed during a real no-progress interval as expected.
- Based on the original implementation and tests contributed by @shantz1 in PR #110.

## 1.0.37 - 2026-08-10

### Watermark Removal

- Restored full-strength alpha removal for positively signed exact 96px/R192 `20260520` watermarks. This reduces the visible residuals reported in issue #101 without weakening the anchor or source-evidence gates.
- Preferred the full-strength candidate when a localized positive source witness provides stronger independent evidence than the candidate's circular self-template score, and kept the accepted result out of the later aggressive downgrade path.
- Preserved the issue #123 inverse-polarity safety guard. Inputs without positive signed source evidence remain on the conservative path instead of risking a dark-hole artifact.

### Verification

- Reprocessed all six issue #101 reporter samples: five positive-source samples selected full-strength alpha and were visually clean in the review sheet; the inverse-polarity sample remained conservatively limited.
- Added deterministic exact 96px/R192 fixtures and regressions for full-strength selection, candidate ranking, source-witness arbitration, and inverse-polarity rejection.
- Revalidated the focused watermark suites, the complete automated test suite, and pull-request CI after the fix.

## 1.0.36 - 2026-08-10

### Video processing

- Use the V1 alpha family by default for projected video watermarks smaller than 40px. This improves the reported 848x478 / 32px case in issue #119 while preserving the existing multi-shape selection path for 40px and larger marks.
- Preserve an explicit SDK or backend-script `adaptiveAlpha: true` choice after the video page reapplies its automatic export preset.

### Validation

- Added focused regressions for the 32px projected watermark and the SDK adaptive-alpha control override.
- Reprocessed the issue #119 source with the website preset and no explicit alpha profile: fixed-anchor confidence fell from `0.3795` to `0.0366` (90.4% reduction), with a passing residual verdict.
- Revalidated all five registered real-video fixtures, including existing 48px and Veo text-watermark paths; all five passed.

## 1.0.35 - 2026-08-10

### Watermark Removal Safety

- Prevented the exact 96px/R192 white source-witness rescue from accepting inverted or effectively zero signed spatial evidence solely because unsigned edges are strongly localized. This avoids the visible black-hole damage reproduced from issue #123 on structured dark content.
- Kept the existing dark-polarity exception narrowly gated: it still requires an independently selected drifted dark-polarity trial plus strong, localized signed spatial evidence at the exact anchor.
- On the reported issue #123 image, the guarded path now preserves the source pixels and reports `no-watermark-detected`. This is a damage-prevention hotfix, not a claim that the watermark itself is reliably removed; the issue remains open for additional samples and profile discovery.

### Verification

- Added a deterministic exact-96/R192 regression reproducing the negative-polarity edge collision and asserting that the unsafe rescue is rejected.
- Revalidated the issue #120 exact-96/R192 positive regressions, the focused watermark processor suites, and the complete main-branch CI workflow after the safety gate change.

## 1.0.34 - 2026-08-08

### Watermark Removal

- Added evidence-gated V2 and exact 96px/R192 source-witness rescues so all 14 reported issue samples produce a best-effort result instead of leaving three visibly watermarked inputs unchanged.
- Preferred a conservative exact white-polarity R192 candidate when a shifted dark-polarity candidate would damage nearby content; on the reported text-overlap sample, the newly clipped pixel ratio drops from about 3.55% to 0.
- Preserved visible-residual and uncertainty metadata for imperfect results. This release improves coverage and content safety but does not claim to eliminate the remaining variable contour residuals.

### Verification and Tooling

- Added a repeatable GitHub issue verification command that reuses the authenticated `gh` keyring session, verifies Release asset SHA-256 digests, caches samples, and generates reviewable JSON, Markdown, CSV, and opt-in comment drafts.
- Hardened diagnostic alpha-profile admission so relative score improvement alone cannot promote a visibly dirty candidate; absolute residual visibility, signed halo, and alpha-band checks must also pass.
- Revalidated all 14 reported assets after the merge: watermark detection reached 14/14, the strict end-to-end quality gate passed 3/14, and the alpha-profile diagnostic admitted 0 production candidates.

## 1.0.33 - 2026-07-29

### CLI Packaging

- Expanded the optional `sharp` peer range to include tested 0.35.x releases, removing the peer warning for consumers that install the current `sharp` release alongside the CLI.

### Verification

- Ran the packed CLI against the same 2816x1536 Gemini sample with `sharp` 0.34.5 and 0.35.3; both versions produced byte-identical PNG output.
- Repacked the updated package and confirmed a fresh consumer can install it with `sharp` 0.35.3 without peer dependency warnings.
- Re-ran the SDK smoke suite and the complete automated test suite after the metadata change.

## 1.0.32 - 2026-07-29

### Watermark Removal

- Expanded evidence-gated handling for recent 48px and 96px Gemini watermark variants, including dark-polarity marks, non-standard anchors, and difficult low-texture backgrounds.
- Added bounded local alpha-gain search and a dedicated large-margin 48px profile rescue so strong detections can reduce visible halos without changing the validated anchor.
- Improved best-effort candidate discovery when watermark presence is plausible but no candidate reaches the strict confirmation tier, while retaining explicit uncertainty metadata.

### Quality and Diagnostics

- Evaluated final post-repair pixels with polarity-aware clipping, halo, texture, and residual-localization signals instead of relying only on the initially selected alpha trial.
- Added final-state decision-path metadata and regression coverage for dark-polarity artifacts, local alpha calibration, candidate ranking, and best-effort selection.
- Expanded the external sample benchmark and cleanliness research tools used to compare the current pipeline with prior releases on real Gemini outputs.
- Prevented zero-sized or stale Gemini image nodes from occupying the serial preview queue, so later renderable images can still reach the processed `ready` state after page reloads.

## 1.0.31 - 2026-07-18

### Watermark Removal

- Fixed issue #111 by preserving the exact 96px Gemini watermark profile at the confirmed 192px right/bottom anchor, including the 2816x1536 output family.
- Kept the canonical 64px anchor first and required candidate evidence before accepting the secondary 192px anchor.
- Improved processing coverage for related new-margin and outline variants while keeping difficult visible-residual cases best-effort instead of loosening content-protection gates.

### Copy and Download

- Hardened bound-preview fallback so a failed preview fetch can recover without overwriting the original-image slot used by full-size downloads.
- Isolated clipboard fallback results from native full-size download bindings and retained passive interception of Gemini's native download chain.
- Added a repeatable real-page probe covering clipboard dimensions, full-size download dimensions, Gemini RPC discovery, asset requests, dialogs, and request failures.

### Quality

- Verified the current fixed-profile flow with a processed 1408x768 clipboard image and a processed 2816x1536 native download, with no failure dialogs or request failures.
- Re-ran the complete automated suite and production build after the issue #111 and request-layer changes.

## 1.0.30 - 2026-07-16

### Watermark Removal

- Improved exact-96px Gemini watermark selection by preferring a materially cleaner same-anchor Top-N result only when watermark evidence and content-damage signals remain within validated bounds.
- Added outline-aware alpha profiles and conservative contour repair for newer light- and dark-outline watermark variants.
- Kept the canonical restoration when an alternative offers only a marginal score change, preventing stronger alpha choices from reintroducing a visible dark star.

### Quality and Diagnostics

- Added bottom-level imperfection signals for visible residuals and possible content damage so clients can expose best-effort quality without encouraging meaningless retries.
- Added same-anchor candidate review and reporting tools together with regression coverage for candidate ordering, outline variants, deterministic selection, and release metadata.
- Re-verified the final production path across the expanded recent-sample set, the contrast set, the full automated suite, and a fresh production build without new out-of-scope candidate changes.

## 1.0.29 - 2026-07-07

### SDK / CLI

- Fixed the npm CLI video path reported in issue #104 by packaging the local video preview page, video app bundle, FDnCNN models, and browser ONNX runtime assets.
- Served the packaged video preview page over a temporary local HTTP URL so the browser runtime can fetch model assets reliably instead of failing from a `file://` page.
- Kept explicit `--video-denoise-backend` CLI selections from being overwritten by automatic video presets.

### Video

- Addressed issue #97 by adding BT.709 limited-range color metadata to video exports to improve color grading consistency and player compatibility.
- Added source-structure protection around video watermark cleanup to reduce edge and background-transition artifacts.

### Release

- Published `v1.0.29` to npm, GitHub Release, the hosted userscript, and the official website fallback extension zip.
- Verified the website extension zip at `72891819454366cf5fc9f21e561bc6a0cf0179a34d57cb076e96aa2ae774ff31 / 1092502` bytes.
- Closed issue #97 as addressed in `v1.0.29`; Chrome Web Store propagation remains the only post-release waiting item.

### Quality

- Added package and SDK regression coverage for packed video assets, local preview-page serving, and packaged CLI video export.

## 1.0.28 - 2026-06-28

### Watermark Removal

- Refactored the Gemini image pipeline into explicit detection, alpha, repair, and evaluation layers while preserving the current production behavior.
- Added evidence-gated decision-path tracing so accepted and skipped watermark candidates can be audited without changing the pixel path.

### Quality

- Re-verified the 2026-06-23 to 2026-06-24 online Gemini sample set at `978/1000 = 97.80%` pass rate with no newly failing samples against the Phase 5 baseline.
- Added strict quality monitoring, visual review packs, alpha ablation reports, and GitHub v1.0.27 comparison sheets for investigating perfect-rate changes.
- Confirmed the observed `perfect strict` drop is primarily a stricter damage/texture metric coverage change, not a visible regression against GitHub v1.0.27 outputs.

## 1.0.27 - 2026-06-20

### Video

- Improved relocated portrait Veo watermark cleanup by selecting the legacy alpha profile for the newly observed `20260619.mp4` sample.
- Tuned the relocated review preset to lower residual watermark edges while keeping the cleanup bounded to the detected footprint.

### Quality

- Added `20260619.mp4` as a committed video regression fixture so the relocated portrait watermark behavior is pinned in tests.
- Added ROI-level alpha regression coverage and re-verified the five-sample video regression batch with all samples passing.

## 1.0.26 - 2026-06-19

### Watermark Removal

- Added a conservative text-overlap path for 96px Gemini image watermarks that sit on top of high-contrast text, allowing weak-alpha cleanup without erasing the underlying lettering.
- Fixed the `20260618-2.png` bug sample by selecting the canonical `96/64/64` anchor with `standard+gain+text-overlap+validated` instead of skipping it as `no-watermark-detected`.

### Release

- Made the Chrome extension zip packaging deterministic by fixing zip entry timestamps, so repeated `pnpm package:extension` runs produce the same hash for the same contents.
- Re-verified the external Gemini watermark sample set and bundled sample set after the text-overlap change; only `bug\20260618-2.png` changed behavior, with no increase in raw visible, calibrated visible, or metric-risk counts.

## 1.0.25 - 2026-06-17

### Watermark Removal

- Fixed the 2026-06-16 Gemini sample by keeping canonical 96px bottom-right evidence ahead of weak inward candidates and avoiding dark over-removal on textured backgrounds.
- Added conservative smooth-prior cleanup for shallow off-catalog residuals so light star overlays can be reduced without turning into dark artifacts.

### Quality

- Added regression coverage for the new bug image and bounded weak-residual outcomes.
- Re-verified the external Gemini watermark sample set with 188 of 190 samples passing and no newly failing samples.
- Published this patch as `v1.0.25` because the earlier npm `1.0.24` tarball is immutable and predates this bug fix.

## 1.0.24 - 2026-06-16

### Video

- Improved Veo text watermark detection for stable low-contrast vertical videos, including the newly added Tibet scenery sample.
- Kept detection conservative by requiring repeated default-template evidence plus at least one strong frame before accepting a low-contrast text watermark.

### Quality

- Added regression coverage for intermittent low-contrast Veo text evidence.
- Re-verified the new 720p, 720x1280, and Veo text sample set through the local video UI preset exporter.
- Published the npm package, GitHub Release assets, userscript artifact, and Chrome extension fallback zip for `v1.0.24`.
- Synced the official website to the `1.0.24` package and release assets. A website-only follow-up now version-tags the video runtime script URL so the fixed runtime path cannot keep serving stale cached JavaScript after a site deploy.

## 1.0.23 - 2026-06-14

### Video

- Fixed the browser video ONNX runtime shape mismatch reported in issue #77 by routing small watermarks to the 104px FDnCNN model and standard or unknown watermarks to the 200px model.
- Added fixed-shape ROI planning and resize fallbacks so every detected video watermark candidate feeds the ONNX runtime with the selected model's expected input size.
- Moved the runtime padding fallback into the video export layer so direct video exports avoid the same fixed-shape mismatch.
- Fixed portrait video framing in the local before/after preview so the bottom-right watermark region remains visible during review.
- Reduced Veo text watermark detection search work and added cooperative progress yielding so the video page stays responsive while detection is running.

### Quality

- Added regression coverage across the video watermark catalog, including standard, inset, compact, scaled, portrait, 4K, oversized 8K, and undersized-canvas ROI cases.
- Added release-safety checks to prevent the video app and website runtime bundle from returning to a fixed 200px model or hard-coded 64px padding path.
- Clarified the release scope for public notes: current image defaults and guarded image improvements are releasable, while video cleanup remains review-scoped until the release gates promote it.

## 1.0.22 - 2026-06-14

### Watermark Removal

- Added support for the newly observed near-official Gemini large-margin anchor reported by the 2026-06-13 sample.
- Added evidence-gated small-anchor relocation for visible fixed-local residuals and stronger mid-alpha tuning for high-confidence 48px large-margin residuals.
- Kept unsafe-looking remaining candidates out of the production path when lower residual scores produced visible dark edge artifacts.

### Quality

- Added regression coverage for the 2026-06-13 anchor, small-anchor relocation, and stronger mid-alpha selection.
- Re-verified the external Gemini watermark sample set with 186 of 189 samples passing and no newly failing samples.

## 1.0.21 - 2026-06-12

### SDK / CLI

- Added the `@pilio/gemini-watermark-remover/video` SDK entrypoint for local video watermark removal with injectable processors and a Playwright-backed preview-page default.
- Re-exported video helpers from the Node SDK and added CLI routing for `.mp4`, `.webm`, and `.mov` inputs.
- Added CLI flags for video page selection, denoise backend selection, timeout control, and low-confidence export handling.

### Video

- Added the browser AI cleanup path used by the local video preview exporter, including adjacent-frame reuse telemetry for faster repeated watermark regions.

## 1.0.20 - 2026-06-09

### SDK

- Moved `sharp` out of hard runtime dependencies and into an optional peer so browser consumers do not install the native Node image codec unless they need the CLI default codec.
- Documented that CLI users should install `sharp` when they want the built-in file decoder/encoder path.

## 1.0.19 - 2026-06-09

### SDK

- Published the latest Gemini watermark candidate detection improvements as a fresh npm SDK release because `1.0.18` is already present on npm.
- Kept the SDK packaging surface unchanged so downstream consumers can depend on the public package instead of maintaining a vendored copy.

### Quality

- Reused the already verified `1.0.18` algorithm build as the baseline for this npm-only release.

## 1.0.18 - 2026-06-08

### Watermark Removal

- Reworked the fixed-core Gemini watermark path around prioritized position and alpha candidates instead of multipass or visual post-processing.
- Added diff-derived artifact scoring so alpha selection can account for residual edges, halo, and newly clipped pixels without treating before/after diff as the only signal.
- Added 2026-06-08 regression samples covering the latest Gemini 48px watermark variants and refined weak-alpha outcomes.

### Chrome Extension

- Moved official extension release packages to the top-level `release/` directory while keeping the unpacked local debugging extension in `dist/extension`.

### Quality

- Documented the fixed-core algorithm findings and the next evolution plan for candidate ranking reports, gold-set manifests, and catalog-driven maintenance.
- Re-verified the release with full tests, production build, sample artifact generation, and extension package generation.

## 1.0.17 - 2026-06-07

### Watermark Removal

- Added support for the newly observed Gemini 48px watermark at the 96px right/bottom anchor.
- Added prioritized alpha-strength selection so the new weak-alpha chain tries 60% strength first and falls back to the standard 100% chain when needed.
- Kept legacy 96px and 192px-margin candidates evidence-gated so older and full-size outputs continue to resolve safely.

### Quality

- Added 2026-06-07 regression samples covering the weak-alpha 48px/96px-anchor output.
- Re-verified the current sample benchmark set with all 23 samples passing.

## 1.0.16 - 2026-05-21

### Chrome Extension

- Added the extension version to the bottom of the popup so installed builds are easier to identify.
- Reused fullscreen image session state after Gemini copy actions so refreshed `blob:` images no longer trigger visible page re-processing.
- Kept copy fallback results in the full-quality session cache so later copy and download actions can reuse the processed image.

### Quality

- Added regression coverage for fullscreen dialog action hints, clipboard fallback caching, and refreshed fullscreen image reuse.

## 1.0.15 - 2026-05-20

### Watermark Removal

- Added support for the updated Gemini 96px watermark alpha map and 192px right/bottom anchor used by newly observed 2K outputs.
- Tightened candidate selection so clean canonical 48px/96px anchors are preserved when smaller preview-anchor candidates leave stronger residual edges.
- Kept preview-anchor cleanup eligible for its own warp and edge-cleanup refinement path, avoiding regressions on real Gemini preview fixtures.

### Quality

- Added regression fixtures for the new Gemini watermark position, updated 2026-05-20 sample images, and the alternate 96px alpha template.
- Re-verified full tests, production build, and sample benchmark coverage for the current sample set.

## 1.0.14 - 2026-05-03

### Userscript

- Switched userscript auto-update metadata to the GitHub Release `latest/download` permalink so the update endpoint is controlled by the published release assets.

### Quality

- Updated regression coverage to pin the release-backed userscript auto-update URL.

## 1.0.13 - 2026-05-03

### Userscript

- Added hosted `@downloadURL` and `@updateURL` metadata so userscript managers can auto-update from the official userscript permalink.

### Quality

- Added regression coverage for the hosted userscript auto-update metadata.

## 1.0.12 - 2026-04-29

### Chrome Extension

- Updated the extension popup to use English copy by default for Chrome Web Store submission.
- Refined the popup visual design with Apple-style spacing, softer panels, a unified blue accent, inline action icons, and a GitHub feedback entry.
- Shortened the extension name to `Gemini Watermark Remover` in the Manifest V3 metadata.

### Quality

- Rebuilt the Chrome extension release artifacts and re-verified the extension build, compatibility adapter, and active cleanup coverage.

## 1.0.11 - 2026-04-17

### Chrome Extension

- Added a Manifest V3 Chrome extension build that packages the shared userscript runtime through a Tampermonkey-compatible adapter.
- Added the extension popup with an enable toggle, official website link, general watermark remover link, and GitHub issue feedback entry.
- Added a versioned extension release package flow that generates a zip, sha256 checksum, and `latest-extension.json` for GitHub Release and official website downloads.

### SDK

- Added the new public `runtime-browser` entrypoint as a side-effect-free blob processor for downstream browser consumers.
- Added the new public `runtime-userscript` entrypoint as a narrow userscript runtime wrapper with explicit initialize/process/remove/dispose methods.
- Published type declarations for both runtime entrypoints so packed TypeScript consumers can import them directly.

### Tooling

- Updated package exports and published file allowlists so `pnpm pack` now includes the runtime entrypoints and their required shared implementation files.
- Added isolated consumer smoke coverage that validates runtime subpath imports and rejects deep private imports from `@pilio/gemini-watermark-remover/src/...`.
- Documented Chrome extension installation in both README files and added release checklist coverage for extension artifacts.

### Quality

- Added runtime-focused regression tests for side-effect-free browser imports, default processing options, detached runtime methods, and userscript worker fallback behavior.
- Added extension build, compatibility, popup, release metadata, and README ordering regression coverage.
- Re-verified the release with targeted page/runtime/sdk/package-consumer tests and a fresh publish dry run for version `1.0.11`.

## 1.0.10 - 2026-04-07

### Userscript

- Let preview request interception fail open for passive preview fetches so Gemini can keep rendering the original page image when request-layer preview processing fails.
- Hardened fullscreen Gemini copy so stale processed object URLs no longer fall back to CSP-blocked `fetch(blob:...)`; the clipboard hook now reprocesses Gemini's own clipboard image payload when needed.
- Stabilized fullscreen preview replacement by reusing session-stored preview source bindings for blob-backed dialog images and prioritizing fullscreen images ahead of queued preview work.

### Quality

- Added regression coverage for stale fullscreen clipboard object URLs, fullscreen preview source reuse from the shared image session, and fullscreen-priority page replacement queue behavior.
- Re-verified the release with a fresh full automated test run, production build, and Tampermonkey userscript freshness check against the fixed profile.

## 1.0.9 - 2026-03-31

### Userscript

- Removed Gemini-original source confirmation from the local app flow and now rely on the user to decide whether the input should be processed.
- Simplified local status messaging so skipped cases are described as "no removable watermark detected" instead of claiming Gemini-specific source knowledge.
- Removed the unused `exifr` dependency after deleting the abandoned original-source validation path.

### Tooling

- Disabled browser caching for the local dev static server so the active `pnpm dev` port, starting from `http://127.0.0.1:4173/`, is less likely to keep serving stale bundles during watermark validation work.

### Quality

- Added regression coverage to ensure the app no longer imports Gemini original-source validation helpers and locale files no longer ship the removed origin-confirmation copy.
- Re-verified the release with a fresh full test run, sample benchmark, and production build.

## 1.0.8 - 2026-03-31

### Userscript

- Fixed Gemini origin confirmation for metadata-stripped inputs by falling back to actual image dimensions instead of EXIF-only width and height fields.
- Expanded the recognized Gemini size catalog to cover the current tall and wide sample outputs used by the project fixtures.
- Softened the non-confirmed origin status copy so confirmed removal quality is no longer described as "not Gemini" when the source is only unconfirmed.

### Tooling

- Removed the local-browser dependency from `benchmark:samples` and `export:samples`; both scripts now decode and encode fixtures through the Node pipeline directly.
- Updated local regression fixtures and tests to use the remaining WebP sample set as the active release baseline.

### Quality

- Added regression coverage for no-EXIF origin fallback and Node-only sample decoding/export flows.
- Re-verified the release with full automated tests, SDK smoke validation, sample benchmark/export runs, and a production build.

## 1.0.7 - 2026-03-31

### Userscript

- Improved watermark anchor recovery for near-official portrait outputs and preview-sized Gemini images that drift away from the default anchor.
- Stopped harmful extra removal passes earlier when the first pass already clears the watermark-shaped residual well enough.
- Kept preview-anchor cleanup on the cheaper edge-cleanup path instead of reintroducing expensive no-op subpixel sweeps.

### Quality

- Added regression coverage for anchor recovery, pass stopping, and release metadata consistency.
- Added the single-pass versus multipass tradeoff note used during this release cycle.

## 1.0.6 - 2026-03-30

### Userscript

- Unified Gemini preview, fullscreen, clipboard, and download actions around a shared image-session and `actionContext` pipeline.
- Reused processed session resources across surfaces so fullscreen copy/download can resolve the same processed image identity more reliably.
- Removed deprecated userscript legacy intent aliases from the active runtime path to simplify release behavior before shipping.

### Quality

- Added focused coverage for `actionContext`, shared image-session resolution, and userscript hook behavior after the release cleanup.
- Re-verified the release with a fresh full test run and production build.

## 1.0.2 - 2026-03-20

### Userscript

- Simplified Gemini page-image replacement into smaller shared helpers for processing preparation, mutation routing, source dispatch, and result application.
- Simplified Gemini original-blob acquisition so preview urls use rendered capture, download urls use background fetch, and inline urls stay on direct fetch.
- Simplified Gemini download interception to keep only in-flight request deduplication instead of retaining processed response cache entries.

### Quality

- Added focused regression coverage for preview/original source dispatch, candidate image collection, mutation scheduling, and self-written processed blob detection.
- Re-verified the release with full automated tests and a fresh production build.

## 1.0.1 - 2026-03-19

### Userscript

- Added in-page Gemini preview replacement so page images can be processed before manual download.
- Routed preview fetching through `GM_xmlhttpRequest` when available, avoiding fallback CORS failures in userscript sandboxes.
- Added a restrained `Processing...` overlay during preview processing and made failures fail-open so the original image remains visible.
- Hardened overlay lifecycle cleanup to avoid stale fade callbacks removing a new processing state.

### Shared Display Path

- Kept page-image replacement behavior aligned with the userscript preview pipeline and processing-state UX.

### Quality

- Added regression tests for userscript version sync and processing overlay lifecycle edge cases.
- Verified release build with full automated test coverage and production bundle generation.

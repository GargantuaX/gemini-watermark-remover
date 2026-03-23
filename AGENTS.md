# AGENTS.md

## Debug Workflow

### Fixed Tampermonkey / Gemini Environment

- Fixed Chrome profile: `D:\Project\gemini-watermark-remover\.chrome-debug\tampermonkey-profile`
- Fixed CDP port: `9226`
- Default proxy: `http://127.0.0.1:7890`
- Production userscript artifact: `dist/userscript/gemini-watermark-remover.user.js`

### Open the Fixed Profile

- PowerShell launcher: `.\open-fixed-chrome-profile.ps1`
- Node launcher: `node scripts/open-tampermonkey-profile.js --cdp-port 9226`

Default behavior:

- Reuse the fixed Chrome profile
- Open remote debugging on port `9226`
- Use the local proxy
- Open the local probe page by default, or a passed target URL

### One-Time Manual Setup

Do this only once in the fixed profile:

1. Install Tampermonkey.
2. Enable `Allow User Scripts` in Chrome extension details.
3. Keep Developer Mode enabled.
4. Install `public/tampermonkey-worker-probe.user.js` when local probe validation is needed.
5. Install or reinstall the production userscript from `http://127.0.0.1:4173/userscript/gemini-watermark-remover.user.js` when validating the latest build.

### Local Build and Services

- Production build: `pnpm build`
- Local dist server: dev mode or an existing `http://127.0.0.1:4173/`
- Probe smoke test: `pnpm probe:tm`
- Open fixed profile: `pnpm probe:tm:profile`

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

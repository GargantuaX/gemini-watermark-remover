import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package.json should expose the expected local script entrypoints', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  const expectedScripts = {
    clean: 'node scripts/clean.js',
    'clean:all': 'node scripts/clean.js --include-profile',
    'test:serial': 'node --test --test-concurrency=1 tests/**/*.test.js',
    'convert:samples:webp': 'node scripts/convert-samples-to-webp.js',
    'diagnose:same-anchor-imperfection': 'node scripts/run-same-anchor-imperfection-review.js',
    'report:same-anchor-imperfection': 'node scripts/summarize-same-anchor-imperfection-review.js',
    'probe:tm': 'node scripts/tampermonkey-smoke.js run',
    'probe:tm:setup': 'node scripts/tampermonkey-smoke.js setup',
    'probe:tm:freshness': 'node scripts/tampermonkey-freshness.js',
    'probe:tm:profile': 'node scripts/open-tampermonkey-profile.js',
    'probe:real-page:compare': 'node scripts/real-page-pixel-compare.js',
    'probe:real-page:copy-download': 'node scripts/real-page-copy-download-probe.js',
    'benchmark:userscript': 'node scripts/userscript-benchmark.js',
    'compare:allenk-v2': 'node scripts/create-allenk-v2-comparison-report.js',
    'release:image-validation': 'node scripts/run-image-release-validation.js',
    'release:image-evidence': 'node scripts/create-image-release-evidence.js',
    'release:image-quality-gate': 'node scripts/check-image-release-evidence.js',
    'release:readiness': 'node scripts/create-release-readiness-report.js',
    'release:quality-gate': 'pnpm release:image-quality-gate && pnpm compare:allenk-v2 && pnpm release:readiness -- --scope image-defaults --fail-on-not-ready',
    'release:goal-audit': 'node scripts/create-release-goal-audit-report.js',
    'release:ci-check': 'node scripts/check-github-ci.js --workflow ci.yml --commit HEAD --fail-closed',
    'release:preflight': 'pnpm build && pnpm test && pnpm package:extension && pnpm release:quality-gate && pnpm release:goal-audit -- --fail-on-incomplete && pnpm release:ci-check',
    'analyze:video-residual': 'node scripts/analyze-video-residual.js',
    'score:video-candidates': 'node scripts/score-video-watermark-candidates.js',
    'sweep:veo-text-cleanup': 'node scripts/sweep-veo-text-cleanup.js',
    'score:video-output-residual': 'node scripts/score-video-output-residual.js',
    'benchmark:video-crops': 'node scripts/video-crop-benchmark.js',
    'report:video-crops': 'node scripts/report-video-crop-benchmark.js',
    'diagnose:video-lowbody': 'node scripts/diagnose-video-lowbody-regression.js',
    'lab:video-frames': 'node scripts/run-video-frame-backend-lab.js',
    'lab:video-alpha-profile': 'node scripts/run-video-alpha-profile-lab.js',
    'lab:video-temporal-residual': 'node scripts/run-video-temporal-residual-lab.js',
    'fit:video-alpha-shape': 'node scripts/fit-video-alpha-shape.js',
    'gate:video-alpha-shape': 'node scripts/gate-video-alpha-shape-candidates.js',
    'gate:video-denoise': 'node scripts/gate-video-denoise-candidates.js',
    'gate:video-delivery': 'node scripts/run-video-delivery-gate.js',
    'report:video-alpha-policy-evidence': 'node scripts/create-video-alpha-policy-evidence-report.js',
    'report:video-frame-lab': 'node scripts/report-video-frame-lab-sweep.js',
    'lab:allenk-fdncnn-onnx-frames': 'node scripts/run-allenk-fdncnn-onnx-frame-lab.js',
    'report:video-review-pack': 'node scripts/create-video-review-pack.js',
    'report:video-review-index': 'node scripts/create-video-review-index.js',
    'report:video-review-screenshot': 'node scripts/create-video-review-screenshot.js',
    'report:video-review-thumbnail-sheet': 'node scripts/create-video-review-thumbnail-sheet.js',
    'report:video-dashboard-screenshot': 'node scripts/create-video-review-screenshot.js --html .artifacts/video-delivery-dashboard/latest-video-dashboard.html --output .artifacts/video-delivery-dashboard/latest-video-dashboard.png --report .artifacts/video-delivery-dashboard/latest-video-dashboard-screenshot.json',
    'report:video-review-decision': 'node scripts/create-video-review-decision-report.js',
    'report:video-acceptance-quickstart': 'node scripts/create-video-acceptance-quickstart.js',
    'report:video-pending-review-decision': 'node scripts/create-video-pending-review-decision.js',
    'report:video-alpha-policy-review-pack': 'node scripts/create-video-alpha-policy-review-pack.js',
    'report:video-light-polish-review-pack': 'node scripts/create-video-light-polish-review-pack.js',
    'report:video-polish-sweep-review-pack': 'node scripts/create-video-polish-sweep-review-pack.js',
    'report:video-delivery-dashboard': 'node scripts/create-video-delivery-dashboard.js',
    'report:video-goal-status': 'node scripts/create-video-goal-status-report.js',
    'report:video-delivery-bundle': 'node scripts/create-video-delivery-bundle.js',
    'verify:video-delivery-bundle': 'node scripts/verify-video-delivery-bundle.js',
    'export:video-backend': 'node scripts/export-video-backend-variant.js',
    'export:allenk-fdncnn-onnx-video': 'node scripts/export-allenk-fdncnn-onnx-video.js',
    'export:allenk-fdncnn-onnx-frame-video': 'node scripts/export-allenk-fdncnn-onnx-frame-video.js',
    'report:allenk-fdncnn-onnx-video-evidence': 'node scripts/create-allenk-fdncnn-onnx-video-evidence.js',
    'report:allenk-catalog-audit': 'node scripts/create-allenk-catalog-audit.js',
    'report:allenk-video-binary-analysis': 'node scripts/create-allenk-video-binary-analysis.js',
    'export:video-ui-preset': 'node scripts/export-video-ui-preset.js',
    'verify:video-ui-preset-output': 'node scripts/verify-video-ui-preset-output.js',
    'verify:video-ui-preset-batch': 'node scripts/verify-video-ui-preset-batch.js',
    'verify:video-regression-samples': 'pnpm verify:video-ui-preset-batch -- --manifest tests/fixtures/video-regression-samples/gemini-video-regression-samples.json --output-dir .artifacts/video-regression-samples --no-screenshots --fail-on-residual',
    'render:video-comparison-grid': 'node scripts/render-video-comparison-grid.js',
    'cli:smoke': 'node bin/gwr.mjs --help',
    'extract:allenk-fdncnn': 'node scripts/extract-allenk-fdncnn-model.js',
    'export:allenk-fdncnn-onnx': 'node scripts/export-allenk-fdncnn-onnx.js',
    'smoke:allenk-fdncnn-onnx-runtime': 'node scripts/smoke-allenk-fdncnn-onnx-runtime.js',
    'report:allenk-fdncnn-browser-spike': 'node scripts/create-allenk-fdncnn-browser-spike-report.js',
    'report:allenk-fdncnn-runtime-seam': 'node scripts/create-allenk-fdncnn-runtime-seam-report.js'
  };

  for (const [scriptName, command] of Object.entries(expectedScripts)) {
    assert.equal(
      pkg.scripts?.[scriptName],
      command,
      `expected package.json to expose ${scriptName}`
    );
  }
});

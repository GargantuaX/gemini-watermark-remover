# 1.0.46 release candidate

Status: preparation; not published or deployed.

This image-only change fixes candidate selection for a strongly localized V2
medium watermark at the existing 48px/R73 geometry on 768×1376 images. A weaker
candidate elsewhere could previously leave the source mark and add a dark star.
The change keeps the existing canonical priority, signed source evidence,
localization controls, and completed-output evaluation.

The #172 attachment now selects the correct region without changing pixels
outside that region. Fine outline residuals remain and output quality is mixed.
The attachment's unedited provenance is unknown; controlled fixtures reproduce
the selection defect. #171 and #165 are not claimed fixed. Video processing and
SDK interfaces are unchanged from 1.0.45.

The public website is a separate release surface and remains pinned to 1.0.44.
It must be upgraded and verified separately. No Chrome Web Store submission,
package publication, GitHub Release, or website deployment is part of preparation.

## Validation

- Core change: 2c3b5ee02befc3610d41219692d3f0c0a9b7a73a, merged via #174.
- PR and main CI passed; full suite: 1,738 passed, 33 skipped, 0 failed.
- Focused tests and review details: `docs/code-review-log.md`.
- Frozen 424-image input inventory: all hashes verified. Candidate-versus-1.0.45
  output comparison completed on de-ci: all 424 outputs are pixel-identical.
  Historical unknown-source and unresolved quality observations remain retained.
- Versioned 1.0.46 candidate build, 8 SDK smoke checks, and extension packaging
  passed on de-ci. The actual tarball's #172 output matches the reviewed output;
  its 97 packaged JS files match the current source tree.
- Image quality, scoped release readiness, and release goal audit passed.
  Final 1.0.46 candidate CI is pending. Earlier full-suite CI covers the unchanged
  core snapshot; it does not replace final candidate CI.

Candidate tarball SHA-256:
`17f0329c42d433219568b1fd801aa3d6c171885353bf1a8b07badc2a9cae9cce`.

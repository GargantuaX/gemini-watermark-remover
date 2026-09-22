# GitHub 跟进回复（2026-09-21，已发送）

2026-09-21 用户确认后发送；发送前重新核对评论，未重复发帖。

- #167：https://github.com/GargantuaX/gemini-watermark-remover/issues/167#issuecomment-5762976985
- #165：https://github.com/GargantuaX/gemini-watermark-remover/issues/165#issuecomment-5762977623
- #164：https://github.com/GargantuaX/gemini-watermark-remover/pull/164#issuecomment-5762978486
- #138：https://github.com/GargantuaX/gemini-watermark-remover/pull/138#issuecomment-5762979422

## Issue #167

Thanks for reporting this. The attachment is an image, so I cannot yet reproduce the video quality loss or distinguish whole-frame encoding changes from cleanup near the watermark.

Please attach the original Gemini/Veo video and the processed video, and tell us which entry point you used (website, CLI, or extension), any non-default export settings, and one or two timestamps showing the loss. Please also mention whether the input was resized, re-encoded, or edited before processing; unknown history is fine to state.

There is an existing PR investigating texture loss near the watermark, but we have not established that it explains your report. This issue is not confirmed fixed.

## Issue #165

Thanks for clarifying the sources. I have recorded the first reference as coming from the watermark-removal website, and the second female portrait as a direct Gemini download. The original JPEG was already separately confirmed as a direct download. There is no need to upload these files again.

The first reference will not be used as an untouched clean control. The original JPEG and the female portrait remain unresolved quality cases; source confirmation does not mean a fix has been validated or released.

## PR #164

I checked commit `3d4d4b34bb3f6a0f2522af49b2cc8f64d907d30b` in an isolated checkout. The catalog and denoise-runtime tests pass: 14 passed, 0 failed. The new 160px candidate fits the 200px model with padding 20, and the existing projected candidates remain present.

Before treating this as validated 4K support, please provide the untouched source video supporting the 160px, right/bottom 198/265 geometry, its provenance, and a before/after comparison at representative timestamps. We also need checks that the new candidate does not displace the existing 144px anchors on those inputs or damage structured background content. The current tests establish catalog/model compatibility, not detection and removal quality.

## PR #138

I checked commit `5a7750df9f6e4790e4ae3b392ed4ff15ce8569ac` in an isolated checkout. All 33 cleanup-backend tests pass. I did not find a confirmed defect in the scoped code review, but I have not independently reproduced the three-video quality comparison in the description.

Please make the original comparison clips and export settings available, including the flat and textured cases and the timestamps shown. A clip where surrounding texture changes over time would also help verify that cleanup strength changes do not introduce visible flicker. We should retain the content-detail comparisons rather than judging success only by watermark-template residual scores.

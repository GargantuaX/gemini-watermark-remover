# 1.0.45

Release date: 2026-09-22.

## Changes since 1.0.44

- Stop current detection/export and cancel pending videos. No partial result is
  downloaded, and a new selection can be processed after cleanup completes.
- Select or drop multiple videos in the standalone video interface. Videos are
  processed sequentially, with per-file status and automatic downloads.
- Add videos to an active batch without replacing the video currently being
  processed. A failed file does not stop the remaining queue.
- Preserve the existing manual workflow when selecting a single video while idle.
- Include ONNX Runtime 1.26.0's complete license and upstream third-party notices
  alongside the redistributed runtime assets.

The image-removal algorithm, video-removal algorithm, and SDK interfaces are
unchanged from 1.0.44. The public website is a separate repository and deployment;
batch-video support in this release is scoped to the open-source standalone
interface. The website keeps its existing single-video workflow. Adding a website
batch interface is not a prerequisite for this release. A future website SDK
upgrade can adopt underlying fixes without exposing batch processing.

Batch processing runs one video at a time for convenience; it does not accelerate
AI inference. Processing can be CPU- and memory-intensive. Performance on 4K,
long videos, large queues, and mobile devices has not been validated.

Thanks to @kavyp12 for the batch-video contribution in #109.

## Release verification

- Released from commit `112505cfb093eb385d6aa906294654b3b642a3f4` via #170.
- Final candidate CI: [35741605580](https://github.com/GargantuaX/gemini-watermark-remover/actions/runs/35741605580), passed.
- npm publication: [35742178936](https://github.com/GargantuaX/gemini-watermark-remover/actions/runs/35742178936), passed. The public `latest` tag was verified as `1.0.45`.
- The public npm integrity matches the accepted tarball; its SHA256 is
  `3dc6d2a491241aae434e6ec585e0dd562534331eb303f54050205b2ec6ea7968`.
  A fresh registry installation passed CLI help and image-data SDK smoke checks.
- The GitHub release contains the package, userscript, both extension ZIPs,
  checksums, and extension version metadata. The latest extension download
  metadata was verified as `1.0.45`.
- The website was not deployed and remains pinned to SDK `1.0.44`. No Chrome Web
  Store submission was made. These separate distribution steps are not claimed
  complete by this release.
- The reviewed local-path cleanup was integrated before publishing. Unaccepted
  image-quality experiments were excluded. Existing 4K, long-video, mobile, and
  watermark-quality limitations remain separate follow-up work.

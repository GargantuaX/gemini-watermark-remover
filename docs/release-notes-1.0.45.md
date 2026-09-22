# 1.0.45 release candidate

Status: prepared for validation; not published.

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

# 1.0.45 release candidate

Status: prepared for validation; not published.

## Changes since 1.0.44

- Select or drop multiple videos in the standalone video interface. Videos are
  processed sequentially, with per-file status and automatic downloads.
- Add videos to an active batch without replacing the video currently being
  processed. A failed file does not stop the remaining queue.
- Preserve the existing manual workflow when selecting a single video while idle.
- Include ONNX Runtime 1.26.0's complete license and upstream third-party notices
  alongside the redistributed runtime assets.

The image-removal algorithm, video-removal algorithm, and SDK interfaces are
unchanged from 1.0.44. The public website is a separate repository and deployment;
this release does not itself add a batch-video interface to the website.

Thanks to @kavyp12 for the batch-video contribution in #109.

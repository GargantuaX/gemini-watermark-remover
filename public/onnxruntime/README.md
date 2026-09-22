# ONNX Runtime redistribution

These runtime assets come from `onnxruntime-web@1.26.0` (Microsoft ONNX Runtime).
The checked-in WASM files match that package byte for byte. JavaScript module
contents match after line-ending normalization; `ort-wasm-simd-threaded.js`
is the same module as upstream `ort-wasm-simd-threaded.mjs`, renamed for the
existing runtime loader.

- Source: https://github.com/microsoft/onnxruntime/tree/v1.26.0
- License: [MIT](./LICENSE), copied from the upstream v1.26.0 tag.
- Upstream notices: [ThirdPartyNotices.txt](./ThirdPartyNotices.txt), copied
  unchanged from the same tag. This is the upstream aggregate notice file;
  it is not a claim that every listed component is present in these WASM builds.

Keep these notices with redistributed runtime assets. The npm package includes
the plain WASM and Asyncify variants; the static build also contains JSEP assets.

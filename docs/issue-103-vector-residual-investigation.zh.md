# Issue #103 平面/矢量图残留调查记录

日期：2026-07-07

## 结论

Issue #103 的样本不是定位错误。当前检测能命中 `2048x2048` 图像中的 `96x96` 水印，位置为 `x=1760, y=1760`，右/下边距均为 `192px`，并使用 `alphaVariant=20260520`。问题出在去水印后的可见残留仍然明显，而且损伤门判定为不安全。

已落地的生产修复是 fail-closed：当 `20260520` 的 `96px / 192px` 新边距候选在处理后仍有可见残留，且损伤评估不安全时，流水线返回 `applied=false` 与 `skipReason=visible-residual-unsafe-damage`，避免输出一张带明显鬼影或新增损伤的图片。

第二阶段调查显示，暂时不应把 palette snap、局部区域平滑、MRF 类视觉修补直接放进生产路径。它们在单样本上可以降低部分梯度指标，但没有清除可见残留，并且会在硬边界、细线、局部图形上引入错误重建。

## 复现样本

本地样本：

- `.artifacts/issue-103/issue-103-input.png`
- sha256: `09f83c1dcf29f6be88f7bc28dbfb8c2412dd427f038b02e14be051a8313ed6ff`

修复前 CLI 处理结果：

- `applied=true`
- `source=standard+located-aggressive`
- `position={ x:1760, y:1760, width:96, height:96 }`
- `config={ logoSize:96, marginRight:192, marginBottom:192, alphaVariant:"20260520" }`
- `residualVisibility.visible=true`
- `visibleGradientResidual=true`
- `visibleSpatialResidual=true`
- `damage.safe=false`
- `damage.reason=texture`

修复后 CLI 处理结果：

- `applied=false`
- `skipReason=visible-residual-unsafe-damage`
- 保留检测位置、配置、分数、残留可见性与 decision path，便于 UI/CLI/后续调试展示原因。

## 调查证据

### Alpha / profile / localization 扫描

相关产物：

- `.artifacts/issue-103/alpha-profile-small-sweep.json`
- `.artifacts/issue-103/localization-small-sweep.json`
- `.artifacts/issue-103/logo-value-sweep.json`
- `.artifacts/issue-103/channel-logo-sweep.json`

结论：

- 扫描 alpha gain、局部 profile、轻微位移/缩放、logo value 与 RGB logo value 后，没有找到 `visible=false` 且安全的候选。
- 最佳候选仍保留明显残留，只是在不同策略下把残留从亮边、暗边或局部纹理之间转移。

### 合成模型检查

相关产物：

- `.artifacts/issue-103/compositing-model-fit.json`

结论：

- sRGB 正向叠加拟合明显优于 linear RGB。
- sRGB RMSE 约 `2.9393`，linear RGB RMSE 约 `48.6116`。
- 该样本不是线性合成假设导致的失败；当前水印更像是 sRGB alpha 模型下的背景重建问题。

### 视觉修补实验

相关产物：

- `.artifacts/issue-103/flat-nearest-repair-report.json`
- `.artifacts/issue-103/palette-repair-report.json`
- `.artifacts/issue-103/model-fit-palette-repair-report.json`
- `.artifacts/issue-103/model-fit-threshold-sweep.json`
- `.artifacts/issue-103/inverse-palette-snap-report.json`
- `.artifacts/issue-103/palette-mrf-repair-report.json`

结论：

- `inverse-palette-snap` 是目前单样本上指标最好的简单修补，但仍然 `visible=true`。
- 其最佳结果约为 `severity=21.40704`、`gradientResidual=0.2578`、`spatialResidual=0.26759`，仍超过可见阈值。
- MRF/区域平滑可进一步压低梯度残留，但会增加空间残留与区域化错误，不适合直接上线。

### 合成 hard/vector 基准

相关产物：

- `.artifacts/issue-103/synthetic-vector-benchmark/benchmark.json`
- `.artifacts/issue-103/synthetic-vector-benchmark/comparison-sheet.png`

该基准使用已知 ground truth 的平面/矢量图，并故意制造 alpha gain 偏差。结果显示：

- 在大块纯色背景中，palette snap 有时能接近真值。
- 在局部形状只出现在水印区域内部时，即便使用 oracle alpha gain，palette snap 也无法恢复隐藏形状。
- `nested-shapes` case 中 palette snap 的 RMSE 约 `15.46`，明显差于简单反解。

这说明单图 palette/区域重建存在不可观测信息：如果被水印遮住的颜色或形状没有在外圈出现，算法无法可靠知道真实底色。

## 处理建议

短期：

- 保留当前 fail-closed 行为，避免生产输出明显残留或损伤。
- 在 CLI/UI 上将 `visible-residual-unsafe-damage` 解释为“检测到水印，但当前样本属于不安全残留，已保留原图”。
- 不要为了 #103 单样本放宽安全门或上线视觉修补。

中期：

- 请求 issue reporter 提供更多同类 flat/vector 样本，至少覆盖不同背景颜色、局部形状、细线、文字/图标与不同 1K/2K/4K 尺寸。
- 建立 hard/vector 类 fixture 集合，用 before/after crop sheet 与 ground truth/synthetic benchmark 一起评估。
- 若继续研究修补，应优先做“可证明安全的局部常量区域识别”：只在被遮挡区域与外圈连通、且颜色类别可由外圈证明时修复；遇到孤立局部形状时仍 fail-closed。

## 不建议的方向

- 直接降低残留可见性阈值。
- 把 palette snap、nearest fill、MRF smoothing 作为通用后处理上线。
- 从单张 #103 样本泛化 96px / 192px 新边距水印的修复策略。

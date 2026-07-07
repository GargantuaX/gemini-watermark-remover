# Issue 99 Small Preview-Anchor Residual Design

## 背景

Issue #99 报告 `704x1523` 图片在在线站点处理后仍残留可见水印。核实材料已保存到 `.artifacts/issue99/`。当前本地代码可以定位该水印，但处理后在检测框放大图里仍有淡菱形残影。

关键观测：

- 样本尺寸：`704x1523`
- 当前选中水印：约 `27x27`
- 当前锚点：右边距 `22px`、下边距 `26px`
- 当前路径：`standard+preview-anchor+validated+aggressive-located`
- 当前停止原因：`residual-low`
- 当前指标：`processedGradientScore ~= 0.073`，`residualVisibility.visible = false`
- 视觉结论：指标判定偏乐观，淡色几何残影仍可见

## 目标

修复 Issue #99 中的小尺寸 preview-anchor 残留问题，并把它固化为回归用例。修复应尽量小，只覆盖证据支持的候选范围。

成功标准：

- Issue #99 的 `before.png` 经过当前算法处理后，不再出现肉眼可见淡菱形水印残影。
- 新增自动化或半自动化诊断能复现当前失败，并在修复后通过。
- 不降低已有 `src/assets/samples` 基准与相关 preview-anchor 回归表现。
- 不扩大 48/96 主路径的行为面。
- 不引入对漫画线稿、文字边缘、高对比局部纹理的明显误伤。

## 非目标

- 不重写整体水印检测架构。
- 不为单张图片无门控地放宽所有 preview-anchor 阈值。
- 不把 48/96 固定锚点目录规则改成泛化猜测。
- 不启动或依赖本地开发服务。
- 不用真实 Gemini 页面作为本轮修复的必需验证条件。

## 方案

采用“证据门控的小样本修复”。

1. 固化 Issue #99 样本
   - 将 issue 的 before 图作为回归 fixture，或在测试中引用 `.artifacts/issue99/before.png` 的可复制来源。
   - 生成/保留检测框放大图作为人工复核材料。
   - 新增一条针对 `704x1523` 小尺寸 preview-anchor 的测试或诊断脚本。

2. 建立失败判据
   - 当前代码的普通 `residualVisibility.visible` 已经误判为不可见，因此不能只断言该字段。
   - 判据应结合检测框局部残留指标，例如 alpha 边缘带的正/负 halo、局部梯度残留、处理前后模板相关性，或已有 `assessRemovalDiffArtifacts` 能稳定表达的值。
   - 如果纯自动指标不足以覆盖视觉残影，先保留一个诊断报告与放大裁片，再用较窄的数值门槛做回归保护。

3. 最小修复
   - 优先调整小尺寸 preview-anchor 的残留可见性判定或 edge cleanup 触发条件。
   - 作用范围限制为：
     - `selectedTrial.provenance.previewAnchor === true`
     - 水印尺寸约 `24px-32px`
     - 已经通过候选验证，但处理后仍存在低强度几何残影信号
   - 优先修正“残留还可见但流程认为 residual-low”的门控，而不是一开始增强所有 cleanup 强度。

4. 验证
   - 运行 Issue #99 专项测试或诊断。
   - 运行相关核心测试，至少覆盖 candidate selection、pipeline、restoration metrics、sample benchmark 中受影响的部分。
   - 生成 before/after 检测框放大图，人工确认残影消失或明显低于可见水平。
   - 检查 git diff，确保没有夹带 release/distribution 或 `out/` 既有改动。

## 风险与缓解

风险：小尺寸水印靠近手写文字边缘，增强清理可能损坏内容。

缓解：修复只在 preview-anchor、小尺寸、已验证候选、残留信号仍存在时触发，并用已有高对比样本回归测试兜底。

风险：单样本导致过拟合。

缓解：不新增通用 catalog 规则，不把 `704x1523` 当作全局尺寸目录；本轮只处理“已定位但残留可见”的后处理/门控缺口。

风险：自动指标与肉眼残影不完全一致。

缓解：保留可视化裁片作为诊断产物，同时用最能表达该残影的局部指标做测试门槛。

## 实施顺序

1. 新增 Issue #99 回归 fixture 与专项诊断输出。
2. 写出当前失败断言，确认在未修复代码上失败。
3. 调整小尺寸 preview-anchor 残留判定或 cleanup 触发。
4. 跑专项测试和相关核心回归。
5. 复核放大裁片和 diff。

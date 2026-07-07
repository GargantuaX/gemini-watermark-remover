# Issue 103 Vector New-Margin Visible Residual Design

## 背景

Issue #103 报告 `2048x2048` 平面矢量/硬边图形在 CLI `v1.0.28` 处理后仍留下可见 Gemini 星形残影。核实材料已保存到 `.artifacts/issue-103/`。

当前本地工作树可稳定复现：

- 输入：`.artifacts/issue-103/issue-103-input.png`
- 输出：`.artifacts/issue-103/issue-103-current-output.png`
- 放大裁片：`.artifacts/issue-103/issue-103-output-crop-3x.png`
- 原图 sha256：`09f83c1dcf29f6be88f7bc28dbfb8c2412dd427f038b02e14be051a8313ed6ff`
- 当前选中水印：`x=1760, y=1760, width=96, height=96`
- 当前配置：`logoSize=96, marginRight=192, marginBottom=192, alphaVariant=20260520`
- 当前路径：`standard+located-aggressive`
- 当前停止原因：`located-aggressive-edge-cleanup`
- 当前指标：`residualVisibility.visible = true`
- 当前 damage：`safe = false, reason = texture`

关键问题不是检测不到水印，而是引擎已经知道最终结果仍有可见残影且 texture damage 不安全，却仍返回 `applied=true` 并写出处理图。这会把失败包装成成功。

## 目标

第一阶段修复 Issue #103 的错误成功语义：当高风险 `96px / 192px / 20260520` 路径最终仍有可见残影且 damage 不安全时，不应输出假成功结果。

成功标准：

- Issue #103 样本不再返回带明显残影的 `applied=true` 成功结果。
- 元数据明确表达失败原因：`skipReason = visible-residual-unsafe-damage`。
- 已有已验证的 192px margin 样本不被误退，尤其当前确认过的 `2816x1536` 新边距样本。
- 不改变通用 48px、96px canonical、preview-anchor 主路径行为。
- 不启动或依赖本地开发服务，不把真实 Gemini 页面作为本轮必需验证条件。

## 非目标

- 不在第一阶段解决所有 flat-color/vector 图片的视觉残影。
- 不无门控增强 alpha gain、edge cleanup 或 inpaint。
- 不把单张 issue 样本泛化成新的尺寸目录规则。
- 不重写 candidate selector 或 pipeline 架构。
- 不修改发布、distribution、`out/` 或当前工作树中已有的无关改动。

## 方案

采用“两步走”：先 fail-closed 修正假成功，再做 evidence-gated 的视觉质量修复。

### 第一阶段：高风险 unsafe residual fail-closed

新增一个窄门控，作用于候选已经完成处理、即将生成最终结果之前或候选评估阶段：

- 候选是 `96x96`、`192px` 右/下边距、`alphaVariant=20260520`
- 最终残影可见：`residualVisibility.visible === true`
- damage 不安全：`selectedTrial.damage.safe === false` 或最终等价 damage 判定不安全
- 没有更安全且 residual cleared 的替代候选

满足这些条件时，不应继续返回 accepted result。推荐返回 skipped/failed-closed 结果，并保留原始检测证据到 `decisionPath`，便于后续诊断。

推荐原因名：

- `visible-residual-unsafe-damage`

原因名要表达两个事实：水印证据存在，但当前 removal result 不够安全，不能作为成功输出。

### 第二阶段：flat/vector 专项调查

后续单独调查为什么 `20260520` alpha 在这类平面硬边背景上留下暗残影。调查内容：

- 收集或生成同类 flat-color/vector 样本，不从单图直接泛化。
- 生成 bottom-right crop sheet、before/after crop、candidate overlay。
- 对比默认 alpha、`20260520` alpha、gain sweep、edge profile、subpixel/scale drift。
- 优先验证 alpha 边缘 profile / antialiasing 模型是否不匹配。
- 只有当多样本证据支持时，才新增 flat/vector 专用策略。

## 测试策略

1. 新增 Issue #103 专项回归
   - 使用 issue 原图作为 fixture，或在测试说明中固定 artifact 来源。
   - 断言当前样本不会返回 `applied=true` 的假成功。
   - 断言 skip/fail-closed 原因稳定为 `visible-residual-unsafe-damage`。

2. 保护已有新边距成功样本
   - 保留 `2816x1536` 的 `96px / 192px` confirmed exception 成功路径。
   - 保留已有 `20260520` 样本中 residual 已清理或 damage 安全的成功路径。

3. 相关核心回归
   - 运行 candidate evaluation / selector / pipeline / watermark processor 相关测试。
   - 如测试成本过高，至少运行 Issue #103 专项测试和包含 192px new margin 的核心测试片段。

4. 可视化验证
   - 保留 `.artifacts/issue-103/issue-103-output-crop-3x.png` 作为当前失败证据。
   - 如果后续进入第二阶段视觉修复，再生成新的 before/after crop sheet 进行人工复核。

## 风险与缓解

风险：fail-closed 会让某些用户看到“未处理”而不是“有残影但勉强处理”的结果。

缓解：当前结果已经被引擎判定为 visible residual 和 unsafe damage，作为成功输出更糟。失败原因应清晰，便于后续专门修复。

风险：门控过宽导致已知新边距样本误退。

缓解：门控只针对 `96/192/192/20260520`，并同时要求最终 `residualVisibility.visible === true` 与 damage unsafe；用已知 `2816x1536` 样本回归兜底。

风险：第一阶段没有真正去掉残影。

缓解：这是有意拆分。第一阶段先修正产品语义和安全边界；第二阶段再基于样本簇研究 alpha profile，不把猜测修复混进 fail-closed 改动。

## 实施顺序

1. 固化 Issue #103 样本和当前失败断言。
2. 在候选最终接受路径加入窄门控，识别 visible residual + unsafe damage 的高风险新边距结果。
3. 返回 fail-closed meta，并保持检测证据可诊断。
4. 运行 Issue #103 专项测试和 192px new margin 相关回归。
5. 复核 diff，确保只包含本问题所需的测试和逻辑改动。

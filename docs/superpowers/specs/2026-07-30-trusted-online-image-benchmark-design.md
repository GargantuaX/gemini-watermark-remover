# 可信在线图片评测设计

## 背景

当前外部图片评测脚本把样本目录中的每个文件都写成 `expectedGemini: true`。2026-07-30 对最新 119 个在线文件进行人工抽查后确认，21 个 `missed-detection` 中混有普通照片、海报、其他品牌素材和无 Gemini 可见水印的文件。正确跳过这些文件会被误算成漏检，因此当前 `71/119` 不能作为可信的算法通过率，也不应继续用于指导检测阈值。

本设计先修复评测真值和统计口径，不修改水印检测、候选选择或去除算法。

## 目标

- 用独立于被测算法的人工金标定义每个唯一文件是否存在可见 Gemini 水印。
- 分开统计有水印样本的检测与清理效果，以及无水印样本的误处理率。
- 排除重复文件对通过率的重复加权。
- 对无法可靠判断的文件保持 `ambiguous`，不强迫它们进入通过率。
- 使基线比较只发生在同一数据集和同一版金标之间。
- 在可信基线上找出数量最大的真实失败簇，再决定下一轮核心算法改动。

## 非目标

- 本次不修改核心去水印算法。
- 不用当前检测器、残差评分或视觉模型自动生成最终真值。
- 不把 `ambiguous` 自动推断为有水印或无水印。
- 不把本地外部图片提交到仓库。
- 不建立通用图片来源识别器。

## 方案选择

### 采用：人工金标 + 自动复核排序

人工目测和文件来源证据决定最终标签。自动检测、轮廓残差和内部残差只用于排序待复核队列，不能覆盖人工标签。

### 未采用：检测器集成自动标注

该方案速度快，但仍然让被测系统给自己判分，会继承当前漏检和误检偏差。

### 未采用：视觉模型作为最终裁判

视觉模型可辅助复核，但对小尺寸、低对比度水印存在非确定性，同时引入网络、成本和模型版本漂移，不适合作为可复现发布门禁。

## 金标清单

外部数据集使用独立 JSON 清单。清单可以保存在 `.artifacts/` 下，不提交外部图片或机器绝对路径。每个条目通过相对路径和 SHA-256 双重绑定。

```json
{
  "version": 1,
  "datasetId": "recent-online-20260729",
  "samples": {
    "2026-07-29/example.png": {
      "sha256": "...",
      "label": "watermarked",
      "reviewConfidence": "high",
      "watermarkFamily": "gemini-star",
      "expectedAnchor": {
        "logoSize": 48,
        "marginRight": 96,
        "marginBottom": 96
      },
      "note": "右下角可见四角星"
    }
  }
}
```

允许的 `label`：

- `watermarked`：人工确认存在可见 Gemini 水印。
- `clean`：人工确认没有可见 Gemini 水印；可以是非 Gemini 图片或已经无水印的图片。
- `ambiguous`：现有证据不足，不能可靠判断。

`reviewConfidence` 允许 `high` 或 `medium`。低置信度样本必须标为 `ambiguous`，不能进入发布门禁。

### 完整性规则

- 相对路径必须位于样本根目录内。
- 文件缺失、SHA-256 不匹配、未知标签或清单版本不支持时，评测直接失败。
- 同一 SHA-256 的多个路径属于一个内容组，只计一次；报告保留全部路径。
- 同一 SHA-256 出现冲突标签时，评测直接失败。
- 清单中不存在的文件标为 `unlabeled`，不进入通过率并出现在待复核列表。
- 清单引用了不存在的文件时视为清单陈旧，评测直接失败。

## 命令行行为

外部评测新增：

- `--labels <path>`：加载可信金标清单。
- `--assume-watermarked`：显式启用旧行为，仅供临时诊断，不允许用于发布门禁。

未提供 `--labels` 且未显式提供 `--assume-watermarked` 时，命令失败并解释如何选择。这样可以防止未来再次把目录来源误当作水印真值。

基线比较要求以下值全部一致：

- `datasetId`
- 金标清单规范化内容的 SHA-256
- 去重后的内容哈希集合

不一致时不生成 `newlyPassing` / `newlyFailing`，并以错误终止，避免跨分母比较。

## 分类语义

### `watermarked`

- 未处理：`fail / missed-detection`。
- 已处理：继续使用现有残差、梯度、质量状态和误伤规则分类。
- 处理后仍有可见残影或疑似内容损伤：保留现有失败桶。
- 满足清理质量门：`pass / pass`。

### `clean`

- 未处理且输出保持不变：`pass / clean-skip`。
- 进入处理路径并改变像素：`fail / false-positive`。
- 即使算法自报 `qualityStatus=clean`，也不能把误处理改判为通过。

### `ambiguous` 与 `unlabeled`

- 分类状态为 `excluded`。
- 不进入总通过率、失败数或基线升降统计。
- 保留算法输出和 shadow 指标，用于安排复核顺序。

## 报告结构

报告保留现有逐文件诊断，并增加：

- `dataset.datasetId`
- `dataset.labelManifestSha256`
- `dataset.uniqueContentCount`
- `dataset.duplicatePathCount`
- `labels.watermarked`
- `labels.clean`
- `labels.ambiguous`
- `labels.unlabeled`
- `metrics.watermarkDetectionRecall`
- `metrics.watermarkEndToEndPassRate`
- `metrics.restorationPassRateAmongApplied`
- `metrics.cleanSkipRate`
- `metrics.falsePositiveRate`
- `metrics.qualifiedOverallPassRate`
- `reviewQueue.ambiguous`
- `reviewQueue.unlabeled`

`qualifiedOverallPassRate` 的分母仅包含去重后的 `watermarked + clean`。报告必须同时突出分项指标，不能只展示一个综合百分比。

Markdown 和 CSV 中应明确显示标签、是否计入统计、内容哈希组和分类原因。

## 人工复核流程

1. 先按 SHA-256 去重 119 个文件。
2. 查看完整图片和右下角高分辨率裁剪。
3. 只有明确看到 Gemini 星形水印，或存在可核验的原始来源证据时，标为 `watermarked`。
4. 明确没有 Gemini 水印时标为 `clean`，不根据“看起来像 AI 图片”推断来源。
5. 水印被内容遮挡、压缩过重或尺寸过小而无法确认时标为 `ambiguous`。
6. 完成清单后重新运行基准，输出新的可信基线和最大真实失败簇。

自动指标可以把高空间相关、高梯度相关或可疑轮廓的 `ambiguous/unlabeled` 文件排在前面，但不得自动写回标签。

## 测试设计

聚焦测试覆盖：

- `watermarked` 未处理被判为漏检。
- `clean` 未处理被判为正确跳过。
- `clean` 被处理后判为误处理。
- `ambiguous` 与 `unlabeled` 不进入分母。
- 重复 SHA-256 只计一次且保留全部路径。
- 冲突标签、缺失文件、哈希不匹配和未知版本失败。
- 没有 `--labels` 时默认失败；显式 `--assume-watermarked` 保持诊断兼容。
- 不同清单或不同内容集合拒绝基线比较。
- Markdown、JSON、CSV 使用一致的分母和标签语义。

全量验证继续包括现有测试、样本基准和生产构建。核心算法输出在本次变更前后应逐文件完全一致；允许变化的只有评测标签、分类和汇总。

## 交付顺序

1. 为标签清单加载、校验、去重和分类行为写失败测试。
2. 实现清单解析与内容哈希分组。
3. 改造外部评测分类和报告汇总。
4. 增加 CLI 参数及旧行为的显式兼容开关。
5. 对当前 119 个文件完成人工标注并生成可信基线。
6. 复核最大真实失败簇，另行设计核心算法改进。

评测基础设施与后续算法修改必须分开提交。

## 验收标准

- 119 个路径全部处于 `watermarked`、`clean` 或 `ambiguous`，不存在 `unlabeled`。
- 重复内容不会重复加权。
- 每个计入发布指标的文件均通过路径和 SHA-256 校验。
- 正确跳过 `clean` 图片不会再计为漏检。
- 误处理 `clean` 图片会明确计为 `false-positive`。
- 新报告同时给出检测召回、去除质量、无水印安全性和综合合格率。
- 相同金标上的前后版本比较可复现；不同金标之间拒绝生成升降结论。
- 本次提交不改变任何图片输出像素或核心算法决策。

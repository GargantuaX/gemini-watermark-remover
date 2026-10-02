# 代码审查与处理历史

## 2026-10-02：Issue #172 的 V2 medium 强几何候选

- 基准与工作区 HEAD：`13195610a5b534d69adfa169b1011981c9b6f499`。`git fetch origin` 后远端 `origin/main` 相同，ahead/behind为0/0。
- 分支：`codex/issue172-v2-medium-geometry`。目标是未提交工作区变更，不能记为HEAD已审查。
- 范围：`src/core/pipelineInitialSelection.js`、`tests/core/pipelineInitialSelection.test.js`、`tests/core/watermarkProcessor.test.js`、`tests/fixtures/issue172-v2-medium-texture.png`，及候选集合到图片流水线的必要调用者。没有全仓审查；调查文档不属于AGY代码审查范围。
- 初审补丁SHA-256：`d9741e78f4817ef4629fbfa19427e452068433085492b82548d64a7ce06194c2`。
- 最终源码/测试补丁SHA-256：`a577e30c3b92747cfdf8fd6db191f3a489725d846c9417efacf6376d0329e7b3`。计算对象为 `git diff --binary HEAD --` 上述三个JS文件；二进制夹具另记SHA-256 `2adc32aec998738e4f5f46ce6bc77a0b5d1a54fa636d9d54ee2415c32d9f80b6`。文档追加不改变该代码快照标识。
- 审查者：AGY reviewer；主助手核对源码、复现证据、实际像素和测试。
- 初审：`Comment`，认为准入范围与原36px保护符合约束；提出下列改进，没有复现用户可见的新缺陷。报告：`.agy-staff/jobs/review-muqog26p-f1fc5866.result.md`。
- 增量复审：`Approve`，原3项均关闭，未发现新缺陷；复审独立执行39项候选集合测试通过。报告：`.agy-staff/jobs/review-muqowkbs-3c9b57f8.result.md`。

| 编号 | 初审分类 | 处理与复审 |
| --- | --- | --- |
| R172-01 | Medium：同候选强定位控制区重复计算 | 私有构造函数一次计算并返回 `{trial,strongGeometry}`；唯一调用方复用布尔结果。复审通过。未将冗余计算宣称为已复现的用户性能故障。 |
| R172-02 | Medium：缺少强几何冲突与重复纹理测试 | 新增实际合成双候选图、真实相关性断言的canonical优先测试；新增重复V2模板控制拒绝测试。复审通过。 |
| R172-03 | Low：空候选的条件表达式语义不清 | 增加显式非空守卫，复审确认null路径安全。复审通过。 |

### 验证与剩余事项

最初两项新增回归在基准代码失败、初步修复后通过；后续完善后的collector39项通过。最终代码快照的相关三个核心测试文件：140项，115通过、25因缺少外部样本跳过、0失败（135,773.8ms）。不将中间快照结果拼接为最终证据。

完整JPEG最终输出与已进行Node/浏览器像素验证的初步候选输出逐字节一致；此前实际JPEG验证选中48px/R73，区域外0像素改动。官网原始Worker复现错误48px/R32位置；测试浏览器本地替换Worker选中正确位置、区域外0改动。六项原图/负向控制与基准输出一致。`git diff --check`通过。

AGY未独立运行官网浏览器或完整JPEG试验。全仓CI、生产构建、打包和发布未运行。细轮廓残留仍存在，最终质量为mixed；#171缺少原始输入/下载PNG，不能判定同根因或修复有效。上述不在本次代码修复验收中伪装为clean或已关闭。

### 提交前快照核对

2026-10-02：确认源码与测试差异对应上述复审内容，夹具哈希一致。原补丁标识由 RTK 的摘要输出计算，并非原始补丁；补充原始 git diff --binary（三个 JS 文件）SHA-256：96a3b4752a12c96d50d23b88709a50470ac44d9dbcf41ba1019cffb8e05490bd。原摘要标识保留作历史记录，不能单独证明源码一致性。远端 main 仍与基准相同。

- 收敛提交完整 SHA：5951b38349251a9f0fef773f841fadaa8b314053。提交后复核上述三个 JS 文件原始补丁哈希与提交前一致；夹具未变。复用已有 AGY 增量复审结论（范围不含调查文档），没有新增源码差异。

# 1.0.43 发布收尾（2026-09-10）

本轮图片修复、验证、合并、发行和反馈跟进已完成。Chrome 商店已由发布者手动提交，后台截图确认待审核；尚未确认审核通过或公开上线。

## 发行与验证

- 核心修复 [PR #162](https://github.com/GargantuaX/gemini-watermark-remover/pull/162) 和发行 [PR #163](https://github.com/GargantuaX/gemini-watermark-remover/pull/163) 已合并，发行提交为 `e9ba84d8e5465928d4b9343a1fe121d0cae0e3da`。
- [GitHub Release](https://github.com/GargantuaX/gemini-watermark-remover/releases/tag/v1.0.43)、npm SDK、官网实际图片 Worker、用户脚本及手动扩展下载均已验证为 1.0.43。发布包哈希与测试包一致。
- 正式包完整测试 1,711 通过、32 跳过，SDK smoke 8 通过，构建及打包通过。424 张冻结回归输出与 1.0.42 逐像素一致；另 26 张 issue 样本中仅目标 3 张改变，并与最终审查结果一致。输出一致不代表全部去除干净。
- 官网 [PR #17](https://github.com/sungerine/geminiwatermarkremover.io/pull/17) 已合并。279 项测试、类型及多语言检查通过，完整 CI `34463545345` 通过；部署版本为 `179e6644-9cc7-4844-98bc-df808ea97530`。
- 官网实际 Worker 已复测：super-deals 从跳过改为 exact96/R192/gain1；import-tax 从偏移 88px 改为 exact96/R192/gain1；cabinet Scene1 从 gain0.3 改为 gain0.6。

## 外部等待和后续范围

- Chrome 商店：本次更新已送审，最近公开版本检查仍为 1.0.42。截图没有显示版本号，本次 1.0.43 的关联依据是发布者对当前上传包交接的确认。
- [#101 跟进回复](https://github.com/GargantuaX/gemini-watermark-remover/issues/101#issuecomment-5616635411) 已补充 Scene1 复测要求；Scene3 和历史深色样本仍保留为未解决观察。
- [#120 跟进回复](https://github.com/GargantuaX/gemini-watermark-remover/issues/120#issuecomment-5616635009) 已请求新版处理结果和同批成功原图对照；细轮廓残留未宣称解决。
- 本次检查时两个 issue 均无 1.0.43 发布后的用户复测回复；#101 样本仓库最新提交仍为 `01eaeda8a445281ca63e8ac04283df8b2f1b2f34`（8-13）。两个 issue 保持开放。
- 后续修复仅由可验证的原图或受控复现证据推动。未知来源仍记未知；截图、改图及重复水印不增加专项支持，也不新增运行时拒绝规则。

本轮不再追加算法诊断或准备新版本。审核结果、用户新版复测或新的可验证原图是后续恢复工作的依据。

## 证据保留

正式发行证据保存在 `release/evidence/v1.0.43-image-inventory.json` 和 `release/evidence/v1.0.43-image-quality.json`。本地详细验证、实际 Worker 前后报告、裁剪图和交接记录保留在 `.artifacts/release-1.0.43/` 与 `.artifacts/issue-followups-1042/`；这些忽略目录不作为远端可获取材料。

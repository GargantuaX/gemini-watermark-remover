# 发版清单

## 发布面

当前仓库有四个发布面：

- 网站构建产物：`dist/`
- 油猴脚本产物：`dist/userscript/gemini-watermark-remover.user.js`
- `package.json`、`src/core/`、`src/sdk/` 对应的 package/sdk 源码与元数据
- Chrome Web Store 商店页及其根目录 manifest 上传包：`release/gemini-watermark-remover-extension-web-store-v<version>.zip`，以及手动安装备用包：`release/gemini-watermark-remover-extension-v<version>.zip`

## 发布前检查

在仓库根目录执行：

```bash
pnpm install
pnpm release:preflight
```

图片范围发布前，运行 `pnpm release:image-validation` 和 `pnpm release:image-evidence` 刷新证据。质量门依次运行 `pnpm release:image-quality-gate`、作为声明审计的内部对比 gate，以及 `pnpm release:readiness -- --scope image-defaults --fail-on-not-ready`。

预期结果：

- 所有测试通过
- `dist/` 下的网站构建产物已按当前代码重新生成
- `dist/userscript/gemini-watermark-remover.user.js` 已重新生成
- `package.json` 中的 package/sdk 入口仍与实际发布源码布局一致
- 生成后的 userscript 元数据使用当前 `package.json` 版本号
- `release/` 下已重新生成 Chrome Web Store 上传 zip、手动安装备用 zip、对应 sha256 文件和 `latest-extension.json`
- 内部对比 gate 输出 `current-gap-known`
- `pnpm release:preflight` 会依次运行 `pnpm build`、`pnpm test`、`pnpm package:extension`、`pnpm release:quality-gate`、`pnpm release:goal-audit -- --fail-on-incomplete` 和 `pnpm release:ci-check`
- `pnpm release:quality-gate` 会先运行内部对比 gate，再运行 `pnpm release:readiness -- --fail-on-not-ready`
- `pnpm release:goal-audit` 对当前 scoped RC 目标输出 `goal achieved: yes`
- `pnpm release:ci-check` 会检查当前 `HEAD` 对应的 GitHub Actions CI；如果找不到已完成且成功的 run，release preflight 会 fail-closed，并打印失败 job / 日志摘要
- 在视频 gate promoted 之前，继续阻断更宽泛的视频质量声明
- release readiness 在发布 scoped 图片 RC 前输出 `rc-current-image-defaults-with-scoped-claims`
- 发布说明以 `Release Claim Matrix` 为边界：只描述 `allowed`、`allowed-scoped` 或 `allowed-safety-only` 行；`review-only`、`experiment-only` 和 `forbidden` 行不能写成公开能力声明
- `dist/extension` 下的未打包插件是本地测试版；正式发布 manifest 只写入 `release/` 里的 zip

## 公开发布口径

- 公开说明只写用户可感知的修复、支持的发布面，以及已经通过 gate 的受限能力声明。
- 公开 release note 不写内部 benchmark 名称、实现研究记录，或尚未发布的对比声明。
- 以当前 gate 结果为准，视频清理只能描述为 review-scoped 或实验能力，除非后续 gate 明确提升。
- 当 readiness 仍输出 `rc-current-image-defaults-with-scoped-claims` 时，不要把构建称为完整 stable / GA 正式版。

## 版本元数据

- 提升 `package.json` 版本号
- 保持 `build.js` 中 userscript 的 `@version` 来自 `pkg.version`
- 在 `CHANGELOG.md` 和 `CHANGELOG_zh.md` 中新增对应版本记录

## 人工验证

- 在 Tampermonkey 或 Violentmonkey 中安装或更新生成后的 userscript
- 验证本地安装版本时，针对固定 profile 运行一次 `pnpm probe:tm:freshness`
- 验证 Gemini 页面预览图替换链路正常
- 验证 Gemini 原生复制/下载动作仍返回去水印后的结果
- 验证预览图处理失败时页面原图仍保持可见
- 从 `dist/extension` 加载未打包本地 Chrome 插件，验证弹窗开关、Gemini 在线工具链接、通用去水印链接和 GitHub 反馈链接；确认扩展卡片显示为 `Gemini Watermark Remover Local`
- 确认线上 Chrome Web Store 商店页指向：
  `https://chromewebstore.google.com/detail/gemini-watermark-remover/cjlmnfcfnofnglkphbcdclbpimdjkmdf`
- 如果本次要发布 sdk/package，发包前再做一次 package smoke 检查

## 发布

- 提交版本相关改动
- 创建与版本号一致的 git tag，例如 `v1.0.1`
- 基于该 tag 创建 GitHub Release，并上传 `dist/userscript/gemini-watermark-remover.user.js`
- 上传 `release/gemini-watermark-remover-extension-v<version>.zip`、对应 `.sha256.txt` 和 `latest-extension.json` 到 GitHub Release，作为手动安装备用包
- 将 `release/gemini-watermark-remover-extension-web-store-v<version>.zip` 提交到 Chrome Web Store；该包按商店要求把 `manifest.json` 放在归档根目录
- 只有本次涉及 package 对外接口时，才同步发布 sdk/package

## 下游依赖同步

- 先检查下游项目是否存在直接 package 依赖，再决定是否 bump：
  `rg -n "@pilio/gemini-watermark-remover" --glob package.json --glob pnpm-lock.yaml`
- 不要把任务路由、processor key、i18n 文案、测试或文档中出现的 `gemini-watermark-remover` 当成必须升级 npm SDK 的证据。
- 只有下游项目直接依赖 `@pilio/gemini-watermark-remover` 时，才更新该依赖。
- 如果独立官网仍直接消费 npm SDK，则更新该站的 `package.json` / `pnpm-lock.yaml`，再重新构建、测试和部署。

GitHub Release 命令示例：

```bash
gh release create v<version> \
  dist/userscript/gemini-watermark-remover.user.js \
  release/gemini-watermark-remover-extension-v<version>.zip \
  release/gemini-watermark-remover-extension-v<version>.zip.sha256.txt \
  release/latest-extension.json \
  --repo GargantuaX/gemini-watermark-remover \
  --title "v<version>" \
  --notes "<release notes>" \
  --latest
```

## 官网同步

如果你维护了独立的项目官网，则在 GitHub Release 发布后同步它：

1. 在官网项目中运行 userscript 构建/同步命令。
   - 该命令会重新构建当前上游仓库。
   - 然后把 `dist/userscript/gemini-watermark-remover.user.js` 复制到 `public/userscript/gemini-watermark-remover.user.js`。
2. 如果本次已经发布 npm SDK，且官网仍直接依赖该 SDK，则把 `@pilio/gemini-watermark-remover` 更新到对应版本并刷新 `pnpm-lock.yaml`。
3. 从 GitHub Release 下载准确的 Chrome 插件备用资产到官网项目：
   - `gemini-watermark-remover-extension-v<version>.zip`
   - `gemini-watermark-remover-extension-v<version>.zip.sha256.txt`
   - `latest-extension.json`
4. 将这些文件复制到 `public/downloads/`。
5. 更新 `src/i18n/chrome-extension-content.ts`，确保 Chrome 插件主 CTA 指向 Chrome Web Store，备用包元数据与 `latest-extension.json` 保持一致。
6. 从 `public/downloads/` 删除旧版本 zip 和 checksum 文件。
7. 在官网项目中运行 `pnpm test` 和 `pnpm run build`。
8. 使用 `pnpm run deploy:cf-workers` 部署官网。
9. 回到当前仓库运行 `pnpm release:distribution-check`，以生成的报告作为发布面状态的最终依据。

`pnpm run deploy:cf-workers` 可能已经成功完成 Cloudflare 部署，但最后报告 Sentry release finalize 错误。如果 Wrangler 打印了当前 version ID，并且线上站点验证通过，应先把官网部署视为已发布，再单独排查 Sentry。

## 发布后检查

- 确认 `pnpm release:distribution-check` 对 local package、GitHub Release、release assets、npm latest、官网 userscript、官网 `latest-extension.json` 和官网 extension zip 都输出 `ok`
- 如果唯一剩余项是 `chrome-web-store-update: waiting`，则把本次发布视为除 Chrome Web Store 审核/传播外已经完成，后续只跟进商店状态
- 确认浏览器里已安装的 userscript 显示正确版本号
- 确认 GitHub Release latest userscript 返回最新产物：
  `https://github.com/GargantuaX/gemini-watermark-remover/releases/latest/download/gemini-watermark-remover.user.js`
- 确认官网返回最新 userscript 产物：
  `https://geminiwatermarkremover.io/userscript/gemini-watermark-remover.user.js`
- 确认 Chrome Web Store 商店页可访问：
  `https://chromewebstore.google.com/detail/gemini-watermark-remover/cjlmnfcfnofnglkphbcdclbpimdjkmdf`
- 确认官网 Chrome 插件主 CTA 指向 Chrome Web Store，同时仍提供最新备用 zip，且校验值一致
- 确认 `https://geminiwatermarkremover.io/downloads/latest-extension.json` 返回最新插件版本、文件名、体积和 sha256
- 更新 GitHub Release note 和本次直接处理的 GitHub issue，写明已发布版本、验证证据，以及仍在等待的传播事项
- 临时性的验证记录放到 release note 或 PR 里，不继续堆在仓库文档中

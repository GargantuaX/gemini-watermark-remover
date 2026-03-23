# 发版清单

## 发布面

当前仓库有三个发布面：

- 网站构建产物：`dist/`
- 油猴脚本产物：`dist/userscript/gemini-watermark-remover.user.js`
- `package.json` 对应的 package/sdk 元数据

## 发布前检查

在仓库根目录执行：

```bash
pnpm install
pnpm test
pnpm build
```

预期结果：

- 所有测试通过
- `dist/userscript/gemini-watermark-remover.user.js` 已重新生成
- 生成后的 userscript 元数据使用当前 `package.json` 版本号

## 版本元数据

- 提升 `package.json` 版本号
- 保持 `build.js` 中 userscript 的 `@version` 来自 `pkg.version`
- 在 `CHANGELOG.md` 和 `CHANGELOG_zh.md` 中新增对应版本记录

## 人工验证

- 在 Tampermonkey 或 Violentmonkey 中安装或更新生成后的 userscript
- 验证 Gemini 页面预览图替换链路正常
- 验证 Gemini 原生复制/下载动作仍返回去水印后的结果
- 验证预览图处理失败时页面原图仍保持可见
- 如果本次要发布 sdk/package，发包前再做一次 package smoke 检查

## 发布

- 提交版本相关改动
- 创建与版本号一致的 git tag，例如 `v1.0.1`
- 发布或上传 `dist/userscript/gemini-watermark-remover.user.js`
- 如果在线站点入口有变更，同步部署 `dist/` 下的网站产物
- 只有本次涉及 package 对外接口时，才同步发布 sdk/package

## 发布后检查

- 确认浏览器里已安装的 userscript 显示正确版本号
- 确认线上安装链接返回的是最新 userscript 产物
- 临时性的验证记录放到 release note 或 PR 里，不继续堆在仓库文档中

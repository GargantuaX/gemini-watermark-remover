# GitHub Issue 样本复核

对附带 GitHub Release 样本的反馈 issue，优先使用统一命令完成取样、摘要核验、基准运行和评论草稿生成：

```bash
pnpm issue:verify -- --issue 120
```

命令会通过当前 `gh` keyring 登录态读取 issue，解析正文中的第一个 GitHub Release 链接，把图片资源缓存到 `.artifacts/github-issues/`，并对 Release API 提供的 SHA-256 逐文件复核。摘要匹配的缓存会直接复用；缺失或不匹配的资源会重新下载并再次核验。

默认只在本地生成以下证据，不写 GitHub：

- `latest.json`：issue、来源、资源摘要、指标和产物清单
- `benchmark-report.json` / `benchmark-report.md`：外部样本基准
- `benchmark-results.csv` / `benchmark-failures.csv`：逐样本结果
- `comment.md`：可审阅的 GitHub 评论草稿

确认草稿后，只有显式传入 `--comment` 才会发布：

```bash
pnpm issue:verify -- --issue 120 --comment
```

其他常用参数：

```bash
# 指定仓库
pnpm issue:verify -- --repo owner/repo --issue 120

# 使用本地样本；此模式无法核验 GitHub Release 摘要
pnpm issue:verify -- --issue 120 --sample-root path/to/samples

# 与既有基准报告比较
pnpm issue:verify -- --issue 120 --baseline path/to/baseline.json
```

该流程使用 `--assume-watermarked` 运行现有外部样本基准，因此结果属于可复现的诊断证据，不自动等同于人工标注的发布门禁，也不会自动关闭 issue。

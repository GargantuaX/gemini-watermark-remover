# npm Trusted Publishing 配置

本仓库通过 GitHub Actions OIDC 发布 npm 包，不保存长期 `NPM_TOKEN`。

## npmjs.com 一次性配置

打开 `@pilio/gemini-watermark-remover` 的 package settings，在 **Trusted Publisher** 中选择 **GitHub Actions**，填写：

- Organization or user：`GargantuaX`
- Repository：`gemini-watermark-remover`
- Workflow filename：`publish-npm.yml`
- Environment name：留空
- Allowed actions：只选择 `npm publish`

保存后先完成一次 OIDC 发布并确认成功，再把 **Publishing access** 改为 **Require two-factor authentication and disallow tokens**。最后撤销不再使用的 npm automation token。

## 发布方式

创建并发布 GitHub Release 后，`publish-npm.yml` 会自动发布与 `package.json` 版本对应的 `release/pilio-gemini-watermark-remover-<version>.tgz`。

如果 GitHub Release 已经存在（例如首次迁移 Trusted Publishing），可以在 GitHub Actions 中手动运行 **Publish npm package**。手动任务要求：

- `v<version>` 标签存在，且是当前提交的祖先；
- 版本化 `.tgz` 已提交；
- 当前 `.tgz` 与该标签中的文件 SHA-256 完全一致；
- `.tgz` 内的包名和版本与仓库 `package.json` 一致。

版本已经存在于 npm 时，任务会安全跳过。发布任务仅拥有 `contents: read` 和 `id-token: write` 权限，并使用 GitHub-hosted runner；OIDC 发布会自动生成 npm provenance。

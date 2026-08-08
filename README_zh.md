[English](README.md)

> 🔥 厌倦了 Gemini 水印？试试更强大的 **GPT Image 2**：[pilio.ai](https://pilio.ai) — 限时免费。

# Gemini 去水印工具 — 无损去除 Gemini AI 图片水印

开源的 **Gemini 水印去除工具**，在已支持的 Gemini 导出图片上可提供高保真、可复现的去水印结果。基于纯 JavaScript 实现，使用数学精确的反向 Alpha 混合算法，而非 AI 修复。

> **🚀 想快速去除 Gemini 水印？直接使用`在线 Gemini 去水印工具`：[geminiwatermarkremover.io](https://geminiwatermarkremover.io/)** — 免费、无需安装，浏览器即可使用。
>
> 💡 Gemini 去不掉的水印？试试通用 AI 去水印工具：[pilio.ai/image-watermark-remover](https://pilio.ai/image-watermark-remover)

<p align="center">
  <a href="https://geminiwatermarkremover.io/"><img src="https://img.shields.io/badge/🛠️_在线工具-geminiwatermarkremover.io-blue?style=for-the-badge" alt="在线工具"></a>&nbsp;
  <a href="https://geminiwatermarkremover.io/video"><img src="https://img.shields.io/badge/🎬_视频去水印-New!-ff6b6b?style=for-the-badge" alt="视频去水印"></a>&nbsp;
  <a href="https://chromewebstore.google.com/detail/gemini-watermark-remover/cjlmnfcfnofnglkphbcdclbpimdjkmdf"><img src="https://img.shields.io/badge/🧩_Chrome插件-安装-blueviolet?style=for-the-badge" alt="Chrome 插件"></a>&nbsp;
  <a href="https://geminiwatermarkremover.io/userscript/gemini-watermark-remover.user.js"><img src="https://img.shields.io/badge/🐒_油猴脚本-安装-green?style=for-the-badge" alt="油猴脚本"></a>&nbsp;
  <a href="https://pilio.ai/image-watermark-remover"><img src="https://img.shields.io/badge/🧹_通用去水印-pilio.ai-gray?style=for-the-badge" alt="通用去水印"></a>
</p>

<p align="center">
  <img src="https://count.getloli.com/@gemini-watermark-remover?name=gemini-watermark-remover&theme=minecraft&padding=7&offset=0&align=top&scale=1&pixelated=1&darkmode=auto" width="400">
</p>

## 特性

- ✅ **100% 本地处理** - 所有图片处理都在你的浏览器或本地环境中完成，不会上传到任何服务器
- ✅ **数学精确** - 基于反向 Alpha 混合算法，而非 AI 修复模型
- ✅ **自动检测** - 基于 Gemini 已知输出尺寸目录和局部锚点搜索，自动识别水印大小与位置
- ✅ **灵活使用** - 在线工具快速上手、Chrome 插件或油猴脚本无缝集成 Gemini 页面、CLI 和 Skill 支持脚本化与自动化
- ✅ **视频支持** - 支持去除 Gemini 生成视频中的水印，访问 [geminiwatermarkremover.io/video](https://geminiwatermarkremover.io/video) 即可使用
- ✅ **跨平台** - 支持现代浏览器（Chrome、Firefox、Safari、Edge）和 Node.js 环境

## Gemini 去水印效果示例

<details open>
<summary>点击查看/收起示例</summary>

| 原图 | 去水印后 |
| :---: | :----: |
| <img src="docs/demo-before.webp" width="400"> | <img src="docs/demo-after.webp" width="400"> |

</details>

## ⚠️ 使用需注意

> [!WARNING]
> **使用此工具产生的风险由用户自行承担**
>
> 本工具涉及对图像数据的修改。尽管在设计上力求处理结果的可靠性，但由于以下因素，仍可能产生非预期的处理结果：
> - Gemini 水印实现方式的更新或变动
> - 图像文件损坏或使用了非标准格式
> - 测试案例未能覆盖的边界情况
>
> 作者对任何形式的数据丢失、图像损坏或非预期的修改结果不承担法律责任。使用本工具即代表您已了解并接受上述风险。

> [!NOTE]
> 另请注意：使用此工具需禁用 Canvas 指纹防护扩展（如 Canvas Fingerprint Defender），否则可能会导致处理结果错误。 https://github.com/GargantuaX/gemini-watermark-remover/issues/3

## 如何去除 Gemini 水印

### 在线 Gemini 去水印工具（推荐）

所有用户均可使用 — 最简单快速的 Gemini 图片去水印方式：

1. 浏览器打开 **[geminiwatermarkremover.io](https://geminiwatermarkremover.io/)**
2. 拖拽或点击选择带水印的 Gemini 图片
3. 图片会自动开始处理，移除水印
4. 下载处理后的图片

### 在线视频去水印工具（新功能！）

针对带有可见水印的 Gemini 生成**视频**：

1. 浏览器打开 **[geminiwatermarkremover.io/video](https://geminiwatermarkremover.io/video)**
2. 拖拽或点击选择带水印的 Gemini 生成视频
3. 工具会自动检测并去除视频中的水印
4. 下载处理后的视频

> **说明**：视频去水印处理完全在浏览器本地完成，不会上传任何文件到服务器。

### Chrome 插件

适合不想安装油猴脚本、但希望在 Gemini 页面里实时自动处理预览图、复制和下载动作的用户。

1. 打开 [Chrome Web Store 上的 Gemini Watermark Remover](https://chromewebstore.google.com/detail/gemini-watermark-remover/cjlmnfcfnofnglkphbcdclbpimdjkmdf)
2. 点击“添加至 Chrome”，并确认安装
3. 打开 Gemini 页面，插件会自动处理可支持的 Gemini 图片

插件弹窗里提供了“在 Gemini 中自动去除”开关。如果遇到 Gemini 页面卡顿、异常或需要排查问题，可以先关闭开关再刷新页面。

通过 Chrome Web Store 安装后，插件会自动更新。如果你的网络无法稳定访问 Chrome Web Store，仍可从 [GitHub Releases](https://github.com/GargantuaX/gemini-watermark-remover/releases/latest) 或官网备用下载入口获取同版本已校验 zip（`gemini-watermark-remover-extension-v*.zip`），并按手动加载未打包插件的方式安装。

### 油猴脚本

1. 安装油猴插件（如 Tampermonkey 或 Greasemonkey）
2. 打开 [gemini-watermark-remover.user.js](https://geminiwatermarkremover.io/userscript/gemini-watermark-remover.user.js)
3. 脚本会自动安装到浏览器中
4. 打开 Gemini 对话页面
5. 页面里可处理的 Gemini 预览图会在处理后直接替换显示
6. 点击原生“复制图片”或“下载图片”时，脚本也会在下载流里自动返回去水印结果

当前油猴模式的边界是：

- 不注入页面按钮
- 不提供弹窗 UI 或批量操作入口
- 当源图可获取时，会同时处理页面预览图和原生复制/下载链路
- 处理预览图时会保留原图显示，并叠加克制的 `Processing...` 状态遮罩
- 如果预览图处理失败，不会把页面原图隐藏掉或替换成空白

### Skill

面向使用 AI 编程 agent 的开发者：

- `skills/gemini-watermark-remover/` 包含打包好的 Skill，AI agent 可自动发现并调用。
- 用 `skills.sh` 安装可执行：

```bash
pnpm dlx skills add GargantuaX/gemini-watermark-remover --skill gemini-watermark-remover
```

- 只有在你的本地环境确实需要时，再额外加上 `--agent`、`--yes`、`--copy` 这类参数。
- 用法：

```bash
node skills/gemini-watermark-remover/scripts/run.mjs remove <input> --output <file>
```

- 详见 [`SKILL.md`](skills/gemini-watermark-remover/SKILL.md)。

### CLI

面向脚本化、CI、批量处理等自动化场景，可直接调用 CLI：

```bash
# 仓库内直接运行
node bin/gwr.mjs remove <input> --output <file>

# 全局安装后使用
gwr remove <input> [--output <file> | --out-dir <dir>] [--overwrite] [--json]
```

如果本机未全局安装 `gwr`，可直接使用：

```bash
pnpm dlx @pilio/gemini-watermark-remover remove <input> --output <file>
```

默认 CLI 文件解码/编码路径使用 `sharp`。只使用浏览器或 `ImageData` SDK 的消费者不需要它。如果你在自己的项目里使用 CLI 文件处理，请同时安装 `sharp`：

```bash
pnpm add sharp
```

### 去不掉的水印？

本工具专门针对 Gemini 可见水印（右下角半透明 Logo）。如果你的图片水印不属于 Gemini 已知格式，或需要去除其他类型的图片水印，可以试试通用 AI 去水印工具：

👉 **[pilio.ai/image-watermark-remover](https://pilio.ai/image-watermark-remover)**

### 开发者预览

仓库里仍保留了一个本地内部预览页 `/dev-preview.html`，用于单图对比、复制和下载结果验证。

- 这是保留给仓库本地调试使用的内部页面，不是公开产品站点。
- 根路径 `/` 现在只负责把用户引导到项目官网、userscript 安装地址和内部预览页。
- 对外使用时，应优先使用官网或 userscript，而不是这个本地预览 harness。

## 开发

```bash
# 安装依赖
pnpm install

# 开发构建
pnpm dev

# 生产构建
pnpm build

# 本地静态服务
pnpm serve
```

说明：

- 根路径 `/` 现在是轻量入口页，只负责引导到官网、userscript 安装地址和仓库内保留的内部预览页。
- 内部浏览器预览页位于 `/dev-preview.html`，当前保留为中文静态单图对比 harness，用于本地算法/UI 调试，不再作为对外开发者预览站，也不再维护多语言和主题切换。
- `pnpm dev` / `pnpm serve` 仍会提供 userscript、probe 页面和这些静态资产。
- 跟进附带 Release 样本的 GitHub issue 时，可用 `pnpm issue:verify -- --issue <编号>` 复用登录态、缓存样本、核验摘要并生成评论草稿；详见 [GitHub Issue 样本复核](docs/github-issue-verification.zh.md)。

### macOS 下调试油猴固定 Profile

如果要走仓库内置的固定 profile 调试流，macOS 下建议直接用：

```bash
# 构建最新 userscript
pnpm build

# 如有需要，启动本地产物服务
pnpm dev

# 打开固定 Chrome profile，并直达 Gemini
./scripts/open-fixed-chrome-profile.sh --url https://gemini.google.com/app
```

说明：

- 固定 profile 目录是 `.chrome-debug/tampermonkey-profile`
- 默认 CDP 端口是 `9226`
- 默认代理是 `http://127.0.0.1:7890`，不需要时可加 `--proxy off`
- 验证最新构建时，请从当前 `pnpm dev` 实际启动的本地服务地址重新安装 userscript
- `pnpm dev` 默认从 `http://127.0.0.1:4173/` 开始探测；如果端口被占用，会自动递增
- 如果你参考的是之前某次调试记录，端口可能不是 `4173`；以当前 `pnpm dev` 输出为准

## SDK 用法（高级 / 内部）

包根仍然提供 SDK，但更建议将它视为高级或内部集成接口：

```javascript
import {
  createWatermarkEngine,
  removeWatermarkFromImage,
  removeWatermarkFromImageData,
  removeWatermarkFromImageDataSync,
} from '@pilio/gemini-watermark-remover';
```

如果你已经拿到了 `ImageData`，优先用纯数据接口：

```javascript
const result = await removeWatermarkFromImageData(imageData, {
  adaptiveMode: 'auto',
});

console.log(result.meta.decisionTier);
```

如果你在浏览器里拿到的是 `HTMLImageElement` 或 `HTMLCanvasElement`，可直接用图像接口：

```javascript
const { canvas, meta } = await removeWatermarkFromImage(imageElement);
document.body.append(canvas);
console.log(meta.applied, meta.decisionTier);
```

如果要批量处理，建议复用同一个 engine 实例，让 alpha map 保持缓存：

```javascript
const engine = await createWatermarkEngine();
const first = await removeWatermarkFromImageData(imageDataA, { engine });
const second = await removeWatermarkFromImageData(imageDataB, { engine });
```

如果你在 Node.js 里接入，可使用专门的子入口，并注入自己的解码/编码器：

```javascript
import { removeWatermarkFromBuffer } from '@pilio/gemini-watermark-remover/node';

const result = await removeWatermarkFromBuffer(inputBuffer, {
  mimeType: 'image/png',
  decodeImageData: yourDecodeFn,
  encodeImageData: yourEncodeFn,
});
```

## 运行要求

### 网页与油猴脚本

- 现代 Chrome / Firefox / Safari / Edge 浏览器
- ES Modules
- Canvas API
- Async/Await
- TypedArray（`Float32Array`、`Uint8ClampedArray`）
- 如果要使用网页上的“复制结果”按钮，还需要 `navigator.clipboard.write(...)` 和 `ClipboardItem`

### CLI 与 Skill

- 能运行本包的本地 Node.js 环境
- 使用默认 CLI 文件解码/编码路径时需要安装 `sharp`
- 可读写本地输入/输出路径的文件系统环境
- 在仓库内可直接使用：

```bash
node bin/gwr.mjs remove <input> --output <file>
node skills/gemini-watermark-remover/scripts/run.mjs remove <input> --output <file>
```

- 分发后的 Skill 则依赖本地环境能够执行打包后的 `gwr` CLI 边界

## 测试

```bash
# 运行全部测试
pnpm test
```

回归测试会使用 `src/assets/samples/` 下的源样本。
源样本文件应保留在 git 中。
这些样本的命名与保留规则见 `src/assets/samples/README.md`。
复杂图预览/下载验证说明见 `docs/complex-figure-verification-checklist.md`。
本地生成到 `src/assets/samples/fix/` 下的文件只是人工回归快照，不进入 git，也不作为 CI 必须存在的基线。

## 发版说明

版本变更请看 [CHANGELOG_zh.md](CHANGELOG_zh.md)，本地发版清单见 [RELEASE_zh.md](RELEASE_zh.md)。最新发布收尾记录见 [docs/release-1.0.29-post-release.md](docs/release-1.0.29-post-release.md)。

## Gemini 水印去除算法原理

### Gemini 添加水印的方式

Gemini 通过以下方式添加水印：

$$watermarked = \alpha \cdot logo + (1 - \alpha) \cdot original$$

其中：
- `watermarked`: 带水印的像素值
- `α`: Alpha 通道值 (0.0-1.0)
- `logo`: 水印 logo 的颜色值（白色 = 255）
- `original`: 原始像素值

### 反向求解移除水印

为了去除水印，可以反向求解如下：

$$original = \frac{watermarked - \alpha \cdot logo}{1 - \alpha}$$

通过在纯色背景上捕获水印，我们可以重建 Alpha 通道，然后应用反向公式恢复原始图像

## 水印检测规则

引擎使用分层检测来定位和验证水印：

1. **尺寸目录匹配** — 将图片尺寸与 Gemini 已知输出尺寸对比，预测水印大小和位置。
2. **局部锚点搜索** — 在预测的水印区域周围扫描实际像素数据，精确定位水印位置。
3. **恢复验证** — 在应用去水印前确认检测到的水印是真实的，避免误判。

默认水印配置：

| 条件 | 水印尺寸 | 右边距 | 下边距 |
|------------|---------|--------|--------|
| 较大的 Gemini 输出 | 96×96 | 64px | 64px |
| 较小的 Gemini 输出 | 48×48 | 32px | 32px |

## 项目结构

```
gemini-watermark-remover/
├── bin/                   # 发布后的 CLI 入口（`gwr`）
├── public/
│   ├── index.html         # 官网 / userscript / 内部预览入口页
│   ├── dev-preview.html   # 保留给仓库本地调试的内部浏览器预览页
│   └── tampermonkey-worker-probe.*  # userscript / worker 调试探针页
├── skills/
│   └── gemini-watermark-remover/    # 可分发的 agent Skill bundle
├── src/
│   ├── assets/            # 校准资源与回归样本
│   ├── cli/               # CLI 参数解析与文件工作流
│   ├── core/              # 去水印核心算法、评分与恢复逻辑
│   ├── page/              # Gemini 页面侧运行时
│   ├── sdk/               # 高级 / 内部 SDK 接口
│   ├── shared/            # DOM、blob、session 等共享辅助模块
│   ├── userscript/        # userscript 入口与浏览器钩子
│   ├── workers/           # worker 运行时
│   ├── app.js             # 内部单图预览 harness 入口
│   └── utils.js           # 内部预览页通用浏览器工具
├── tests/                 # 单元、回归、打包与 smoke 测试
├── scripts/               # 本地自动化与调试启动脚本
├── dist/                  # 构建输出目录
├── build.js               # 构建脚本
└── package.json
```

## 架构概览

- `src/core/` 负责水印检测、候选位置选择、恢复评分和反向 alpha 去水印主流程。
- `src/userscript/`、`src/page/`、`src/shared/` 共同实现真实 Gemini 页面上的预览替换、复制/下载拦截等集成功能。
- `src/cli/` 与 `bin/gwr.mjs` 提供面向文件的本地自动化入口。
- `skills/gemini-watermark-remover/` 提供可分发的 Skill bundle，并且严格停留在 CLI 边界，不直接导入仓库内部实现。
- `src/sdk/` 仍保留给高级 / 内部集成使用，但不再是对外主入口。

---

## 局限性

- 只去除了 **Gemini 可见的水印**<small>（即右下角的半透明 Logo）</small>
- 同时支持**图片**和**视频**水印去除 — 视频处理请使用[在线工具](https://geminiwatermarkremover.io/video)
- 无法去除隐形或隐写水印。<small>[（了解更多关于 SynthID 的信息）](https://support.google.com/gemini/answer/16722517)</small>
- 针对 Gemini 当前的可见水印模式设计<small>（本仓库验证范围截至 2026 年 4 月）</small>

## 免责声明

本项目采用 **MIT License** 发布。

根据您所在的司法管辖区及图像的实际用途，移除水印的行为可能具有潜在的法律影响。用户需自行确保其使用行为符合适用法律、相关服务条款以及知识产权规定，并对此承担全部责任。

作者不纵容也不鼓励将本工具用于侵犯版权、虚假陈述或任何其他非法用途。

**本软件按“原样”提供，不提供任何形式（无论是明示或暗示）的保证。在任何情况下，作者均不对因使用本软件而产生的任何索赔、损害或其他责任承担任何义务。**

## 致谢

本项目是 [Gemini Watermark Tool](https://github.com/allenk/GeminiWatermarkTool) 的 JavaScript 移植版本，原作者 Allen Kuo ([@allenk](https://github.com/allenk))

反向 Alpha 混合算法和用于校准的水印图像基于原作者的工作 © 2024 AllenK (Kwyshell)，采用 MIT 许可证

## 相关链接

- [Gemini Watermark Tool](https://github.com/allenk/GeminiWatermarkTool)
- [算法原理说明](https://allenkuo.medium.com/removing-gemini-ai-watermarks-a-deep-dive-into-reverse-alpha-blending-bbbd83af2a3f)

## 许可证

[MIT License](./LICENSE)

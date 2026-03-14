[English](README.md)

# Gemini 去水印工具 — 无损去除 Gemini AI 图片水印

开源的 **Gemini 水印去除工具**，可无损去除 Gemini AI 生成图片中的水印。基于纯 JavaScript 实现，使用数学精确的反向 Alpha 混合算法，而非 AI 修复，确保像素级精准的 Gemini 图片去水印效果。

> **🚀 想快速去除 Gemini 水印？直接使用在线去水印工具：[pilio.ai/gemini-watermark-remover](https://pilio.ai/gemini-watermark-remover)** — 免费、无需安装，浏览器即可使用。

<p align="center">
  <a href="https://pilio.ai/gemini-watermark-remover"><img src="https://img.shields.io/badge/🛠️_在线工具-pilio.ai-blue?style=for-the-badge" alt="在线工具"></a>&nbsp;
  <a href="https://gemini.pilio.ai/userscript/gemini-watermark-remover.user.js"><img src="https://img.shields.io/badge/🐒_油猴脚本-安装-green?style=for-the-badge" alt="油猴脚本"></a>&nbsp;
  <a href="https://gemini.pilio.ai"><img src="https://img.shields.io/badge/🧪_开发者预览-gemini.pilio.ai-gray?style=for-the-badge" alt="开发者预览"></a>
</p>

<p align="center">
  <img src="https://count.getloli.com/@gemini-watermark-remover?name=gemini-watermark-remover&theme=minecraft&padding=7&offset=0&align=top&scale=1&pixelated=1&darkmode=auto" width="400">
</p>

## 特性

- ✅ **纯浏览器端处理** - 无需后端服务器，所有处理在本地完成
- ✅ **隐私保护** - 图片不会上传到任何服务器
- ✅ **数学精确** - 基于反向 Alpha 混合算法，非 AI 模型
- ✅ **自动检测** - 自动识别 48×48 或 96×96 水印尺寸
- ✅ **易于使用** - 拖拽选择图片，一键处理
- ✅ **跨平台** - 支持所有现代浏览器

## Gemini 去水印效果示例

<details open>
<summary>点击查看/收起示例</summary>
　
<p>无损 diff 示例</p>
<p><img src="docs/lossless_diff.webp"></p>


<p>示例图片</p>

| 原图 | 去水印后 |
| :---: | :----: |
| <img src="docs/1.webp" width="400"> | <img src="docs/unwatermarked_1.webp" width="400"> |
| <img src="docs/2.webp" width="400"> | <img src="docs/unwatermarked_2.webp" width="400"> |
| <img src="docs/3.webp" width="400"> | <img src="docs/unwatermarked_3.webp" width="400"> |
| <img src="docs/4.webp" width="400"> | <img src="docs/unwatermarked_4.webp" width="400"> |
| <img src="docs/5.webp" width="400"> | <img src="docs/unwatermarked_5.webp" width="400"> |

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

1. 浏览器打开 **[pilio.ai/gemini-watermark-remover](https://pilio.ai/gemini-watermark-remover)**
2. 拖拽或点击选择带水印的 Gemini 图片
3. 图片会自动开始处理，移除水印
4. 下载处理后的图片

### 油猴脚本

1. 安装油猴插件（如 Tampermonkey 或 Greasemonkey）
2. 打开 [gemini-watermark-remover.user.js](https://gemini.pilio.ai/userscript/gemini-watermark-remover.user.js)
3. 脚本会自动安装到浏览器中
4. Gemini 对话页面点击复制或者下载图片时，会自动移除水印

### 开发者预览

如果你是开发者或贡献者，可以通过 [gemini.pilio.ai](https://gemini.pilio.ai) 预览最新的开发版本。该版本可能包含实验性功能，不建议普通用户日常使用。

## 开发

```bash
# 安装依赖
pnpm install

# 开发构建
pnpm dev

# 生产构建
pnpm build

# 本地预览
pnpm serve
```

## SDK 用法

现在包根已经暴露了一层较稳定的公共 SDK，第三方可直接调用：

```javascript
import {
  createWatermarkEngine,
  removeWatermarkFromImage,
  removeWatermarkFromImageData,
} from 'gemini-watermark-remover';
```

如果你已经拿到了 `ImageData`，优先用纯数据接口：

```javascript
const result = await removeWatermarkFromImageData(imageData, {
  adaptiveMode: 'auto',
  maxPasses: 4,
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

现在的检测已经不再只是“48/96 + 32/64”的粗粒度 if/else 规则。

当前策略分层如下：

- 先使用 Gemini 官方尺寸目录作为主要锚点先验
- 对接近官方尺寸的导出图，按最近的官方尺寸族反推锚点
- 围绕默认锚点和目录锚点一起做局部搜索
- 只有在 restoration validation 确认压制真实发生后，才接受去水印结果

默认回退配置仍然是：

| 默认条件 | 水印尺寸 | 右边距 | 下边距 |
|------------|---------|--------|--------|
| 较大的官方或推断尺寸 | 96×96 | 64px | 64px |
| 较小的官方或推断尺寸 | 48×48 | 32px | 32px |

## 测试

```bash
# 运行全部测试
pnpm test
```

回归测试会使用 `src/assets/samples/` 下的源样本。
源样本文件应保留在 git 中。
本地生成的 `*-fix.*` 只是人工回归快照，不进入 git，也不作为 CI 必须存在的基线。

## 项目结构

```
gemini-watermark-remover/
├── public/
│   ├── index.html         # 主页面
│   └── terms.html         # 使用条款页面
├── src/
│   ├── core/
│   │   ├── alphaMap.js    # Alpha map 计算
│   │   ├── blendModes.js  # 反向 alpha 混合算法
│   │   └── watermarkEngine.js  # 主引擎
│   ├── assets/
│   │   ├── bg_48.png      # 48×48 水印背景
│   │   └── bg_96.png      # 96×96 水印背景
│   ├── i18n/              # 国际化语言文件
│   ├── userscript/        # 用户脚本
│   ├── app.js             # 网站应用入口
│   └── i18n.js            # 国际化工具
├── dist/                  # 构建输出目录
├── build.js               # 构建脚本
└── package.json
```

## 核心模块

### alphaMap.js

从背景捕获图像计算 Alpha 通道：

```javascript
export function calculateAlphaMap(bgCaptureImageData) {
    // 提取 RGB 通道最大值并归一化到 [0, 1]
    const alphaMap = new Float32Array(width * height);
    for (let i = 0; i < alphaMap.length; i++) {
        const maxChannel = Math.max(r, g, b);
        alphaMap[i] = maxChannel / 255.0;
    }
    return alphaMap;
}
```

### blendModes.js

实现反向 Alpha 混合算法：

```javascript
export function removeWatermark(imageData, alphaMap, position) {
    // 对每个像素应用公式：original = (watermarked - α × 255) / (1 - α)
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const alpha = Math.min(alphaMap[idx], MAX_ALPHA);
            const original = (watermarked - alpha * 255) / (1.0 - alpha);
            imageData.data[idx] = Math.max(0, Math.min(255, original));
        }
    }
}
```

### watermarkEngine.js

主引擎类，协调整个处理流程：

```javascript
export class WatermarkEngine {
    async removeWatermarkFromImage(image) {
        // 1. 检测水印尺寸
        const config = detectWatermarkConfig(width, height);

        // 2. 获取 alpha map
        const alphaMap = await this.getAlphaMap(config.logoSize);

        // 3. 移除水印
        removeWatermark(imageData, alphaMap, position);

        return canvas;
    }
}
```

## 浏览器兼容性

- ✅ Chrome 90+
- ✅ Firefox 88+
- ✅ Safari 14+
- ✅ Edge 90+

需要支持：
- ES6 Modules
- Canvas API
- Async/Await
- TypedArray (Float32Array, Uint8ClampedArray)

---

## 局限性

- 只去除了 **Gemini 可见的水印**<small>（即右下角的半透明 Logo）</small>
- 无法去除隐形或隐写水印。<small>[（了解更多关于 SynthID 的信息）](https://support.google.com/gemini/answer/16722517)</small>
- 针对 Gemini 当前的水印模式设计<small>（截至 2025 年）</small>

## 免责声明

本工具仅限**个人学习研究**所用，不得用于商业用途。

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

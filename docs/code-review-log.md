# 代码审查与线上跟进台账

## 2026-09-21：开放 Issues / PR 跟进

审查者：Codex。主工作区 HEAD：`7411b444d4041829c938c338204ac863ead77b69`。
线上清单：13 个开放 Issue，4 个开放 PR。读取最新列表、#165/#166/#167 和四个 PR 的正文、评论及 review；其余 Issue 通过更新时间与既有交接对照，本轮未重复复现。

未找到既有统一代码审查台账，因此建立本文件；历史依据保留在 GitHub review、`agy-handoff-2026-09-16.md` 和发行文档中，不将历史声明记作本轮验证。

### PR #164：4K 视频候选

- 链接：https://github.com/GargantuaX/gemini-watermark-remover/pull/164
- 比较基准：`25ef59dfa8322303ba98643adc486bc152587dc6`；受检 head：`3d4d4b34bb3f6a0f2522af49b2cc8f64d907d30b`。
- 范围：PR 两个文件的完整差异、现有目录编排；隔离工作树 `.artifacts/pr-164-review`。
- 改动：保留现有 144px 投影候选，另加 160px、右/下边距 198/265 的精确 3840×2160 候选；200px 模型 padding 为 20。
- 验证：`node --test tests/video/videoWatermarkCatalog.test.js tests/video/videoDenoiseRuntimePolicy.test.js`，14 通过、0 失败。
- 结论：此范围未发现可确认的代码缺陷；不是完整检测/导出质量验收。PR 未附原始 4K 视频、来源及候选逐帧证据，无法确认新几何的普适性。没有 CI 检查结果，GitHub 显示 MERGEABLE / BLOCKED；本轮未诊断 BLOCKED 的具体分支规则。
- `FOLLOWUP-164-01`：待补验证。需要未经编辑的原视频、候选定位对比，以及旧 144px 锚点和无水印/结构化背景控制。`evidenceGate` 字段值差异只记录为元数据差异，未证明它在视频路径产生门控作用，不据此报运行时漏洞。

### PR #138：按周围纹理减弱残留清理

- 链接：https://github.com/GargantuaX/gemini-watermark-remover/pull/138
- merge-base：`83a6cbda10e4c5d1c3bd818143f8410fcb186020`；受检 head：`5a7750df9f6e4790e4ae3b392ed4ff15ce8569ac`。
- 范围：两个文件的完整 PR 差异和清理调用上下文；隔离工作树 `.artifacts/pr-138-review`。
- 验证：`node --test tests/video/videoCleanupBackends.test.js`，33 通过、0 失败。对比受检文件与主线，生产文件差异仅为本 PR 的纹理门控改动，未发现额外主线漂移。
- 结论：此范围未发现可确认的新代码缺陷；33 项测试不证明真实视频纹理与残留质量。PR 正文有三段视频的指标与截图，但没有可复现的原视频附件；本轮未复现作者的视觉对比、时间连续性或编码质量。
- `FOLLOWUP-138-01`：待补验证。保留平坦/纹理背景的原始视频、导出设置及时间点，覆盖背景随时间变化的情况；使用逐帧裁剪和内容损伤证据，不能只靠模板残留分数验收。不能直接宣称修复 #167 的整片画质投诉。

### PR #109：复用同 SHA 的阻塞审查

- head：`081bcd0a82796ed15dc2d4ec9ad2680f5474bf03`，与 2026-08-10 CHANGES_REQUESTED review 相同。
- `PR109-ACTIVE-SINGLE`：待处理（沿用历史问题，不是本轮新发现）。批处理中选择恰好一个视频会进入 `setFile` 单文件路径，改写共享状态而未追加队列。
- 本轮只核对 SHA 与 review，未重复浏览器复现或全量测试。仍需 UI 路由边界修复和回归；原 review 见 PR 内 2026-08-10 的 CHANGES_REQUESTED：https://github.com/GargantuaX/gemini-watermark-remover/pull/109

### PR #157 与 Issue #150

- head：`5c486fc9ee481220ea9f483dca7644b19918408a`。草稿，CI 历史结果 SUCCESS，GitHub 显示 MERGEABLE / CLEAN。
- 本轮未审代码或重跑测试；正文记录的 192 帧及 #136 对照是历史证据。
- `FOLLOWUP-157-01`：待独立视频发行验收。#150 已关闭，但其最新维护者评论明确“尚未部署”，PR 仍未合并；不能把关闭状态解释为线上已修复。本轮未检查官网运行时代码。

### Issue 分类与恢复条件

| Issue | 已核实状态 | 下一项 |
| --- | --- | --- |
| #167 | 新报告，1.0.43、Full HD 视频画质下降；仅图片附件，无原视频和处理视频 | 需要原视频、结果、入口、设置及损失位置，区分整片重编码与局部清理 |
| #166 | 截图报告；9 月 14 日已请求材料，尚无新回复 | 原视频/结果/时间点到位后复现，避免重复催问 |
| #165 | 最初 824×1024 与第二张 896×1200 已由作者确认直接来自 Gemini；第一张 765×1024 来自去水印网站 | 两张原始输出仍未解决。第一张不能作为原始无水印控制。9 月 16 日交接已保留来源确认，不再重复要求上传 |
| #101/#120/#123/#114/#117/#121/#143/#152/#154 | 列表更新时间没有晚于既有 9 月 16 日交接的新活动 | 复用原调查与材料请求，不据无回复关闭 |
| #151 | 桌面应用请求 | 单独产品范围决策 |

来源确认：https://github.com/GargantuaX/gemini-watermark-remover/issues/165#issuecomment-5693571584

### 工作区保护与未覆盖事项

- 原有 `src/core/pipelineInitialSelection.js` 和 `tests/core/exact48CandidateRetention.test.js` 未提交改动未修改、未纳入上述 PR 结论。本机 #165 目录含 9 月 17 日实验脚本与输出，不能将较旧交接当成这些改动的验收记录。
- 没有运行全量测试、生产构建、视频编码或官网验收；没有合并、发布、关闭 Issue、发评论或提交 review。
- 后续回复草稿见 `github-followup-drafts.md`。本轮不将待补证据项标记成确认代码 Bug。

## 2026-09-21：用户确认后继续

### 已发送回复

用户明确同意开始后，重新读取评论并去重，已发送 #167、#165、#164、#138 的回复。准确内容及链接见 `github-followup-drafts.md`。没有关闭 Issue、合并 PR 或部署。

### #157 固定提交复审与有限视频核验

- 审查者 Codex；受检 head `5c486fc9ee481220ea9f483dca7644b19918408a`，当前远端主线 `25ef59dfa8322303ba98643adc486bc152587dc6`。只审查 PR 完整两文件差异和同步/异步检测、逐帧选择的相关调用。两个受检文件相对当前主线仅有该 PR 差异，无其他漂移。
- `node --test tests/video/videoWatermarkDetector.test.js`：18 通过、0 失败。在隔离工作树固定 PR head 执行，非合并后全量测试。
- 未发现可确认的新代码缺陷：主候选保持 best-effort，只在所有采样一致时排除零票次候选；混合投票路径保持原逻辑。
- 下载 #150 原视频及 #136 两个附件，以 FFmpeg 单线程解码右下 256×256 区域，在原尺寸图像相同坐标恢复候选上下文；以 videoExport 的首帧与后续目标时间策略取 12 个检测样本。执行真实 baseline/patched 检测器，并比较所有帧的候选位置、alpha 与 seed。
- #136 两份视频各 240 帧，候选选择/alpha/seed 对照均 0 帧改变。没有编码导出，不能声称输出视频或解码输出帧像素一致。
- #150 共 192 帧，本轮 FFmpeg 解码下 baseline 和 patched 均选择 48px 主候选，未复现历史网页 102 帧误选。弱 24px 候选均值约 0.17376，低于默认 0.18；历史网页约 0.18924。当前证据不能确定差异仅由解码色彩或采样引起。
- 结论：聚焦代码检查与有限对照通过，真实网页正向复现仍未完成，`FOLLOWUP-157-01` 保持待验收；不以“未复现”宣称线上已修复。需要原网页/浏览器解码路径重放并完成独立视频发行检查，才决定发布。
- 证据：`.artifacts/pr-157-review/probe-tracks.mjs`、`track-probe-results.json`，JSON 包含附件 SHA256、采样索引和逐候选摘要。临时脚本不属于产品代码。

#### 同轮补充：真实浏览器解码路径

- 使用 Playwright Chromium、Mediabunny 和真实 `detectGeminiVideoWatermark` 入口完成对照；通过内存路由载入隔离页面及视频，没有启动服务，也没有改动官网。
- baseline 的检测文件与远端主线一致，patched 为固定 PR head。#150 原视频 baseline 在 105/192 帧选中 24px 背景候选，patched 全部 192 帧选中目标 48px。历史记录为 102 帧，本轮结果为 105，不拼接两个环境的数据。
- #136 两附件各 240 帧，逐帧位置、alpha、seed 均无变化；相同选择不等同于编码后输出逐像素相同。
- 此证据解决上述“浏览器正向复现未完成”子项。限定检测路径的代码复审和实样验证通过，未发现阻塞问题。`FOLLOWUP-157-01` 剩余完整清理/编码导出、当前集成 CI 与独立发布面验收，仍未合并或发布。
- 证据：`.artifacts/pr-157-review/browser-probe-entry.mjs`、`browser-probe.mjs`、`browser-probe-results.json`（含 Chromium 版本和候选统计）。
- 已向 PR 回报本轮证据：https://github.com/GargantuaX/gemini-watermark-remover/pull/157#issuecomment-5763281600

### #165 验收准备

- 原有两份代码/测试改动保留，基准 `7411b444d4041829c938c338204ac863ead77b69`。已有4项聚焦测试通过，不代表质量验收。
- 发现旧比较脚本混用了不同样本，旧女性对照图无效；要求重新建立完整 baseline/patched 对照。
- 执行曾因外部条件中断，恢复后继续同一验收范围。内部登录、会话和调度记录仅保留于本地归档。

## 2026-09-22：#165 执行交付与主控复审

- AGY 交付提交 `03f510ce6daea0bae595d3283e5d2300d223b78b`，base `7411b444d4041829c938c338204ac863ead77b69`；只含原来两文件44增3删，没有扩展生产改动。协议正常 `end_turn`，隔离工作树仅有本地工具配置。
- 主控审查覆盖这两文件完整diff、原图对照图、`.artifacts/run-evaluation-worker.mjs`、`run-comparison-orchestrator.mjs`、`measure-accurate-dark-ring.mjs` 及报告。AGY报告4+36聚焦测试通过；本轮主控未重复全部测试。
- 有效观察：男性824×1024完整输出解码RGBA哈希保持 `99b716a5507ca64d30ff54c3869292b4dbda6f1b18d673aed0f7b388bf9ea886`；女性基线RGBA与历史 `eae268fb33781606624f1e4f24b0bc0c67e16bb2c8d9dd6d9964393ec2477eea` 一致，新输出 `be5aef44410e76f0a96f418ca885795856ec330ae747be434fb1c6d2a6ebde40`，候选49/gain0.45改为48/gain0.55。没有将输出不同解释为独立质量通过。
- 主控目视检查普通ROI与上下文拼图：处理图相对原图水印减弱，但不能确认完全干净或独立内容无损。映射在看图前已披露，不记为盲测。

### 问题与处理

| ID | 严重度 | 状态 | 发现与要求 |
| --- | --- | --- | --- |
| REVIEW-165-01 | P1 | 待处理 | 验收worker对interpolateAlphaMap传入五个参数，而签名为三参数，实际返回96×96，所谓49反例不成立。修正长度/有限值断言及正确49反例，旧结论作废 |
| REVIEW-165-02 | P1 | 待处理 | 新增平滑48测试baseline也通过，不覆盖新增分支回归。需baseline失败/patched通过的受控或候选收集测试；无法合理复现则保留待验收 |
| REVIEW-165-03 | P1 | 待处理 | 报告以周围均值阈值推出“彻底消除暗环、当前最优、压缩导致残留”等无独立证据断言；撤回并保留未知。原阶段调查显示暗弧在初次逆运算已有，不可归因三次清理 |

已集中反馈原AGY会话，范围限于证据与聚焦测试修正，不扩展生产算法。当前整批验收不通过，未集成、推送、发布，也未向Issue宣称修复。原主工作区改动继续保留。

### 复审修正交付与最终处置

- FIX 提交 `68bd01303500965c48055189ac48fbd897aa3b91`，相对 `03f510ce6daea0bae595d3283e5d2300d223b78b` 只调整测试，生产代码不变。主控复审该增量完整diff、修正的49反例脚本与结果JSON、修订报告和2x普通对照图。
- REVIEW-165-01：复审通过。49模板调用修正为三参数并检查2401个有限值，两个锚点均实际施加水印914像素；新旧完整SDK输出指标相同，ROI RMSE为1.2986072 / 1.3096254、外环RMSE均0。原跳过结论作废。这是有限反例验证，不是所有49px输入安全证明。
- REVIEW-165-02：分支回归复审通过。主控实际运行当前新测试1/1通过；从完整基线SHA提取候选收集模块单独导入，同一测试在“应保留sourceWitness候选”的预期断言失败。临时文件已删除。此测试注入了fixed/automatic选择结果，只覆盖候选收集分支，不算完整流水线独立复现或真实图质量真值。
- REVIEW-165-03：报告结论已降为证据不足待验收。主控另在报告顶部补勘误，纠正仍残留的因果表述和与JSON不一致的MAE（0.0217014 / 0.6317998 / 0.4802166 / 0.4956268）。暗背景案例两端都修改876像素，只记基线一致，不认定无损。文字问题复审关闭，但真实图独立内容保护缺口保留。
- 最终质量状态：**待验收，不集成/不发布/不关闭#165**。女性原图在放大对照仍能看到轮廓，男性原图残留未改变。进一步推进需要独立模板/背景证据及未用于调参的复杂内容控制；不继续对同一图调强度或复跑已有矩阵充当进展。
- 交付位置：隔离worktree `.artifacts/issue165-acceptance`，head `68bd01303500965c48055189ac48fbd897aa3b91`；报告 `.artifacts/acceptance-result.md`，对照 `.artifacts/eval-outputs/165-ref2_comparison_quad_sheet_2x.png`。主工作区原两文件改动仍原样保留。
- AGY本次恢复后业务prompt共2次（验收+集中FIX），均在原会话正常end_turn；没有扩大提供方、模型或发布权限。
- 已向 #165 回报上述进度与未解决状态：https://github.com/GargantuaX/gemini-watermark-remover/issues/165#issuecomment-5763783022

## 2026-09-22：完整导出与独立控制验收（执行中）

- 用户同意先推进 #157 完整导出，再验证 #165 独立控制。原 AGY ACP 会话续接一次业务 prompt，任务文件 `.artifacts/followup-export-task.md`；限现有两个隔离工作树，不改生产代码、不合并发布。
- GitHub 重新核实：远端 main 仍为 `25ef59dfa8322303ba98643adc486bc152587dc6`，#157 head 仍为 `5c486fc9ee481220ea9f483dca7644b19918408a`。PR API 的 baseRefOid `07b059a8d56e5fd47f4b73de24f2e370aa6fc82c` 是旧基准，不能当作当前主线；比较 API 及 commits/main 已确认。
- #157 仍是 draft，现有成功 CI 是 2026-09-09 run34367927651；本轮尚无当前集成 CI 证据。现有 CI 只有 push/main 和 pull_request 触发，ubuntu-latest，无手动入口。
- 本轮查询 2026-09-21 以来 issue comments，只返回上一轮维护者跟进，未出现新的原始素材；不重复催问。
- 原工作区两个用户修改及未提交文档保持。执行终态和主控复审结论待追加，本段不构成验收通过。

### 首次交付复审与集中修正

- AGY 正常 end_turn，exit0；生成三视频各 baseline/patched/control 共9份 MP4，以及 #165 九组控制。没有产品代码改动。
- 主控检查两份报告、三个执行脚本、#150 f50/f100 与 #136a/b f60 拼图。#150 两个被抽查帧中主水印明显减弱、错误24位置黑点消失；#136b 基线与补丁都存在暗斑，不能称整体无损。非盲评、不是全帧质量确认。
- `REVIEW-FOLLOWUP-01` P1 待处理：#165 baseline 导入主工作区未提交补丁，比较实际不是提交7411基线。首次九组相同输出作为前后比较证据作废；要求固定基线源哈希校验、正确锚点true49控制和有界重跑。
- `REVIEW-FOLLOWUP-02` P1 待处理：视频报告仅凭容器元数据声称末帧/音画同步100%保留，且把#136像素差归为编码浮动、抽查图推广为全帧清洁。要求对现有文件实际解码计数及首末PTS、音频包hash/timestamps核验，缩小未证实的画质结论。RGB求和最大差不能标成单通道差；特殊浏览器flag和编码传播限制必须披露。
- 已一次集中反馈同一ACP会话，提示文件 `.artifacts/followup-export-fix.md`。原始导出文件可保留，报告PASSED暂不采纳。

### 本轮复审结算

- FIX 正常end_turn、exit0，仍无产品diff。主控复审修订脚本、报告、结果数据；AGY本轮业务prompt2次（验收+FIX），沿用原ID与模型，受限等待不属于事件唤醒。
- REVIEW-FOLLOWUP-01：基线导入错误修复复审通过。隔离archive基线模块hash `4bf93ef30a5433b7713dbf24174b5adf82c7bf0290d3dc1edcd981bd4dc556c8`，补丁模块 `7729efba78ec9f0bd43dff1e18b0825024129ead5a4d2e27a39fc30a9e1ddfcf`。固定背景/seed/gain，true49改为相对H-144/H-145，12组完整SDK输出均基线补丁相同。首次9组归档INVALID。没有分支轨迹，不能由输出相同推断具体不触发原因。无水印图两端仍改动，因此不是整体安全通过。
- REVIEW-FOLLOWUP-02：视频首末时间和帧数补证通过：原视频与三种输出均192/240/240帧，起点0，末PTS7.958333/9.958333/9.958333。修订音频脚本仍仅对包元数据算hash，主控发现并追加真实payload核验：`rtk proxy node .artifacts/verify-export-audio.cjs`，九份输出全部非负PTS包的真实SHA256、PTS/DTS、duration、size均与原输入相同。原#150/#136a省略负时间预卷包，具有Skip Samples1024标记。证据 `reviewer-audio-payload-results.json`。未做听感验收，不能声称感知无损。
- 已在两份报告顶部追加主控勘误，撤回暗斑具体Inpaint根因和#136差异全部源于编码的断言。特殊browser flags的完整导出不算正常官网集成测试。
- #157 固定受检head仍 `5c486fc9ee481220ea9f483dca7644b19918408a`：完整导出执行、时间轴及包复制检查通过，抽查#150明显改善；既有#136b暗斑仍在，全片画质与当前集成CI/官网验收未完成。`FOLLOWUP-157-01` 保留剩余门禁，不标记可发布。
- #165 固定受检head仍 `68bd01303500965c48055189ac48fbd897aa3b91`：12组正确基线控制未显示新增退化，也未显示独立全流程收益。维持证据不足，不集成或发布。
- 两个报告位于各worktree的 `.artifacts/export-acceptance/report.md` 与 `.artifacts/heldout-safety/report.md`。主工作区用户改动保留，本轮未合并、推送、发布或关闭issue。

## 2026-09-22：#157 当前主线集成

- 用户同意将#157推进到可合并状态，补完整CI和普通浏览器验证。新隔离worktree `.artifacts/pr157-integration`，本地分支 `codex/pr157-integration-check`。
- 原PR head `5c486fc9ee481220ea9f483dca7644b19918408a` 无冲突合入远端main `25ef59dfa8322303ba98643adc486bc152587dc6`，生成集成head `6a3a3f8b089960bc7a997bddc461cc88806b3501`。主控核对相对main差异，仍仅原PR检测器和测试两文件46增4删，无新增算法变更。
- 已快进推送原PR分支 `codex/issue150-video-tracks`，没有强推、合入main或发布。新完整CI：https://github.com/GargantuaX/gemini-watermark-remover/actions/runs/35634362543 。待终态，不能复用旧CI冒称新提交通过。
- AGY原会话执行普通Chromium（无禁用安全/实验flags）三段视频完整导出验证，限本集成树artifact写入；主控处理CI。提示 `.artifacts/pr157-integration-task.md`。
- `FOLLOWUP-136-QUALITY-01`：既有质量观察，暂缓根因调查。#136b f60基线与PR输出均有暗斑，不能归因为PR157，也尚未定位具体清理阶段；保持独立于本PR的后续事项。来源及图见前轮export-acceptance。#165冻结、不扩大本轮范围。

### 集成CI与普通浏览器初次交付

- CI run35634362543 对应完整head `6a3a3f8b089960bc7a997bddc461cc88806b3501`，SUCCESS。构建通过；项目入口7/7，SDK smoke8/8；全量1744项中1711通过、0失败、33跳过。没有把跳过记作通过。
- AGY正常end_turn，生成普通Chromium145.0.7632.6核心导出结果，未自定义启动flags。三片192/240/240帧、首末PTS保持，音频payload哈希与前轮patched一致。主控看#150 f50对照，改善保持。核心脚本真实输入hash正确；报告表格#136a/b输入hash抄写错误，要求据JSON修订。
- `REVIEW-INTEGRATION-157-01` P2待修正：报告继续把内部videoExport函数称为SDK实际入口，尚未走公开Node wrapper依赖的video-preview实际UI；其默认后端与裸核心API可能不同。集中反馈补一个192帧实际UI上传/处理/下载验证，普通浏览器、默认设置、不启动服务或完整本地构建。同步纠正哈希、未证实的Inpaint根因及编码成因表述。
- 原始普通浏览器证据 `.artifacts/pr157-integration/.artifacts/ordinary-browser/`；执行者将runner保存在旧会话worktree的`.artifacts/run-ordinary-browser-export.mjs`，已要求复制到本集成证据目录，不改生产代码。现有结果限定核心函数，待UI补证。

### 集成最终复审

- REVIEW-INTEGRATION-157-01复审通过（限定页面流程）。AGY FIX正常end_turn，补实际public/video-preview.html与src/video-app.js上传/处理/读取下载blob两条流程：未干预UI自动切Canvas preset；模拟Node wrapper默认后端的流程实际加载ONNX并由WebGPU回退WASM。均192帧，首末PTS保持。没有直接调用公开Node wrapper，也未点击下载按钮，不扩大结论。
- 主控复审完整UI runner及JSON，确认集成模块路径、默认headless launch、页面控件、模型请求及回退日志。UI context含ignoreHTTPSErrors，本地route供给不验证线上TLS；不等同部署验收。没有产品修改。
- 报告修订又误写了三份核心输出SHA，主控以实际文件核对纠正。执行 `.artifacts/review-integration.cjs`：三核心+两UI文件hash均与原JSON一致；所有非负PTS音频包的真实payload hash/PTS/DTS/duration逐包等于原输入。结果 `reviewer-verification.json`。
- 主控实际查看两UI输出f50：水印显著减弱，未看到基线错误24位置黑点。非盲评、非全片无损证明。普通核心脚本与UI脚本均已保留在integration证据目录。
- 最后已审SHA `6a3a3f8b089960bc7a997bddc461cc88806b3501`。结论：#157限定候选选择修复可进入合并审议，当前主线CI和普通浏览器/实际页面流程门禁已补齐；官网发布验证保留在独立发布阶段。#136质量观察与#165暂缓状态不变。
- 本轮AGY业务prompt2次（验证+集中FIX），原会话/模型，无新生产算法。主工作区原修改完整保留。
- 已按复审证据重写#157描述并标记ready for review，保留未合并未发布边界：https://github.com/GargantuaX/gemini-watermark-remover/pull/157 。

## 2026-09-22：用户批准合并与发布候选准备

- 合并前核对#157 head仍 `6a3a3f8b089960bc7a997bddc461cc88806b3501`，CI SUCCESS，CLEAN。使用match-head保护执行squash合并，主线提交 `59d1b70b2ba3ce95f4023c37973b17cf2f472c08`，GitHub确认MERGED。
- npm latest与GitHub最新版本均1.0.43；准备下一版候选，不据旧验证直接发布。主线CI run35636589130待终态。
- 上游隔离worktree `.artifacts/video-release-candidate` 分支 `codex/video-release-candidate`，从59d1b70开始。官网路径通过已保存项目配置解析，独立隔离worktree `.artifacts/website-video-release` 分支 `codex/video-sdk-release`，从网站origin/main `e79a213`开始；官网主工作区既有analytics/巡检文档不动。
- AGY原会话接收 `.artifacts/video-release-task.md`：准备版本/双语变更说明/可获取的候选产物与官网依赖验证，禁止自行发布/部署/远端合并。官网锁定SDK1.0.43。完整发布规则仍限制广泛视频画质声明，#165和#136不纳入本次修复宣称。

### 发布候选首次复审

- 上游交付 `78b23c924f90a7bdc5fb6613361a24b5f59c4ad9`：版本1.0.44、双语changelog、CI成功后打包并上传tgz/dist。主控审查全部4文件；将错误f0/多数表述、虚构#136a/b issue编号等修正为可验证的用户行为，追加 `d0f4e03d312dc7ce3c1a413e0a720d6c19f8c047`。
- 已建草稿PR168：https://github.com/GargantuaX/gemini-watermark-remover/pull/168 。CI35637967257对应d0f4e03 SUCCESS，含构建、smoke、全量、pack、artifact上传。候选包/dist下载到`.artifacts/video-rc-ci`，尚未发布。
- 官网交付 `c669a205b1ee9fade1b3080310b639cf84d5ce37`：包版本变更、167行诊断CLI和53行镜像测试。`REVIEW-RELEASE-01` P2待修正：未完成真实包安装/锁文件，诊断tar参数未使用、缺候选exit0、版本测试不能证明运行时更新。要求删本轮新加的无效产品helper/test，完成实际候选验证，未公开版本的锁文件不得伪造。
- 官网视频构建读取GWR_USERSCRIPT_SOURCE_REPO上游源码，并非仅npm依赖；npm升级与网站视频产物必须分别验证。二次任务`.artifacts/video-candidate-integration-task.md`已交AGY原会话，以真实CI包继续隔离验证及轻量发布readiness检查；不授权其自行发布。
- 合并主线CI35636589130已SUCCESS；没有将其替代候选CI。官网主工作区原文档仍保留。

### 官网候选复审与CI

- 官网远端main在本轮推进到 `33b1023d6d8e6daef1a7a11ad2f68285c61535bd`（仅文档），AGY改用此基准形成 `f78a094b30b7b26b76a864abeff86ba02c852b46`。最终差异仅生成video-app.js及预览页缓存hash，包依赖/锁仍一致为1.0.43；此前多余诊断脚本/test已移除，REVIEW-RELEASE-01实现问题关闭，真实包安装验证仍另核实。
- 草稿官网PR18：https://github.com/sungerine/geminiwatermarkremover.io/pull/18 。主控已检查bundle生成入口和HTML引用变化。六次网站本地路由预览导出完成，但脚本预先设置denoiseBackend=none且未记录最终控件，不接受其“默认UI无退化/全帧锁定”断言，已要求真实默认设置补证。原报告再次错误叙述f0/192票，均不采纳。
- release readiness实际not-ready-for-release、gate fail。safe-current-defaults不等于可发布；存在package-extension-version-mismatch及证据缺失等项。已安排仅用现有CI dist轻量打包并列明剩余阻塞，不改门禁。
- 官网CI run35639640146固定f78a094。GitHub托管WebKit job106465530183因执行资源不可用未启动，属于外部阻塞，不能以其他浏览器替代或记通过。CI runner类型/i18n/coverage/build已通过，浏览器E2E仍在执行。
- 主工作区原两个代码改动仍在；官网原文档由其他工作提交后工作树当前clean，未由本任务覆盖/清理。本轮未发布npm/GitHub Release/网站。

### 最终默认配置与候选制品复审（2026-09-22）

- 复审SHA维持核心 `d0f4e03d312dc7ce3c1a413e0a720d6c19f8c047`、官网 `f78a094b30b7b26b76a864abeff86ba02c852b46`（基准 `33b1023d6d8e6daef1a7a11ad2f68285c61535bd`），没有新产品改动。AGY最终prompt完成，原始runner/JSON及主控核验保存在官网worktree `.artifacts/`。
- 六次真实默认UI上传/处理/读取blob成功，192/240/240帧；初始fdncnn-browser，最终全部canvas-footprint-polish，无ONNX/WASM请求。执行者报告误称FDnCNN运行/回退，主控已在报告顶端勘误，不采纳该断言。未测试实际下载点击/线上部署TLS。#136暗斑根因仍未知，不归因FDnCNN。
- 主控 `.artifacts/review-website-final.cjs` 独立核对六输出SHA，全部与JSON一致；每个非负PTS音频包payload hash、PTS、DTS、duration全部与原输入相同。#150/#136a负PTS AAC前导包省略，不是归零。实际查看#150 f50两ROI，残留/黑点明显改善，非全片无损证明。
- pnpm隔离fixture含真实node_modules，主控实际导入public与image-data入口成功。REVIEW-RELEASE-01限定候选安装复审关闭；官网image Worker仍1.0.43，未完成SDK公开升级。
- 官网CI35639640146：CI runner质量/build/279单测通过，E2E26通过4跳过。WebKit未启动，执行资源不可用；整体失败，需恢复执行资源后重跑失败作业，不重试不变阻塞。
- CI dist轻量extension打包完成，核心worktree有本次未提交release metadata及zip，保留不混入固定SHA。主控重跑readiness：artifact/userscript/docs ready，但整体not-ready-for-release。缺v1.0.44-image-quality/inventory，visible-residual/36px/allenk等证据仍不足。npm/Release未发布的404不作为发布前必须消除的质量错误。创建证据脚本还需要人工review/输入报告，不能声称两条命令自动补齐。
- 本阶段交付两草稿PR168/官网18；发布与部署保留。下一步先补可追溯的版本图像验收材料；维护者解决WebKit资源限制后重跑该job，全部门禁通过才进入发布。#165与#136既有暂缓项不变。

### 2026-09-22 视频专修验收路径调查与初审

- 用户连续要求继续。实际读取门禁发现除缺证据外，旧image-defaults规则明确拒绝任何video变更（image-evidence-video-scope-changed）；仅补图像报告无法验收本次视频专修。对比v1.0.43与d0f4e03的src差异只有videoWatermarkDetector.js。旧图像门禁保持，不重命名旧凭证。
- 使用已安装agy:lead/implementer companion执行独立video-fix验收路径，job [内部任务标识已省略]。原头d0f4e03，新增未提交scripts/video-fix-release-evidence.js、CLI、tests及package scripts；发布zip/metadata为既有本轮资产，不归入新增工具diff。
- REVIEW-VIDEO-GATE-01 P1：初稿verifyCandidateCiStatus硬编码ciPassedOnCandidateSha=true，未查询CI，caller candidate-sha可改变判断；集成对比未绑定实际HEAD，制品缺失无阻塞。拒绝接受。
- REVIEW-VIDEO-GATE-02 P1：CLI提供--no-fail-closed绕过失败；历史图像凭证未绑定发布Git blob，信任自身字段；网站review空数组/重复记录可通过。拒绝接受。
- REVIEW-VIDEO-GATE-03 P1：源码/构建输入黑名单与package字段覆盖不足、detector仅substring检查；artifact元数据仅自洽无CI源绑定。报告静态事实误作校验。要求简化、完整绑定当前源码与证据、真实CI查询和负面回归测试，缺证明则阻塞。
- 初稿只报告聚焦34+22通过，不视为门禁正确性证明。集中FIX任务job [内部任务标识已省略]，原会话继续。禁止发布/提交/推送，主控待复审；官网WebKit资源阻塞未重试。

### 视频验收工具复审修正与候选CI

- 第二次AGY交付虽声称自包含及TGZ来源验证，但代码仍只计算TGZ哈希、不比对可信目标，测试仍读取兄弟目录真实样本。REVIEW-VIDEO-GATE-03继续待修正。第三次任务[内部任务标识已省略]提前返回“等待下载”，后台任务在退出时被终止，不能记完成。主控接手。
- 主控补真实当前HEAD成功CI artifact下载比较，联合篡改ZIP/metadata与非空假TGZ均拒绝；pin发布tagSHA、检查实际工作树package而非Git index、CI缺响应/错SHA/脏workflow或build必须失败。移除旧本机依赖测试，独立临时夹具覆盖上述路径。固定review报告和MP4哈希作为既有复审证据复用，不冒称新执行音频探针。
- 聚焦42项通过0失败0跳过，含原image门禁和video detector回归；原image gate代码未改。CI增加extension打包/上传供新门禁比较。文档新增明确video-fix入口，图像源码/资源/依赖仍不变。REVIEW-VIDEO-GATE-01/02/03限定当前修复复审通过；全量CI和真实新制品验收尚待。
- 提交 `401a11d7cebafe5123b4f84b31d4dfd845121ec5`，更新草稿PR168。CI35684134222待终态；没有将旧CI冒称新提交通过。release/latest-extension.json和旧zip仍为未提交本地产物，不在提交内。主工作区原两个代码修改不变。

### 当前候选完整CI与实际制品验收完成

- CI35684134222在 `401a11d7cebafe5123b4f84b31d4dfd845121ec5` SUCCESS：全量1750项，1717通过0失败33跳过；SDK smoke8/8，构建/打包/上传全部通过。
- 下载当前CI制品到 `.artifacts/video-gate-ci`。在候选worktree实际执行新gate，显式指定原ordinary-browser证据、当前CI tgz及当前CI latest-extension路径。gate再次从GitHub下载该HEAD成功运行的制品作可信比较，返回PASS/exit0。报告 `.artifacts/video-release-candidate/.artifacts/video-fix-gate-report.md`。旧本地release产物未混入此次验收。
- 通过限定核心video-fix候选：固定v1.0.43基准、已审src树、原图像证据Git blob、视频复审报告与输出hash、真实CI及制品字节比较。不是图像重新采样/通用视频画质/官网上线证明。原image-defaults gate仍拒绝视频改动，本次使用显式新作用域，没有伪造1.0.44图像报告。
- 当前无运行中AGY；已收集全部三个job。最后已审与已验证SHA401a11d。PR168仍draft，官网18仍draft，WebKit资源阻塞仍需维护者解除后重跑。未合并新PR、未发布npm/Release/扩展商店、未部署网站。

### 官网 WebKit 迁移 CI runner（用户明确要求，2026-09-22）

- 确认可用的CI runner；官网原verify已在CI runner执行。基准官网f78a094，仅改.github/workflows/ci.yml，保留原PR信任条件和owner fallback。两浏览器测试命令限workers=2。
- 初次提交 `65682f2444f5e0616d09cd7af5ba7986289348a0` 改为CI runner原生WebKit，CI35684610333成功调度但WebKit因缺GTK/GStreamer等宿主库失败。不是业务测试失败，不记通过。
- 只读确认CI runner Docker29.6.2可用，改为官方mcr.microsoft.com/playwright:v1.59.1-noble容器，与pnpm-lock一致；固定2CPU/4GB、内置/ms-playwright、执行版本一致性检查，避免安装宿主系统库。官方参考 https://github.com/microsoft/playwright/blob/main/docs/src/docker.md 。未连接CI runner或重启宿主服务。
- 最后审查SHA `38b78b8769771fa51dd41607a1bfa0c237a889d8`，CI35684859170 SUCCESS：verify在CI runner执行，279单测通过、其他E2E26通过4跳过；WebKit在CI runner容器执行，8通过2跳过。构建/类型/i18n/coverage全部通过；未改变用例或跳过规则。
- 官网PR18已更新，工作树clean，原GitHub托管计算资源阻塞对该CI已解除。上游PR168/core401a11d验收仍有效（官网本轮只有CI配置变化，runtime未改）。本轮未合并PR、发布或部署；后续可继续两候选的发布准备与最终发布检查，不再要求先解决托管执行资源。

### 2026-09-22 合并候选与准备正式发布草稿

- 用户要求继续推进。核对两PR精确SHA、CLEAN和全绿，match-head保护squash合并：上游#168→`69787acf5d934443dc39f5c6613c09d8c2f3daf7`，官网#18→`d62346de66f5933db9c54061f2ae93c8ecde3acf`。两主线CI35685221382/35685229673 SUCCESS。
- 发现发布工作流要求版本TGZ必须提交至tag源码。新隔离worktree `.artifacts/release144-delivery` 从69787ac创建，branch codex/release-1.0.44-artifacts。固化已验收CI35684134222的SDK及两种extension zip/校验文件/metadata，没有重新包装或替换原制品。
- 必要发布流程修正：制品入库产生新SHA，需要保留原构建身份。增加release/evidence/v1.0.44-video-build.json，resolveArtifactCi核对原构建与HEAD生产输入及package完全一致、原GitHub成功CI编号一致，随后下载原制品比较；当前HEAD仍独立通过CI。原image gate不变。删除默认读取旧兄弟候选tgz的路径，默认使用本release目录。
- 新增回归覆盖生产输入变化、错误/缺失构建CI身份。7项聚焦通过；PR#169 head `e1130870ec15da089ddc48b44d1b52905133bc19` CI35685469212全量1751：1718通过0失败33跳过。真实gate PASS。完整差异仅发布工具/测试/双语说明及原CI制品记录，生产输入diff为空。
- #169已match-head合并，最终主线 `c861ee36c481e27090448301c1ef60ae7f5f107b`。发布worktree clean后切detached该SHA，CI35685820491 SUCCESS，1718通过0失败33跳过。该最终SHA实际video-fix gate再次PASS（原制品来源401a11d/run35684134222、当前CI35685820491分别验证）。未用旧CI代替新提交测试。
- GitHub草稿v1.0.44已创建，target c861ee3，isDraft=true，7附件全部uploaded：https://github.com/GargantuaX/gemini-watermark-remover/releases/tag/untagged-c4869a753169db877f4c 。SDK TGZ sha256 `79dc3c35752fa135df5beb7eb5addea0808d370939d48dc504f193fc0682e32a`；fallback zip `8cbdde0b1a47ed43c2acd282ed6c27fb6b3585a3f2d878db085fd5f27b041dd3`；web-store zip `dd0c7e60ddfb3936ceedb064fb1aad51173a1929e312c40ee1bd5e63388ddfe9`。发布说明保留视频清理局限，图像算法1.0.43不变。
- 未公开GitHub Release/未触发npm发布/未部署官网/未提交商店审核。生产发布需按用户提供AGENTS明确授权：拟公开本草稿触发npm trusted publishing，之后升级官网SDK/锁文件与下载资产，远程验证后部署并用真实样本验收线上Worker。主工作区原两个代码变更完整保留，#165暂缓不入本版。


### 2026-09-22 正式发布 1.0.44 与官网上线

- 用户在明确的补丁发版和官网部署建议后回复“同意”，授权正式发布。GitHub v1.0.44 已公开，tag c861ee36c481e27090448301c1ef60ae7f5f107b；npm trusted-publishing run 35686728782 SUCCESS。公开 npm 1.0.44 TGZ SHA-512 与已验收制品一致（VjjdYkYGr39V2phX28r/yuesEBTRN35JRXDqLVRppsuUzYAIT2uoto3ZWmX7WAFzS+6lZ6JJI4XDOYOz4/m4QQ==）。
- 官网增量审查基准 d62346de66f5933db9c54061f2ae93c8ecde3acf，目标 a02e36d3f511300a1eb65e3a146168e1824fbeda：完整7文件 diff，只更新 SDK/lock、用户脚本及扩展下载/版本/hash；公开包依赖元数据与冻结包一致。PR19 CI35687031566 SUCCESS，已合并 a73182db6ac575bbaf45943a3063bad983ba13e8；合并树与已验收目标完全一致。
- REVIEW-SITE-CI-OWNERSHIP-01：main CI35687266985 checkout 失败，WebKit root 容器留下原生 runner 不可清理缓存。目标 d41cde9076281c762cddb771bc9f5aa20cf1aa57 的6行 workflow 完整增量复审：always 步骤将工作区归属恢复为父目录 UID/GID，不改测试/生产代码。已恢复受影响的官网 runner 工作区权限；PR20首次原生 job 在修复旧目录之前失败，修复后 rerun35687448900 SUCCESS（279单测，26原生E2E、8WebKit通过；4+2既有跳过），检查 node_modules 无 root 所有文件。PR20合并3de8c148d74883e351f19f6bde4b666af437ff56，最终main CI35687717582 SUCCESS；问题复审关闭。
- 生产构建来自 PR19 CI merge tree `4c59f0190014ae3943185c4374285df6f5e70cf1`（对应已验收 a02e36d），未使用主工作区未发布代码。SDK运行版本清单与136页生产构建完成，Source Map上传成功。内部主机、证书和认证传递细节仅保留于本地归档。
- 官网配置的部署预检通过354项资产，正式部署153个变化资产；生产域名 geminiwatermarkremover.io。内部连接故障排查和部署标识仅保留于本地归档。
- HTTP验证 .artifacts/site144-http.json：线上manifest、视频runtime、用户脚本、下载metadata和1.0.44 ZIP逐字节等于已验收构建。manifest bundledVersion=1.0.44；视频runtime SHA256 59658e8def7f3c0a606ff8e8b110c768954c7e2e3a15cf33f64b28eb557b229e。
- 真实浏览器验证 .artifacts/website-video-release/.artifacts/site144-live/report.json：首次脚本在React hydration前上传导致90秒等待超时；按现有E2E等待html[data-gwr-tool-stage=idle]后真实上传成功。线上Worker gemini-watermark.worker-BihRcdhw.js 返回ok=true、782921字节；使用165-source仅作运行smoke，仍有残留信号，不代表修复#165。
- #150原视频在线上默认UI实际导出成功：720x1280/24fps/192帧，749421字节，SHA256 556792a674c11164e5b4d56180f42091563f6f55d4498829ca5aa8dc855b0147。实际backend由fdncnn-browser自动选择canvas-footprint-polish。独立ffprobe核验375个非负PTS AAC包payloadhash/PTS/DTS/duration与原片一致；不声称负PTS priming包保留。f50-before-after.png目视确认星形水印移除，无旧错误选择产生的点；非全片无损声明。
- 未提交ChromeWebStore；图片算法不变，#165/#136剩余质量问题不计已修复。主工作区原2文件修改完整保留。GitHub/npm/官网本次发布及线上验证完成。


## 2026-09-22: Information disclosure audit

Reviewer: Codex. Base/HEAD: 7411b444d4041829c938c338204ac863ead77b69. Additional local origin/main snapshot: c861ee36c481e27090448301c1ef60ae7f5f107b. No fetch; no claim of live remote freshness. Existing algorithm edits preserved. This audit is a new privacy scope, not a repeat algorithm review.

- PRIVACY-001 (P3, open): real machine paths remain in scripts/fit-video-alpha-shape.js:21, scripts/run-confirmatory-cleanliness-collection.js:91, scripts/video-crop-benchmark-manifest.json:8 and release/evidence/v1.0.30-image-quality.json:100 / v1.0.31-image-quality.json:100. Confirmed in both snapshots.
- PRIVACY-002 (P2, open): tests/project/localPathLeak.test.js:6-10 scans literal backslashes but misses escaped JSON/JS paths. Actual focused test passed 1/1 while PRIVACY-001 remained. Add escaped-path coverage and publish artifact scanning.
- PRIVACY-003 (P3, open): main-reachable historical commit fed88b06d69366575c76cc6db9e7a3d0c03c21fa, docs/core-watermark-removal-algorithm-research.zh.md:530, contains a personal home/download path; later cleanup does not remove history. Sensitive path not copied here. Local handoff commits are not assumed publicly reachable.
- Scope: 663 HEAD text files, 637 origin/main text files, 39 release archives (1834 text members), 2270 identifiable text blobs below 3 MB from 4690 reachable Git objects; metadata keys on 110 images. Read selected network, storage, packaging and CI boundaries.
- No confirmed credential/private-key leak; token-pattern hit was a test-string false positive. No rule hits in scanned release archive text. This is limited pattern scanning, not proof of absence.
- Excluded: live remote assets/refs, unreachable history, full historical large/binary/archive contents, image/video visual privacy, arbitrary encoded secrets, complete runtime and dependency security audit. No full suite/build, production edits, publishing or history rewrite.
- Local report and reproducible scanner: .artifacts/privacy-audit/report.md, scan.py, results.json, latest.py, latest.json. Keep raw findings local. Existing untracked review log and follow-up drafts need privacy editing before any public commit.


### 2026-09-22 #165 边缘模型调查续接
- 用户授权开始#165质量调查。复用旧68bd013验收不通过结论；生产基准c861ee36c481e27090448301c1ef60ae7f5f107b，core/sdk相对7411b444d4041829c938c338204ac863ead77b69无diff，两真实图完整SDK基线RGBA哈希再次精确匹配旧记录。主工作区两个修改保留。
- 新证据 .artifacts/issue165-profile/report.md：候选alpha数组证明43px来自96缩小；固定背景拟合/模板/位移及缩放核对照只作诊断，不作干净真值。初稿不同比较支持区域、Buffer映射错误均在最终数据前修正：统一固定ROI含signed负值，缩放模板非空断言；最终脚本SHA见scripts.json。
- 8输入×2模式完整SDK反事实：43px已知真值RMSE 4.128→1.170、6.552→3.918；96px反例1.166→5.059、1.351→5.841。两个无水印控制均0修改，ROI外均0误差。仅证明合成模板来源失配可造成残留，不反推真实退化机理。
- 两张真实图反事实仍有轮廓，普通对照已目视，非盲评。REVIEW-165-TEMPLATE-01：全局替换96模板被96px反例否决；没有生产候选提交，旧补丁仍暂缓。未增加擦除/抹平/放松保护阈值，未全量测试/构建/发布/发送GitHub评论。恢复条件是小尺寸候选能通过双向模板反例且对真实图有明确收益；需要独立背景验证，不能靠这两张图调参。


## 2026-09-22：信息泄露整改与复审

- 用户同意处理当前路径、漏检测试及待公开记录，明确保留历史提交和已发行压缩包。基准 HEAD 为 `7411b444d4041829c938c338204ac863ead77b69`；此次是该工作区上的未提交整改，未变更远端主线或已发行版本。
- 代码复审范围：本次18个跟踪文件的完整差异，含3个执行脚本、样本清单、环境变量示例和相关测试。差异快照 `.artifacts/privacy-audit/remediation.patch`，SHA256 `260afe3af7b66118981034001fbd17e4ef8d6236d1ed9e4daa956662df90e661`。原有 `src/core/pipelineInitialSelection.js` 与 `tests/core/exact48CandidateRetention.test.js` 不在本次修改/验收范围。
- PRIVACY-001：当前执行脚本路径整改复审通过。视频原始样本从 `GWR_VIDEO_SAMPLE_ROOT` 解析，清单保存样本文件名；仍兼容显式 `originalPath`。采集脚本支持 `GWR_SAMPLE_COLLECTOR` 和既有 `--collector` 覆盖，示例已更新。测试中的真实目录替换为虚构路径。两份既有发行证据按用户同意的低风险保留策略暂缓清理；仅对精确文件与内容哈希设例外，不放行新增路径。
- PRIVACY-002：路径漏检修复复审通过。支持多层反斜杠转义、不同盘符与 Unix 用户目录；已先观察旧真实路径被新检查拦截，再完成清理。完整密码扫描/自动解包发布门禁未在本次实现；前次人工压缩包审查结论仍是有限范围结论。
- PRIVACY-003：暂缓历史清理，按用户已同意方案接受低敏感度历史目录残留；不重写历史、不替换发行包。
- 待公开台账：精简登录流程、内部会话标识、主机名及认证/部署排查细节；原文在被忽略的本地审查目录留档。保留问题编号、完整提交SHA、复审决定与验证限制。`docs/github-followup-drafts.md` 经复查仅含公开回复及链接，未作无必要修改。
- 最终代码快照的14个相关测试文件：69通过、0失败、0跳过。验证覆盖路径扫描、环境变量读取、样本清单兼容、采集流程及替换目录的既有测试。另执行拟合脚本 `--help`，入口正常。确认其他样本读取脚本使用统一加载器；直接读取清单的低强度诊断脚本只消费未改变的几何字段。
- 本次修改范围 `git diff --check` 通过。整个工作区的检查仍报原有候选测试末尾空行，未擅自修整。未运行全量测试、视频拟合/采集任务或生产构建，未启动服务，未提交、推送或发布。


### 2026-09-22 #165 小尺寸独立候选离线复核
- 复用 REVIEW-165-TEMPLATE-01；基准 c861ee36c481e27090448301c1ef60ae7f5f107b，仅隔离工作区两文件未提交实验。完整源码快照/哈希 .artifacts/issue165-small-results/snapshot.json；实验及脚本增量自审，不记作基准SHA生产审查通过。
- 10输入×2模式完整SDK验证，20次正常，最终10对RGBA完全一致。男图新增2候选实际执行仍有暗星轮廓，女图不进入小于48范围。48→43纹理新增输出RMSE4.528优于选中6.552，但反向96→43候选6.136/6.181差于选中4.187；禁止直接优先小模板。光滑48→43继承gain0.5被现有校验拦截，未放松门槛。
- 状态：不采纳本实验作为生产修复，#165仍暂缓。隔离diff --check通过；未全量测试、构建、提交、推送、发布或发送评论。原主工作区改动保留。详见 .artifacts/issue165-small-results/report.md；后续须先取得独立真实边缘/校准证据，不能只靠候选自评分改排序。


### 2026-09-22 #165 光度/编码诊断续接
- 延续 REVIEW-165-TEMPLATE-01，已发布基准 c861ee36c481e27090448301c1ef60ae7f5f107b；本轮没有生产源码差异，仅新增离线诊断脚本，未重审已有算法。脚本/结果SHA .artifacts/issue165-photometry/snapshot.json。
- encoded/linear两个已知背景控制辨识正常。男图核心拟合gain0.598/0.601，线性光模型整体及3/4边缘象限更差；女图gain强烈依赖背景，不能据此校准。JPEG固定六控制即使用正确模板逆变换仍有1.77至3.93 RMSE，但未证明真实残留全部由压缩导致。
- 决定：不采纳换合成空间或统一强度修复，#165未解决。背景模型仅拟合、不作独立真值；保留原图来源分类。未全量测试/构建/提交/推送/发布/评论。后续需独立配对控制验证边缘模型和编码退化后才可推广。


### 2026-09-22 #165 配对来源和JPEG量化表控制
- 延续 REVIEW-165-TEMPLATE-01；生产基准 c861ee36c481e27090448301c1ef60ae7f5f107b，无新增生产差异。只读19份样本清单3879条记录，不读冻结holdout像素；两份差评集合有39个Gemini移除任务配对，但target是处理结果，不当作干净真值。未证明整个库没有其他配对。
- 原图JPEG量化表与上一轮75/85/95及新100品质表不精确匹配。新控制直接复用原图两张量化表、4:2:0并断言输出表一致；已知背景逆变换RMSE2.255，源模型1.908。相同表不等于相同编码历史，未据此认定JPEG为真实暗轮廓唯一原因。
- 证据 .artifacts/issue165-pair-evidence/report.md 和 snapshot.json；旧JPEG脚本只新增导出控制像素模式，已有结果不变。无生产修复、全量测试、构建、提交、推送、发布或外部评论。#165继续暂缓：缺独立背景/边缘/编码证据，停止对同两图无边界调参；恢复需真实配对导出或独立可验证复现。


### 2026-09-22 发行后线上巡检与PR109增量修复
- GitHub实时核对13开放issue/3开放PR；发布2026-09-22T04:23:54Z之后issues API无新更新，不能推断没有未上报回归。#138 head 5a7750df9f6e4790e4ae3b392ed4ff15ce8569ac、#164 head 3d4d4b34bb3f6a0f2522af49b2cc8f64d907d30b 均未变化，复用原待证据结论。#167/#143未新增复现材料。
- npm latest1.0.44；官网最新主线 f4339e77ada4cd02545cd74637c4d90aebd4a5d0 已有统计功能更新，CI success，package仍固定1.0.44。线上版本清单404；从实时首页→当前GeminiWatermarkTool脚本→worker解析真实引用，workerSHA256 082e6cef4974ea2402ad033a1cf8f460bc71e9187273ff83923d28b8f6eb9960 与发布验收字节一致。视频脚本SHA256 59658e8def7f3c0a606ff8e8b110c768954c7e2e3a15cf33f64b28eb557b229e 同样一致；本轮未重跑浏览器处理，历史实图验证仅作相同文件的既有证据。HTTP结果 .artifacts/followup-live.json、引用链 .artifacts/followup-worker.json。版本清单404保留待查，未部署修改。
- PR109-ACTIVE-SINGLE：基准 c861ee36c481e27090448301c1ef60ae7f5f107b 与PR head 081bcd0a82796ed15dc2d4ec9ad2680f5474bf03 在隔离worktree无冲突整合。本地目标提交 ea403e6b0017b132c745b453eb631f2c0779c1dc（codex/pr109-active-selection）包含原PR及一处路由条件修复、新4项测试。新增测试执行真实handleIncomingFiles函数并stub外部UI依赖；旧实现1失败3通过，新实现与既有队列7项共11通过0失败。验证单个/多个视频追加、空闲单文件和新批次，未将队列模块单测冒称浏览器验收。
- 增量自审范围：handleIncomingFiles条件与完整新测试文件，沿用原PR其余审查，不记整合后全量审查通过。diff --check通过，提交后隔离worktree clean。状态已修复待真实浏览器/整合CI复审；未推送、更新外部评论、远端合并或发布。主工作区其他任务改动保留。


### 2026-09-22 PR109 真实浏览器/完整验证与分支更新
- 审查者Codex；基准 c861ee36c481e27090448301c1ef60ae7f5f107b，原PR081bcd0a82796ed15dc2d4ec9ad2680f5474bf03，目标 ea403e6b0017b132c745b453eb631f2c0779c1dc。复用原PR已有结论，复核整合后的video-app调用上下文、一处条件修复及4项新增路由测试，未重复声称全算法审查。
- PR109-ACTIVE-SINGLE：复审通过。真实Chromium双视频处理中追加第三视频，当前blob不变，3项done、3次顺序下载；新坏文件+正常文件得到error/done、1/2和一次下载；空闲单视频恢复手动模式并清空队列。独立ffprobe确认4个输出尺寸/时长/帧数和音轨存在性，非全片画质与音频逐包验收。报告 .artifacts/pr109-browser-results/acceptance.md、report.json、output-check.json。
- de-ci限2CPU/4GB生产构建成功；第一次完整测试唯一失败为归档无Git元数据。补精确跟踪清单并规范化归档换行后，write-tree 90ed38a0064c6834a846828788363d042c1cba14与固定提交一致，完整重跑1762项：1729通过0失败33既有跳过；SDK smoke8/8。未改代码绕过测试。归档构建banner无提交信息，产物不用于发布。
- 已快进更新原PR109作者允许维护者编辑的分支至目标SHA，保留作者历史；没有新开重复PR、发送评论、合并或发布。
- 官网SITE-MANIFEST-001：完整一行修复自审通过，基准 f4339e77ada4cd02545cd74637c4d90aebd4a5d0，目标6e02a2d97a7ef7c6e658153da1c4453f4dac927d。现有2测试和de-ci实际build:ci通过，dist清单版本1.0.44；PR23 CI35693904211 两job通过。未合并/部署，线上404尚未消除。

- PR109补充终态：外部分支CI35694101821初始action_required；确认沿用主线工作流后放行。目标ea403e6b0017b132c745b453eb631f2c0779c1dc的build-and-test最终SUCCESS（3m44s），包含构建、项目回归、SDK smoke、全量测试与候选打包/上传；与前述de-ci独立验收分别记录。原PR已更新，两PR均未合并、发布或部署。最后已复审目标SHA不变。


## 2026-09-22：开源内容边界复查

审查者Codex；基准/目标HEAD均为7411b444d4041829c938c338204ac863ead77b69，包含前轮未提交整改；关键目录存在性另核查本地origin/main c861ee36c481e27090448301c1ef60ae7f5f107b及1.0.44 TGZ。范围为公开文档、样本来源记录、Issue表单、第三方分发声明及发布资产布局；复用前轮信息泄露扫描，不重复声称全库安全。

- PUBLIC-001，P2待处理：直接分发ONNX Runtime JS/WASM，但仓库及受查TGZ未见配套完整LICENSE/ThirdPartyNotices；bundle有Microsoft版权短注释，不能说完全未署名。应按准确资产版本补声明。allenk本地fork根MIT已核实，模型权重单独来源记录仍建议完善，未认定模型侵权。
- PUBLIC-002，P2待确认：样本清单有来源/hash但缺公开使用与隐私核验记录；Issue原文件上传表单无公开附件隐私提醒。未证明已有样本未经许可或含隐私。
- PUBLIC-003，P3待处理：AGENTS.md:352的真实会话定位符、docs/image-watermark-pipeline-refactor-live.zh.md:3492附近的线上原始样本编号，建议替换公开占位符/独立编号。未验证外部可访问性，不复制原始标识。
- PUBLIC-004，P3建议整理：超长实验流水账与20份仍被跟踪的docs/superpowers文档；保留公开设计证据，归档调度过程，不因AI参与而全部删除。
- PUBLIC-005，P3建议后续改造：HEAD release目录约194MiB，发布流程依赖已提交TGZ；先迁移可信资产读取流程，再停止新增大二进制，不能直接删除。
- 官方参考：https://github.com/microsoft/onnxruntime/blob/main/LICENSE 与 ThirdPartyNotices.txt；实际资产版本仍需对应核验。详细范围、证据与处理建议在本地 .artifacts/privacy-audit/public-content-review.md。
- 本轮仅审查与记录，未修改产品文件、删除样本、运行全量测试或发布；未逐张/逐段核验媒体内容，未完成完整权利审计。


## 2026-09-22 PR109 / SITE-MANIFEST-001 合并与部署收尾
- 用户明确同意合并、等待主线 CI 并部署官网；不发布新核心版本。
- PR109 已 squash merge：9ce3ad50d959d6ba6e627fbb9c9b2c93f092a3dd；主线 CI 35695257324 success。沿用 ea403e6b0017b132c745b453eb631f2c0779c1dc 的审查与批量视频验收，不重复声称新版本已发布。
- 官网 PR23 已 squash merge：a26a855ecc09f43c0da044bfd0e52e89f54c16bd；主线 CI 35695265208 success；git diff 确认与已审查 6e02a2d97a7ef7c6e658153da1c4453f4dac927d 无内容差异。
- 从官网合并提交归档，在 de-ci 隔离目录以 2 CPU / 4 GiB 生产构建成功；Sentry release gwr-site-manifest-a26a855 的 20 文件上传成功。产物传输前后 SHA256 dac4f5a321b9d22d58a4e49c7dfa7e820decd461529fd23357e8f362cfecdc58 一致。
- Wrangler dry-run 和部署成功。Cloudflare Version ID：3cf25513-7824-4ad5-92d9-bebf77378f22。
- 线上首页、版本清单、扩展清单均 HTTP 200；gwr-runtime-version.json declaredVersion / bundledVersion 均为 1.0.44，原 404 已消除。
- 从新首页实际组件引用解析图片 Worker，SHA256 082e6cef4974ea2402ad033a1cf8f460bc71e9187273ff83923d28b8f6eb9960，与此前验收产物逐字节相同。视频 runtime SHA256 59658e8def7f3c0a606ff8e8b110c768954c7e2e3a15cf33f64b28eb557b229e 未变。
- 证据：核心仓库 .artifacts/followup-live.json、followup-worker.json、site-manifest-deploy/dist。此次部署后验证为 HTTP 与实际引用产物哈希，不冒称重新完成真实样本全流程；处理代码复用此前 1.0.44 验收。官网批量视频 UI 不因核心 PR109 合并而自动上线。


## 2026-09-22 1.0.45 候选准备与复审
# 1.0.45 候选验收

- 发布基准：`c861ee36c481e27090448301c1ef60ae7f5f107b`（1.0.44）。
- 主线功能提交：`9ce3ad50d959d6ba6e627fbb9c9b2c93f092a3dd`（#109）。
- 最终候选源码：`6ac9c95c8e4f9bddc6dac08bcf7e673fba0476f6`，草稿 PR #170。
- 审查范围：版本与打包白名单、ONNX Runtime 来源/声明、中英文 Changelog、发布说明和打包回归测试。#109 复用台账已有审查，确认主线只有该功能增量；没有重新宣称全算法审查。
- ONNX Runtime 七个 JS/WASM 资产与本地已安装的 1.26.0 核对：WASM 字节一致，JS 规范化换行后一致；`.js` 为同名 `.mjs` 的现有重命名。声明来自 Microsoft `v1.26.0` 的 LICENSE 和 ThirdPartyNotices.txt。
- PUBLIC-001 的 ONNX 声明缺失已修复并核验打包内容。模型独立权利来源、样本公开许可等既有台账事项不据此关闭，不声称完整法律审计。
- 第一轮 CI 发现缺少双语 Changelog，补齐后 5 项元数据测试通过。第一次构建 `8929c13f8eba09a45614418dee69e38121a5b008` 的证据单独留存；最终候选重新构建、安装和浏览器验证，不混用两个提交的产物。
- de-ci 在 2 CPU / 4 GiB 范围构建；实际 TGZ 经 pnpm 安装到独立 consumer，CLI help、SDK 初始化、8 项 SDK smoke 通过。
- 浏览器加载 consumer 内已安装 TGZ 的视频页面：2 个视频处理中追加第 3 个、3 次自动下载、坏文件失败后继续下一项、空闲单文件回到手动模式，全部通过，pageerror 为空。
- 未改变图片或视频去水印算法；本次不推广新的水印质量主张。未重跑整个真实 Gemini 用户脚本/扩展手动验收，也未跑针对 1.0.44 算法修复硬编码的发布 gate。
- 本次仅候选验收，不是正式发布审批。草稿 PR 不合并，不创建 tag、不运行 publish workflow、不改官网版本。正式发布前应确定发行日期、固化最终采纳的制品及其 build identity，并按发布范围处理剩余发布检查。
- 最终 CI：35696955854 success，1762 项中 1729 通过、0 失败、33 既有跳过，SDK smoke、构建、候选打包和上传成功。
- de-ci 候选 TGZ SHA256：`fc4f3fcde35457210ddf00878139b78e1cdd602a5d6e0dd04a505e98b9614a86`。该包来自最终提交的 de-ci 构建，不冒称与 GitHub Actions 构建产物逐字节相同。

- 最终 4 个导出 MP4 经独立 ffprobe 校验：尺寸、时长、帧数和音轨存在性与输入一致，下载哈希与浏览器报告一致；不声称逐帧画质或音频逐包一致。证据目录 .artifacts/release-6ac9c95-results/output/。


## 2026-09-22 PR109 性能调查与发布暂停
# 批量视频性能调查（2026-09-22）

结论：串行批量在本次 720p 控制样本上没有按队列长度成倍增加峰值内存，连续两批均完成。当前仍不建议正式发布：缺少取消正在处理的视频及停止队列的入口；未完成高分辨率和低内存设备验证。

## 快照与范围
- 目标源码：6ac9c95c8e4f9bddc6dac08bcf7e673fba0476f6；不修改产品源码。
- 已安装候选 TGZ SHA256：fc4f3fcde35457210ddf00878139b78e1cdd602a5d6e0dd04a505e98b9614a86。
- 实际 video-app.js SHA256：6ad6ce96d9d535324ebb302938a2f4347a0eceae431235c9947b0bac64dfb464。
- de-ci 隔离 cgroup，2 CPU 配额、4 GiB 内存上限、禁用该组 swap，headless Chromium。服务器结果不等价于消费级设备性能。
- 同一 1280×720、24fps、10秒原视频作控制；两批各重复选择6次。60秒样本是 FFmpeg stream-copy 循环6次，1440帧，有音轨，明确属于压力测试加工素材，不用于水印质量结论。
- 250ms 采样整个测试 cgroup 的 memory.current，包含浏览器、Node、文件页缓存，不是纯 JS heap 或精确 GPU 内存；短于采样间隔的尖峰可能遗漏。每项结束后观察10秒，再重置页面并观察10秒，不强制GC。

## 最终同一次运行
| 场景 | 处理秒数 | 起始 MiB | 峰值 MiB | 空闲10秒 MiB | 重置10秒 MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| single-720p-10s | 11.3 | 288 | 1011 | 979 | 874 |
| batch-six-720p-10s | 68.1 | 875 | 1098 | 962 | 925 |
| repeat-batch-six-720p-10s | 67.7 | 925 | 1101 | 985 | 948 |
| single-720p-60s-controlled-loop | 53.4 | 949 | 1198 | 1049 | 981 |

- 两批均收到6个下载事件且等待下载完成；页面错误与下载错误为0。cgroup memory.events：low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0。
- 首轮采样脚本曾在最后一次下载事件到达前比较计数，提前结束浏览器并使下载清理 promise 失败；原始报告保留为 run1.json。修正为等待下载事件和下载完成后，完整重跑四场景；不将首轮计时问题当作产品漏下载，也不混用首轮与最终数据。
- 当前峰值和连续两批数据未显示明显增长，但不能排除更长时间、更大队列、不同素材的累积问题。重置后仍有较高常驻占用，源码存在模型缓存，不能据此认定泄漏或保证不会泄漏。
- 导出使用 BufferTarget 和 in-memory MP4，单个长视频本身仍有完整输出缓冲成本；串行队列不消除此成本。

## 待处理
- PR109-PERF-001（P2，待处理）：运行期间 resetBtn 禁用，页面无停止批次/取消当前项入口；UI实测与 src/video-app.js 的 updateButtons/runExport 一致。底层导出有错误清理，但没有从该界面接入用户取消。发布保持暂停，PR170保留draft。
- 建议下一步实现取消当前处理和停止剩余队列，并验证取消能释放解码、编码与临时输出资源；之后再补代表性高分辨率/低内存环境压力测试。不要用本次控制样本承诺任意批量规模或一般视频质量提升。

原始证据：report.json；测试脚本 video-batch-perf.mjs；报告 SHA256：6d7344562c5a003b3d390577d37ed53d3c2d2834fde3b524c95b1b21fde0a90a。


# PR109-PERF-001 取消处理复审（2026-09-22）

- 审查者 Codex；基准 6ac9c95c8e4f9bddc6dac08bcf7e673fba0476f6，最终源码 8a647669b6207a6869dd7a6c4b5028b76436bc3b。复用 #109 与候选包既有审查，仅复查停止入口、任务控制器、队列、模型下载、解码/编码清理、3项新增回归及变更影响。
- 新增停止处理按钮；AbortSignal 贯穿检测、模型下载和逐帧导出；当前操作清理完成前不解锁新任务。队列取消后不启动待处理项、不自动下载取消项；结束后清空文件引用、预览和Blob URL。错误仍按既有规则允许后续项继续。
- 导出错误/取消复用 Output.cancel 和 Input.dispose；音频复制 promise 即时接入拒绝处理，清理时等待其落定。未更改水印算法、默认策略或生产部署。
- 聚焦25项测试通过；CI35700438664 success，1765项中1732通过、0失败、33既有跳过；生产构建、SDK smoke和实际TGZ安装完成。
- 最终实际安装包：延迟模型下载取消 84ms；single-detection 63ms；batch-detection 67ms；batch-export 218ms；repeat-batch-export 218ms；ai-export 2075ms。五个场景均观测到已创建的WebCodecs对象进入closed，原/结果预览解除，队列清空，5秒观察窗无新增帧和下载，CPU仅消耗 0.065–0.193 秒。同页取消后成功重新导出并下载 6458143 字节MP4。
- 独立最终源码批量回归：处理中追加第三视频、3次导出、坏文件后继续导出、返回单文件模式通过；页面错误0。证据 cancel-report.json、regression-report.json。
- PR109-PERF-001 状态：复审通过（所测检测、下载、Canvas及AI导出取消路径）。取消属于协作式中止：无法强制打断正在执行的一次原生推理/初始化；实际AI取消约2.1秒，不能承诺任意设备立即停止。
- 资源结论限定为观测到的编解码器关闭、预览引用清理和CPU回落。模型缓存可保留，进程组内存没有回到初始值；未据此宣称所有内存立即归还或长期无泄漏。
- 更正先前性能调查范围：720p控制样本自动选择 canvas-footprint-polish，aiDenoiseFrames=0；之前约1GiB/批的结果不能解释为AI模型运行占用。本轮明确用已有调试选项启用AI，仅验证其取消行为，未推广一般AI批量吞吐结论。
- 初次模型下载探针未强制AI，未触发模型请求；已停止该隔离测试scope，修正探针后完整重跑最终源码。早期14cffb3证据只作过程记录，不混用为最终提交验收。
- PR170保持draft，未合并/打标签/发布。4K、低内存设备、大批量和长期资源稳定性仍未验证。

报告SHA256：e59e50f3b63364d95502ab3f56d26ff316316b32e8b754d72990abbab6de3f93。

- 补充：取消后恢复导出的MP4经独立ffprobe确认1280×720、10秒、240帧，包含音轨；截图中的中文方框来自de-ci缺少中文字形，未据此认定文案渲染问题。


# AI 视频批量性能验证（2026-09-22）

源码：`8a647669b6207a6869dd7a6c4b5028b76436bc3b`；候选 TGZ SHA256：`454d5fe56ef8daf873708d719a62e33db8e118689c900f822b5ab5918b24beb1`。本轮未修改产品代码，复用已安装的实际候选包；审查仅覆盖测试脚本和新验证证据。

de-ci、headless Chromium、2 CPU 配额、禁用该组 swap；显式启用 allenk-fdncnn-browser-spike 并禁用 WebGPU，测量 CPU/WASM 路径。原始样本 20260615.mp4（720p/10秒/240帧）与20260615-2.mp4（720p/8秒/192帧）；同一页面依次单独处理两段，再连续跑两批相同视频。每次均核实实际 AI 帧数为226/174，复用帧14/18；批量等待所有下载完成。

## 4 GiB 上限结果

| 场景 | 耗时秒 | 峰值MiB | 空闲10秒MiB | 重置后10秒MiB |
| --- | ---: | ---: | ---: | ---: |
| single-720p-10s | 76.8 | 899 | 888 | 806 |
| single-720p-8s | 58.5 | 921 | 841 | 812 |
| batch-same-two | 139.3 | 957 | 832 | 801 |
| repeat-batch-same-two | 135.4 | 980 | 886 | 817 |

完整测试通过：true；页面/下载错误：0。内存事件：low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0。

主线程100ms心跳的最大实际间隔：single-720p-10s 493ms；single-720p-8s 987ms；batch-same-two 796ms；repeat-batch-same-two 881ms。CPU组消耗约为墙钟时间的两倍，接近2核配额；页面存在数百毫秒至近1秒的调度停顿，不能描述为全程流畅。心跳不是实际用户输入延迟或INP。

250ms采样整个cgroup的memory.current，包含浏览器、Node和文件缓存，不等于JS堆。内存峰值还包含结束后的观察窗口；不强制GC。单独处理第一段包含冷启动成本，后续复用缓存；少量单次实验不能证明严格统计等价或长期无泄漏。

## 2 GiB 上限取消和恢复

通过：true；测试组峰值 1094 MiB。模型下载取消 80ms；ai-export取消2486ms，停止后5秒CPU消耗0.199秒；repeat-ai-export取消2292ms，停止后5秒CPU消耗0.165秒。已创建的WebCodecs关闭、预览和文件引用清理、取消及排队任务无下载、5秒内处理帧数不再增加。

坏文件失败后下一文件完成AI导出：226 AI帧；同页重新开始并完成新AI导出：226 AI帧，输出6457205字节。页面错误0。内存事件：low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0。

## 结论和边界

AI确实显著吃CPU；串行批量在所测两段720p短视频中可完成，并未将内存按文件数叠加。有限的两轮数据不支持任意规模承诺。2 GiB是测试进程组上限，不等于真实2 GiB手机，也未触发OOM，因此没有验证系统内存耗尽后的恢复。取消为协作式，模型缓存可以保留。4K、长视频、大队列、移动设备和WebGPU性能仍未验证；完整MP4内存缓冲仍是长视频的限制。

PR170保持draft，不合并、不发布。建议将批量定位为顺序处理的便利功能，不宣称加速或低内存设备普适支持。

证据SHA256：{"report.json":"d7e34c55dc51a420a47f80ee6eeab8981af34a60c3d6ce15b8d14c70e4bb8518","low-memory.json":"96ccde7e79cff7a206bef1ddf470d615edcc35dc8044e8d2021ddebf9b5687cc","video-ai-perf.mjs":"e68ceb8d535ba57727d6299aefa24639359b2e1840b52d192e2abfa1f5733406","video-ai-low.mjs":"3052e9c04c1afe0286e7e3fbafba1a361d060f9d7626b1e53f7d5fe3392e2353"}

补充验证：取消后重新开始的AI输出经ffprobe确认H.264 1280×720、10秒240帧，AAC音轨10秒，6457205字节。PR170验证说明已更新，未合并或发布。


### 2026-09-22 用户确认1.0.45功能范围
- 批量视频仅在开源独立界面提供；官网保留单视频流程，不新增批量入口，官网批量适配不作为本次发版前置条件。后续官网SDK升级和是否开放批量界面分开决定。
- 本轮仅更新发布说明与PR说明，产品代码和已测8a647669b6207a6869dd7a6c4b5028b76436bc3b不变；未授权生产发布。


### 2026-09-22 1.0.45最终发布增量检查
审查者Codex；基准f3d1a957d10ef56322d8dda8923069666307afe7，目标a68d84e7a6d8abcd80db607f855a1e16d24aa7b2。仅覆盖正式发布文件、包身份、扩展哈希/清单及双语范围文案；复用8a647669b6207a6869dd7a6c4b5028b76436bc3b的源码复审与AI/取消证据，生产源码无变化。补齐publish-npm工作流必需的版本化TGZ；CI35713094072包与实测包130文件比较仅构建SHA注释不同，程序字节一致，TGZ SHA256 3dc6d2a491241aae434e6ec585e0dd562534331eb303f54050205b2ec6ea7968。两个扩展ZIP校验通过，diff --check通过，最终CI35716104484 success。结论：约定范围内可发布，无剩余技术阻塞；未声称固定1.0.44样本专项门禁适用于本次，也未声称4K/移动端/长视频已验收。保持draft，未合并/打标签/发布/部署。完整记录.artifacts/release-final-readiness.md。


### 2026-09-22 两日统一审查
审查者Codex；核心7411b444d4041829c938c338204ac863ead77b69→a68d84e7a6d8abcd80db607f855a1e16d24aa7b2；官网e79a21315f53668800cd6867f1541423dd9429f6→a26a855ecc09f43c0da044bfd0e52e89f54c16bd。用户明确要求统一复查，重点复查跨提交影响并复用台账已覆盖证据；根工作区及实验差异哈希见.artifacts/review-two-days-snapshot.json。
REVIEW-ALL-001(P2)：PRIVACY-001/002在旧主树验证通过但尚未进入发布分支，增强扫描绑定候选树复现14文件命中（含测试模式自身），1通过1失败；主树相关27测试通过，候选批量/取消/发行门禁21测试通过。最终候选CI成功使用旧扫描，不能覆盖此缺口。建议只集成18文件整改，排除#165实验；保持历史包保留策略。产品功能增量复查未发现其他确定性缺陷；#165/138/164保留待证据，不混入发布。
整体结论修订：视频功能/制品范围既有验收有效，但这两天全部承诺整改未收尾，补齐上述集成后再给发布放行。没有改产品、合并、发布或部署。详细范围/限制见.artifacts/review-two-days.md。


### 2026-09-22 REVIEW-ALL-001 修复复审
基准a68d84e7a6d8abcd80db607f855a1e16d24aa7b2，修复7c7122d747babf9a58b112c47544547a3b527f73。仅集成18个已审路径整改文件，排除#165的src/core/pipelineInitialSelection.js和tests/core/exact48CandidateRetention.test.js；逐文件核对原主树内容未变。候选路径扫描恢复通过，14文件相关测试共69通过/0失败，diff --check通过，最终CI35738974974 success。运行时/包输入及正式TGZ未变化，SHA256仍3dc6d2a491241aae434e6ec585e0dd562534331eb303f54050205b2ec6ea7968。PRIVACY-001/002的发布分支集成缺口已补齐，REVIEW-ALL-001复审通过；历史目录及发行包保留策略不变。详细补丁哈希见.artifacts/privacy-release-fix.json。未合并/打标签/发布/部署。


## 2026-09-22：公开内容清理与旧包归档

- 用户明确要求清理不必要私人信息、整理旧文档、发行包瘦身。基准HEAD 7411b444d4041829c938c338204ac863ead77b69；本地工作区版本为1.0.43，未切换远端主线或修改公开发行。
- PUBLIC-003复审通过（文档范围）：AGENTS真实会话链接改通用地址；线上编号随详细研究流水账移入本地归档；受检跟踪Markdown未再命中真实会话路径或18–20位数字编号。不是任意格式秘密的完全排除。
- PUBLIC-004复审通过：三份研究流水账改为设计/验证摘要，旧交接与20份历史AI执行计划改为短说明和有效链接，保留路径兼容。原文存于被忽略的 .artifacts/privacy-audit/content-archive/，未删除研究证据。
- PUBLIC-005本轮瘦身完成：33个旧ZIP/TGZ逐文件校验后移到本地归档，当前树减少183461333字节（约175MiB）；保留工作区版本1.0.43的3个包及所有历史checksum/evidence。发布工作流未改，旧tag和远端Release未动，Git历史体积不变。新增release/README.md说明保留策略。未来彻底停止提交二进制仍需另行迁移发布流程。
- 复核本轮完整文档/发行差异、当前3个包与HEAD原始字节一致、归档前后SHA256一致。证据快照 .artifacts/privacy-audit/content-cleanup.patch；归档包清单位于content-archive/release/manifest.json。
- 路径扫描显式跳过TGZ二进制，避免已归档的跟踪包被误作待扫描文本；ZIP原已有跳过逻辑。20项相关检查通过（路径扫描、文档冗余、发布元数据、detached-tag发布流程模拟）。未真实发布、全量构建或改图片算法；既有用户改动保留。第三方许可和样本公开规则不属于本次选定改动，保持原待处理状态。

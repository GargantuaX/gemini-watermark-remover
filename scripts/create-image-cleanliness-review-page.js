import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`${token} requires a value`);
        }
        options[token.slice(2)] = value;
        index += 1;
    }
    return options;
}

function toBrowserPath(fromDirectory, targetPath) {
    return path.relative(fromDirectory, path.resolve(targetPath)).replaceAll('\\', '/');
}

function buildPublicAssignment(manifest, outputPath, reviewerId) {
    if (!Array.isArray(manifest?.rows) || manifest.rows.length === 0) {
        throw new Error('review manifest must contain at least one row');
    }
    const blindIds = new Set();
    const outputDirectory = path.dirname(outputPath);
    const decisions = manifest.rows.map((row) => {
        if (typeof row.blindId !== 'string' || blindIds.has(row.blindId)) {
            throw new Error(`review manifest contains an invalid or duplicate blindId: ${row.blindId}`);
        }
        if (typeof row.rowPath !== 'string' || typeof row.fullOutputPath !== 'string') {
            throw new Error(`review manifest row ${row.blindId} is missing review assets`);
        }
        blindIds.add(row.blindId);
        return {
            blindId: row.blindId,
            blindAssetPath: toBrowserPath(outputDirectory, row.rowPath),
            fullOutputAssetPath: toBrowserPath(outputDirectory, row.fullOutputPath),
            outputClean: null,
            contentDamage: null,
            confidence: null,
            notes: ''
        };
    });
    return {
        schemaVersion: 1,
        reviewerId,
        decisions
    };
}

function safeJson(value) {
    return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function renderReviewHtml(assignment) {
    const serializedAssignment = safeJson(assignment);
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gemini 去水印盲评</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Segoe UI", sans-serif; background: #0d1117; color: #e6edf3; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #172033 0, #0d1117 42rem); }
    button, textarea { font: inherit; }
    button { color: inherit; }
    .app { max-width: 1440px; margin: 0 auto; padding: 20px; }
    .topbar { display: flex; gap: 16px; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10; padding: 14px 16px; background: rgba(13,17,23,.92); border: 1px solid #30363d; border-radius: 14px; backdrop-filter: blur(14px); }
    .title { margin: 0; font-size: 18px; }
    .meta { display: flex; gap: 14px; align-items: center; color: #9da7b3; }
    .meta strong { color: #fff; font-variant-numeric: tabular-nums; }
    .progress-track { width: min(280px, 30vw); height: 8px; overflow: hidden; border-radius: 999px; background: #252c35; }
    .progress-fill { height: 100%; width: 0; background: #4fd1a1; transition: width .18s ease; }
    .review { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; margin-top: 18px; }
    .visuals, .panel { border: 1px solid #30363d; border-radius: 16px; background: rgba(18,24,32,.92); }
    .visuals { min-width: 0; padding: 16px; }
    .visual-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; color: #9da7b3; }
    .blind-id { color: #fff; font-size: 18px; }
    .comparison { width: 100%; min-height: 360px; max-height: 68vh; object-fit: contain; border-radius: 10px; background: #090c10; }
    details { margin-top: 12px; }
    summary { cursor: pointer; color: #9da7b3; }
    .full-output { display: block; max-width: 100%; max-height: 60vh; margin: 12px auto 0; object-fit: contain; background: #090c10; border-radius: 10px; }
    .panel { padding: 16px; align-self: start; position: sticky; top: 94px; }
    .instructions { margin: 0 0 14px; color: #9da7b3; line-height: 1.55; }
    .decisions { display: grid; gap: 9px; }
    .decision { min-height: 48px; padding: 10px 14px; text-align: left; border: 1px solid #3a4450; border-radius: 10px; background: #202731; cursor: pointer; }
    .decision:hover { border-color: #6f7e8f; }
    .decision[aria-pressed="true"] { border-color: #4fd1a1; background: #163a31; box-shadow: inset 3px 0 #4fd1a1; }
    textarea { width: 100%; min-height: 88px; margin-top: 14px; padding: 10px; resize: vertical; color: #e6edf3; border: 1px solid #3a4450; border-radius: 10px; background: #0d1117; }
    .nav, .exports { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 12px; }
    .secondary, .primary { min-height: 42px; padding: 8px 12px; border-radius: 9px; cursor: pointer; }
    .secondary { border: 1px solid #3a4450; background: #202731; }
    .primary { border: 1px solid #2f9e76; background: #238464; font-weight: 650; }
    button:disabled { opacity: .42; cursor: not-allowed; }
    .status { min-height: 22px; margin-top: 10px; color: #f0c36a; font-size: 13px; }
    .legend { margin-top: 14px; color: #7f8a98; font-size: 12px; line-height: 1.5; }
    @media (max-width: 900px) { .review { grid-template-columns: 1fr; } .panel { position: static; } .topbar { align-items: flex-start; flex-direction: column; } .progress-track { width: 100%; } }
  </style>
</head>
<body>
  <main class="app">
    <header class="topbar">
      <div><h1 class="title">Gemini 去水印盲评</h1><div class="meta">评审者 <strong>${assignment.reviewerId}</strong></div></div>
      <div class="meta"><strong data-testid="progress">0 / ${assignment.decisions.length}</strong><div class="progress-track"><div class="progress-fill" data-testid="progress-fill"></div></div></div>
    </header>
    <section class="review">
      <div class="visuals">
        <div class="visual-title"><span>局部盲评对比</span><strong class="blind-id" data-testid="current-id"></strong></div>
        <img class="comparison" data-testid="comparison" alt="盲评对比图">
        <details><summary>查看完整处理结果</summary><img class="full-output" data-testid="full-output" alt="完整处理结果"></details>
      </div>
      <aside class="panel">
        <p class="instructions">只根据画面判断，不推测算法分数。选择后自动前进；数字键 1–4 可快速标注。</p>
        <div class="decisions">
          <button class="decision" data-kind="clean">1 干净</button>
          <button class="decision" data-kind="residual">2 有残影</button>
          <button class="decision" data-kind="damage">3 内容受损</button>
          <button class="decision" data-kind="uncertain">4 不确定</button>
        </div>
        <textarea data-testid="notes" placeholder="可选备注：残影形状、误伤位置等"></textarea>
        <div class="nav"><button class="secondary" data-action="previous">← 上一张</button><button class="secondary" data-action="next">下一张 →</button></div>
        <div class="exports"><button class="secondary" data-action="export">导出进度</button><button class="primary" data-action="freeze">冻结并导出</button></div>
        <div class="status" role="status"></div>
        <div class="legend">干净：无可见水印且内容自然。残影：仍能辨认水印形状。内容受损：出现水印形孔洞、色块或真实纹理被破坏。不确定不会计入完成。</div>
      </aside>
    </section>
  </main>
  <script>
    const assignment = ${serializedAssignment};
    const storageKey = 'gwr-image-cleanliness-review:' + assignment.reviewerId + ':' + assignment.decisions.map((item) => item.blindId).join(',');
    const decisionButtons = [...document.querySelectorAll('[data-kind]')];
    const progress = document.querySelector('[data-testid="progress"]');
    const progressFill = document.querySelector('[data-testid="progress-fill"]');
    const currentId = document.querySelector('[data-testid="current-id"]');
    const comparison = document.querySelector('[data-testid="comparison"]');
    const fullOutput = document.querySelector('[data-testid="full-output"]');
    const notes = document.querySelector('[data-testid="notes"]');
    const status = document.querySelector('[role="status"]');
    let decisions = loadDecisions();
    let currentIndex = Math.max(0, decisions.findIndex((item) => !isComplete(item)));

    function isComplete(decision) {
      return typeof decision.outputClean === 'boolean' && typeof decision.contentDamage === 'boolean';
    }

    function loadDecisions() {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        if (!Array.isArray(saved)) return assignment.decisions.map((item) => ({ ...item }));
        const byId = new Map(saved.map((item) => [item.blindId, item]));
        return assignment.decisions.map((item) => ({ ...item, ...(byId.get(item.blindId) || {}) }));
      } catch {
        return assignment.decisions.map((item) => ({ ...item }));
      }
    }

    function save() {
      localStorage.setItem(storageKey, JSON.stringify(decisions));
    }

    function selectedKind(decision) {
      if (decision.outputClean === true && decision.contentDamage === false) return 'clean';
      if (decision.outputClean === false && decision.contentDamage === false) return 'residual';
      if (decision.contentDamage === true) return 'damage';
      if (decision.confidence === 0.5) return 'uncertain';
      return null;
    }

    function render() {
      const decision = decisions[currentIndex];
      const completed = decisions.filter(isComplete).length;
      progress.textContent = completed + ' / ' + decisions.length;
      progressFill.style.width = ((completed / decisions.length) * 100) + '%';
      currentId.textContent = decision.blindId;
      comparison.src = decision.blindAssetPath;
      fullOutput.src = decision.fullOutputAssetPath;
      notes.value = decision.notes || '';
      const activeKind = selectedKind(decision);
      for (const button of decisionButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.kind === activeKind));
      }
      document.querySelector('[data-action="previous"]').disabled = currentIndex === 0;
      document.querySelector('[data-action="next"]').disabled = currentIndex === decisions.length - 1;
      status.textContent = completed === decisions.length ? '全部完成，可以冻结并导出。' : '状态已自动保存在本机浏览器。';
    }

    function applyDecision(kind) {
      const values = {
        clean: { outputClean: true, contentDamage: false, confidence: 0.9 },
        residual: { outputClean: false, contentDamage: false, confidence: 0.9 },
        damage: { outputClean: false, contentDamage: true, confidence: 0.9 },
        uncertain: { outputClean: null, contentDamage: null, confidence: 0.5 }
      }[kind];
      decisions[currentIndex] = { ...decisions[currentIndex], ...values };
      save();
      if (currentIndex < decisions.length - 1) currentIndex += 1;
      render();
    }

    function exportReview(frozen) {
      if (frozen && decisions.some((item) => !isComplete(item))) {
        status.textContent = '仍有未完成或不确定的样本，不能冻结。';
        return;
      }
      const payload = {
        schemaVersion: 1,
        reviewerId: assignment.reviewerId,
        frozen,
        exportedAt: new Date().toISOString(),
        decisions: decisions.map(({ fullOutputAssetPath, ...decision }) => decision)
      };
      const blob = new Blob([JSON.stringify(payload, null, 2) + '\\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = assignment.reviewerId + (frozen ? '-labels.frozen.json' : '-labels.progress.json');
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    for (const button of decisionButtons) button.addEventListener('click', () => applyDecision(button.dataset.kind));
    document.querySelector('[data-action="previous"]').addEventListener('click', () => { currentIndex = Math.max(0, currentIndex - 1); render(); });
    document.querySelector('[data-action="next"]').addEventListener('click', () => { currentIndex = Math.min(decisions.length - 1, currentIndex + 1); render(); });
    document.querySelector('[data-action="export"]').addEventListener('click', () => exportReview(false));
    document.querySelector('[data-action="freeze"]').addEventListener('click', () => exportReview(true));
    notes.addEventListener('input', () => { decisions[currentIndex].notes = notes.value; save(); });
    window.addEventListener('keydown', (event) => {
      if (event.target === notes) return;
      if (['1', '2', '3', '4'].includes(event.key)) applyDecision(['clean', 'residual', 'damage', 'uncertain'][Number(event.key) - 1]);
      if (event.key === 'ArrowLeft') { currentIndex = Math.max(0, currentIndex - 1); render(); }
      if (event.key === 'ArrowRight') { currentIndex = Math.min(decisions.length - 1, currentIndex + 1); render(); }
    });
    render();
  </script>
</body>
</html>`;
}

export async function createImageCleanlinessReviewPage({
    manifestPath,
    outputPath,
    reviewerId = 'reviewer-a'
}) {
    if (!manifestPath || !outputPath) {
        throw new Error('manifestPath and outputPath are required');
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(reviewerId)) {
        throw new Error('reviewerId may contain only letters, numbers, dot, underscore, and dash');
    }
    const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8'));
    const resolvedOutputPath = path.resolve(outputPath);
    const assignment = buildPublicAssignment(manifest, resolvedOutputPath, reviewerId);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, renderReviewHtml(assignment));
    return {
        outputPath: resolvedOutputPath,
        reviewerId,
        total: assignment.decisions.length
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await createImageCleanlinessReviewPage({
        manifestPath: options.manifest,
        outputPath: options.output,
        reviewerId: options['reviewer-id'] ?? 'reviewer-a'
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

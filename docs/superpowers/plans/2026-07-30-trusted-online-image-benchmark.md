# Trusted Online Image Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用独立人工金标、内容哈希去重和分项指标替代“目录内所有图片都应含水印”的失真外部评测，并在同一金标上可信比较 `9d20d29` 与当前实现。

**Architecture:** 将文件完整性与金标解析放入 `external-benchmark-dataset.js`，将标签感知分类、指标和基线可比性放入 `external-benchmark-evaluation.js`。现有运行器继续负责调用真实水印处理管线和写出报告，发布门禁只接受通过完整性校验的 trusted-labels 报告；人工复核包只生成本地 `.artifacts` 证据，不提交外部图片或机器路径。

**Tech Stack:** Node.js ESM、`node:test`、`node:crypto`、`node:fs/promises`、Sharp、现有 `processWatermarkImageData` 与 pnpm 脚本。

## Global Constraints

- 最终标签只能由人工目测和可核验来源证据决定；自动检测、残差和轮廓指标只能排序复核队列。
- 标签仅允许 `watermarked`、`clean`、`ambiguous`；清单外文件在运行期归为 `unlabeled`。
- 每条清单记录必须同时绑定样本根目录内的相对路径与 SHA-256；路径越界、缺失、哈希不符、未知版本或冲突标签必须 fail closed。
- 同一 SHA-256 只处理、计数一次，但报告必须保留全部相对路径；当前数据应为 119 条路径、105 个唯一内容、14 条重复路径。
- `ambiguous` 与 `unlabeled` 必须保留算法诊断，但不能进入任何通过率、失败数或前后版本升降统计。
- `--labels <path>` 是可信模式；`--assume-watermarked` 只能显式启用旧诊断模式，发布门禁必须拒绝该模式。
- 基线比较只允许 `datasetId`、规范化金标 SHA-256、去重内容哈希集合 SHA-256 全部一致的报告。
- 本轮不能修改 `src/core/`、水印模板、阈值、候选选择或输出像素；评测基础设施与后续算法改动分开提交。
- 外部图片、人工金标和生成报告保留在 `.artifacts/recent-online-20260729/`，不提交仓库，也不在已提交文件中写入机器绝对路径。
- Node.js 包管理与项目命令使用 pnpm；不启动本地开发服务。

---

## File Structure

- Create: `scripts/external-benchmark-dataset.js` — 规范化清单、校验路径与 SHA-256、按内容去重、生成数据集身份。
- Create: `scripts/external-benchmark-evaluation.js` — 标签感知分类、分项指标、review queue 和可信基线比较。
- Create: `tests/scripts/externalBenchmarkDataset.test.js` — 清单完整性、规范化哈希、去重和冲突回归测试。
- Create: `tests/scripts/externalBenchmarkEvaluation.test.js` — 标签语义、分母和基线可比性回归测试。
- Modify: `scripts/run-external-gemini-watermark-sample-benchmark.js` — 新 CLI、唯一内容处理、报告与 CSV 集成；保留现有 alpha/shadow 能力。
- Create: `tests/scripts/externalBenchmarkRunner.test.js` — CLI fail-closed、像素变更判断和报告渲染测试。
- Modify: `scripts/gate-online-gemini-watermark-sample-benchmark.js` — 只接受可信报告并读取新的合格率。
- Create: `tests/scripts/onlineSampleBenchmarkGate.test.js` — 门禁纯函数与 CLI 退出码测试。
- Modify: `scripts/render-strong-located-review-sheet.js` — 增加覆盖全部唯一内容的人工标签复核视图与标签模板。
- Create: `tests/scripts/externalBenchmarkReviewSheet.test.js` — 全量选择、重复内容折叠和模板字段测试。
- Local-only: `.artifacts/recent-online-20260729/trusted-labels.json` — 119 路径的人工金标，不提交。
- Local-only: `.artifacts/recent-online-20260729/trusted-evaluation/` — 基准版、当前版、Markdown、CSV 和 review sheet，不提交。

---

### Task 1: Trusted Dataset Contract

**Files:**
- Create: `scripts/external-benchmark-dataset.js`
- Create: `tests/scripts/externalBenchmarkDataset.test.js`

**Interfaces:**
- Produces: `canonicalizeExternalBenchmarkJson(value): string`
- Produces: `listExternalBenchmarkImages(sampleRoot): Promise<ImageItem[]>`
- Produces: `indexExternalBenchmarkImages(images): Promise<ContentGroup[]>`
- Produces: `loadTrustedExternalBenchmarkDataset({ sampleRoot, labelManifestPath, images }): Promise<ExternalBenchmarkDataset>`
- Produces: `createAssumedWatermarkedDataset({ sampleRoot, images }): Promise<ExternalBenchmarkDataset>`
- `ImageItem` shape: `{ fileName, filePath, group }`
- `ExternalBenchmarkDataset` shape: `{ dataset, cases }`, where `dataset` contains `mode`, `trusted`, `datasetId`, `labelManifestSha256`, `contentSetSha256`, `pathCount`, `uniqueContentCount`, `duplicatePathCount`, and each case contains `fileName`, `filePath`, `paths`, `sha256`, `label`, `reviewConfidence`, `watermarkFamily`, `expectedAnchor`, `note`, `group`.

- [ ] **Step 1: Write failing manifest normalization and integrity tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
    canonicalizeExternalBenchmarkJson,
    listExternalBenchmarkImages,
    loadTrustedExternalBenchmarkDataset
} from '../../scripts/external-benchmark-dataset.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('canonical manifest hash input is stable across object key order', () => {
    assert.equal(
        canonicalizeExternalBenchmarkJson({ samples: { b: { label: 'clean' }, a: { label: 'watermarked' } }, version: 1 }),
        canonicalizeExternalBenchmarkJson({ version: 1, samples: { a: { label: 'watermarked' }, b: { label: 'clean' } } })
    );
});

test('trusted dataset validates hashes, deduplicates bytes, and keeps every path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gwr-trusted-dataset-'));
    await mkdir(path.join(root, '2026-07-29'));
    const bytes = Buffer.from('same-image-bytes');
    for (const name of ['a.png', 'b.png']) await writeFile(path.join(root, '2026-07-29', name), bytes);
    const manifestPath = path.join(root, 'labels.json');
    await writeFile(manifestPath, JSON.stringify({
        version: 1,
        datasetId: 'fixture-dataset',
        samples: {
            '2026-07-29/a.png': { sha256: sha256(bytes), label: 'clean', reviewConfidence: 'high' },
            '2026-07-29/b.png': { sha256: sha256(bytes), label: 'clean', reviewConfidence: 'high' }
        }
    }));
    const images = await listExternalBenchmarkImages(root);
    const loaded = await loadTrustedExternalBenchmarkDataset({ sampleRoot: root, labelManifestPath: manifestPath, images });

    assert.equal(loaded.dataset.pathCount, 2);
    assert.equal(loaded.dataset.uniqueContentCount, 1);
    assert.equal(loaded.dataset.duplicatePathCount, 1);
    assert.deepEqual(loaded.cases[0].paths, ['2026-07-29/a.png', '2026-07-29/b.png']);
    assert.equal(loaded.cases[0].label, 'clean');
});
```

Use one fixture helper and explicit invalid cases in the same file:

```js
async function createManifestFixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'gwr-trusted-invalid-'));
    const bytes = Buffer.from('fixture-image');
    await writeFile(path.join(root, 'a.png'), bytes);
    return {
        root,
        bytes,
        images: await listExternalBenchmarkImages(root),
        valid: {
            version: 1,
            datasetId: 'fixture',
            samples: { 'a.png': { sha256: sha256(bytes), label: 'clean', reviewConfidence: 'high' } }
        }
    };
}

test('trusted dataset fails closed on malformed or stale manifests', async (t) => {
    const cases = [
        ['unknown version', (value) => ({ ...value, version: 2 }), /unsupported label manifest version/],
        ['missing dataset id', (value) => ({ ...value, datasetId: '' }), /datasetId is required/],
        ['unknown label', (value) => ({ ...value, samples: { 'a.png': { ...value.samples['a.png'], label: 'unknown' } } }), /unknown label/],
        ['path escape', (value) => ({ ...value, samples: { '../escape.png': value.samples['a.png'] } }), /escapes sample root/],
        ['stale path', (value) => ({ ...value, samples: { 'missing.png': value.samples['a.png'] } }), /manifest file is missing/],
        ['hash mismatch', (value) => ({ ...value, samples: { 'a.png': { ...value.samples['a.png'], sha256: '0'.repeat(64) } } }), /sha256 mismatch/]
    ];
    for (const [name, mutate, pattern] of cases) await t.test(name, async () => {
        const fixture = await createManifestFixture();
        const manifestPath = path.join(fixture.root, 'labels.json');
        await writeFile(manifestPath, JSON.stringify(mutate(fixture.valid)));
        await assert.rejects(
            loadTrustedExternalBenchmarkDataset({ sampleRoot: fixture.root, labelManifestPath: manifestPath, images: fixture.images }),
            pattern
        );
    });
});

test('trusted dataset rejects conflicting labels for duplicate bytes', async () => {
    const fixture = await createManifestFixture();
    await writeFile(path.join(fixture.root, 'b.png'), fixture.bytes);
    const manifestPath = path.join(fixture.root, 'labels.json');
    await writeFile(manifestPath, JSON.stringify({
        ...fixture.valid,
        samples: {
            'a.png': fixture.valid.samples['a.png'],
            'b.png': { sha256: sha256(fixture.bytes), label: 'watermarked', reviewConfidence: 'high' }
        }
    }));
    await assert.rejects(
        loadTrustedExternalBenchmarkDataset({
            sampleRoot: fixture.root,
            labelManifestPath: manifestPath,
            images: await listExternalBenchmarkImages(fixture.root)
        }),
        /conflicting labels for sha256/
    );
});

test('a file absent from the manifest remains unlabeled', async () => {
    const fixture = await createManifestFixture();
    await writeFile(path.join(fixture.root, 'b.png'), Buffer.from('different-image'));
    const manifestPath = path.join(fixture.root, 'labels.json');
    await writeFile(manifestPath, JSON.stringify(fixture.valid));
    const loaded = await loadTrustedExternalBenchmarkDataset({
        sampleRoot: fixture.root,
        labelManifestPath: manifestPath,
        images: await listExternalBenchmarkImages(fixture.root)
    });
    assert.equal(loaded.cases.find((record) => record.fileName === 'b.png').label, 'unlabeled');
});
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run: `rtk pnpm exec node --test tests/scripts/externalBenchmarkDataset.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/external-benchmark-dataset.js`.

- [ ] **Step 3: Implement canonical JSON, path validation, hashing, and content grouping**

```js
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const LABELS = new Set(['watermarked', 'clean', 'ambiguous']);
const REVIEW_CONFIDENCE = new Set(['high', 'medium']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const reportPath = (value) => value.replace(/\\/g, '/');

export function canonicalizeExternalBenchmarkJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalizeExternalBenchmarkJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalizeExternalBenchmarkJson(value[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}

function resolveInsideRoot(sampleRoot, relativePath) {
    const normalized = reportPath(relativePath);
    const resolved = path.resolve(sampleRoot, normalized);
    const relative = reportPath(path.relative(sampleRoot, resolved));
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        throw new Error(`label path escapes sample root: ${relativePath}`);
    }
    return { normalized, resolved };
}
```

Implement `listExternalBenchmarkImages()` with the existing recursive ordering and group inference. In `loadTrustedExternalBenchmarkDataset()`, parse BOM-safe JSON, require version 1 and a non-empty `datasetId`, validate every manifest entry, hash every listed image byte-for-byte, group sorted paths by actual SHA-256, reject conflicting non-null labels inside a group, and derive:

```js
const dataset = {
    mode: 'trusted-labels',
    trusted: true,
    datasetId: manifest.datasetId,
    labelManifestSha256: sha256(canonicalizeExternalBenchmarkJson(manifest)),
    contentSetSha256: sha256([...groups.keys()].sort().join('\n')),
    pathCount: images.length,
    uniqueContentCount: groups.size,
    duplicatePathCount: images.length - groups.size
};
```

`indexExternalBenchmarkImages()` hashes every `filePath` and returns sorted SHA-256 groups. `createAssumedWatermarkedDataset()` must preserve one case per path while attaching the real `contentSha256`, set `mode: 'assumed-watermarked'`, `trusted: false`, `datasetId: null`, and never synthesize a trusted manifest hash.

- [ ] **Step 4: Run focused dataset tests**

Run: `rtk pnpm exec node --test tests/scripts/externalBenchmarkDataset.test.js`

Expected: all dataset tests PASS, including the eight fail-closed cases and duplicate grouping.

- [ ] **Step 5: Commit the dataset contract**

```powershell
rtk git add scripts/external-benchmark-dataset.js tests/scripts/externalBenchmarkDataset.test.js
rtk git commit -m "Add trusted external benchmark dataset contract"
```

---

### Task 2: Label-Aware Classification, Metrics, and Baseline Identity

**Files:**
- Create: `scripts/external-benchmark-evaluation.js`
- Create: `tests/scripts/externalBenchmarkEvaluation.test.js`
- Modify: `scripts/run-external-gemini-watermark-sample-benchmark.js` only to re-export `classifyExternalBenchmarkCase` from the new module so existing imports remain valid.

**Interfaces:**
- Consumes: trusted cases from Task 1.
- Produces: `classifyExternalBenchmarkCase(record): Classification` for existing watermarked quality rules.
- Produces: `classifyLabeledExternalBenchmarkCase(record): Classification` for all four runtime labels.
- Produces: `summarizeTrustedExternalBenchmarkResults(results): { labels, metrics, summary, reviewQueue }`.
- Produces: `compareTrustedExternalBenchmarkResults({ dataset, results, baseline }): { status, newlyPassing, newlyFailing }`.
- `Classification` shape: `{ status: 'pass'|'fail'|'excluded', bucket: string, includedInMetrics: boolean }`.

- [ ] **Step 1: Write failing label semantics and denominator tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyLabeledExternalBenchmarkCase,
    compareTrustedExternalBenchmarkResults,
    summarizeTrustedExternalBenchmarkResults
} from '../../scripts/external-benchmark-evaluation.js';

test('label-aware classification separates misses, clean skips, false positives, and exclusions', () => {
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'watermarked', applied: false }), {
        status: 'fail', bucket: 'missed-detection', includedInMetrics: true
    });
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'clean', pixelsChanged: false }), {
        status: 'pass', bucket: 'clean-skip', includedInMetrics: true
    });
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'clean', pixelsChanged: true }), {
        status: 'fail', bucket: 'false-positive', includedInMetrics: true
    });
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'ambiguous', pixelsChanged: true }), {
        status: 'excluded', bucket: 'ambiguous', includedInMetrics: false
    });
    assert.deepEqual(classifyLabeledExternalBenchmarkCase({ label: 'unlabeled', pixelsChanged: false }), {
        status: 'excluded', bucket: 'unlabeled', includedInMetrics: false
    });
});

test('trusted metrics use only watermarked and clean denominators', () => {
    const result = summarizeTrustedExternalBenchmarkResults([
        { label: 'watermarked', applied: true, classification: { status: 'pass', bucket: 'pass', includedInMetrics: true } },
        { label: 'watermarked', applied: false, classification: { status: 'fail', bucket: 'missed-detection', includedInMetrics: true } },
        { label: 'clean', applied: false, classification: { status: 'pass', bucket: 'clean-skip', includedInMetrics: true } },
        { label: 'clean', applied: true, classification: { status: 'fail', bucket: 'false-positive', includedInMetrics: true } },
        { label: 'ambiguous', applied: true, classification: { status: 'excluded', bucket: 'ambiguous', includedInMetrics: false } },
        { label: 'unlabeled', applied: false, classification: { status: 'excluded', bucket: 'unlabeled', includedInMetrics: false } }
    ]);

    assert.deepEqual(result.labels, { watermarked: 2, clean: 2, ambiguous: 1, unlabeled: 1 });
    assert.deepEqual(result.metrics.watermarkDetectionRecall, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.deepEqual(result.metrics.watermarkEndToEndPassRate, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.deepEqual(result.metrics.restorationPassRateAmongApplied, { numerator: 1, denominator: 1, rate: 1 });
    assert.deepEqual(result.metrics.cleanSkipRate, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.deepEqual(result.metrics.falsePositiveRate, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.deepEqual(result.metrics.qualifiedOverallPassRate, { numerator: 2, denominator: 4, rate: 0.5 });
});
```

Add these baseline tests using content hashes as stable identities:

```js
test('baseline comparison uses trusted dataset identity and content hashes', () => {
    const dataset = {
        trusted: true,
        datasetId: 'fixture',
        labelManifestSha256: 'labels-hash',
        contentSetSha256: 'contents-hash'
    };
    const baseline = {
        dataset,
        results: [
            { contentSha256: 'a', classification: { status: 'fail', includedInMetrics: true } },
            { contentSha256: 'b', classification: { status: 'pass', includedInMetrics: true } }
        ]
    };
    const comparison = compareTrustedExternalBenchmarkResults({
        dataset,
        baseline,
        results: [
            { fileName: 'a.png', contentSha256: 'a', classification: { status: 'pass', includedInMetrics: true } },
            { fileName: 'b.png', contentSha256: 'b', classification: { status: 'fail', includedInMetrics: true } }
        ]
    });
    assert.deepEqual(comparison, { status: 'comparable', newlyPassing: ['a.png'], newlyFailing: ['b.png'] });
});

test('baseline comparison rejects every dataset identity mismatch and legacy reports', () => {
    const dataset = { trusted: true, datasetId: 'fixture', labelManifestSha256: 'labels', contentSetSha256: 'contents' };
    const baseline = { dataset, results: [] };
    for (const field of ['datasetId', 'labelManifestSha256', 'contentSetSha256']) {
        assert.throws(
            () => compareTrustedExternalBenchmarkResults({
                dataset,
                results: [],
                baseline: { ...baseline, dataset: { ...dataset, [field]: 'different' } }
            }),
            new RegExp(field)
        );
    }
    assert.throws(
        () => compareTrustedExternalBenchmarkResults({ dataset, results: [], baseline: { results: [] } }),
        /requires trusted-labels reports/
    );
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `rtk pnpm exec node --test tests/scripts/externalBenchmarkEvaluation.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/external-benchmark-evaluation.js`.

- [ ] **Step 3: Move the existing watermarked classifier and add label dispatch**

```js
export function classifyLabeledExternalBenchmarkCase(record) {
    if (record.label === 'ambiguous' || record.label === 'unlabeled') {
        return { status: 'excluded', bucket: record.label, includedInMetrics: false };
    }
    if (record.label === 'clean') {
        return record.pixelsChanged === true
            ? { status: 'fail', bucket: 'false-positive', includedInMetrics: true }
            : { status: 'pass', bucket: 'clean-skip', includedInMetrics: true };
    }
    const classification = classifyExternalBenchmarkCase(record);
    return { ...classification, includedInMetrics: true };
}
```

Move `isConservativeCanonical96Pass()` and `classifyExternalBenchmarkCase()` without changing thresholds or watermarked semantics. Re-export the classifier from the runner so `tests/scripts/sampleBenchmark.test.js` and `externalBenchmarkContourResidual.test.js` retain their current import path.

- [ ] **Step 4: Implement explicit metric fractions and review queues**

```js
const metric = (numerator, denominator) => ({
    numerator,
    denominator,
    rate: denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null
});

export function summarizeTrustedExternalBenchmarkResults(results) {
    const labels = { watermarked: 0, clean: 0, ambiguous: 0, unlabeled: 0 };
    for (const record of results) labels[record.label]++;
    const watermarked = results.filter((record) => record.label === 'watermarked');
    const clean = results.filter((record) => record.label === 'clean');
    const appliedWatermarked = watermarked.filter((record) => record.applied === true);
    const passedWatermarked = watermarked.filter((record) => record.classification.status === 'pass');
    const cleanSkips = clean.filter((record) => record.classification.bucket === 'clean-skip');
    const falsePositives = clean.filter((record) => record.classification.bucket === 'false-positive');
    const qualifiedPasses = passedWatermarked.length + cleanSkips.length;
    return {
        labels,
        metrics: {
            watermarkDetectionRecall: metric(appliedWatermarked.length, watermarked.length),
            watermarkEndToEndPassRate: metric(passedWatermarked.length, watermarked.length),
            restorationPassRateAmongApplied: metric(passedWatermarked.length, appliedWatermarked.length),
            cleanSkipRate: metric(cleanSkips.length, clean.length),
            falsePositiveRate: metric(falsePositives.length, clean.length),
            qualifiedOverallPassRate: metric(qualifiedPasses, watermarked.length + clean.length)
        },
        reviewQueue: {
            ambiguous: results.filter((record) => record.label === 'ambiguous'),
            unlabeled: results.filter((record) => record.label === 'unlabeled')
        }
    };
}
```

Retain the existing diagnostic bucket, group, decision-tier, source, anchor and shadow summaries, but add `excludedCount`; calculate `successRate` from `metrics.qualifiedOverallPassRate.rate`, never from all unique content.

- [ ] **Step 5: Implement fail-closed baseline comparison**

```js
const DATASET_IDENTITY_FIELDS = ['datasetId', 'labelManifestSha256', 'contentSetSha256'];

export function compareTrustedExternalBenchmarkResults({ dataset, results, baseline }) {
    if (!baseline) return { status: 'not-requested', newlyPassing: [], newlyFailing: [] };
    if (dataset.trusted !== true || baseline.dataset?.trusted !== true) {
        throw new Error('baseline comparison requires trusted-labels reports');
    }
    for (const field of DATASET_IDENTITY_FIELDS) {
        if (dataset[field] !== baseline.dataset[field]) {
            throw new Error(`baseline dataset ${field} mismatch`);
        }
    }
    const previous = new Map(baseline.results
        .filter((record) => record.classification?.includedInMetrics === true)
        .map((record) => [record.contentSha256, record.classification.status]));
    const newlyPassing = [];
    const newlyFailing = [];
    for (const record of results.filter((item) => item.classification.includedInMetrics === true)) {
        const before = previous.get(record.contentSha256);
        if (before === 'fail' && record.classification.status === 'pass') newlyPassing.push(record.fileName);
        if (before === 'pass' && record.classification.status === 'fail') newlyFailing.push(record.fileName);
    }
    return { status: 'comparable', newlyPassing, newlyFailing };
}
```

- [ ] **Step 6: Run focused and existing classifier tests**

Run: `rtk pnpm exec node --test tests/scripts/externalBenchmarkEvaluation.test.js tests/scripts/sampleBenchmark.test.js tests/scripts/externalBenchmarkContourResidual.test.js`

Expected: all tests PASS; existing watermarked classifications remain unchanged.

- [ ] **Step 7: Commit label-aware evaluation**

```powershell
rtk git add scripts/external-benchmark-evaluation.js scripts/run-external-gemini-watermark-sample-benchmark.js tests/scripts/externalBenchmarkEvaluation.test.js
rtk git commit -m "Add label-aware external benchmark evaluation"
```

---

### Task 3: Runner CLI, Unique-Content Processing, and Reports

**Files:**
- Modify: `scripts/run-external-gemini-watermark-sample-benchmark.js`
- Create: `tests/scripts/externalBenchmarkRunner.test.js`

**Interfaces:**
- Consumes: Task 1 dataset loader and Task 2 evaluator.
- Produces: `parseExternalBenchmarkArgs(argv)` with `labelManifestPath`, `assumeWatermarked`, optional `baselinePath`, `resultsCsvPath`, and existing output paths.
- Produces: `imageDataPixelsChanged(before, after): boolean`.
- Produces: `benchmarkExternalSamples(options): Promise<ExternalBenchmarkReport>`.
- Produces: `renderExternalBenchmarkMarkdown(report): string` and `renderExternalBenchmarkResultsCsv(results): string`.

- [ ] **Step 1: Write failing CLI, pixel comparison, and renderer tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    imageDataPixelsChanged,
    parseExternalBenchmarkArgs,
    renderExternalBenchmarkMarkdown,
    renderExternalBenchmarkResultsCsv
} from '../../scripts/run-external-gemini-watermark-sample-benchmark.js';

test('runner requires exactly one label source', () => {
    assert.throws(() => parseExternalBenchmarkArgs([]), /exactly one of --labels or --assume-watermarked/);
    assert.throws(
        () => parseExternalBenchmarkArgs(['--labels', 'labels.json', '--assume-watermarked']),
        /exactly one of --labels or --assume-watermarked/
    );
    assert.equal(parseExternalBenchmarkArgs(['--labels', 'labels.json']).assumeWatermarked, false);
    assert.equal(parseExternalBenchmarkArgs(['--assume-watermarked']).assumeWatermarked, true);
});

test('pixel comparison detects real byte changes rather than trusting metadata', () => {
    const original = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) };
    const identical = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) };
    const changed = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 4, 255]) };
    assert.equal(imageDataPixelsChanged(original, identical), false);
    assert.equal(imageDataPixelsChanged(original, changed), true);
});

test('Markdown and CSV expose labels, inclusion, hashes, and classifications', () => {
    const report = {
        generatedAt: '2026-07-30T00:00:00.000Z',
        sampleRoot: 'sample-root',
        dataset: { trusted: true, datasetId: 'fixture', pathCount: 2, uniqueContentCount: 1, duplicatePathCount: 1 },
        labels: { watermarked: 0, clean: 1, ambiguous: 0, unlabeled: 0 },
        metrics: { qualifiedOverallPassRate: { numerator: 1, denominator: 1, rate: 1 } },
        summary: { passCount: 1, failCount: 0, excludedCount: 0, buckets: { 'clean-skip': 1 }, contourResidualShadow: { flaggedCount: 0, measuredCount: 0, unavailableCount: 1, fallbackGeometryCount: 0 }, interiorResidualShadow: { flaggedCount: 0, measuredCount: 0, unavailableCount: 1, fallbackGeometryCount: 0 } },
        comparison: { status: 'not-requested' },
        newlyPassing: [], newlyFailing: [], failures: [],
        results: [{ fileName: 'a.png', paths: ['a.png', 'b.png'], contentSha256: 'abc', label: 'clean', classification: { status: 'pass', bucket: 'clean-skip', includedInMetrics: true } }]
    };
    assert.match(renderExternalBenchmarkMarkdown(report), /qualifiedOverallPassRate/);
    const csv = renderExternalBenchmarkResultsCsv(report.results);
    assert.match(csv, /contentSha256,label,includedInMetrics,status,bucket/);
    assert.match(csv, /abc,clean,true,pass,clean-skip/);
});
```

Use subprocess coverage for both CLI modes:

```js
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

test('CLI fails before writing output when label mode is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gwr-runner-cli-'));
    const output = path.join(dir, 'report.json');
    const result = spawnSync(process.execPath, [
        'scripts/run-external-gemini-watermark-sample-benchmark.js',
        '--sample-root', dir,
        '--output', output
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one of --labels or --assume-watermarked/);
    assert.equal(existsSync(output), false);
});

test('CLI marks assumed-watermarked output as diagnostic-only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gwr-runner-assumed-'));
    await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toFile(path.join(dir, 'one.png'));
    const output = path.join(dir, 'report.json');
    const result = spawnSync(process.execPath, [
        'scripts/run-external-gemini-watermark-sample-benchmark.js',
        '--sample-root', dir,
        '--assume-watermarked',
        '--output', output,
        '--markdown', path.join(dir, 'report.md'),
        '--results-csv', path.join(dir, 'results.csv'),
        '--failures-csv', path.join(dir, 'failures.csv')
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).dataset.trusted, false);
});
```

- [ ] **Step 2: Run focused runner tests and verify failures**

Run: `rtk pnpm exec node --test tests/scripts/externalBenchmarkRunner.test.js`

Expected: FAIL because the new exports and CLI checks do not exist.

- [ ] **Step 3: Integrate trusted dataset selection before image processing**

```js
export function parseExternalBenchmarkArgs(argv) {
    const parsed = {
        sampleRoot: DEFAULT_SAMPLE_ROOT,
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        resultsCsvPath: path.join(DEFAULT_OUTPUT_DIR, 'latest-strong-located-results.csv'),
        failuresCsvPath: DEFAULT_FAILURES_CSV_PATH,
        baselinePath: null,
        labelManifestPath: null,
        assumeWatermarked: false
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--sample-root') parsed.sampleRoot = path.resolve(args.shift() || parsed.sampleRoot);
        else if (arg === '--output') parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
        else if (arg === '--markdown') parsed.markdownPath = path.resolve(args.shift() || parsed.markdownPath);
        else if (arg === '--results-csv') parsed.resultsCsvPath = path.resolve(args.shift() || parsed.resultsCsvPath);
        else if (arg === '--failures-csv') parsed.failuresCsvPath = path.resolve(args.shift() || parsed.failuresCsvPath);
        else if (arg === '--baseline') parsed.baselinePath = path.resolve(args.shift());
        else if (arg === '--labels') parsed.labelManifestPath = path.resolve(args.shift());
        else if (arg === '--assume-watermarked') parsed.assumeWatermarked = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    const selected = Number(Boolean(parsed.labelManifestPath)) + Number(parsed.assumeWatermarked);
    if (selected !== 1) throw new Error('exactly one of --labels or --assume-watermarked is required');
    return parsed;
}
```

Load all image paths, then use `loadTrustedExternalBenchmarkDataset()` or `createAssumedWatermarkedDataset()`. Iterate `dataset.cases`, so trusted mode processes each SHA-256 once. For each result, preserve `paths`, `contentSha256`, `label`, `reviewConfidence`, `watermarkFamily`, `expectedAnchor`, `note`, and calculate pixel mutation with:

```js
export function imageDataPixelsChanged(before, after) {
    if (before.width !== after.width || before.height !== after.height || before.data.length !== after.data.length) return true;
    for (let index = 0; index < before.data.length; index++) {
        if (before.data[index] !== after.data[index]) return true;
    }
    return false;
}
```

Do not alter the call to `processWatermarkImageData`, alpha maps, shadow geometry, or quality fields.

- [ ] **Step 4: Assemble trusted report and baseline comparison**

```js
const aggregate = summarizeTrustedExternalBenchmarkResults(results);
const comparison = compareTrustedExternalBenchmarkResults({ dataset: loaded.dataset, results, baseline });
return {
    generatedAt: new Date().toISOString(),
    sampleRoot,
    dataset: loaded.dataset,
    policy,
    labels: aggregate.labels,
    metrics: aggregate.metrics,
    summary: aggregate.summary,
    reviewQueue: aggregate.reviewQueue,
    comparison,
    newlyPassing: comparison.newlyPassing,
    newlyFailing: comparison.newlyFailing,
    failures: results.filter((record) => record.classification.status === 'fail'),
    results
};
```

When `--assume-watermarked` is used, emit `dataset.trusted=false` and a console warning `diagnostic-only: assumed-watermarked labels are not release evidence`.

- [ ] **Step 5: Render all required fields**

Markdown must show dataset identity, 119-path/105-content-style counts, all six named metrics with numerator/denominator/rate, label counts, true failures, and `ambiguous` / `unlabeled` review queues. Results CSV must contain `fileName`, joined `paths`, `contentSha256`, `label`, `includedInMetrics`, `status`, `bucket`, dimensions, applied state, source, decision tier, anchor, residual/gradient/suppression and quality fields. Keep the failure CSV as a failure-only compatibility artifact with the same label and hash columns.

- [ ] **Step 6: Run runner, evaluation, and existing shadow tests**

Run: `rtk pnpm exec node --test tests/scripts/externalBenchmarkRunner.test.js tests/scripts/externalBenchmarkDataset.test.js tests/scripts/externalBenchmarkEvaluation.test.js tests/scripts/sampleBenchmark.test.js tests/scripts/externalBenchmarkContourResidual.test.js`

Expected: all tests PASS.

- [ ] **Step 7: Commit runner integration**

```powershell
rtk git add scripts/run-external-gemini-watermark-sample-benchmark.js tests/scripts/externalBenchmarkRunner.test.js
rtk git commit -m "Integrate trusted labels into external benchmark"
```

---

### Task 4: Trusted Release Gate

**Files:**
- Modify: `scripts/gate-online-gemini-watermark-sample-benchmark.js`
- Create: `tests/scripts/onlineSampleBenchmarkGate.test.js`

**Interfaces:**
- Consumes: Task 3 report schema.
- Produces: `evaluateOnlineSampleBenchmarkGate(report, args): GateResult`.
- `GateResult` shape retains `ok`, totals, rate, comparison counts, anchor evidence and `failures`, and adds `dataset` plus `unlabeledCount`.

- [ ] **Step 1: Write failing pure gate and CLI tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOnlineSampleBenchmarkGate } from '../../scripts/gate-online-gemini-watermark-sample-benchmark.js';

const args = {
    expectedTotal: 105,
    expectedPaths: 119,
    minSuccessRate: 0.8,
    maxNewlyFailing: 0,
    minNewlyPassing: 0,
    requiredAnchors: []
};

const trustedReport = {
    dataset: { mode: 'trusted-labels', trusted: true, pathCount: 119, uniqueContentCount: 105 },
    labels: { watermarked: 40, clean: 65, ambiguous: 0, unlabeled: 0 },
    metrics: { qualifiedOverallPassRate: { numerator: 90, denominator: 105, rate: 0.8571 } },
    summary: { passCount: 90, failCount: 15, byAnchor: {} },
    comparison: { status: 'comparable' },
    newlyPassing: [], newlyFailing: []
};

test('gate accepts a trusted complete report', () => {
    assert.equal(evaluateOnlineSampleBenchmarkGate(trustedReport, args).ok, true);
});

test('gate rejects assumed labels, unlabeled content, and dataset count mismatches', () => {
    assert.equal(evaluateOnlineSampleBenchmarkGate({ ...trustedReport, dataset: { ...trustedReport.dataset, trusted: false } }, args).ok, false);
    assert.equal(evaluateOnlineSampleBenchmarkGate({ ...trustedReport, labels: { ...trustedReport.labels, unlabeled: 1 } }, args).ok, false);
    assert.equal(evaluateOnlineSampleBenchmarkGate({ ...trustedReport, dataset: { ...trustedReport.dataset, uniqueContentCount: 104 } }, args).ok, false);
});
```

Add direct and subprocess coverage for comparison and trust:

```js
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('newly-passing thresholds require a comparable baseline', () => {
    const result = evaluateOnlineSampleBenchmarkGate(
        { ...trustedReport, comparison: { status: 'not-requested' } },
        { ...args, minNewlyPassing: 1 }
    );
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('comparable trusted baseline is required'));
});

test('gate CLI exits non-zero for assumed-watermarked reports', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gwr-gate-cli-'));
    const reportPath = path.join(dir, 'report.json');
    await writeFile(reportPath, JSON.stringify({
        ...trustedReport,
        dataset: { ...trustedReport.dataset, mode: 'assumed-watermarked', trusted: false }
    }));
    const result = spawnSync(process.execPath, [
        'scripts/gate-online-gemini-watermark-sample-benchmark.js',
        '--report', reportPath,
        '--expected-total', '105',
        '--expected-paths', '119',
        '--min-success-rate', '0',
        '--max-newly-failing', '105',
        '--min-newly-passing', '0',
        '--no-default-anchors'
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /report must use trusted-labels/);
});
```

- [ ] **Step 2: Run the gate tests and verify they fail**

Run: `rtk pnpm exec node --test tests/scripts/onlineSampleBenchmarkGate.test.js`

Expected: FAIL because `evaluateOnlineSampleBenchmarkGate` is not exported.

- [ ] **Step 3: Extract a pure evaluator and enforce trust**

```js
export function evaluateOnlineSampleBenchmarkGate(report, args) {
    const failures = [];
    const dataset = report.dataset ?? {};
    const qualified = report.metrics?.qualifiedOverallPassRate ?? {};
    assertCondition(failures, dataset.trusted === true && dataset.mode === 'trusted-labels', 'report must use trusted-labels');
    assertCondition(failures, Number(report.labels?.unlabeled ?? 0) === 0, 'report must not contain unlabeled content');
    assertCondition(failures, dataset.uniqueContentCount === args.expectedTotal, `expected unique total ${args.expectedTotal}, got ${dataset.uniqueContentCount}`);
    assertCondition(failures, dataset.pathCount === args.expectedPaths, `expected path total ${args.expectedPaths}, got ${dataset.pathCount}`);
    assertCondition(failures, Number(qualified.rate ?? -1) >= args.minSuccessRate, `expected qualifiedOverallPassRate >= ${args.minSuccessRate}, got ${qualified.rate}`);
    if (args.minNewlyPassing > 0 || args.maxNewlyFailing < Number.POSITIVE_INFINITY) {
        assertCondition(failures, report.comparison?.status === 'comparable', 'comparable trusted baseline is required');
    }
    const newlyPassing = Array.isArray(report.newlyPassing) ? report.newlyPassing.length : 0;
    const newlyFailing = Array.isArray(report.newlyFailing) ? report.newlyFailing.length : 0;
    assertCondition(failures, newlyFailing <= args.maxNewlyFailing, `expected newlyFailing <= ${args.maxNewlyFailing}, got ${newlyFailing}`);
    assertCondition(failures, newlyPassing >= args.minNewlyPassing, `expected newlyPassing >= ${args.minNewlyPassing}, got ${newlyPassing}`);
    for (const [anchorKey, expectedPass] of args.requiredAnchors) {
        const anchor = report.summary?.byAnchor?.[anchorKey] ?? null;
        assertCondition(failures, Boolean(anchor), `required anchor ${anchorKey} is missing`);
        if (anchor) assertCondition(
            failures,
            anchor.pass >= expectedPass && anchor.fail === 0,
            `expected anchor ${anchorKey} pass >= ${expectedPass} and fail=0, got pass=${anchor.pass} fail=${anchor.fail}`
        );
    }
    return {
        ok: failures.length === 0,
        dataset,
        total: Number(dataset.uniqueContentCount ?? 0),
        pathCount: Number(dataset.pathCount ?? 0),
        passCount: Number(report.summary?.passCount ?? 0),
        failCount: Number(report.summary?.failCount ?? 0),
        unlabeledCount: Number(report.labels?.unlabeled ?? 0),
        successRate: Number(qualified.rate ?? 0),
        newlyPassing,
        newlyFailing,
        requiredAnchors: Object.fromEntries(args.requiredAnchors.map(([key]) => [
            key,
            report.summary?.byAnchor?.[key] ?? null
        ])),
        failures
    };
}
```

Add `--expected-paths`, preserve existing CLI flags, and make `main()` read JSON then call this pure function. Anchor counts continue to come from `summary.byAnchor`, which must include only `includedInMetrics=true` watermarked records.

- [ ] **Step 4: Run gate and report tests**

Run: `rtk pnpm exec node --test tests/scripts/onlineSampleBenchmarkGate.test.js tests/scripts/externalBenchmarkRunner.test.js tests/scripts/externalBenchmarkEvaluation.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit the trusted gate**

```powershell
rtk git add scripts/gate-online-gemini-watermark-sample-benchmark.js tests/scripts/onlineSampleBenchmarkGate.test.js
rtk git commit -m "Require trusted data in online sample gate"
```

---

### Task 5: Full-Sample Human Label Review Pack

**Files:**
- Modify: `scripts/render-strong-located-review-sheet.js`
- Create: `tests/scripts/externalBenchmarkReviewSheet.test.js`
- Local-only output: `.artifacts/recent-online-20260729/trusted-evaluation/review/`
- Local-only labels: `.artifacts/recent-online-20260729/trusted-labels.json`

**Interfaces:**
- Consumes: `listExternalBenchmarkImages()` and `indexExternalBenchmarkImages()` from Task 1.
- Produces: `buildExternalBenchmarkLabelTemplate(indexedCases, datasetId): object`.
- Produces: `selectExternalBenchmarkReviewRecords(report, { allUniqueContent }): object[]`.
- CLI adds `--all-unique-content` and `--label-template` without changing the existing missed/newly-passing outputs.

- [ ] **Step 1: Write failing selection and template tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildExternalBenchmarkLabelTemplate,
    selectExternalBenchmarkReviewRecords
} from '../../scripts/render-strong-located-review-sheet.js';

test('all-content review selects one canonical record per hash', () => {
    const report = { results: [
        { fileName: 'a.png', contentSha256: 'same', paths: ['a.png', 'b.png'] },
        { fileName: 'c.png', contentSha256: 'other', paths: ['c.png'] }
    ] };
    assert.deepEqual(
        selectExternalBenchmarkReviewRecords(report, { allUniqueContent: true }).map((item) => item.fileName),
        ['a.png', 'c.png']
    );
});

test('label template expands reviewed content decisions to every path', () => {
    const template = buildExternalBenchmarkLabelTemplate([{
        sha256: 'a'.repeat(64),
        paths: ['a.png', 'b.png']
    }], 'recent-online-20260729');
    assert.equal(template.version, 1);
    assert.equal(template.datasetId, 'recent-online-20260729');
    assert.deepEqual(Object.keys(template.samples), ['a.png', 'b.png']);
    assert.equal(template.samples['a.png'].sha256, 'a'.repeat(64));
    assert.equal(template.samples['a.png'].label, null);
});
```

- [ ] **Step 2: Run focused review-sheet tests and verify failures**

Run: `rtk pnpm exec node --test tests/scripts/externalBenchmarkReviewSheet.test.js`

Expected: FAIL because the exports and all-content mode are absent.

- [ ] **Step 3: Add all-unique-content sheet and local template output**

```js
export function buildExternalBenchmarkLabelTemplate(indexedCases, datasetId) {
    const samples = {};
    for (const record of indexedCases.sort((a, b) => a.paths[0].localeCompare(b.paths[0]))) {
        for (const fileName of record.paths) {
            samples[fileName] = {
                sha256: record.sha256,
                label: null,
                reviewConfidence: null,
                watermarkFamily: null,
                expectedAnchor: null,
                note: ''
            };
        }
    }
    return { version: 1, datasetId, samples };
}

export function selectExternalBenchmarkReviewRecords(report, { allUniqueContent = false } = {}) {
    if (!allUniqueContent) {
        return (report.failures ?? []).filter((record) => record.bucket === 'missed-detection');
    }
    const byHash = new Map();
    for (const record of report.results ?? []) {
        const key = record.contentSha256 || record.fileName;
        if (!byHash.has(key)) byHash.set(key, record);
    }
    return [...byHash.values()].sort((left, right) => left.fileName.localeCompare(right.fileName));
}
```

Render one high-resolution bottom-right crop panel per unique content, label it with canonical filename, dimensions, SHA prefix, and duplicate path count, and keep the existing full source path in `review-index.json`. Write the null-label template only to the explicit `--label-template` path; the trusted loader must continue rejecting it until every entry has a valid human label and confidence.

- [ ] **Step 4: Run review-sheet tests**

Run: `rtk pnpm exec node --test tests/scripts/externalBenchmarkReviewSheet.test.js tests/scripts/externalBenchmarkDataset.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit the review tooling**

```powershell
rtk git add scripts/render-strong-located-review-sheet.js tests/scripts/externalBenchmarkReviewSheet.test.js
rtk git commit -m "Add full-sample benchmark label review pack"
```

- [ ] **Step 6: Generate the 105-content review pack and 119-path template**

Run:

```powershell
rtk pnpm exec node scripts/run-external-gemini-watermark-sample-benchmark.js --sample-root .artifacts/recent-online-20260729/RemoveGeminiWatermark --assume-watermarked --output .artifacts/recent-online-20260729/trusted-evaluation/diagnostic.json --markdown .artifacts/recent-online-20260729/trusted-evaluation/diagnostic.md --results-csv .artifacts/recent-online-20260729/trusted-evaluation/diagnostic-results.csv --failures-csv .artifacts/recent-online-20260729/trusted-evaluation/diagnostic-failures.csv
rtk pnpm exec node scripts/render-strong-located-review-sheet.js --report .artifacts/recent-online-20260729/trusted-evaluation/diagnostic.json --sample-root .artifacts/recent-online-20260729/RemoveGeminiWatermark --out-dir .artifacts/recent-online-20260729/trusted-evaluation/review --all-unique-content --label-template .artifacts/recent-online-20260729/trusted-labels.json
```

Expected: `review-index.json` reports `pathCount=119`, `uniqueContentCount=105`, `duplicatePathCount=14`; the template contains 119 sample keys and is rejected by the trusted runner while labels remain null.

- [ ] **Step 7: Review and freeze all human labels**

For each of the 105 content groups, inspect the full source image and its bottom-right crop. Mark `watermarked` only when the Gemini star is visibly present or a verifiable original-source record proves it; mark `clean` when no Gemini watermark is visible without inferring from artistic style; mark `ambiguous` when scale, compression, occlusion or contrast prevents a reliable judgment. Apply the same decision to all paths in a duplicate group, set `reviewConfidence` to `high` or `medium`, use `watermarkFamily: "gemini-star"` only for visible Gemini marks, and record the visual/source reason in `note`.

Run the trusted runner once after editing the local JSON. Expected: it accepts all 119 path/hash bindings, reports `unlabeled=0`, `uniqueContentCount=105`, and no conflicting duplicate labels. Do not stage `.artifacts/recent-online-20260729/trusted-labels.json`.

---

### Task 6: Same-Gold Before/After Evaluation and Completion Verification

**Files:**
- No production file changes.
- Local-only worktree: `.worktrees/trusted-benchmark-9d20d29/`
- Local-only reports: `.artifacts/recent-online-20260729/trusted-evaluation/base-9d20d29.json` and `current.json` plus Markdown/CSV companions.

**Interfaces:**
- Consumes: completed trusted manifest and Tasks 1–5 benchmark scripts.
- Produces: one trusted base report, one trusted current report, a comparable `newlyPassing` / `newlyFailing` result, and an evidence-backed release recommendation.

- [ ] **Step 1: Run all focused tests before the expensive sample pass**

Run:

```powershell
rtk pnpm exec node --test tests/scripts/externalBenchmarkDataset.test.js tests/scripts/externalBenchmarkEvaluation.test.js tests/scripts/externalBenchmarkRunner.test.js tests/scripts/onlineSampleBenchmarkGate.test.js tests/scripts/externalBenchmarkReviewSheet.test.js tests/scripts/sampleBenchmark.test.js tests/scripts/externalBenchmarkContourResidual.test.js
```

Expected: all focused tests PASS.

- [ ] **Step 2: Create an isolated base-core worktree at `9d20d29`**

Run:

```powershell
rtk git worktree add .worktrees/trusted-benchmark-9d20d29 9d20d29
```

Copy only the benchmark-infrastructure files from the current worktree into the isolated worktree:

```powershell
rtk powershell -NoProfile -Command "Copy-Item -LiteralPath 'scripts/external-benchmark-dataset.js' -Destination '.worktrees/trusted-benchmark-9d20d29/scripts/external-benchmark-dataset.js'"
rtk powershell -NoProfile -Command "Copy-Item -LiteralPath 'scripts/external-benchmark-evaluation.js' -Destination '.worktrees/trusted-benchmark-9d20d29/scripts/external-benchmark-evaluation.js'"
rtk powershell -NoProfile -Command "Copy-Item -LiteralPath 'scripts/run-external-gemini-watermark-sample-benchmark.js' -Destination '.worktrees/trusted-benchmark-9d20d29/scripts/run-external-gemini-watermark-sample-benchmark.js'"
```

Do not copy any `src/` file. This makes both runs use the same evaluator while the base worktree imports the `9d20d29` core.

- [ ] **Step 3: Run the base core with the frozen trusted manifest**

Run from `.worktrees/trusted-benchmark-9d20d29`; the `../..` paths resolve to the main worktree without committing a machine-specific path:

```powershell
rtk pnpm exec node scripts/run-external-gemini-watermark-sample-benchmark.js --sample-root ../../.artifacts/recent-online-20260729/RemoveGeminiWatermark --labels ../../.artifacts/recent-online-20260729/trusted-labels.json --output ../../.artifacts/recent-online-20260729/trusted-evaluation/base-9d20d29.json --markdown ../../.artifacts/recent-online-20260729/trusted-evaluation/base-9d20d29.md --results-csv ../../.artifacts/recent-online-20260729/trusted-evaluation/base-9d20d29-results.csv --failures-csv ../../.artifacts/recent-online-20260729/trusted-evaluation/base-9d20d29-failures.csv
```

Expected: trusted report, 119 paths, 105 unique contents, 14 duplicate paths, `labels.unlabeled=0`.

- [ ] **Step 4: Run current core against the base report**

Run from the main worktree:

```powershell
rtk pnpm exec node scripts/run-external-gemini-watermark-sample-benchmark.js --sample-root .artifacts/recent-online-20260729/RemoveGeminiWatermark --labels .artifacts/recent-online-20260729/trusted-labels.json --baseline .artifacts/recent-online-20260729/trusted-evaluation/base-9d20d29.json --output .artifacts/recent-online-20260729/trusted-evaluation/current.json --markdown .artifacts/recent-online-20260729/trusted-evaluation/current.md --results-csv .artifacts/recent-online-20260729/trusted-evaluation/current-results.csv --failures-csv .artifacts/recent-online-20260729/trusted-evaluation/current-failures.csv
```

Expected: `comparison.status="comparable"`; both reports have identical `datasetId`, `labelManifestSha256`, `contentSetSha256`, and label counts.

- [ ] **Step 5: Verify the trusted report contract with the gate**

Run:

```powershell
rtk pnpm benchmark:online-sample:gate -- --report .artifacts/recent-online-20260729/trusted-evaluation/current.json --expected-total 105 --expected-paths 119 --min-success-rate 0 --max-newly-failing 105 --min-newly-passing 0 --no-default-anchors
```

Expected: PASS for report trust, completeness and baseline comparability. The permissive numerical bounds in this command validate report integrity only; the release decision in Step 7 must use the observed split metrics and visual failures rather than treating this command as a quality approval.

- [ ] **Step 6: Run full project verification and prove algorithm scope stayed untouched**

Run:

```powershell
rtk pnpm test
rtk pnpm build
rtk pnpm release:image-validation
rtk git diff --check 5ebffe6..HEAD
rtk git diff --name-only 5ebffe6..HEAD -- src
```

Expected: full tests, build and image validation PASS; `git diff --check` is empty; the final `src` command prints nothing, proving this implementation did not change the processing algorithm or output path.

- [ ] **Step 7: Make the release recommendation from trusted evidence**

Read `base-9d20d29.md`, `current.md`, the two results CSV files, `newlyPassing`, `newlyFailing`, and visually inspect every newly changed content group. Report separately:

- watermarked count and `watermarkDetectionRecall`;
- `watermarkEndToEndPassRate` and `restorationPassRateAmongApplied`;
- clean count, `cleanSkipRate`, and `falsePositiveRate`;
- `qualifiedOverallPassRate`;
- ambiguous count and reasons;
- exact newly passing/failing groups and whether visual inspection agrees;
- largest remaining true failure bucket.

Recommend release only if current has no trusted clean-image regression, no visually confirmed newly failing watermarked group, and the observed gain is material enough to justify a version. Otherwise keep the current package version, use the largest trusted failure bucket as the next algorithm design input, and do not tune thresholds from excluded samples.

---

## Final Self-Review Checklist

- [ ] Every requirement in `docs/superpowers/specs/2026-07-30-trusted-online-image-benchmark-design.md` maps to a task above.
- [ ] All new APIs have one spelling and one return shape across producer and consumer tasks.
- [ ] No implementation task modifies `src/core/`, assets, package version, changelog or release artifacts.
- [ ] Focused tests run before full tests and before 105-image base/current passes.
- [ ] The current release recommendation is based on the 105-content trusted denominator, not the old 71/119 report.
- [ ] Local labels, external images, worktree outputs and generated reports remain untracked.

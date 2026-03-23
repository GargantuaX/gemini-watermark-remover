import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const SUPPORTED_SCENARIOS = Object.freeze(['main-thread', 'inline-worker']);
const DEFAULT_SAMPLE_NAMES = Object.freeze(['4.png', '6.png', 'large2.png']);
const DEFAULT_USERSCRIPT_PATH = path.resolve('dist/userscript/gemini-watermark-remover.user.js');
const DEFAULT_SAMPLE_DIR = path.resolve('src/assets/samples');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/userscript-benchmark/latest.json');
const PLACEHOLDER_DATA_URL =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function inferMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.webp') return 'image/webp';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return 'image/png';
}

function assertPositiveInteger(value, flagName) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${flagName} must be a non-negative integer`);
    }
    return parsed;
}

function parseScenarioList(rawScenario = 'both') {
    const normalized = String(rawScenario || 'both').trim().toLowerCase();
    if (normalized === 'both') {
        return [...SUPPORTED_SCENARIOS];
    }
    if (!SUPPORTED_SCENARIOS.includes(normalized)) {
        throw new Error(`Unsupported scenario: ${rawScenario}`);
    }
    return [normalized];
}

function parseSampleNames(rawSamples = '') {
    const normalized = String(rawSamples || '').trim();
    if (!normalized) return [...DEFAULT_SAMPLE_NAMES];
    return normalized
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
}

function roundMetric(value) {
    if (!Number.isFinite(value)) return null;
    return Number(value.toFixed(3));
}

function computeMedian(sortedValues) {
    if (sortedValues.length === 0) return null;
    const middle = Math.floor(sortedValues.length / 2);
    if (sortedValues.length % 2 === 1) {
        return sortedValues[middle];
    }
    return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

function computeNearestRank(sortedValues, percentile) {
    if (sortedValues.length === 0) return null;
    const rank = Math.max(1, Math.ceil(sortedValues.length * percentile));
    return sortedValues[Math.min(sortedValues.length - 1, rank - 1)];
}

export function computeDurationStats(values = []) {
    const durations = values
        .filter((value) => Number.isFinite(value))
        .map((value) => Number(value))
        .sort((left, right) => left - right);

    if (durations.length === 0) {
        return {
            count: 0,
            min: null,
            max: null,
            mean: null,
            p50: null,
            p95: null
        };
    }

    const total = durations.reduce((sum, value) => sum + value, 0);
    return {
        count: durations.length,
        min: roundMetric(durations[0]),
        max: roundMetric(durations[durations.length - 1]),
        mean: roundMetric(total / durations.length),
        p50: roundMetric(computeMedian(durations)),
        p95: roundMetric(computeNearestRank(durations, 0.95))
    };
}

function summarizeMetricGroup(results = []) {
    const metricNames = new Set();
    for (const result of results) {
        for (const metricName of Object.keys(result?.metrics || {})) {
            metricNames.add(metricName);
        }
    }

    const metrics = {};
    for (const metricName of metricNames) {
        metrics[metricName] = computeDurationStats(
            results.map((result) => result?.metrics?.[metricName]).filter((value) => Number.isFinite(value))
        );
    }

    return {
        runCount: results.length,
        metrics
    };
}

export function summarizeUserscriptBenchmarkResults(results = []) {
    const scenarios = [...new Set(results.map((item) => item?.scenario).filter(Boolean))];
    const samples = [...new Set(results.map((item) => item?.sampleName).filter(Boolean))];

    const byScenario = {};
    for (const scenario of scenarios) {
        byScenario[scenario] = summarizeMetricGroup(results.filter((item) => item.scenario === scenario));
    }

    const bySample = {};
    for (const sampleName of samples) {
        bySample[sampleName] = summarizeMetricGroup(results.filter((item) => item.sampleName === sampleName));
    }

    const byScenarioSample = {};
    for (const scenario of scenarios) {
        for (const sampleName of samples) {
            const key = `${scenario}::${sampleName}`;
            const scoped = results.filter((item) => item.scenario === scenario && item.sampleName === sampleName);
            if (scoped.length === 0) continue;
            byScenarioSample[key] = summarizeMetricGroup(scoped);
        }
    }

    return {
        totalRuns: results.length,
        scenarios,
        samples,
        byScenario,
        bySample,
        byScenarioSample
    };
}

export function parseUserscriptBenchmarkCliArgs(argv = []) {
    const args = [...argv];
    const parsed = {
        userscriptPath: DEFAULT_USERSCRIPT_PATH,
        sampleDir: DEFAULT_SAMPLE_DIR,
        outputPath: DEFAULT_OUTPUT_PATH,
        iterations: 3,
        warmupIterations: 1,
        scenarios: [...SUPPORTED_SCENARIOS],
        sampleNames: [...DEFAULT_SAMPLE_NAMES]
    };

    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--userscript') {
            parsed.userscriptPath = path.resolve(args.shift() || parsed.userscriptPath);
            continue;
        }
        if (arg === '--sample-dir') {
            parsed.sampleDir = path.resolve(args.shift() || parsed.sampleDir);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
            continue;
        }
        if (arg === '--iterations') {
            parsed.iterations = assertPositiveInteger(args.shift(), '--iterations');
            continue;
        }
        if (arg === '--warmup') {
            parsed.warmupIterations = assertPositiveInteger(args.shift(), '--warmup');
            continue;
        }
        if (arg === '--scenario') {
            parsed.scenarios = parseScenarioList(args.shift());
            continue;
        }
        if (arg === '--samples') {
            parsed.sampleNames = parseSampleNames(args.shift());
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return parsed;
}

async function loadSampleFixture(sampleDir, sampleName) {
    const filePath = path.resolve(sampleDir, sampleName);
    const buffer = await readFile(filePath);
    return {
        sampleName,
        filePath,
        mimeType: inferMimeType(filePath),
        base64: buffer.toString('base64')
    };
}

function buildBenchmarkSourceUrl(sampleName, phase, iteration) {
    const safeName = encodeURIComponent(sampleName.replace(/\s+/g, '-'));
    return `https://lh3.googleusercontent.com/rd-gg/${safeName}=s1024?phase=${phase}&iteration=${iteration}`;
}

async function installUserscriptHarness(page, { sample, scenario, userscriptSource }) {
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.evaluate(({ sample, scenario }) => {
        const decodeBase64 = (base64) => {
            const binary = globalThis.atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
            }
            return bytes;
        };

        const state = {
            sampleName: sample.sampleName,
            scenario,
            scriptStartAt: null,
            readyAt: null,
            initError: '',
            logs: []
        };

        const sourceBytes = decodeBase64(sample.base64);
        const buildArrayBuffer = () => {
            const clone = new Uint8Array(sourceBytes);
            return clone.buffer;
        };
        const buildBlob = () => new Blob([buildArrayBuffer()], { type: sample.mimeType });
        const matchesGeminiUrl = (url) => /googleusercontent\.com/i.test(String(url || ''));

        window.__gwrBenchmarkState = state;
        window.unsafeWindow = window;
        window.__GWR_FORCE_INLINE_WORKER__ = scenario === 'inline-worker';

        const originalLog = console.log.bind(console);
        const originalWarn = console.warn.bind(console);
        const originalError = console.error.bind(console);
        const capture = (type, argsLike) => {
            const text = Array.from(argsLike).map((item) => {
                if (typeof item === 'string') return item;
                try {
                    return JSON.stringify(item);
                } catch {
                    return String(item);
                }
            }).join(' ');
            state.logs.push({ type, text });
            return text;
        };

        console.log = (...args) => {
            const text = capture('log', args);
            if (text.includes('[Gemini Watermark Remover] Ready')) {
                state.readyAt = performance.now();
            }
            originalLog(...args);
        };
        console.warn = (...args) => {
            capture('warn', args);
            originalWarn(...args);
        };
        console.error = (...args) => {
            const text = capture('error', args);
            if (!state.initError) {
                state.initError = text;
            }
            originalError(...args);
        };

        window.fetch = async (input) => {
            const url = typeof input === 'string' ? input : input?.url;
            if (!matchesGeminiUrl(url)) {
                return new Response('Not Found', {
                    status: 404,
                    headers: { 'content-type': 'text/plain; charset=utf-8' }
                });
            }
            return new Response(buildBlob(), {
                status: 200,
                statusText: 'OK',
                headers: {
                    'content-type': sample.mimeType,
                    'x-gwr-benchmark': '1'
                }
            });
        };

        const gmRequest = (options = {}) => {
            globalThis.setTimeout(() => {
                const url = options.url || '';
                if (!matchesGeminiUrl(url)) {
                    options.onload?.({
                        status: 404,
                        response: new ArrayBuffer(0),
                        responseHeaders: 'Content-Type: text/plain\r\n'
                    });
                    return;
                }

                options.onload?.({
                    status: 200,
                    response: buildArrayBuffer(),
                    responseHeaders: `Content-Type: ${sample.mimeType}\r\n`
                });
            }, 0);
        };

        window.GM_xmlhttpRequest = gmRequest;
        globalThis.GM_xmlhttpRequest = gmRequest;
    }, { sample, scenario });

    await page.evaluate(() => {
        window.__gwrBenchmarkState.scriptStartAt = performance.now();
    });
    await page.addScriptTag({ content: userscriptSource });
    await page.waitForFunction(() => {
        const state = window.__gwrBenchmarkState;
        return Boolean(state && (typeof state.readyAt === 'number' || state.initError));
    }, { timeout: 30000 });

    const initState = await page.evaluate(() => ({
        scriptStartAt: window.__gwrBenchmarkState?.scriptStartAt ?? null,
        readyAt: window.__gwrBenchmarkState?.readyAt ?? null,
        initError: window.__gwrBenchmarkState?.initError ?? '',
        logs: window.__gwrBenchmarkState?.logs ?? []
    }));

    if (!Number.isFinite(initState.readyAt)) {
        throw new Error(initState.initError || 'Userscript did not reach ready state');
    }

    return {
        initMs: roundMetric(initState.readyAt - initState.scriptStartAt),
        logs: initState.logs
    };
}

async function measurePageReplacement(page, { sampleName, iteration }) {
    const sourceUrl = buildBenchmarkSourceUrl(sampleName, 'page-replacement', iteration);
    return page.evaluate(async ({ sourceUrl, placeholderDataUrl }) => {
        const container = document.createElement('div');
        container.className = 'generated-image-container';
        container.style.width = '512px';
        container.style.height = '512px';
        container.style.position = 'relative';

        const image = document.createElement('img');
        image.width = 512;
        image.height = 512;
        image.src = placeholderDataUrl;
        image.dataset.gwrSourceUrl = sourceUrl;
        container.appendChild(image);
        document.body.appendChild(container);

        const startedAt = performance.now();
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            const state = image.dataset.gwrPageImageState || '';
            if (state === 'ready') {
                return {
                    durationMs: performance.now() - startedAt,
                    finalState: state,
                    finalSrc: image.src,
                    blobType: image.dataset.gwrWatermarkObjectUrl?.startsWith('blob:') ? 'blob' : ''
                };
            }
            if (state === 'failed') {
                throw new Error('Page replacement failed');
            }
            await new Promise((resolve) => globalThis.setTimeout(resolve, 16));
        }
        throw new Error(`Page replacement timed out: ${image.dataset.gwrPageImageState || 'unknown'}`);
    }, {
        sourceUrl,
        placeholderDataUrl: PLACEHOLDER_DATA_URL
    });
}

async function measureDownloadHook(page, { sampleName, iteration }) {
    const requestUrl = buildBenchmarkSourceUrl(sampleName, 'download-hook', iteration);
    return page.evaluate(async ({ requestUrl }) => {
        const startedAt = performance.now();
        const response = await window.fetch(requestUrl);
        const blob = await response.blob();
        return {
            durationMs: performance.now() - startedAt,
            status: response.status,
            blobType: blob.type,
            blobSize: blob.size
        };
    }, { requestUrl });
}

function inspectScenarioObservations(logs = []) {
    const texts = logs.map((item) => String(item?.text || ''));
    return {
        workerAccelerationEnabled: texts.some((text) => text.includes('Worker acceleration enabled')),
        workerFallbackObserved: texts.some((text) => text.includes('fallback to main thread'))
    };
}

async function runSingleBenchmarkIteration(browser, { sample, scenario, userscriptSource, iteration }) {
    const page = await browser.newPage();
    try {
        const init = await installUserscriptHarness(page, {
            sample,
            scenario,
            userscriptSource
        });
        const pageReplacement = await measurePageReplacement(page, {
            sampleName: sample.sampleName,
            iteration
        });
        const downloadHook = await measureDownloadHook(page, {
            sampleName: sample.sampleName,
            iteration
        });

        return {
            scenario,
            sampleName: sample.sampleName,
            iteration,
            metrics: {
                initMs: init.initMs,
                pageReplacementMs: roundMetric(pageReplacement.durationMs),
                downloadHookMs: roundMetric(downloadHook.durationMs)
            },
            observations: {
                ...inspectScenarioObservations(init.logs),
                pageReplacementState: pageReplacement.finalState,
                pageReplacementSrcKind: pageReplacement.blobType,
                downloadStatus: downloadHook.status,
                downloadBlobType: downloadHook.blobType,
                downloadBlobSize: downloadHook.blobSize
            }
        };
    } finally {
        await page.close().catch(() => {});
    }
}

export async function runUserscriptBenchmark({
    userscriptPath = DEFAULT_USERSCRIPT_PATH,
    sampleDir = DEFAULT_SAMPLE_DIR,
    outputPath = DEFAULT_OUTPUT_PATH,
    iterations = 3,
    warmupIterations = 1,
    scenarios = [...SUPPORTED_SCENARIOS],
    sampleNames = [...DEFAULT_SAMPLE_NAMES]
} = {}) {
    const userscriptSource = await readFile(userscriptPath, 'utf8');
    const samples = [];
    for (const sampleName of sampleNames) {
        samples.push(await loadSampleFixture(sampleDir, sampleName));
    }

    const browser = await chromium.launch({ headless: true });
    try {
        for (const scenario of scenarios) {
            for (const sample of samples) {
                for (let warmupIndex = 0; warmupIndex < warmupIterations; warmupIndex += 1) {
                    await runSingleBenchmarkIteration(browser, {
                        sample,
                        scenario,
                        userscriptSource,
                        iteration: `warmup-${warmupIndex + 1}`
                    });
                }
            }
        }

        const results = [];
        for (const scenario of scenarios) {
            for (const sample of samples) {
                for (let iteration = 1; iteration <= iterations; iteration += 1) {
                    results.push(await runSingleBenchmarkIteration(browser, {
                        sample,
                        scenario,
                        userscriptSource,
                        iteration
                    }));
                }
            }
        }

        const report = {
            generatedAt: new Date().toISOString(),
            userscriptPath,
            sampleDir,
            outputPath,
            iterations,
            warmupIterations,
            scenarios,
            sampleNames,
            operationOrder: ['page-replacement', 'download-hook'],
            summary: summarizeUserscriptBenchmarkResults(results),
            results
        };

        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        return report;
    } finally {
        await browser.close();
    }
}

async function runCli() {
    const options = parseUserscriptBenchmarkCliArgs(process.argv.slice(2));
    const report = await runUserscriptBenchmark(options);
    for (const item of report.results) {
        console.log(
            `[${item.scenario}] ${item.sampleName} #${item.iteration} ` +
            `init=${item.metrics.initMs}ms ` +
            `page=${item.metrics.pageReplacementMs}ms ` +
            `download=${item.metrics.downloadHookMs}ms`
        );
    }
    console.log(`summary: runs=${report.summary.totalRuns} scenarios=${report.summary.scenarios.join(',')}`);
    console.log(`report: ${report.outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

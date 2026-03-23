import {
    WatermarkEngine,
    detectWatermarkConfig,
    calculateWatermarkPosition
} from './core/watermarkEngine.js';
import { WatermarkWorkerClient, canUseWatermarkWorker } from './core/workerClient.js';
import {
    isConfirmedWatermarkDecision,
    resolveDisplayWatermarkInfo
} from './core/watermarkDisplay.js';
import { canvasToBlob } from './core/canvasBlob.js';
import i18n from './i18n.js';
import {
    loadImage,
    checkOriginal,
    getOriginalStatus,
    resolveOriginalValidation,
    setStatusMessage,
    showLoading,
    hideLoading
} from './utils.js';
import JSZip from 'jszip';
import mediumZoom from 'medium-zoom';

// global state
let enginePromise = null;
let workerClient = null;
let imageQueue = [];
let processedCount = 0;
let zoom = null;

// dom elements references
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const singlePreview = document.getElementById('singlePreview');
const multiPreview = document.getElementById('multiPreview');
const imageList = document.getElementById('imageList');
const progressText = document.getElementById('progressText');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const originalImage = document.getElementById('originalImage');
const processedImage = document.getElementById('processedImage');
const originalInfo = document.getElementById('originalInfo');
const processedInfo = document.getElementById('processedInfo');
const downloadBtn = document.getElementById('downloadBtn');
const copyBtn = document.getElementById('copyBtn');
const resetBtn = document.getElementById('resetBtn');

async function getEngine() {
    if (!enginePromise) {
        enginePromise = WatermarkEngine.create().catch((error) => {
            enginePromise = null;
            throw error;
        });
    }
    return enginePromise;
}

function getEstimatedWatermarkInfo(item) {
    if (!item?.originalImg) return null;
    const { width, height } = item.originalImg;
    const config = detectWatermarkConfig(width, height);
    const position = calculateWatermarkPosition(width, height, config);
    return {
        size: config.logoSize,
        position,
        config
    };
}

function disableWorkerClient(reason) {
    if (!workerClient) return;
    console.warn('disable worker path, fallback to main thread:', reason);
    workerClient.dispose();
    workerClient = null;
}

/**
 * initialize the application
 */
async function init() {
    try {
        await i18n.init();
        setupLanguageSwitch();
        setupDarkMode();
        showLoading(i18n.t('status.loading'));

        if (canUseWatermarkWorker()) {
            try {
                workerClient = new WatermarkWorkerClient({
                    workerUrl: './workers/watermark-worker.js'
                });
            } catch (workerError) {
                console.warn('worker unavailable, fallback to main thread:', workerError);
                workerClient = null;
            }
        }
        if (!workerClient) {
            getEngine().catch((error) => {
                console.warn('main thread engine warmup failed:', error);
            });
        }

        hideLoading();
        setupEventListeners();
        setupSlider();

        zoom = mediumZoom('[data-zoomable]', {
            margin: 24,
            scrollOffset: 0,
            background: 'rgba(255, 255, 255, .6)',
        })
    } catch (error) {
        hideLoading();
        console.error('initialize error:', error);
    }
}

/**
 * setup language switch
 */
function setupLanguageSwitch() {
    const select = document.getElementById('langSwitch');
    if (!select) return;
    select.value = i18n.resolveLocale(i18n.locale);
    select.addEventListener('change', async () => {
        const newLocale = i18n.resolveLocale(select.value);
        if (newLocale === i18n.locale) return;
        await i18n.switchLocale(newLocale);
        select.value = i18n.locale;
        updateDynamicTexts();
    });
}

/**
 * setup event listeners
 */
function setupEventListeners() {
    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);

    // Global drag & drop
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('border-primary', 'bg-emerald-50', 'dark:bg-gray-700/50');
    });

    document.addEventListener('dragleave', (e) => {
        if (e.clientX === 0 && e.clientY === 0) {
            uploadArea.classList.remove('border-primary', 'bg-emerald-50', 'dark:bg-gray-700/50');
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('border-primary', 'bg-emerald-50', 'dark:bg-gray-700/50');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFiles(Array.from(e.dataTransfer.files));
        }
    });

    // Paste support
    document.addEventListener('paste', (e) => {
        const items = e.clipboardData.items;
        const files = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
                files.push(items[i].getAsFile());
            }
        }
        if (files.length > 0) handleFiles(files);
    });

    downloadAllBtn.addEventListener('click', downloadAll);
    resetBtn.addEventListener('click', reset);
    window.addEventListener('beforeunload', () => {
        disableWorkerClient('beforeunload');
    });
}

function reset() {
    singlePreview.style.display = 'none';
    multiPreview.style.display = 'none';
    imageQueue = [];
    processedCount = 0;
    fileInput.value = '';
    copyBtn.style.display = 'none';
    downloadBtn.style.display = 'none';
    setStatusMessage('');
    uploadArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function handleFileSelect(e) {
    handleFiles(Array.from(e.target.files));
}

function handleFiles(files) {
    setStatusMessage('');

    const validFiles = files.filter(file => {
        if (!file.type.match('image/(jpeg|png|webp)')) return false;
        if (file.size > 20 * 1024 * 1024) return false;
        return true;
    });

    if (validFiles.length === 0) return;

    imageQueue.forEach(item => {
        if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
        if (item.processedUrl) URL.revokeObjectURL(item.processedUrl);
    });

    imageQueue = validFiles.map((file, index) => ({
        id: Date.now() + index,
        file,
        name: file.name,
        status: 'pending',
        validation: null,
        originalImg: null,
        processedMeta: null,
        processedBlob: null,
        originalUrl: null,
        processedUrl: null
    }));

    processedCount = 0;

    if (validFiles.length === 1) {
        singlePreview.style.display = 'block';
        multiPreview.style.display = 'none';
        processSingle(imageQueue[0]);
    } else {
        singlePreview.style.display = 'none';
        multiPreview.style.display = 'block';
        imageList.innerHTML = '';
        updateProgress();
        multiPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });
        imageQueue.forEach(item => createImageCard(item));
        processQueue();
    }
}

function renderSingleImageMeta(item) {
    if (!item?.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    if (!watermarkInfo) return;

    originalInfo.innerHTML = `
        <p>${i18n.t('info.size')}: ${item.originalImg.width}×${item.originalImg.height}</p>
        <p>${i18n.t('info.watermark')}: ${watermarkInfo.size}×${watermarkInfo.size}</p>
        <p>${i18n.t('info.position')}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>
    `;
}

function getProcessedStatusLabel(item) {
    return !isConfirmedWatermarkDecision(item)
        ? i18n.t('info.skipped')
        : i18n.t('info.removed');
}

function renderSingleProcessedMeta(item) {
    if (!item?.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    const showWatermarkInfo = watermarkInfo && isConfirmedWatermarkDecision(item);

    processedInfo.innerHTML = `
        <p>${i18n.t('info.size')}: ${item.originalImg.width}×${item.originalImg.height}</p>
        ${showWatermarkInfo ? `<p>${i18n.t('info.watermark')}: ${watermarkInfo.size}×${watermarkInfo.size}</p>` : ''}
        ${showWatermarkInfo ? `<p>${i18n.t('info.position')}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>` : ''}
        <p>${i18n.t('info.status')}: ${getProcessedStatusLabel(item)}</p>
    `;
}

function renderImageCardStatus(item) {
    if (!item) return;

    if (item.status === 'pending') {
        updateStatus(item.id, i18n.t('status.pending'));
        return;
    }

    if (item.status === 'processing') {
        updateStatus(item.id, i18n.t('status.processing'));
        return;
    }

    if (item.status === 'error') {
        updateStatus(item.id, i18n.t('status.failed'));
        return;
    }

    if (item.status !== 'completed' || !item.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    const showWatermarkInfo = watermarkInfo && isConfirmedWatermarkDecision(item);

    let html = `<p>${i18n.t('info.size')}: ${item.originalImg.width}×${item.originalImg.height}</p>`;
    if (showWatermarkInfo) {
        html += `<p>${i18n.t('info.watermark')}: ${watermarkInfo.size}×${watermarkInfo.size}</p>
        <p>${i18n.t('info.position')}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>`;
    }
    html += `<p>${i18n.t('info.status')}: ${getProcessedStatusLabel(item)}</p>`;

    if (item.validation && !item.validation.is_google) {
        html += `<p class="inline-block mt-1 text-xs md:text-sm text-warn">${getOriginalStatus(item.validation)}</p>`;
    }

    updateStatus(item.id, html, true);
}

async function processSingle(item) {
    try {
        const img = await loadImage(item.file);
        item.originalImg = img;

        const validation = await checkOriginal(item.file);
        item.validation = validation;
        const status = getOriginalStatus(validation);
        setStatusMessage(status, validation.is_google ? 'success' : 'warn');

        originalImage.src = img.src;
        renderSingleImageMeta(item);

        const processed = await processImageWithBestPath(item.file, img);
        item.processedMeta = processed.meta;
        item.validation = resolveOriginalValidation(item.validation, item.processedMeta);
        const resolvedStatus = getOriginalStatus(item.validation);
        setStatusMessage(resolvedStatus, item.validation.is_google ? 'success' : 'warn');

        renderSingleImageMeta(item);
        item.processedBlob = processed.blob;

        item.processedUrl = URL.createObjectURL(processed.blob);
        processedImage.src = item.processedUrl;
        const overlay = document.getElementById('processedOverlay');
        const handle = document.getElementById('sliderHandle');
        overlay.style.display = 'block';
        handle.style.display = 'flex';
        processedInfo.style.display = 'block';

        copyBtn.style.display = 'flex';
        copyBtn.onclick = () => copyImage(item);

        downloadBtn.style.display = 'flex';
        downloadBtn.onclick = () => downloadImage(item);

        renderSingleProcessedMeta(item);

        document.getElementById('comparisonContainer').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        console.error(error);
    }
}

function createImageCard(item) {
    const card = document.createElement('div');
    card.id = `card-${item.id}`;
    card.className = 'bg-white md:h-[140px] rounded-xl shadow-card border border-gray-100 overflow-hidden';
    card.innerHTML = `
        <div class="flex flex-wrap h-full">
            <div class="w-full md:w-auto h-full flex border-b border-gray-100">
                <div class="w-24 md:w-48 flex-shrink-0 bg-gray-50 p-2 flex items-center justify-center">
                    <img id="result-${item.id}" class="max-w-full max-h-24 md:max-h-full rounded" data-zoomable />
                </div>
                <div class="flex-1 p-4 flex flex-col min-w-0">
                    <h4 class="font-semibold text-sm text-gray-900 mb-2 truncate">${item.name}</h4>
                    <div class="text-xs text-gray-500" id="status-${item.id}">${i18n.t('status.pending')}</div>
                </div>
            </div>
            <div class="w-full md:w-auto ml-auto flex-shrink-0 p-2 md:p-4 flex flex-col md:flex-row items-center justify-center gap-2">
                <button id="copy-${item.id}" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs md:text-sm hidden flex items-center gap-1">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m-1 10H8m4-3H8m1.5 6H8"></path></svg>
                    <span data-i18n="btn.copy">${i18n.t('btn.copy')}</span>
                </button>
                <button id="download-${item.id}" class="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg text-xs md:text-sm hidden">
                    <span data-i18n="btn.download">${i18n.t('btn.download')}</span>
                </button>
            </div>
        </div>
    `;
    imageList.appendChild(card);
}

async function processQueue() {
    await Promise.all(imageQueue.map(async item => {
        const img = await loadImage(item.file);
        item.originalImg = img;
        item.originalUrl = img.src;
        document.getElementById(`result-${item.id}`).src = img.src;
        zoom.attach(`#result-${item.id}`);
    }));

    const concurrency = 3;
    for (let i = 0; i < imageQueue.length; i += concurrency) {
        await Promise.all(imageQueue.slice(i, i + concurrency).map(async item => {
            if (item.status !== 'pending') return;

            item.status = 'processing';
            renderImageCardStatus(item);

            try {
                const processed = await processImageWithBestPath(item.file, item.originalImg);
                item.processedMeta = processed.meta;
                item.processedBlob = processed.blob;

                item.processedUrl = URL.createObjectURL(processed.blob);
                document.getElementById(`result-${item.id}`).src = item.processedUrl;

                item.status = 'completed';
                renderImageCardStatus(item);

                const copyBtn = document.getElementById(`copy-${item.id}`);
                copyBtn.classList.remove('hidden');
                copyBtn.onclick = () => copyImage(item, copyBtn);

                const downloadBtn = document.getElementById(`download-${item.id}`);
                downloadBtn.classList.remove('hidden');
                downloadBtn.onclick = () => downloadImage(item);

                processedCount++;
                updateProgress();

                checkOriginal(item.file).then((validation) => {
                    item.validation = resolveOriginalValidation(validation, item.processedMeta);
                    renderImageCardStatus(item);
                }).catch(() => { });
            } catch (error) {
                item.status = 'error';
                renderImageCardStatus(item);
                console.error(error);
            }
        }));
    }

    if (processedCount > 0) {
        downloadAllBtn.style.display = 'flex';
    }
}

async function processImageWithBestPath(file, fallbackImage, options = {}) {
    if (workerClient) {
        try {
            return await workerClient.processBlob(file, options);
        } catch (error) {
            console.warn('worker process failed, fallback to main thread:', error);
            disableWorkerClient(error);
        }
    }

    const engine = await getEngine();
    const canvas = await engine.removeWatermarkFromImage(fallbackImage, options);
    const blob = await canvasToBlob(canvas);
    return {
        blob,
        meta: canvas.__watermarkMeta || null
    };
}

function updateStatus(id, text, isHtml = false) {
    const el = document.getElementById(`status-${id}`);
    if (el) el.innerHTML = isHtml ? text : text.replace(/\n/g, '<br>');
}

function updateProgress() {
    progressText.textContent = `${i18n.t('progress.text')}: ${processedCount}/${imageQueue.length}`;
}

function updateDynamicTexts() {
    if (progressText.textContent || imageQueue.length > 0) {
        updateProgress();
    }

    if (imageQueue.length > 0) {
        imageQueue.forEach(item => renderImageCardStatus(item));
    }

    if (singlePreview.style.display !== 'none' && imageQueue.length === 1) {
        const [item] = imageQueue;
        renderSingleImageMeta(item);

        if (item?.processedBlob) {
            renderSingleProcessedMeta(item);
        }

        if (item?.validation) {
            const status = getOriginalStatus(item.validation);
            setStatusMessage(status, item.validation.is_google ? 'success' : 'warn');
        }
    }
}

async function copyImage(item, targetBtn = copyBtn) {
    if (!navigator.clipboard || !window.ClipboardItem) {
        setStatusMessage(i18n.t('status.unsupported'), 'warn');
        return;
    }

    try {
        if (!item.processedBlob) return;
        const data = [new ClipboardItem({ [item.processedBlob.type]: item.processedBlob })];
        await navigator.clipboard.write(data);

        const span = targetBtn.querySelector('span');
        const svg = targetBtn.querySelector('svg');
        const originalText = span.textContent;
        const originalSvgPath = svg.innerHTML;

        span.textContent = i18n.t('status.copied');
        svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>';

        setTimeout(() => {
            // Restore using i18n to handle potential language switch during timeout
            span.textContent = i18n.t('btn.copy');
            svg.innerHTML = originalSvgPath;
        }, 2000);
    } catch (err) {
        console.error('Failed to copy image: ', err);
        setStatusMessage(i18n.t('status.copy_failed'), 'warn');
    }
}

function downloadImage(item) {
    const a = document.createElement('a');
    a.href = item.processedUrl;
    a.download = `unwatermarked_${item.name.replace(/\.[^.]+$/, '')}.png`;
    a.click();
}

async function downloadAll() {
    const completed = imageQueue.filter(item => item.status === 'completed');
    if (completed.length === 0) return;

    const zip = new JSZip();
    completed.forEach(item => {
        const filename = `unwatermarked_${item.name.replace(/\.[^.]+$/, '')}.png`;
        zip.file(filename, item.processedBlob);
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `unwatermarked_${Date.now()}.zip`;
    a.click();
}

function setupDarkMode() {
    const themeToggle = document.getElementById('themeToggle');
    const html = document.documentElement;

    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        html.classList.add('dark');
    }

    themeToggle.addEventListener('click', () => {
        if (html.classList.contains('dark')) {
            html.classList.remove('dark');
            localStorage.theme = 'light';
        } else {
            html.classList.add('dark');
            localStorage.theme = 'dark';
        }
    });
}

function setupSlider() {
    const container = document.getElementById('comparisonContainer');
    const overlay = document.getElementById('processedOverlay');
    const handle = document.getElementById('sliderHandle');
    let isDown = false;

    function move(e) {
        if (!isDown) return;
        const rect = container.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        if (!clientX) return;

        const x = clientX - rect.left;
        const percent = Math.min(Math.max(x / rect.width, 0), 1) * 100;

        overlay.style.width = `${percent}%`;
        handle.style.left = `${percent}%`;
    }

    container.addEventListener('mousedown', (e) => { isDown = true; move(e); });
    window.addEventListener('mouseup', () => { isDown = false; });
    window.addEventListener('mousemove', move);

    container.addEventListener('touchstart', (e) => { isDown = true; move(e); });
    window.addEventListener('touchend', () => { isDown = false; });
    window.addEventListener('touchmove', move);
}

init();

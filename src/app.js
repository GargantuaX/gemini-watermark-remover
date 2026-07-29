import {
    WatermarkEngine,
    detectWatermarkConfig,
    calculateWatermarkPosition
} from './core/watermarkEngine.js';
import { WatermarkWorkerClient, canUseWatermarkWorker } from './core/workerClient.js';
import {
    isConfirmedWatermarkDecision,
    resolveDisplayWatermarkInfo,
    resolveProcessedStatusPresentation
} from './core/watermarkDisplay.js';
import { canvasToBlob } from './core/canvasBlob.js';
import {
    loadImage,
    setStatusMessage,
    showLoading,
    hideLoading
} from './utils.js';
import {
    consumeDebugFileHandoff,
    getDebugFileKind,
    saveDebugFileHandoff
} from './shared/debugFileHandoff.js';

const TEXT = {
    loading: '正在加载资源...',
    size: '尺寸',
    watermark: '检测到的水印',
    position: '位置',
    status: '状态',
    removed: '水印已移除',
    skipped: '未检测到可移除水印，已保留原图',
    visibleResidual: '已处理，可能仍有可见残影',
    possibleContentDamage: '已生成最佳结果，请检查水印区域',
    mixedQualityWarning: '已生成最佳结果，可能有残影或局部失真',
    unsupported: '浏览器不支持复制图片',
    copied: '已复制！',
    copy: '复制结果',
    copyFailed: '复制失败',
    unsupportedFile: '请选择 JPG、PNG、WebP 图片，或 MP4/WebM/MOV 视频。',
    fileTooLarge: '图片调试入口暂不处理超过 20MB 的图片。视频会进入视频调试页。',
    skippedLargeImages: '已跳过超过 20MB 的图片。',
    handoffVideo: '正在进入视频调试流程...',
    progress: '处理进度',
    pending: '等待处理',
    loadingImage: '读取图片...',
    processing: '正在处理...',
    processFailed: '处理失败'
};

let enginePromise = null;
let workerClient = null;
let currentItem = null;
let imageQueue = [];
let processedCount = 0;
let activeBatchId = 0;

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const singlePreview = document.getElementById('singlePreview');
const multiPreview = document.getElementById('multiPreview');
const imageList = document.getElementById('imageList');
const progressText = document.getElementById('progressText');
const originalImage = document.getElementById('originalImage');
const processedImage = document.getElementById('processedImage');
const originalInfo = document.getElementById('originalInfo');
const processedInfo = document.getElementById('processedInfo');
const downloadBtn = document.getElementById('downloadBtn');
const copyBtn = document.getElementById('copyBtn');
const resetBtn = document.getElementById('resetBtn');
const batchResetBtn = document.getElementById('batchResetBtn');
const processedOverlay = document.getElementById('processedOverlay');
const sliderHandle = document.getElementById('sliderHandle');

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

function cleanupCurrentItem() {
    if (!currentItem) return;
    if (currentItem.originalUrl) URL.revokeObjectURL(currentItem.originalUrl);
    if (currentItem.processedUrl) URL.revokeObjectURL(currentItem.processedUrl);
    currentItem = null;
}

function cleanupBatchItems() {
    activeBatchId++;
    imageQueue.forEach((item) => {
        if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
        if (item.processedUrl) URL.revokeObjectURL(item.processedUrl);
    });
    imageQueue = [];
    processedCount = 0;
}

async function init() {
    try {
        showLoading(TEXT.loading);

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
        await consumePendingImageHandoff();
    } catch (error) {
        hideLoading();
        console.error('initialize error:', error);
    }
}

function setupEventListeners() {
    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('border-primary', 'bg-emerald-50');
    });

    document.addEventListener('dragleave', (e) => {
        if (e.clientX === 0 && e.clientY === 0) {
            uploadArea.classList.remove('border-primary', 'bg-emerald-50');
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('border-primary', 'bg-emerald-50');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFiles(Array.from(e.dataTransfer.files));
        }
    });

    document.addEventListener('paste', (e) => {
        const items = e.clipboardData.items;
        const files = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                files.push(items[i].getAsFile());
            }
        }
        if (files.length > 0) handleFiles(files);
    });

    resetBtn.addEventListener('click', reset);
    batchResetBtn.addEventListener('click', reset);
    window.addEventListener('beforeunload', () => {
        cleanupBatchItems();
        disableWorkerClient('beforeunload');
    });
}

function reset() {
    cleanupCurrentItem();
    cleanupBatchItems();
    singlePreview.style.display = 'none';
    multiPreview.style.display = 'none';
    fileInput.value = '';
    imageList.innerHTML = '';
    updateProgress();
    originalImage.src = '';
    processedImage.src = '';
    originalInfo.innerHTML = '';
    processedInfo.innerHTML = '';
    processedInfo.style.display = 'none';
    processedOverlay.style.display = 'none';
    sliderHandle.style.display = 'none';
    copyBtn.style.display = 'none';
    downloadBtn.style.display = 'none';
    setStatusMessage('');
    uploadArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function handleFileSelect(e) {
    handleFiles(Array.from(e.target.files));
}

async function handleFiles(files) {
    setStatusMessage('');

    const list = Array.from(files || []).filter(Boolean);
    const videoFile = list.find((file) => getDebugFileKind(file) === 'video');
    if (videoFile) {
        await routeVideoFile(videoFile);
        return;
    }

    const imageFiles = list.filter((file) => getDebugFileKind(file) === 'image');
    if (imageFiles.length === 0) {
        setStatusMessage(TEXT.unsupportedFile, 'warn');
        return;
    }

    const validImageFiles = imageFiles.filter((file) => file.size <= 20 * 1024 * 1024);
    if (validImageFiles.length === 0) {
        setStatusMessage(TEXT.fileTooLarge, 'warn');
        return;
    }

    if (validImageFiles.length < imageFiles.length) {
        setStatusMessage(TEXT.skippedLargeImages, 'warn');
    }

    if (validImageFiles.length > 1) {
        processBatch(validImageFiles);
        return;
    }

    const validFile = validImageFiles[0];
    cleanupCurrentItem();
    cleanupBatchItems();
    multiPreview.style.display = 'none';
    imageList.innerHTML = '';
    currentItem = {
        id: Date.now(),
        file: validFile,
        name: validFile.name,
        originalImg: null,
        processedMeta: null,
        processedBlob: null,
        originalUrl: null,
        processedUrl: null
    };

    singlePreview.style.display = 'block';
    processSingle(currentItem);
}

function createDebugImageItem(file, index) {
    return {
        id: `${Date.now()}-${index}`,
        file,
        name: file.name,
        status: 'pending',
        originalImg: null,
        processedMeta: null,
        processedBlob: null,
        originalUrl: null,
        processedUrl: null
    };
}

function processBatch(files) {
    cleanupCurrentItem();
    cleanupBatchItems();

    imageQueue = files.map(createDebugImageItem);
    singlePreview.style.display = 'none';
    multiPreview.style.display = 'block';
    imageList.innerHTML = '';
    updateProgress();
    imageQueue.forEach((item) => createImageCard(item));
    multiPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const batchId = activeBatchId;
    processQueue(batchId);
}

async function routeVideoFile(file) {
    try {
        showLoading(TEXT.handoffVideo);
        await saveDebugFileHandoff(file, 'video');
        window.location.assign('./video-preview.html?fileHandoff=1');
    } catch (error) {
        hideLoading();
        console.error(error);
        setStatusMessage(error.message || '无法进入视频调试流程，请打开视频页后重新选择文件。', 'warn');
    }
}

async function consumePendingImageHandoff() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fileHandoff') !== '1') return;

    try {
        const record = await consumeDebugFileHandoff('image');
        if (!record?.file) return;
        await handleFiles([record.file]);
        window.history.replaceState(null, '', window.location.pathname);
    } catch (error) {
        console.warn('image handoff unavailable:', error);
        setStatusMessage(error.message || '读取图片暂存失败，请重新选择文件。', 'warn');
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
        <p>${TEXT.size}: ${item.originalImg.width}x${item.originalImg.height}</p>
        <p>${TEXT.watermark}: ${watermarkInfo.size}x${watermarkInfo.size}</p>
        <p>${TEXT.position}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>
    `;
}

function getProcessedStatusPresentation(item) {
    const presentation = resolveProcessedStatusPresentation(item);
    return {
        label: TEXT[presentation.messageKey],
        tone: presentation.tone
    };
}

function renderSingleProcessedMeta(item) {
    if (!item?.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    const showWatermarkInfo = watermarkInfo && isConfirmedWatermarkDecision(item);
    const statusPresentation = getProcessedStatusPresentation(item);

    processedInfo.innerHTML = `
        <p>${TEXT.size}: ${item.originalImg.width}x${item.originalImg.height}</p>
        ${showWatermarkInfo ? `<p>${TEXT.watermark}: ${watermarkInfo.size}x${watermarkInfo.size}</p>` : ''}
        ${showWatermarkInfo ? `<p>${TEXT.position}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>` : ''}
        <p class="${statusPresentation.tone === 'warning' ? 'text-warning' : ''}">${TEXT.status}: ${statusPresentation.label}</p>
    `;
}

async function processSingle(item) {
    try {
        const img = await loadImage(item.file);
        item.originalImg = img;
        item.originalUrl = img.src;

        originalImage.src = img.src;
        renderSingleImageMeta(item);

        const processed = await processImageWithBestPath(item.file, img);
        item.processedMeta = processed.meta;
        item.processedBlob = processed.blob;
        item.processedUrl = URL.createObjectURL(processed.blob);

        processedImage.src = item.processedUrl;
        processedOverlay.style.display = 'block';
        sliderHandle.style.display = 'flex';
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
    card.className = 'batch-card';
    card.innerHTML = `
        <div class="batch-comparison">
            <div class="batch-pane original">
                <span class="batch-pane-label">原图</span>
                <img id="original-${item.id}" class="batch-image" draggable="false" alt="" />
            </div>
            <div class="batch-pane processed">
                <span class="batch-pane-label">处理后</span>
                <img id="processed-${item.id}" class="batch-image" draggable="false" alt="" />
            </div>
        </div>
        <div class="batch-main">
            <h4 class="batch-title"></h4>
            <div class="batch-status" id="status-${item.id}"></div>
        </div>
        <div class="batch-actions">
            <button id="copy-${item.id}" class="batch-button primary" style="display: none;">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m-1 10H8m4-3H8m1.5 6H8"></path></svg>
                <span>${TEXT.copy}</span>
            </button>
            <button id="download-${item.id}" class="batch-button secondary" style="display: none;">
                下载结果
            </button>
        </div>
    `;
    imageList.appendChild(card);

    const title = card.querySelector('.batch-title');
    title.textContent = typeof item.name === 'string' ? item.name : '';
    title.title = title.textContent;
    renderImageCardStatus(item);
}

function renderImageCardStatus(item) {
    const statusEl = document.getElementById(`status-${item.id}`);
    if (!statusEl) return;

    statusEl.classList.remove('text-primary', 'text-warning');
    if (item.status === 'completed') {
        const presentation = getProcessedStatusPresentation(item);
        statusEl.textContent = presentation.label;
        statusEl.classList.add(presentation.tone === 'warning' ? 'text-warning' : 'text-primary');
        return;
    }

    const labels = {
        pending: TEXT.pending,
        loading: TEXT.loadingImage,
        processing: TEXT.processing,
        error: TEXT.processFailed
    };
    statusEl.textContent = labels[item.status] || TEXT.pending;
}

function updateProgress() {
    progressText.textContent = `${TEXT.progress}: ${processedCount}/${imageQueue.length}`;
}

async function processQueue(batchId) {
    const concurrency = 3;
    for (let i = 0; i < imageQueue.length; i += concurrency) {
        if (batchId !== activeBatchId) return;

        await Promise.all(imageQueue.slice(i, i + concurrency).map(async (item) => {
            if (batchId !== activeBatchId || item.status !== 'pending') return;

            item.status = 'loading';
            renderImageCardStatus(item);

            try {
                const img = await loadImage(item.file);
                if (batchId !== activeBatchId) return;

                item.originalImg = img;
                item.originalUrl = img.src;
                const originalPreview = document.getElementById(`original-${item.id}`);
                const processedPreview = document.getElementById(`processed-${item.id}`);
                if (originalPreview) originalPreview.src = img.src;

                item.status = 'processing';
                renderImageCardStatus(item);

                const processed = await processImageWithBestPath(item.file, img);
                if (batchId !== activeBatchId) return;

                item.processedMeta = processed.meta;
                item.processedBlob = processed.blob;
                item.processedUrl = URL.createObjectURL(processed.blob);
                if (processedPreview) processedPreview.src = item.processedUrl;

                item.status = 'completed';
                processedCount++;
                renderImageCardStatus(item);
                updateProgress();

                const itemCopyBtn = document.getElementById(`copy-${item.id}`);
                if (itemCopyBtn) {
                    itemCopyBtn.style.display = 'inline-flex';
                    itemCopyBtn.onclick = () => copyImage(item, itemCopyBtn);
                }

                const itemDownloadBtn = document.getElementById(`download-${item.id}`);
                if (itemDownloadBtn) {
                    itemDownloadBtn.style.display = 'inline-flex';
                    itemDownloadBtn.onclick = () => downloadImage(item);
                }
            } catch (error) {
                if (batchId !== activeBatchId) return;
                item.status = 'error';
                renderImageCardStatus(item);
                console.error(error);
            }
        }));
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

async function copyImage(item, targetBtn = copyBtn) {
    if (!navigator.clipboard || !window.ClipboardItem) {
        setStatusMessage(TEXT.unsupported, 'warn');
        return;
    }

    try {
        if (!item.processedBlob) return;
        const data = [new ClipboardItem({ [item.processedBlob.type]: item.processedBlob })];
        await navigator.clipboard.write(data);

        const span = targetBtn.querySelector('span');
        const svg = targetBtn.querySelector('svg');
        const originalSvgPath = svg.innerHTML;

        span.textContent = TEXT.copied;
        svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>';

        setTimeout(() => {
            span.textContent = TEXT.copy;
            svg.innerHTML = originalSvgPath;
        }, 2000);
    } catch (err) {
        console.error('Failed to copy image: ', err);
        setStatusMessage(TEXT.copyFailed, 'warn');
    }
}

function downloadImage(item) {
    const a = document.createElement('a');
    a.href = item.processedUrl;
    a.download = `unwatermarked_${item.name.replace(/\.[^.]+$/, '')}.png`;
    a.click();
}

function setupSlider() {
    const container = document.getElementById('comparisonContainer');
    let isDown = false;

    function move(e) {
        if (!isDown) return;
        const rect = container.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        if (!clientX) return;

        const x = clientX - rect.left;
        const percent = Math.min(Math.max(x / rect.width, 0), 1) * 100;

        processedOverlay.style.width = `${percent}%`;
        sliderHandle.style.left = `${percent}%`;
    }

    container.addEventListener('mousedown', (e) => {
        isDown = true;
        move(e);
    });
    window.addEventListener('mouseup', () => { isDown = false; });
    window.addEventListener('mousemove', move);

    container.addEventListener('touchstart', (e) => {
        isDown = true;
        move(e);
    });
    window.addEventListener('touchend', () => { isDown = false; });
    window.addEventListener('touchmove', move);
}

init();

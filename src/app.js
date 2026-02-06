import { WatermarkEngine } from './core/watermarkEngine.js';
import i18n from './i18n.js';
import { loadImage, checkOriginal, getOriginalStatus, setStatusMessage, showLoading, hideLoading } from './utils.js';
import JSZip from 'jszip';
import mediumZoom from 'medium-zoom';

// global state
let engine = null;
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
const processedSection = document.getElementById('processedSection');
const processedImage = document.getElementById('processedImage');
const originalInfo = document.getElementById('originalInfo');
const processedInfo = document.getElementById('processedInfo');
const downloadBtn = document.getElementById('downloadBtn');
const copyBtn = document.getElementById('copyBtn');
const resetBtn = document.getElementById('resetBtn');

/**
 * initialize the application
 */
async function init() {
    try {
        await i18n.init();
        setupLanguageSwitch();
        showLoading(i18n.t('status.loading'));

        engine = await WatermarkEngine.create();

        hideLoading();
        setupEventListeners();

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
    const btn = document.getElementById('langSwitch');
    btn.textContent = i18n.locale === 'zh-CN' ? 'EN' : '中文';
    btn.addEventListener('click', async () => {
        const newLocale = i18n.locale === 'zh-CN' ? 'en-US' : 'zh-CN';
        await i18n.switchLocale(newLocale);
        btn.textContent = newLocale === 'zh-CN' ? 'EN' : '中文';
        updateDynamicTexts();
    });
}

/**
 * setup event listeners
 */
function setupEventListeners() {
    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        handleFiles(Array.from(e.dataTransfer.files));
    });

    downloadAllBtn.addEventListener('click', downloadAll);
    resetBtn.addEventListener('click', reset);
}

function reset() {
    singlePreview.style.display = 'none';
    multiPreview.style.display = 'none';
    imageQueue = [];
    processedCount = 0;
    fileInput.value = '';
    copyBtn.style.display = 'none';
    downloadBtn.style.display = 'none';
}

function handleFileSelect(e) {
    handleFiles(Array.from(e.target.files));
}

function handleFiles(files) {
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
        originalImg: null,
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

async function processSingle(item) {
    try {
        const img = await loadImage(item.file);
        item.originalImg = img;

        const { is_google, is_original } = await checkOriginal(item.file);
        const status = getOriginalStatus({ is_google, is_original });
        setStatusMessage(status, is_google && is_original ? 'success' : 'warn');

        originalImage.src = img.src;

        const watermarkInfo = engine.getWatermarkInfo(img.width, img.height);
        originalInfo.innerHTML = `
            <p>${i18n.t('info.size')}: ${img.width}×${img.height}</p>
            <p>${i18n.t('info.watermark')}: ${watermarkInfo.size}×${watermarkInfo.size}</p>
            <p>${i18n.t('info.position')}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>
        `;

        const result = await engine.removeWatermarkFromImage(img);
        const blob = await new Promise(resolve => result.toBlob(resolve, 'image/png'));
        item.processedBlob = blob;

        item.processedUrl = URL.createObjectURL(blob);
        processedImage.src = item.processedUrl;
        processedSection.style.display = 'block';
        
        copyBtn.style.display = 'flex';
        copyBtn.onclick = () => copyImage(item);
        
        downloadBtn.style.display = 'flex';
        downloadBtn.onclick = () => downloadImage(item);

        processedInfo.innerHTML = `
            <p>${i18n.t('info.size')}: ${img.width}×${img.height}</p>
            <p>${i18n.t('info.status')}: ${i18n.t('info.removed')}</p>
        `;

        zoom.detach();
        zoom.attach('[data-zoomable]');

        processedSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
                <button id="download-${item.id}" class="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg text-xs md:text-sm hidden">${i18n.t('btn.download')}</button>
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
            updateStatus(item.id, i18n.t('status.processing'));

            try {
                const result = await engine.removeWatermarkFromImage(item.originalImg);
                const blob = await new Promise(resolve => result.toBlob(resolve, 'image/png'));
                item.processedBlob = blob;

                item.processedUrl = URL.createObjectURL(blob);
                document.getElementById(`result-${item.id}`).src = item.processedUrl;

                item.status = 'completed';
                const watermarkInfo = engine.getWatermarkInfo(item.originalImg.width, item.originalImg.height);

                updateStatus(item.id, `<p>${i18n.t('info.size')}: ${item.originalImg.width}×${item.originalImg.height}</p>
            <p>${i18n.t('info.watermark')}: ${watermarkInfo.size}×${watermarkInfo.size}</p>
            <p>${i18n.t('info.position')}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>`, true);

                const copyBtn = document.getElementById(`copy-${item.id}`);
                copyBtn.classList.remove('hidden');
                copyBtn.onclick = () => copyImage(item, copyBtn);

                const downloadBtn = document.getElementById(`download-${item.id}`);
                downloadBtn.classList.remove('hidden');
                downloadBtn.onclick = () => downloadImage(item);

                processedCount++;
                updateProgress();

                checkOriginal(item.originalImg).then(({ is_google, is_original }) => {
                    if (!is_google || !is_original) {
                        const status = getOriginalStatus({ is_google, is_original });
                        const statusEl = document.getElementById(`status-${item.id}`);
                        if (statusEl) statusEl.innerHTML += `<p class="inline-block mt-1 text-xs md:text-sm text-warn">${status}</p>`;
                    }
                }).catch(() => {});
            } catch (error) {
                item.status = 'error';
                updateStatus(item.id, i18n.t('status.failed'));
                console.error(error);
            }
        }));
    }

    if (processedCount > 0) {
        downloadAllBtn.style.display = 'flex';
    }
}

function updateStatus(id, text, isHtml = false) {
    const el = document.getElementById(`status-${id}`);
    if (el) el.innerHTML = isHtml ? text : text.replace(/\n/g, '<br>');
}

function updateProgress() {
    progressText.textContent = `${i18n.t('progress.text')}: ${processedCount}/${imageQueue.length}`;
}

function updateDynamicTexts() {
    if (progressText.textContent) {
        updateProgress();
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

init();

const DEFAULT_VIDEO_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS = 30_000;

function configureVideoPageTimeouts(page) {
    page.setDefaultTimeout(DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS);
}

export {
    DEFAULT_VIDEO_PAGE_SETUP_TIMEOUT_MS,
    DEFAULT_VIDEO_TIMEOUT_MS,
    configureVideoPageTimeouts
};

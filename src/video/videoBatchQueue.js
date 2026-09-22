// Batch queue rules for the video page.
//
// Video decode/encode is CPU/GPU bound, so queued items run sequentially
// through the existing single-file pipeline instead of in parallel. The queue
// holds no DOM references so these rules stay unit-testable.

export function createBatchQueue() {
    return { items: [], processing: false };
}

// A completed queue must never leak into the next selection. Appending is only
// meaningful while a batch is still running, so an idle queue is dropped here.
export function startBatchSelection(queue) {
    if (!queue.processing) {
        queue.items = [];
    }
    return queue;
}

export function enqueueBatchFiles(queue, files) {
    for (const file of files) {
        queue.items.push({ file, status: 'pending' });
    }
    return queue;
}

export function summarizeBatch(items) {
    return {
        done: items.filter((item) => item.status === 'done').length,
        total: items.length
    };
}

export async function processBatchQueue(queue, {
    processFile,
    downloadResult = () => {},
    onChange = () => {},
    onError = () => {}
} = {}) {
    if (queue.processing) return null;
    queue.processing = true;

    try {
        // Index-based so files appended while a batch runs are still picked up.
        for (let index = 0; index < queue.items.length; index += 1) {
            const item = queue.items[index];
            if (item.status !== 'pending') continue;

            item.status = 'processing';
            onChange(queue);

            try {
                const outcome = await processFile(item.file);
                if (outcome?.skipped) {
                    item.status = 'skipped';
                } else if (outcome?.ok && outcome.href) {
                    item.status = 'done';
                    downloadResult({ href: outcome.href, filename: outcome.filename });
                } else {
                    item.status = 'error';
                }
            } catch (error) {
                // One bad file must not abort the rest of the batch.
                onError(error, item.file);
                item.status = 'error';
            }

            onChange(queue);
        }

        return summarizeBatch(queue.items);
    } finally {
        queue.processing = false;
    }
}

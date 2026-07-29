import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

import { createImageCleanlinessReviewPage } from '../../scripts/create-image-cleanliness-review-page.js';

const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZQAAAAASUVORK5CYII=',
    'base64'
);

test('offline review page persists blind decisions and exports a frozen complete review', async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'gwr-image-review-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    await mkdir(path.join(workspace, 'rows'));
    await mkdir(path.join(workspace, 'outputs'));

    const rows = ['B001', 'B002'].map((blindId, index) => ({
        blindId,
        fileName: `secret-${index + 1}.png`,
        filePath: path.join(workspace, `secret-${index + 1}.png`),
        rowPath: path.join(workspace, 'rows', `${blindId}.png`),
        fullOutputPath: path.join(workspace, 'outputs', `${blindId}.png`),
        metricValues: { residual: 99 - index }
    }));
    for (const row of rows) {
        await writeFile(row.rowPath, ONE_PIXEL_PNG);
        await writeFile(row.fullOutputPath, ONE_PIXEL_PNG);
    }

    const manifestPath = path.join(workspace, 'manifest.json');
    const outputPath = path.join(workspace, 'review.html');
    await writeFile(
        manifestPath,
        JSON.stringify({ schemaVersion: 1, total: rows.length, rows })
    );

    const result = await createImageCleanlinessReviewPage({
        manifestPath,
        outputPath,
        reviewerId: 'reviewer-a'
    });
    assert.equal(result.total, 2);

    const html = await readFile(outputPath, 'utf8');
    assert.equal(html.includes('secret-1.png'), false);
    assert.equal(html.includes('metricValues'), false);

    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(pathToFileURL(outputPath).href);

    await assertPageText(page, '[data-testid="progress"]', '0 / 2');
    await assertPageText(page, '[data-testid="current-id"]', 'B001');
    await page.getByRole('button', { name: '1 干净' }).click();
    await assertPageText(page, '[data-testid="progress"]', '1 / 2');
    await assertPageText(page, '[data-testid="current-id"]', 'B002');

    await page.reload();
    await assertPageText(page, '[data-testid="progress"]', '1 / 2');
    await assertPageText(page, '[data-testid="current-id"]', 'B002');
    await page.getByRole('button', { name: '2 有残影' }).click();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '冻结并导出' }).click();
    const download = await downloadPromise;
    const labelsPath = path.join(workspace, 'labels.json');
    await download.saveAs(labelsPath);
    const labels = JSON.parse(await readFile(labelsPath, 'utf8'));

    assert.equal(labels.reviewerId, 'reviewer-a');
    assert.equal(labels.frozen, true);
    assert.deepEqual(labels.decisions, [
        {
            blindId: 'B001',
            blindAssetPath: 'rows/B001.png',
            outputClean: true,
            contentDamage: false,
            confidence: 0.9,
            notes: ''
        },
        {
            blindId: 'B002',
            blindAssetPath: 'rows/B002.png',
            outputClean: false,
            contentDamage: false,
            confidence: 0.9,
            notes: ''
        }
    ]);
});

async function assertPageText(page, selector, expected) {
    await page.waitForFunction(
        ({ selector: target, expected: text }) =>
            document.querySelector(target)?.textContent?.trim() === text,
        { selector, expected }
    );
}

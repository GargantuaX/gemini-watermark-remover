import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const htmlPath = path.join(repoRoot, 'public', 'index.html');

function getClassListById(html, id) {
  const regex = new RegExp(`<[^>]*id="${id}"[^>]*class="([^"]+)"[^>]*>`, 'i');
  const match = html.match(regex);
  assert.ok(match, `cannot find class for #${id}`);
  return match[1].split(/\s+/).filter(Boolean);
}

test('portrait comparison layout should shrink to image width and align to right-bottom', () => {
  const html = readFileSync(htmlPath, 'utf8');

  const containerClasses = getClassListById(html, 'comparisonContainer');
  assert.ok(containerClasses.includes('w-fit'), '#comparisonContainer should use w-fit');
  assert.ok(containerClasses.includes('max-w-full'), '#comparisonContainer should use max-w-full');

  const originalClasses = getClassListById(html, 'originalImage');
  assert.ok(originalClasses.includes('w-auto'), '#originalImage should use w-auto');
  assert.ok(originalClasses.includes('h-auto'), '#originalImage should use h-auto');
  assert.ok(originalClasses.includes('max-w-full'), '#originalImage should use max-w-full');
  assert.ok(originalClasses.includes('object-right-bottom'), '#originalImage should align right-bottom');
  assert.ok(!originalClasses.includes('w-full'), '#originalImage should not use w-full');

  const processedClasses = getClassListById(html, 'processedImage');
  assert.ok(processedClasses.includes('object-right-bottom'), '#processedImage should align right-bottom');
});

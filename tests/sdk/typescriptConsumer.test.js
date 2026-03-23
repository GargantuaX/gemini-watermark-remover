import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { packProjectTarball, runCommand } from './testUtils.js';

const ROOT_DIR = process.cwd();

test('packed sdk should compile in an isolated TypeScript consumer without DOM libs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-ts-consumer-'));
    const nodeModulesDir = path.join(tempDir, 'node_modules');
    const packageRoot = path.join(nodeModulesDir, 'gemini-watermark-remover');
    const tarballDir = path.join(tempDir, 'packed');
    const tsconfigPath = path.join(tempDir, 'tsconfig.json');
    const consumerEntry = path.join(tempDir, 'consumer.ts');
    const exampleDir = path.join(ROOT_DIR, 'examples', 'sdk-consumer-ts');

    await mkdir(packageRoot, { recursive: true });
    await mkdir(tarballDir, { recursive: true });

    const tarballPath = await packProjectTarball(tarballDir);
    runCommand('tar', ['-xf', tarballPath, '-C', packageRoot, '--strip-components=1']);

    const exampleTsconfig = JSON.parse(await readFile(path.join(exampleDir, 'tsconfig.json'), 'utf8'));
    exampleTsconfig.compilerOptions.typeRoots = [path.join(ROOT_DIR, 'node_modules', '@types')];
    await writeFile(tsconfigPath, JSON.stringify(exampleTsconfig, null, 2), 'utf8');

    await writeFile(consumerEntry, await readFile(path.join(exampleDir, 'consumer.ts'), 'utf8'), 'utf8');

    const examplePackageJson = JSON.parse(await readFile(path.join(exampleDir, 'package.json'), 'utf8'));
    await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({
        ...examplePackageJson,
        dependencies: {
            ...examplePackageJson.dependencies,
            'gemini-watermark-remover': 'file:./node_modules/gemini-watermark-remover'
        }
    }, null, 2), 'utf8');

    runCommand('pnpm', ['exec', 'tsc', '--project', tsconfigPath, '--pretty', 'false'], ROOT_DIR);
});

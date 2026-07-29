import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-root');
if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(3);
const outputRoot = path.resolve(args[outputIndex + 1]);
mkdirSync(outputRoot, { recursive: true });
writeFileSync(
    path.join(outputRoot, 'received.json'),
    `${JSON.stringify({
        args,
        proxyEnvironment: {
            HTTP_PROXY: process.env.HTTP_PROXY ?? null,
            HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
            ALL_PROXY: process.env.ALL_PROXY ?? null,
            http_proxy: process.env.http_proxy ?? null,
            https_proxy: process.env.https_proxy ?? null,
            all_proxy: process.env.all_proxy ?? null,
            NO_PROXY: process.env.NO_PROXY ?? null,
            no_proxy: process.env.no_proxy ?? null
        }
    }, null, 2)}\n`
);

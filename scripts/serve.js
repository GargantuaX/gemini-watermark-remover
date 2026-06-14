import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const findPort = (start) => new Promise((res, rej) => {
  const tryPort = (port) => {
    const probe = createNetServer();
    probe.once('error', (e) => { probe.close(); e.code === 'EADDRINUSE' ? tryPort(port + 1) : rej(e); });
    probe.once('listening', () => probe.close(() => res(port)));
    probe.listen(port);
  };
  tryPort(start);
});

const distRoot = resolve('dist');
const port = await findPort(Number(process.env.PORT || 4173));

const server = createServer((req, res) => {
  let urlPath = '/';
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  const requestPath = urlPath === '/' ? '/index.html' : urlPath;
  const fsPath = resolve(join(distRoot, normalize(requestPath)));

  if (!fsPath.startsWith(distRoot)) { res.writeHead(403); res.end('Forbidden'); return; }

  const targetExists = existsSync(fsPath);
  const target = (!targetExists && extname(requestPath) === '') ? resolve(join(distRoot, 'index.html')) : fsPath;

  if (!existsSync(target)) { res.writeHead(404); res.end('Not Found'); return; }
  if (statSync(target).isDirectory()) { res.writeHead(403); res.end('Forbidden'); return; }

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(target).pipe(res);
});

server.listen(port, () => console.log(`\n  Serving dist/ at http://localhost:${port}\n`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

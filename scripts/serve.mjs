import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = path === '/' ? '/index.html' : path;
    if (target !== '/index.html' && !/^\/(assets|data)\//.test(target)) { response.writeHead(404).end('Not found'); return; }
    const file = await realpath(resolve(root, `.${target}`));
    const allowed = file === resolve(root, 'index.html') || ['assets', 'data'].some((directory) => file.startsWith(`${resolve(root, directory)}${sep}`));
    if (!allowed || !(await stat(file)).isFile()) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, host, () => console.log(`Automit siap di http://${host}:${port}\nDemo berhasil: http://${host}:${port}/?demo=success\nDemo gagal: http://${host}:${port}/?demo=error`));

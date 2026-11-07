import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = '127.0.0.1';
const port = Number.parseInt(process.env.CLUE_CONSOLE_DEMO_PORT ?? '47834', 10);

function type(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wgsl': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end('Read-only demo.');
    return;
  }
  const relative = url.pathname === '/' ? 'demo/index.html' : url.pathname.replace(/^\//, '');
  let candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    response.writeHead(403);
    response.end('Path not allowed.');
    return;
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) candidate = resolve(candidate, 'index.html');
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    response.writeHead(404);
    response.end('Not found.');
    return;
  }
  response.writeHead(200, { 'content-type': type(candidate), 'cache-control': 'no-store' });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(candidate);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
});

server.listen(port, host, () => {
  console.log(`CLU-E Operational Console demo\n  http://${host}:${port}/?sample=1`);
});

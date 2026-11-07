import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const port = 47835;
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wgsl', 'text/plain; charset=utf-8'],
]);
createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
  let candidate = resolve(sourceRoot, `.${pathname === '/' ? '/demo/index.html' : pathname}`);
  if (!candidate.startsWith(sourceRoot) || !existsSync(candidate)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  if (statSync(candidate).isDirectory()) candidate = resolve(candidate, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(candidate)) ?? 'application/octet-stream' });
  createReadStream(candidate).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log('CLU-E Great Book Improvement Field');
  console.log(`  demo http://127.0.0.1:${port}/`);
});

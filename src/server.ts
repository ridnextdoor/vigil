import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Engine } from './engine.js';

const INDEX = path.resolve('public/index.html');

export function startServer(engine: Engine, port: number) {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX));
    } else if (req.method === 'GET' && url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(engine.state()));
    } else if (req.method === 'POST' && url === '/api/pause') {
      // The custom header blocks other websites from firing this request from your browser.
      if (req.headers['x-dashboard'] !== '1') {
        res.writeHead(403).end();
        return;
      }
      engine.paused = !engine.paused;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ paused: engine.paused }));
    } else {
      res.writeHead(404).end('Not found');
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`[dashboard] http://127.0.0.1:${port}`));
}

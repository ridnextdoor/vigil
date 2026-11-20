import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { TradeStore } from './tracker.js';
import { buildState } from './tracker-state.js';
import { importCsvFile } from './tracker-import.js';
import { LiveTracker } from './tracker-live.js';

const DEFAULT_WALLET = 'STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk';
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const wallet = arg('--wallet') ?? process.env.TRACK_WALLET ?? DEFAULT_WALLET;
try {
  new PublicKey(wallet);
} catch {
  console.error(`"${wallet}" is not a valid Solana address.`);
  process.exit(1);
}

const store = new TradeStore();
store.load();

const importFile = arg('--import');
if (importFile) {
  try {
    const r = importCsvFile(importFile, store);
    console.log(`[import] ${r.added} trades added, ${r.duplicates} already known, ${r.ignored} rows skipped (not pump.fun swaps)`);
  } catch (e) {
    console.error('[import] failed:', (e as Error).message);
    process.exit(1);
  }
}

const live = config.rpcWsUrl
  ? new LiveTracker(config.rpcWsUrl, wallet, store, config.solUsd, Number(process.env.BACKFILL ?? 50))
  : null;

const state = () =>
  buildState(store, wallet, {
    live: live ? { connected: live.connected, lastEventAgoMs: live.lastEventTs ? Date.now() - live.lastEventTs : null } : null,
    balanceSol: live?.balanceSol ?? null,
    solUsd: config.solUsd,
  });

const INDEX = path.resolve('public/tracker.html');
http
  .createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX));
    } else if (req.method === 'GET' && url === '/api/tracker') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state()));
    } else {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(config.port, '127.0.0.1', () => console.log(`[dashboard] http://127.0.0.1:${config.port}`));

if (live) live.start();
else console.log('[track] no RPC_WS_URL set: showing saved/imported history only (no live following).');
console.log(`[track] wallet ${wallet}. Read-only: nothing here can send transactions.`);

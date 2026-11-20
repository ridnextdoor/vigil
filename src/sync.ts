import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { TradeStore } from './tracker.js';
import { httpFromWs, LiveTracker } from './tracker-live.js';

/**
 * One-shot sync for scheduled runs (GitHub Actions). Fetches new transactions for the wallet since the
 * last run, adds their pump.fun trades to data/wallet-trades.jsonl, and remembers where it stopped.
 */
const DEFAULT_WALLET = 'STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk';
const wallet = process.env.TRACK_WALLET || DEFAULT_WALLET;
const url = process.env.RPC_HTTP_URL || (config.rpcWsUrl ? httpFromWs(config.rpcWsUrl) : '');
if (!url) {
  console.error('Set RPC_HTTP_URL (or RPC_WS_URL) to a Solana RPC URL.');
  process.exit(1);
}

const stateFile = path.resolve('data', 'sync-state.json');
let lastSig: string | undefined;
try {
  lastSig = JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSig ?? undefined;
} catch {
  /* first run */
}

const store = new TradeStore();
store.load();
const before = store.trades.length;
const tracker = new LiveTracker(url, wallet, store, config.solUsd, 0);

try {
  // First run looks back as far as one request allows; later runs fetch only what is new.
  const r = await tracker.syncOnce(1000, lastSig);
  fs.writeFileSync(stateFile, JSON.stringify({ lastSig: r.resumeFrom, updatedAt: Date.now() }));
  const added = store.trades.length - before;
  // Keep the saved history bounded so the data file stays small. Change with KEEP_DAYS.
  const keepDays = Number(process.env.KEEP_DAYS) > 0 ? Number(process.env.KEEP_DAYS) : 14;
  const removed = store.prune(Date.now() - keepDays * 86_400_000);
  console.log(`[sync] ${r.seen} new transactions checked, ${added} new memecoin trades saved, ${removed} older than ${keepDays} days removed`);
} catch (e) {
  // Never print the URL: it contains the API key.
  console.error('[sync] failed:', (e as Error).message);
  process.exit(1);
}

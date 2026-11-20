import fs from 'node:fs';
import path from 'node:path';

export interface WalletTrade {
  sig: string;
  ts: number; // ms
  mint: string;
  side: 'buy' | 'sell';
  tokens: number; // UI amount of the memecoin
  usd: number | null; // estimated value of the trade in USD
  mcUsd: number | null; // market cap implied by this trade's own price (pump.fun supply is 1B)
  liqUsd?: number | null; // real SOL in the curve at the time (live mode only)
  ageSec?: number | null; // token age at the time of the trade, when known
  source: 'live' | 'csv';
}

const DEFAULT_FILE = path.resolve('data', 'wallet-trades.jsonl');
const PUMP_SUPPLY = 1_000_000_000;

/** Market cap implied by a trade: price per token times the 1B supply. */
export const impliedMc = (usd: number | null, tokens: number) =>
  usd !== null && tokens > 0 ? (usd / tokens) * PUMP_SUPPLY : null;

export class TradeStore {
  trades: WalletTrade[] = [];
  private keys = new Set<string>();
  private sigs = new Set<string>();

  constructor(private file: string = DEFAULT_FILE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        this.insert(JSON.parse(line));
      } catch {
        /* skip a damaged line */
      }
    }
  }

  hasSig(sig: string) {
    return this.sigs.has(sig);
  }

  private insert(t: WalletTrade) {
    const key = `${t.sig}:${t.mint}:${t.side}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.sigs.add(t.sig);
    this.trades.push(t);
    return true;
  }

  /** Add a trade if it is new. Returns true when it was added. */
  add(t: WalletTrade) {
    if (!this.insert(t)) return false;
    fs.appendFileSync(this.file, JSON.stringify(t) + '\n');
    return true;
  }
}

// ---------- round trips ----------

export interface RoundTrip {
  mint: string;
  buys: number;
  sells: number;
  tokensBought: number;
  tokensSold: number;
  costUsd: number | null;
  proceedsUsd: number | null;
  firstBuyTs: number;
  lastTradeTs: number;
  holdSec: number | null;
  entryMcUsd: number | null;
  entryAgeSec: number | null;
  status: 'closed' | 'open' | 'partial-history';
  pnlUsd: number | null;
  pnlPct: number | null;
}

export function roundTrips(trades: WalletTrade[]): RoundTrip[] {
  const byMint = new Map<string, WalletTrade[]>();
  for (const t of trades) {
    if (!byMint.has(t.mint)) byMint.set(t.mint, []);
    byMint.get(t.mint)!.push(t);
  }
  const out: RoundTrip[] = [];
  for (const [mint, list] of byMint) {
    list.sort((a, b) => a.ts - b.ts);
    const buys = list.filter((t) => t.side === 'buy');
    const sells = list.filter((t) => t.side === 'sell');
    const sum = (xs: WalletTrade[]) => (xs.every((x) => x.usd !== null) ? xs.reduce((a, x) => a + (x.usd as number), 0) : null);
    const tokensBought = buys.reduce((a, t) => a + t.tokens, 0);
    const tokensSold = sells.reduce((a, t) => a + t.tokens, 0);
    const costUsd = buys.length ? sum(buys) : null;
    const proceedsUsd = sells.length ? sum(sells) : null;

    let status: RoundTrip['status'];
    if (!buys.length || tokensSold > tokensBought * 1.05) status = 'partial-history'; // bought before our data starts
    else if (sells.length && tokensSold >= tokensBought * 0.98) status = 'closed';
    else status = 'open';

    const pnlUsd = status === 'closed' && costUsd !== null && proceedsUsd !== null ? proceedsUsd - costUsd : null;
    const firstBuy = buys[0];
    const lastSell = sells.at(-1);
    out.push({
      mint,
      buys: buys.length,
      sells: sells.length,
      tokensBought,
      tokensSold,
      costUsd,
      proceedsUsd,
      firstBuyTs: firstBuy?.ts ?? list[0].ts,
      lastTradeTs: list.at(-1)!.ts,
      holdSec: status === 'closed' && firstBuy && lastSell ? (lastSell.ts - firstBuy.ts) / 1000 : null,
      entryMcUsd: firstBuy?.mcUsd ?? null,
      entryAgeSec: firstBuy?.ageSec ?? null,
      status,
      pnlUsd,
      pnlPct: pnlUsd !== null && costUsd ? (pnlUsd / costUsd) * 100 : null,
    });
  }
  return out;
}

// ---------- patterns ----------

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function buckets(values: number[], edges: number[], labels: string[]) {
  const counts = labels.map(() => 0);
  for (const v of values) {
    let i = edges.findIndex((e) => v < e);
    if (i === -1) i = labels.length - 1;
    counts[i]++;
  }
  return labels.map((label, i) => ({ label, count: counts[i] }));
}

export function patterns(trades: WalletTrade[], trips: RoundTrip[]) {
  const closed = trips.filter((t) => t.status === 'closed' && t.pnlUsd !== null);
  const wins = closed.filter((t) => (t.pnlUsd as number) > 0);
  const losses = closed.filter((t) => (t.pnlUsd as number) <= 0);
  const buyUsd = trades.filter((t) => t.side === 'buy' && t.usd !== null).map((t) => t.usd as number);
  const spanHours = trades.length > 1 ? (Math.max(...trades.map((t) => t.ts)) - Math.min(...trades.map((t) => t.ts))) / 3_600_000 : 0;
  const entryMcs = trips.map((t) => t.entryMcUsd).filter((x): x is number => x !== null);
  const holds = closed.map((t) => t.holdSec).filter((x): x is number => x !== null);
  const ages = trips.map((t) => t.entryAgeSec).filter((x): x is number => x !== null);

  // trades per 10-minute bucket, last 12 buckets ending at the newest trade
  const end = trades.length ? Math.max(...trades.map((t) => t.ts)) : 0;
  const BUCKET = 600_000;
  const activity = Array.from({ length: 12 }, (_, i) => {
    const hi = end - (11 - i) * BUCKET;
    return { ts: hi, count: trades.filter((t) => t.ts > hi - BUCKET && t.ts <= hi).length };
  });

  return {
    closedTrips: closed.length,
    wins: wins.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    avgWinPct: avg(wins.map((t) => t.pnlPct as number)),
    avgLossPct: avg(losses.map((t) => t.pnlPct as number)),
    netPnlUsd: closed.reduce((a, t) => a + (t.pnlUsd as number), 0),
    medianHoldSec: median(holds),
    avgBuyUsd: avg(buyUsd),
    medianBuyUsd: median(buyUsd),
    scaleInPct: trips.length ? (trips.filter((t) => t.buys >= 2).length / trips.length) * 100 : null,
    medianEntryMcUsd: median(entryMcs),
    buysPerHour: spanHours > 0 ? trades.filter((t) => t.side === 'buy').length / spanHours : null,
    holdBuckets: buckets(holds, [10, 30, 60, 180], ['under 10 s', '10-30 s', '30-60 s', '1-3 min', 'over 3 min']),
    entryMcBuckets: buckets(entryMcs, [5000, 10000, 20000], ['under 5K', '5K-10K', '10K-20K', 'over 20K']),
    entryAgeBuckets: ages.length
      ? buckets(ages, [30, 120, 600], ['under 30 s', '30 s-2 min', '2-10 min', 'over 10 min'])
      : [],
    ageKnown: ages.length,
    activity,
  };
}

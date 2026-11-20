import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import { decodeCurve, liquidityUsd } from './curve.js';
import { bondingCurveFor } from './feed-live.js';
import { impliedMc, type TradeStore, type WalletTrade } from './tracker.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

export const httpFromWs = (ws: string) => ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

/**
 * Turn one parsed transaction into memecoin buys and sells for `wallet`.
 * Method: the wallet's token balance change for each pump.fun mint says what it bought or sold;
 * the value is the opposite change in its SOL, wrapped SOL and stablecoins. Routing through
 * other tokens in between does not matter, because only the net change is used.
 * The USD value is an estimate and includes network fees and tips.
 */
export function parseWalletTrades(tx: any, wallet: string, solUsd: number): WalletTrade[] {
  const meta = tx?.meta;
  if (!meta || meta.err) return [];
  const sig: string = tx.transaction?.signatures?.[0] ?? '';
  const ts = (tx.blockTime ?? Date.now() / 1000) * 1000;

  const deltas = new Map<string, number>();
  const add = (list: any[] | undefined, sign: number) => {
    for (const b of list ?? []) {
      if (b.owner !== wallet) continue;
      const v = Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0);
      deltas.set(b.mint, (deltas.get(b.mint) ?? 0) + sign * v);
    }
  };
  add(meta.postTokenBalances, 1);
  add(meta.preTokenBalances, -1);

  const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(wallet);
  const nativeSol = i >= 0 ? (meta.postBalances[i] - meta.preBalances[i]) / 1e9 : 0;
  let stable = 0;
  for (const [m, d] of deltas) if (STABLES.has(m)) stable += d;
  const value = (nativeSol + (deltas.get(WSOL) ?? 0)) * solUsd + stable; // + = wallet received value

  const moved = [...deltas].filter(([m, d]) => m.endsWith('pump') && Math.abs(d) > 1e-9);
  return moved.map(([mint, d]) => {
    const usd = Math.abs(value) / moved.length;
    const tokens = Math.abs(d);
    return { sig, ts, mint, side: d > 0 ? ('buy' as const) : ('sell' as const), tokens, usd, mcUsd: impliedMc(usd, tokens), source: 'live' as const };
  });
}

export class LiveTracker {
  connected = false;
  lastEventTs = 0;
  balanceSol: number | null = null;
  private ws: WebSocket | null = null;
  private retry = 1000;
  private stopped = false;
  private http: string;
  private queue: Promise<void> = Promise.resolve();
  private born = new Map<string, number | null>(); // token creation time (seconds), cached per mint

  constructor(private wsUrl: string, private wallet: string, private store: TradeStore, private solUsd: number, private backfill: number) {
    this.http = httpFromWs(wsUrl);
    new PublicKey(wallet); // throws on a malformed address
  }

  private async rpc(method: string, params: unknown[]) {
    const res = await fetch(this.http, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j: any = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }

  start() {
    this.connect();
    void this.runBackfill();
    void this.pollBalance();
    setInterval(() => void this.pollBalance(), 30_000);
  }

  private async pollBalance() {
    try {
      const r = await this.rpc('getBalance', [this.wallet, { commitment: 'confirmed' }]);
      this.balanceSol = r.value / 1e9;
    } catch (e) {
      console.log('[track] balance:', (e as Error).message);
    }
  }

  private async runBackfill() {
    if (this.backfill <= 0) return;
    try {
      const sigs: any[] = await this.rpc('getSignaturesForAddress', [this.wallet, { limit: this.backfill }]);
      console.log(`[track] backfilling ${sigs.length} recent transactions...`);
      for (const s of sigs.reverse()) {
        if (!s.err) await this.enqueue(s.signature);
        await new Promise((r) => setTimeout(r, 150)); // stay under free-tier rate limits
      }
      console.log('[track] backfill done');
    } catch (e) {
      console.log('[track] backfill failed:', (e as Error).message);
    }
  }

  /**
   * One-shot catch-up for scheduled runs. Fetches signatures newer than `until`, handles them oldest
   * first, and returns the signature to resume from next time. If a call fails (for example a rate
   * limit), it stops there and resumes from the last transaction that was handled.
   */
  async syncOnce(limit: number, until?: string): Promise<{ resumeFrom: string | null; seen: number }> {
    const params: Record<string, unknown> = { limit, commitment: 'confirmed' };
    if (until) params.until = until;
    const sigs: any[] = await this.rpc('getSignaturesForAddress', [this.wallet, params]);
    sigs.reverse(); // oldest first
    let resumeFrom = until ?? null;
    for (const s of sigs) {
      if (!s.err) {
        try {
          await this.processSignature(s.signature);
        } catch (e) {
          console.log('[sync] stopped early:', (e as Error).message);
          break;
        }
        await new Promise((r) => setTimeout(r, 150)); // stay under free-tier rate limits
      }
      resumeFrom = s.signature;
    }
    return { resumeFrom, seen: sigs.length };
  }

  private enqueue(sig: string) {
    this.queue = this.queue.then(() => this.processSignature(sig)).catch((e) => console.log('[track] tx error:', (e as Error).message));
    return this.queue;
  }

  private async processSignature(sig: string) {
    if (this.store.hasSig(sig)) return;
    let tx: any = null;
    for (let attempt = 0; attempt < 6 && !tx; attempt++) {
      tx = await this.rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (!tx) await new Promise((r) => setTimeout(r, 500));
    }
    if (!tx) return;
    const trades = parseWalletTrades(tx, this.wallet, this.solUsd);
    for (const t of trades) {
      await this.enrich(t);
      if (this.store.add(t)) console.log(`[track] ${t.side.toUpperCase()} ${t.mint.slice(0, 6)}... $${t.usd?.toFixed(0)} at ${t.mcUsd ? (t.mcUsd / 1000).toFixed(1) + 'K' : '?'} MC`);
    }
  }

  /** Token age (first transaction on its bonding curve) and current liquidity. Best effort. */
  private async enrich(t: WalletTrade) {
    try {
      const curve = bondingCurveFor(new PublicKey(t.mint));
      if (!this.born.has(t.mint)) {
        const sigs: any[] = await this.rpc('getSignaturesForAddress', [curve.toBase58(), { limit: 1000 }]);
        this.born.set(t.mint, sigs.length && sigs.length < 1000 ? (sigs[sigs.length - 1].blockTime ?? null) : null);
      }
      const born = this.born.get(t.mint);
      if (born) t.ageSec = Math.max(0, t.ts / 1000 - born);
      if (Date.now() - t.ts < 60_000) {
        const acc = await this.rpc('getAccountInfo', [curve.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
        const data = acc?.value?.data?.[0];
        const state = data ? decodeCurve(Buffer.from(data, 'base64')) : null;
        if (state) t.liqUsd = liquidityUsd(state, this.solUsd);
      }
    } catch {
      /* enrichment is optional */
    }
  }

  private connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.retry = 1000;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [this.wallet] }, { commitment: 'confirmed' }] }));
      console.log('[track] connected, following wallet', this.wallet);
    });
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method !== 'logsNotification') return;
      const v = msg.params?.result?.value;
      if (!v || v.err || !v.signature) return;
      this.lastEventTs = Date.now();
      void this.enqueue(v.signature);
    });
    ws.on('close', () => {
      this.connected = false;
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 15000);
    });
    ws.on('error', (e) => console.log('[track] ws error:', e.message));
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}

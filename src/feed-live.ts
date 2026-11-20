import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import { decodeCurve } from './curve.js';
import type { Feed } from './types.js';

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export const bondingCurveFor = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM)[0];

export interface CreateInfo {
  name: string;
  symbol: string;
  mint: string;
  curve: string;
}

/**
 * Read the "create" event that pump.fun writes to the transaction logs, so a launch is
 * detected from the log stream alone, with no extra RPC call. Layout: 8-byte event tag,
 * three length-prefixed strings (name, symbol, uri), then mint, bonding curve and creator.
 * The result is only accepted if the bonding curve matches the address derived from the mint.
 */
export function parseCreateEvent(data: Buffer): CreateInfo | null {
  try {
    let off = 8;
    const strings: string[] = [];
    for (let i = 0; i < 3; i++) {
      const len = data.readUInt32LE(off);
      off += 4;
      if (len > 300 || off + len > data.length) return null;
      strings.push(data.subarray(off, off + len).toString('utf8'));
      off += len;
    }
    if (off + 64 > data.length) return null;
    const mint = new PublicKey(data.subarray(off, off + 32));
    const curve = new PublicKey(data.subarray(off + 32, off + 64));
    if (!bondingCurveFor(mint).equals(curve)) return null;
    return { name: strings[0], symbol: strings[1], mint: mint.toBase58(), curve: curve.toBase58() };
  } catch {
    return null;
  }
}

type Pending = { kind: 'logs' } | { kind: 'account'; mint: string };

export class LiveFeed extends EventEmitter implements Feed {
  connected = false;
  lastEventTs = 0;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subToMint = new Map<number, string>();
  private mintToSub = new Map<string, number>();
  private retry = 1000;
  private stopped = false;

  constructor(private url: string) {
    super();
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  private send(method: string, params: unknown[], tag: Pending) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const id = this.nextId++;
    this.pending.set(id, tag);
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.retry = 1000;
      this.send('logsSubscribe', [{ mentions: [PUMP_PROGRAM.toBase58()] }, { commitment: 'processed' }], { kind: 'logs' });
      console.log('[feed] connected, watching pump.fun launches');
    });
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('close', () => {
      this.connected = false;
      this.pending.clear();
      this.subToMint.clear();
      this.mintToSub.clear();
      if (this.stopped) return;
      console.log(`[feed] disconnected, retrying in ${this.retry} ms`);
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 15000);
    });
    ws.on('error', (e) => console.log('[feed] error:', e.message));
  }

  untrack(mint: string) {
    const sub = this.mintToSub.get(mint);
    if (sub === undefined) return;
    this.mintToSub.delete(mint);
    this.subToMint.delete(sub);
    this.send('accountUnsubscribe', [sub], { kind: 'logs' });
  }

  private onMessage(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    // Reply to one of our subscribe requests.
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (p.kind === 'account' && typeof msg.result === 'number') {
        this.subToMint.set(msg.result, p.mint);
        this.mintToSub.set(p.mint, msg.result);
      }
      return;
    }
    const ts = Date.now();
    if (msg.method === 'logsNotification') {
      const v = msg.params?.result?.value;
      if (!v || v.err || !Array.isArray(v.logs)) return;
      this.lastEventTs = ts;
      if (!v.logs.some((l: string) => l.includes('Instruction: Create'))) return;
      for (const l of v.logs as string[]) {
        if (!l.startsWith('Program data: ')) continue;
        const info = parseCreateEvent(Buffer.from(l.slice(14), 'base64'));
        if (!info) continue;
        this.send('accountSubscribe', [info.curve, { commitment: 'processed', encoding: 'base64' }], { kind: 'account', mint: info.mint });
        this.emit('launch', { mint: info.mint, curve: info.curve, name: info.name, symbol: info.symbol, ts });
        break;
      }
    } else if (msg.method === 'accountNotification') {
      const mint = this.subToMint.get(msg.params?.subscription);
      const b64 = msg.params?.result?.value?.data?.[0];
      if (!mint || typeof b64 !== 'string') return;
      const state = decodeCurve(Buffer.from(b64, 'base64'));
      if (!state) return;
      this.lastEventTs = ts;
      this.emit('curve', { mint, state, ts });
    }
  }
}

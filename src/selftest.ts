import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { INITIAL_CURVE, buyOnCurve, decodeCurve, mcUsd, sellOnCurve, lamports } from './curve.js';
import { bondingCurveFor, parseCreateEvent } from './feed-live.js';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('ok  ', name);
};

test('fresh curve market cap is about 28 SOL', () => {
  const sol = mcUsd(INITIAL_CURVE, 1);
  assert.ok(sol > 27.9 && sol < 28.1, String(sol));
});

test('buy then sell loses roughly the price impact (never gains)', () => {
  const b = buyOnCurve(INITIAL_CURVE, lamports(1));
  const s = sellOnCurve(b.next, b.tokens);
  assert.ok(s.sol <= lamports(1));
  assert.ok(s.sol > lamports(0.99));
});

test('a bigger buy moves the price more', () => {
  const small = buyOnCurve(INITIAL_CURVE, lamports(0.1)).next;
  const big = buyOnCurve(INITIAL_CURVE, lamports(5)).next;
  assert.ok(mcUsd(big, 1) > mcUsd(small, 1));
});

test('cannot sell out more SOL than the curve really holds', () => {
  const b = buyOnCurve(INITIAL_CURVE, lamports(0.5));
  const s = sellOnCurve(b.next, b.tokens * 50n);
  assert.ok(s.sol <= b.next.rSol);
});

test('decodeCurve reads the account layout', () => {
  const buf = Buffer.alloc(49);
  buf.writeBigUInt64LE(111n, 8);
  buf.writeBigUInt64LE(222n, 16);
  buf.writeBigUInt64LE(333n, 24);
  buf.writeBigUInt64LE(444n, 32);
  buf.writeBigUInt64LE(555n, 40);
  buf[48] = 1;
  const s = decodeCurve(buf)!;
  assert.deepEqual([s.vToken, s.vSol, s.rToken, s.rSol, s.supply, s.complete], [111n, 222n, 333n, 444n, 555n, true]);
});

function createEvent(name: string, symbol: string, mint: Keypair['publicKey'], curve: Keypair['publicKey']) {
  const str = (s: string) => {
    const b = Buffer.from(s);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([Buffer.alloc(8, 7), str(name), str(symbol), str('https://example.com/x.json'), mint.toBuffer(), curve.toBuffer(), Keypair.generate().publicKey.toBuffer()]);
}

test('parseCreateEvent accepts a well-formed create event', () => {
  const mint = Keypair.generate().publicKey;
  const info = parseCreateEvent(createEvent('Test Coin', 'TST', mint, bondingCurveFor(mint)));
  assert.ok(info);
  assert.equal(info!.symbol, 'TST');
  assert.equal(info!.mint, mint.toBase58());
});

test('parseCreateEvent rejects a bonding curve that does not match the mint', () => {
  const mint = Keypair.generate().publicKey;
  const wrong = Keypair.generate().publicKey;
  assert.equal(parseCreateEvent(createEvent('X', 'X', mint, wrong)), null);
});

test('parseCreateEvent rejects garbage', () => {
  assert.equal(parseCreateEvent(Buffer.from('hello world')), null);
  assert.equal(parseCreateEvent(Buffer.alloc(200, 255)), null);
});

console.log(`\n${passed} tests passed`);

// ---------- wallet tracker ----------
import os from 'node:os';
import path from 'node:path';
import { TradeStore, roundTrips, patterns } from './tracker.js';
import { importCsvText } from './tracker-import.js';
import { parseWalletTrades } from './tracker-live.js';

const tmpStore = () => new TradeStore(path.join(os.tmpdir(), `vigil-test-${Date.now()}-${Math.random()}.jsonl`));

test('parseWalletTrades reads a buy and a sell from balance changes', () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58().slice(0, -4) + 'pump';
  const mk = (preTok: number, postTok: number, preLam: number, postLam: number) => ({
    blockTime: 1_700_000_000,
    transaction: { signatures: ['SIG1'], message: { accountKeys: [{ pubkey: wallet }, { pubkey: 'x' }] } },
    meta: {
      err: null,
      preBalances: [preLam, 0], postBalances: [postLam, 0],
      preTokenBalances: [{ owner: wallet, mint, uiTokenAmount: { uiAmountString: String(preTok) } }],
      postTokenBalances: [{ owner: wallet, mint, uiTokenAmount: { uiAmountString: String(postTok) } }],
    },
  });
  const buy = parseWalletTrades(mk(0, 10_000_000, 2_000_000_000, 1_000_000_000), wallet, 100);
  assert.equal(buy.length, 1);
  assert.equal(buy[0].side, 'buy');
  assert.ok(Math.abs((buy[0].usd as number) - 100) < 1e-6); // 1 SOL at $100
  assert.ok(Math.abs((buy[0].mcUsd as number) - 10_000) < 1e-3); // $100 / 10M tokens * 1B
  const sell = parseWalletTrades(mk(10_000_000, 0, 1_000_000_000, 1_500_000_000), wallet, 100);
  assert.equal(sell[0].side, 'sell');
  assert.ok(Math.abs((sell[0].usd as number) - 50) < 1e-6);
  assert.deepEqual(parseWalletTrades({ meta: { err: { x: 1 } } }, wallet, 100), []);
});

test('CSV import, round trips and patterns', () => {
  const csv = [
    'Signature,Block Time,Human Time,Action,From,Token1,Amount1,TokenDecimals1,Token2,Amount2,TokenDecimals2,Value,Programs,Token1Multiplier,Token2Multiplier',
    'S1,1700000000,x,ACTIVITY_TOKEN_SWAP,W,SOL,1,9,AAApump,10000000,6,80,p,1,1',
    'S2,1700000010,x,ACTIVITY_TOKEN_SWAP,W,AAApump,10000000,6,SOL,1,9,100,p,1,1',
    'S3,1700000020,x,ACTIVITY_TOKEN_SWAP,W,SOL,1,9,BBBpump,10000000,6,80,p,1,1',
    'S4,1700000050,x,ACTIVITY_TOKEN_SWAP,W,BBBpump,10000000,6,SOL,1,9,60,p,1,1',
    'S5,1700000060,x,ACTIVITY_TOKEN_SWAP,W,SOL,1,9,USDC,10,6,80,p,1,1',
  ].join('\n');
  const store = tmpStore();
  const r = importCsvText(csv, store);
  assert.deepEqual(r, { added: 4, duplicates: 0, ignored: 1 });
  assert.deepEqual(importCsvText(csv, store), { added: 0, duplicates: 4, ignored: 1 });
  const trips = roundTrips(store.trades);
  assert.equal(trips.length, 2);
  const a = trips.find((t) => t.mint === 'AAApump')!;
  assert.equal(a.status, 'closed');
  assert.equal(a.pnlUsd, 20);
  assert.equal(a.holdSec, 10);
  const p = patterns(store.trades, trips);
  assert.equal(p.closedTrips, 2);
  assert.equal(p.wins, 1);
  assert.equal(p.winRatePct, 50);
  assert.equal(p.netPnlUsd, 0); // +20 and -20
});

test('a token sold with no earlier buy is marked partial history, not counted in PnL', () => {
  const store = tmpStore();
  importCsvText(['Signature,Block Time,Token1,Amount1,TokenDecimals1,Token2,Amount2,TokenDecimals2,Value', 'S1,1700000000,CCCpump,5000000,6,SOL,1,9,50'].join('\n'), store);
  const trips = roundTrips(store.trades);
  assert.equal(trips[0].status, 'partial-history');
  assert.equal(trips[0].pnlUsd, null);
});



// ---------- scheduled sync against a mock RPC server ----------
import http from 'node:http';
import { LiveTracker } from './tracker-live.js';

const W = Keypair.generate().publicKey.toBase58();
const M1 = Keypair.generate().publicKey.toBase58().slice(0, -4) + 'pump';
const M2 = Keypair.generate().publicKey.toBase58().slice(0, -4) + 'pump';
const fakeTx = (sig: string, mint: string, side: 'buy' | 'sell') => ({
  blockTime: 1_700_000_000 + (sig === 'SIG1' ? 0 : 30),
  transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: W }] } },
  meta: {
    err: null,
    preBalances: [side === 'buy' ? 2_000_000_000 : 1_000_000_000],
    postBalances: [side === 'buy' ? 1_000_000_000 : 1_500_000_000],
    preTokenBalances: side === 'sell' ? [{ owner: W, mint, uiTokenAmount: { uiAmountString: '10000000' } }] : [],
    postTokenBalances: side === 'buy' ? [{ owner: W, mint, uiTokenAmount: { uiAmountString: '10000000' } }] : [],
  },
});
const calls: string[] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { method, params } = JSON.parse(body);
    calls.push(method + (params[1]?.until ? `:until=${params[1].until}` : ''));
    let result: unknown = null;
    if (method === 'getSignaturesForAddress') {
      if (params[0] === W) {
        const all = [{ signature: 'SIG3', err: { bad: 1 } }, { signature: 'SIG2', err: null }, { signature: 'SIG1', err: null }];
        const until = params[1]?.until;
        result = until ? all.slice(0, all.findIndex((x) => x.signature === until)) : all;
      } else result = [{ signature: 'c', blockTime: 1_699_999_990 }]; // token creation, for the age lookup
    } else if (method === 'getTransaction') result = params[0] === 'SIG1' ? fakeTx('SIG1', M1, 'buy') : fakeTx('SIG2', M1, 'sell');
    else if (method === 'getAccountInfo') result = { value: null };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

{
  const store = tmpStore();
  const t = new LiveTracker(`http://127.0.0.1:${port}`, W, store, 100, 0);
  const first = await t.syncOnce(1000);
  assert.equal(store.trades.length, 2, 'buy and sell saved');
  assert.equal(first.resumeFrom, 'SIG3', 'resumes after the newest signature, even a failed transaction');
  assert.ok(store.trades.every((x) => x.ageSec === 10 || x.ageSec === 40), 'token age filled in from the curve history');
  const trips = roundTrips(store.trades);
  assert.equal(trips[0].status, 'closed');
  const second = await t.syncOnce(1000, 'SIG3');
  assert.equal(second.seen, 0, 'nothing new on the next run');
  assert.ok(calls.includes('getSignaturesForAddress:until=SIG3'));
  passed++;
  console.log('ok   syncOnce catches up, resumes from the last signature, and fills in token age');
}
server.close();

console.log(`\n${passed} tests passed (including wallet tracker and sync)`);

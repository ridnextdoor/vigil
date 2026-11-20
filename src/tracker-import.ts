import fs from 'node:fs';
import { impliedMc, type TradeStore, type WalletTrade } from './tracker.js';

/**
 * Import a Solscan "DeFi activities" CSV export. Each row is one swap leg:
 * Token1 is what the wallet gave, Token2 is what it received, Value is the swap's USD value.
 * A pump.fun token on the receiving side is a buy, on the giving side a sell.
 */
export function importCsvText(text: string, store: TradeStore) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines.shift()?.split(',').map((h) => h.trim()) ?? [];
  const col = (name: string) => header.indexOf(name);
  const idx = {
    sig: col('Signature'), time: col('Block Time'),
    t1: col('Token1'), a1: col('Amount1'), d1: col('TokenDecimals1'),
    t2: col('Token2'), a2: col('Amount2'), d2: col('TokenDecimals2'), value: col('Value'),
  };
  if (Object.values(idx).some((i) => i < 0)) throw new Error('This does not look like a Solscan DeFi activities export (missing columns).');

  let added = 0, duplicates = 0, ignored = 0;
  for (const line of lines) {
    const f = line.split(',');
    const ts = Number(f[idx.time]) * 1000;
    const usdRaw = Number(f[idx.value]);
    const usd = Number.isFinite(usdRaw) && f[idx.value] !== '' ? usdRaw : null;
    const make = (mint: string, amount: string, decimals: string, side: 'buy' | 'sell'): WalletTrade => {
      const tokens = Number(amount) / 10 ** Number(decimals);
      return { sig: f[idx.sig], ts, mint, side, tokens, usd, mcUsd: impliedMc(usd, tokens), source: 'csv' };
    };
    let trade: WalletTrade | null = null;
    if (f[idx.t2]?.endsWith('pump')) trade = make(f[idx.t2], f[idx.a2], f[idx.d2], 'buy');
    else if (f[idx.t1]?.endsWith('pump')) trade = make(f[idx.t1], f[idx.a1], f[idx.d1], 'sell');
    if (!trade || !Number.isFinite(ts) || !(trade.tokens > 0)) {
      ignored++;
      continue;
    }
    if (store.add(trade)) added++;
    else duplicates++;
  }
  return { added, duplicates, ignored };
}

export function importCsvFile(file: string, store: TradeStore) {
  return importCsvText(fs.readFileSync(file, 'utf8'), store);
}

import fs from 'node:fs';
import path from 'node:path';
import type { TradeRecord } from './types.js';

const DIR = path.resolve('data');
const TRADES = path.join(DIR, 'trades.jsonl');
const SIGNALS = path.join(DIR, 'signals.jsonl');

fs.mkdirSync(DIR, { recursive: true });

export function appendTrade(t: TradeRecord) {
  fs.appendFileSync(TRADES, JSON.stringify(t) + '\n');
}

/** One line per decision, with the numbers it was made on, so rules can be tested later. */
export function appendSignal(s: Record<string, unknown>) {
  fs.appendFileSync(SIGNALS, JSON.stringify(s) + '\n');
}

export function loadTrades(): TradeRecord[] {
  if (!fs.existsSync(TRADES)) return [];
  const out: TradeRecord[] = [];
  for (const line of fs.readFileSync(TRADES, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a damaged line */
    }
  }
  return out;
}

import { patterns, roundTrips, type TradeStore } from './tracker.js';

export interface StateExtras {
  live: { connected: boolean; lastEventAgoMs: number | null } | null;
  balanceSol: number | null;
  solUsd: number;
  snapshotAt?: number; // set for the static GitHub Pages copy
}

/** Everything the dashboard page needs, as plain JSON. */
export function buildState(store: TradeStore, wallet: string, x: StateExtras) {
  const trades = store.trades;
  const trips = roundTrips(trades);
  const p = patterns(trades, trips);
  const sorted = [...trades].sort((a, b) => b.ts - a.ts);
  return {
    wallet,
    live: x.live,
    balanceSol: x.balanceSol,
    solUsd: x.solUsd,
    snapshotAt: x.snapshotAt ?? null,
    sources: [...new Set(trades.map((t) => t.source))],
    totals: {
      trades: trades.length,
      buys: trades.filter((t) => t.side === 'buy').length,
      sells: trades.filter((t) => t.side === 'sell').length,
      tokens: trips.length,
      since: trades.length ? Math.min(...trades.map((t) => t.ts)) : null,
      until: trades.length ? Math.max(...trades.map((t) => t.ts)) : null,
    },
    patterns: p,
    activity: sorted.slice(0, 30),
    trips: trips.sort((a, b) => b.lastTradeTs - a.lastTradeTs).slice(0, 30),
  };
}

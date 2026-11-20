import { performance } from 'node:perf_hooks';
import { config } from './config.js';
import { INITIAL_CURVE, buyOnCurve, sellOnCurve, lamports, liquidityUsd, mcUsd, toSol } from './curve.js';
import { appendSignal, appendTrade, loadTrades } from './store.js';
import type { CurveEvent, CurveState, Feed, LaunchEvent, TradeRecord } from './types.js';

type CandStatus = 'watching' | 'entering' | 'entered' | 'skipped';

interface Candidate {
  mint: string;
  symbol: string;
  launchTs: number;
  state: CurveState;
  hist: { ts: number; mc: number }[];
  status: CandStatus;
  reason: string;
  momentumPct: number | null;
  entryAt: number;
  decisionMs: number;
  lastTs: number;
}

interface Position {
  mint: string;
  symbol: string;
  tokens: bigint;
  entryTs: number;
  entryMcUsd: number;
  sizeSol: number;
  feesSol: number;
  decisionMs: number;
  exitReason: string | null;
  exitAt: number;
  launchToEntrySec: number;
  lastState: CurveState;
  lastPnlPct: number;
  lastTs: number;
}

const DAY_MS = 86_400_000;

export class Engine {
  private cands = new Map<string, Candidate>();
  private positions = new Map<string, Position>();
  private clock = 0;
  trades: TradeRecord[] = loadTrades();
  paused = false;
  private decisionMsSamples: number[] = [];
  private launchToEntrySamples: number[] = [];

  constructor(private feed: Feed) {
    feed.on('launch', (e: LaunchEvent) => this.onLaunch(e));
    feed.on('curve', (e: CurveEvent) => this.onCurve(e));
    setInterval(() => this.sweep(), 1000);
  }

  // ---------- events ----------

  private onLaunch(e: LaunchEvent) {
    this.clock = Math.max(this.clock, e.ts);
    this.cands.set(e.mint, {
      mint: e.mint,
      symbol: e.symbol || e.mint.slice(0, 6),
      launchTs: e.ts,
      state: INITIAL_CURVE,
      hist: [],
      status: 'watching',
      reason: 'warming up',
      momentumPct: null,
      entryAt: 0,
      decisionMs: 0,
      lastTs: e.ts,
    });
    if (this.cands.size > 60) {
      const oldest = [...this.cands.values()].sort((a, b) => a.launchTs - b.launchTs)[0];
      this.cands.delete(oldest.mint);
    }
  }

  private onCurve(e: CurveEvent) {
    const t0 = performance.now();
    this.clock = Math.max(this.clock, e.ts);
    const pos = this.positions.get(e.mint);
    if (pos) {
      this.updatePosition(pos, e);
      return;
    }
    const c = this.cands.get(e.mint);
    if (!c) return;
    c.state = e.state;
    c.lastTs = e.ts;
    const mc = mcUsd(e.state, config.solUsd);
    c.hist.push({ ts: e.ts, mc });
    if (c.hist.length > 80) c.hist.shift();

    if (c.status === 'entering') {
      if (e.ts >= c.entryAt) this.fillEntry(c, e);
      return;
    }
    if (c.status !== 'watching') return;
    this.evaluate(c, e, mc, t0);
  }

  private sweep() {
    for (const c of this.cands.values()) {
      if (c.status === 'watching' && this.clock - c.launchTs > config.entry.maxAgeSec * 1000) {
        this.skip(c, c.reason === 'warming up' ? 'never met the rules' : c.reason);
      }
    }
    // An exit that never got a fresh price: fill it at the last known state.
    for (const p of this.positions.values()) {
      if (p.exitReason && this.clock - p.exitAt > 10_000) this.closePosition(p, p.lastState, this.clock);
    }
  }

  // ---------- entry ----------

  private evaluate(c: Candidate, e: CurveEvent, mc: number, t0: number) {
    const cfg = config.entry;
    const ageSec = (e.ts - c.launchTs) / 1000;
    const liq = liquidityUsd(e.state, config.solUsd);

    let momentum: number | null = null;
    const cutoff = e.ts - cfg.momentumWindowSec * 1000;
    const ref = [...c.hist].reverse().find((h) => h.ts <= cutoff);
    if (ref && ref.mc > 0) momentum = (mc / ref.mc - 1) * 100;
    c.momentumPct = momentum;

    const openCount = this.positions.size + [...this.cands.values()].filter((x) => x.status === 'entering').length;
    let fail: string | null = null;
    if (this.paused) fail = 'bot paused';
    else if (this.dailyPnl() <= -config.risk.dailyLossCapSol) fail = 'daily loss cap reached';
    else if (openCount >= config.risk.maxOpenPositions) fail = 'max open positions';
    else if (e.state.complete) fail = 'curve complete';
    else if (ageSec > cfg.maxAgeSec) fail = 'too old';
    else if (mc < cfg.minMcUsd) fail = 'market cap below min';
    else if (mc > cfg.maxMcUsd) fail = 'market cap above max';
    else if (liq < cfg.minLiquidityUsd) fail = 'liquidity too low';
    else if (momentum === null) fail = 'warming up';
    else if (momentum < cfg.minMomentumPct) fail = 'momentum too low';

    if (fail) {
      c.reason = fail;
      return;
    }
    c.status = 'entering';
    c.reason = 'BUY signal';
    c.entryAt = e.ts + config.costs.landingDelayMs;
    c.decisionMs = performance.now() - t0;
    appendSignal({
      ts: e.ts, mint: c.mint, symbol: c.symbol, decision: 'buy', ageSec, mcUsd: mc, liquidityUsd: liq, momentumPct: momentum,
    });
  }

  private skip(c: Candidate, reason: string) {
    c.status = 'skipped';
    c.reason = reason;
    appendSignal({ ts: this.clock, mint: c.mint, symbol: c.symbol, decision: 'skip', reason, lastMcUsd: c.hist.at(-1)?.mc ?? null });
    if (!this.positions.has(c.mint)) this.feed.untrack(c.mint);
  }

  private fillEntry(c: Candidate, e: CurveEvent) {
    const { costs, risk } = config;
    const gross = lamports(risk.positionSol);
    const fee = (gross * BigInt(Math.round(costs.feeRate * 10_000))) / 10_000n;
    const { tokens } = buyOnCurve(e.state, gross - fee);
    c.status = 'entered';
    const pos: Position = {
      mint: c.mint,
      symbol: c.symbol,
      tokens,
      entryTs: e.ts,
      entryMcUsd: mcUsd(e.state, config.solUsd),
      sizeSol: risk.positionSol,
      feesSol: toSol(fee) + costs.tipSol + costs.priorityFeeSol,
      decisionMs: c.decisionMs,
      exitReason: null,
      exitAt: 0,
      launchToEntrySec: (e.ts - c.launchTs) / 1000,
      lastState: e.state,
      lastPnlPct: 0,
      lastTs: e.ts,
    };
    this.positions.set(c.mint, pos);
    this.decisionMsSamples.push(c.decisionMs);
    this.launchToEntrySamples.push(pos.launchToEntrySec);
    if (this.decisionMsSamples.length > 200) this.decisionMsSamples.shift();
    if (this.launchToEntrySamples.length > 200) this.launchToEntrySamples.shift();
  }

  // ---------- exit ----------

  /** What selling the whole position into the curve right now would return, as a % of cost. */
  private markPnlPct(p: Position, s: CurveState) {
    const out = sellOnCurve(s, p.tokens).sol;
    const net = toSol(out) * (1 - config.costs.feeRate);
    return ((net - p.sizeSol) / p.sizeSol) * 100;
  }

  private updatePosition(p: Position, e: CurveEvent) {
    p.lastState = e.state;
    p.lastTs = e.ts;
    p.lastPnlPct = this.markPnlPct(p, e.state);
    if (p.exitReason) {
      if (e.ts >= p.exitAt) this.closePosition(p, e.state, e.ts);
      return;
    }
    const x = config.exit;
    const heldSec = (e.ts - p.entryTs) / 1000;
    let reason: string | null = null;
    if (e.state.complete) reason = 'Curve complete';
    else if (p.lastPnlPct >= x.takeProfitPct) reason = 'Take profit';
    else if (p.lastPnlPct <= -x.stopLossPct) reason = 'Stop loss';
    else if (heldSec >= x.maxHoldSec) reason = 'Time limit';
    if (reason) {
      p.exitReason = reason;
      p.exitAt = e.ts + config.costs.landingDelayMs;
    }
  }

  private closePosition(p: Position, s: CurveState, ts: number) {
    const { costs } = config;
    const out = sellOnCurve(s, p.tokens).sol;
    const sellFee = toSol(out) * costs.feeRate;
    const proceeds = toSol(out) - sellFee;
    const sellCosts = costs.tipSol + costs.priorityFeeSol;
    const feesSol = p.feesSol + sellFee + sellCosts;
    // The 1% fees are already inside `proceeds` and the tokens bought, so only the tips
    // and priority fees (one set per transaction) are subtracted on top.
    const pnlSol = proceeds - p.sizeSol - 2 * (costs.tipSol + costs.priorityFeeSol);
    const trade: TradeRecord = {
      token: p.symbol,
      mint: p.mint,
      entryMcUsd: p.entryMcUsd,
      exitMcUsd: mcUsd(s, config.solUsd),
      holdSec: (ts - p.entryTs) / 1000,
      pnlPct: ((proceeds - p.sizeSol) / p.sizeSol) * 100,
      pnlSol,
      feesSol,
      reason: p.exitReason ?? 'Closed',
      entryTs: p.entryTs,
      exitTs: ts,
    };
    this.positions.delete(p.mint);
    this.trades.push(trade);
    appendTrade(trade);
    this.feed.untrack(p.mint);
  }

  // ---------- numbers for the dashboard ----------

  private dailyPnl() {
    const since = this.clock - (this.clock % DAY_MS);
    return this.trades.filter((t) => t.exitTs >= since).reduce((a, t) => a + t.pnlSol, 0);
  }

  state() {
    const t = this.trades;
    const wins = t.filter((x) => x.pnlSol > 0);
    const losses = t.filter((x) => x.pnlSol <= 0);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const net = t.reduce((a, x) => a + x.pnlSol, 0);
    const equity: number[] = [config.risk.startingBalanceSol];
    for (const x of t) equity.push(equity[equity.length - 1] + x.pnlSol);

    const scan = [...this.cands.values()]
      .sort((a, b) => b.launchTs - a.launchTs)
      .slice(0, 12)
      .map((c) => ({
        token: c.symbol,
        ageSec: (c.lastTs - c.launchTs) / 1000,
        mcUsd: mcUsd(c.state, config.solUsd),
        liqUsd: liquidityUsd(c.state, config.solUsd),
        momentumPct: c.momentumPct,
        status: c.status,
        reason: c.reason,
      }));

    return {
      mode: config.mode,
      paused: this.paused,
      feed: { connected: this.feed.connected, lastEventAgoMs: this.feed.lastEventTs ? Date.now() - this.feed.lastEventTs : null },
      kpis: {
        balanceSol: config.risk.startingBalanceSol + net,
        netSol: net,
        winRatePct: t.length ? (wins.length / t.length) * 100 : 0,
        wins: wins.length,
        trades: t.length,
        avgHoldSec: avg(t.map((x) => x.holdSec)),
        avgWinPct: avg(wins.map((x) => x.pnlPct)),
        avgLossPct: avg(losses.map((x) => x.pnlPct)),
        feesSol: t.reduce((a, x) => a + x.feesSol, 0),
      },
      equity: equity.slice(-120),
      scan,
      trades: t.slice(-12).reverse(),
      open: [...this.positions.values()].map((p) => ({
        token: p.symbol,
        entryMcUsd: p.entryMcUsd,
        nowMcUsd: mcUsd(p.lastState, config.solUsd),
        pnlPct: p.lastPnlPct,
        heldSec: Math.max(0, (p.lastTs - p.entryTs) / 1000),
        maxHoldSec: config.exit.maxHoldSec,
        sizeSol: p.sizeSol,
        exiting: p.exitReason,
      })),
      latency: {
        decisionMs: avg(this.decisionMsSamples),
        landingMs: config.costs.landingDelayMs,
        launchToEntrySec: avg(this.launchToEntrySamples),
      },
      rules: { entry: config.entry, exit: config.exit, risk: config.risk, costs: config.costs },
    };
  }
}

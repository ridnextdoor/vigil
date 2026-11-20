import { EventEmitter } from 'node:events';
import { INITIAL_CURVE, buyOnCurve, sellOnCurve, lamports } from './curve.js';
import type { CurveState, Feed } from './types.js';

type Kind = 'dud' | 'pop' | 'runner';

interface Sim {
  mint: string;
  born: number;
  nextStep: number;
  kind: Kind;
  state: CurveState;
}

const STEP_MS = 250;
const LIFE_MS = 200_000;
const NAMES = ['MOONK', 'PIXEL', 'DUCKY', 'ZAPP', 'OTTR', 'NEBU', 'KOI', 'BOLT', 'FROGGO', 'MISO', 'TACO', 'LUNAR', 'BEEP', 'WAFFLE'];

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

/** Synthetic launches with random-walk bonding curves, so the whole pipeline can run offline. */
export class DemoFeed extends EventEmitter implements Feed {
  connected = true;
  lastEventTs = 0;
  private timer: NodeJS.Timeout | null = null;
  private vnow = Date.now();
  private nextLaunch = this.vnow + 500;
  private sims = new Map<string, Sim>();
  private counter = 0;

  constructor(private speed: number) {
    super();
  }

  start() {
    console.log(`[feed] DEMO mode: synthetic launches at ${this.speed}x speed`);
    this.timer = setInterval(() => this.tick(), 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  untrack(mint: string) {
    this.sims.delete(mint);
  }

  private tick() {
    this.vnow += 100 * this.speed;
    while (this.nextLaunch <= this.vnow) {
      this.launch(this.nextLaunch);
      this.nextLaunch += (2000 + Math.random() * 4000);
    }
    for (const sim of [...this.sims.values()]) {
      while (sim.nextStep <= this.vnow) {
        if (sim.nextStep - sim.born > LIFE_MS) {
          this.sims.delete(sim.mint);
          break;
        }
        this.step(sim, sim.nextStep);
        sim.nextStep += STEP_MS;
      }
    }
    this.lastEventTs = Date.now();
  }

  private launch(ts: number) {
    const r = Math.random();
    const kind: Kind = r < 0.55 ? 'dud' : r < 0.85 ? 'pop' : 'runner';
    const symbol = NAMES[this.counter % NAMES.length];
    const mint = `DEMO${(++this.counter).toString().padStart(4, '0')}${symbol}`;
    this.sims.set(mint, { mint, born: ts, nextStep: ts + STEP_MS, kind, state: INITIAL_CURVE });
    this.emit('launch', { mint, curve: mint + '-curve', name: symbol + ' coin', symbol, ts });
    this.emit('curve', { mint, state: INITIAL_CURVE, ts });
  }

  private step(sim: Sim, ts: number) {
    const age = (ts - sim.born) / 1000;
    let pBuy: number;
    if (sim.kind === 'dud') pBuy = age < 8 ? 0.55 : 0.35;
    else if (sim.kind === 'pop') pBuy = age < 20 ? 0.66 : 0.38;
    else pBuy = age < 70 ? 0.62 : 0.45;
    const trades = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < trades; i++) {
      const sol = Math.min(3, Math.max(0.02, Math.exp(Math.log(0.15) + 0.9 * gauss())));
      if (Math.random() < pBuy) {
        sim.state = buyOnCurve(sim.state, lamports(sol)).next;
      } else {
        const tokens = (lamports(sol) * sim.state.vToken) / sim.state.vSol;
        sim.state = sellOnCurve(sim.state, tokens).next;
      }
    }
    this.emit('curve', { mint: sim.mint, state: sim.state, ts });
  }
}

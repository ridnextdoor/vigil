import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { TradeStore } from './tracker.js';
import { buildState } from './tracker-state.js';

/** Builds a static copy of the dashboard (site/index.html + site/state.json) for GitHub Pages. */
const wallet = process.env.TRACK_WALLET || 'STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk';
const store = new TradeStore();
store.load();

const out = path.resolve('site');
fs.mkdirSync(out, { recursive: true });
const state = buildState(store, wallet, { live: null, balanceSol: null, solUsd: config.solUsd, snapshotAt: Date.now() });
fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify(state));
const page = fs.readFileSync(path.resolve('public/tracker.html'), 'utf8').replace("'/api/tracker'", "'./state.json'");
fs.writeFileSync(path.join(out, 'index.html'), page);
console.log(`[site] built with ${state.totals.trades} trades`);

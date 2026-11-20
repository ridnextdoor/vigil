import fs from 'node:fs';

// Tiny .env loader so no extra dependency is needed.
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  mode: process.argv.includes('--demo') || process.env.DEMO === '1' || !process.env.RPC_WS_URL ? ('demo' as const) : ('live' as const),
  rpcWsUrl: process.env.RPC_WS_URL ?? '',
  demoSpeed: Math.max(1, num(process.env.DEMO_SPEED, 1)),
  port: num(process.env.PORT, 3000),
  solUsd: num(process.env.SOL_USD, 73),

  // Entry rules. These are starting points to test, not recommendations.
  entry: {
    maxAgeSec: 120,
    minMcUsd: 3000,
    maxMcUsd: 25000,
    minLiquidityUsd: 1000, // real SOL in the bonding curve, in USD
    minMomentumPct: 8, // price rise over the window below
    momentumWindowSec: 5,
  },
  exit: {
    takeProfitPct: 20,
    stopLossPct: 15,
    maxHoldSec: 60,
  },
  risk: {
    startingBalanceSol: 10,
    positionSol: 0.05,
    maxOpenPositions: 3,
    dailyLossCapSol: 1, // stop opening trades after losing this much in a UTC day
  },
  costs: {
    feeRate: 0.01, // pump.fun trading fee, applied to each buy and sell
    tipSol: 0.002, // assumed Jito tip per transaction
    priorityFeeSol: 0.0005, // assumed priority fee per transaction
    landingDelayMs: 400, // time between decision and the trade filling
  },
};

export type Config = typeof config;

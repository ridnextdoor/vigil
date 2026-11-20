import type { CurveState } from './types.js';

// Starting reserves of a fresh pump.fun bonding curve (token amounts in base units, 6 decimals).
export const INITIAL_CURVE: CurveState = {
  vToken: 1_073_000_000_000_000n,
  vSol: 30_000_000_000n,
  rToken: 793_100_000_000_000n,
  rSol: 0n,
  supply: 1_000_000_000_000_000n,
  complete: false,
};

/** Decode a pump.fun bonding curve account: 8-byte discriminator, five u64s, then a bool. */
export function decodeCurve(buf: Buffer): CurveState | null {
  if (buf.length < 49) return null;
  return {
    vToken: buf.readBigUInt64LE(8),
    vSol: buf.readBigUInt64LE(16),
    rToken: buf.readBigUInt64LE(24),
    rSol: buf.readBigUInt64LE(32),
    supply: buf.readBigUInt64LE(40),
    complete: buf[48] !== 0,
  };
}

export const mcUsd = (s: CurveState, solUsd: number) =>
  s.vToken === 0n ? 0 : (Number((s.vSol * s.supply) / s.vToken) / 1e9) * solUsd;

/** Real SOL sitting in the curve, in USD. This is what a seller can actually pull out. */
export const liquidityUsd = (s: CurveState, solUsd: number) => (Number(s.rSol) / 1e9) * solUsd;

/** Spend `solInLamports` (after fee) on the curve. Returns tokens received and the new state. */
export function buyOnCurve(s: CurveState, solInLamports: bigint): { tokens: bigint; next: CurveState } {
  const newVSol = s.vSol + solInLamports;
  const newVToken = (s.vSol * s.vToken) / newVSol + 1n;
  let tokens = s.vToken - newVToken;
  if (tokens > s.rToken) tokens = s.rToken;
  if (tokens < 0n) tokens = 0n;
  return {
    tokens,
    next: { ...s, vSol: newVSol, vToken: s.vToken - tokens, rSol: s.rSol + solInLamports, rToken: s.rToken - tokens },
  };
}

/** Sell `tokens` into the curve. Returns lamports received (before fee) and the new state. */
export function sellOnCurve(s: CurveState, tokens: bigint): { sol: bigint; next: CurveState } {
  const newVToken = s.vToken + tokens;
  const newVSol = (s.vSol * s.vToken) / newVToken + 1n;
  let sol = s.vSol - newVSol;
  if (sol > s.rSol) sol = s.rSol; // cannot take out more than is really there
  if (sol < 0n) sol = 0n;
  return {
    sol,
    next: { ...s, vToken: newVToken, vSol: s.vSol - sol, rSol: s.rSol - sol, rToken: s.rToken + tokens },
  };
}

export const lamports = (sol: number) => BigInt(Math.round(sol * 1e9));
export const toSol = (l: bigint) => Number(l) / 1e9;

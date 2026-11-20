import type { EventEmitter } from 'node:events';

export interface CurveState {
  vToken: bigint;
  vSol: bigint;
  rToken: bigint;
  rSol: bigint;
  supply: bigint;
  complete: boolean;
}

export interface LaunchEvent {
  mint: string;
  curve: string;
  name: string;
  symbol: string;
  ts: number; // ms, from the feed's own clock
}

export interface CurveEvent {
  mint: string;
  state: CurveState;
  ts: number;
}

/** A feed emits 'launch' (LaunchEvent) and 'curve' (CurveEvent). */
export interface Feed extends EventEmitter {
  connected: boolean;
  lastEventTs: number;
  start(): void;
  stop(): void;
  untrack(mint: string): void;
}

export interface TradeRecord {
  token: string;
  mint: string;
  entryMcUsd: number;
  exitMcUsd: number;
  holdSec: number;
  pnlPct: number; // before tips and priority fees
  pnlSol: number; // after fees, tips and priority fees
  feesSol: number;
  reason: string;
  entryTs: number;
  exitTs: number;
}

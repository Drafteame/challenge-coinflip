import type { ClientMessage, ErrorCode, Pick, Round, ServerMessage, ServerPush, ServerReply } from './protocol.ts';
import type { Fixture } from './config.ts';
import { tierH } from './config.ts';
import type { Faults } from './faults.ts';
import { streamFor } from './prng.ts';
import type { Rng } from './prng.ts';

export type Quote = { id: string; bet: number; expiresAt: number }; // expiresAt = epoch ms
export type ReplayEntry = { seq: number; reqId: string; frame: string }; // written by server, declared here so both share the type
export type SessionRng = { outcome: Rng; fault: Rng; drop: Rng; tier: Rng };

export type Session = {
  id: string;
  userId: string;
  ordinal: number;
  balanceCents: number;
  openRound: Round | null;
  openPayoutCents: number;
  acked: Set<string>;
  quotes: Map<number, Quote>; // keyed by bet (dollars)
  shiftH: number;             // 0 or delta*100 (hundredths)
  roundSeq: number;
  quoteSeq: number;
  seq: number;
  writtenSeq: number;
  replay: ReplayEntry[];
  closedAt: number | null;
  rng: SessionRng;
};

export type FaultLogger = (
  kind: string,
  sessionId: string,
  userId: string,
  reqId: string | null,
  detail?: Record<string, unknown>,
) => void;

export type Ctx = {
  fixture: Fixture;
  now: number;
  faults: Faults;
  fault: FaultLogger;
};

const QUOTE_TTL_MS = 30_000;

function iso(ms: number): string { return new Date(ms).toISOString(); }

function error(reqId: string | undefined, code: ErrorCode, message: string): ServerReply {
  return reqId === undefined ? { type: 'error', code, message } : { reqId, type: 'error', code, message };
}

function validBet(bet: unknown): bet is number {
  return typeof bet === 'number' && Number.isInteger(bet) && bet >= 1 && bet <= 5000;
}

function validPick(pick: unknown): pick is Pick {
  return pick === 'heads' || pick === 'tails';
}

function pruneQuotes(s: Session, now: number): void {
  for (const [bet, q] of s.quotes) { if (now >= q.expiresAt) s.quotes.delete(bet); }
}

export function newSession(id: string, userId: string, ordinal: number, seed: string, fx: Fixture): Session {
  return {
    id, userId, ordinal,
    balanceCents: Math.round(fx.startingBalance * 100),
    openRound: null,
    openPayoutCents: 0,
    acked: new Set<string>(),
    quotes: new Map(),
    shiftH: 0,
    roundSeq: 0,
    quoteSeq: 0,
    seq: 0,
    writtenSeq: 0,
    replay: [],
    closedAt: null,
    rng: {
      outcome: streamFor(seed, userId, ordinal, 'outcome'),
      fault: streamFor(seed, userId, ordinal, 'fault'),
      drop: streamFor(seed, userId, ordinal, 'drop'),
      tier: streamFor(seed, userId, ordinal, 'tier'),
    },
  };
}

export function welcome(s: Session, reqId: string, resumed: boolean): ServerReply {
  return {
    reqId, type: 'welcome', sessionId: s.id, gameId: 'coinflip', userId: s.userId,
    balance: s.balanceCents / 100, openRound: s.openRound, resumed,
  };
}

export function parse(text: string): { ok: true; msg: ClientMessage } | { ok: false; reqId?: string; message: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, message: 'malformed JSON' }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'message must be an object with string reqId and type' };
  }
  const o = raw as Record<string, unknown>;
  const reqId = o['reqId'];
  const type = o['type'];
  if (typeof reqId !== 'string' || typeof type !== 'string') {
    return { ok: false, reqId: typeof reqId === 'string' ? reqId : undefined, message: 'message must be an object with string reqId and type' };
  }
  switch (type) {
    case 'hello':
      return { ok: true, msg: { reqId, type, clientVersion: typeof o['clientVersion'] === 'string' ? o['clientVersion'] : '' } };
    case 'get_balance':
    case 'get_open_round':
    case 'ping':
      return { ok: true, msg: { reqId, type } as ClientMessage };
    case 'get_quote':
      return { ok: true, msg: { reqId, type, bet: o['bet'] as number } };
    case 'place_round':
      return { ok: true, msg: { reqId, type, bet: o['bet'] as number, pick: o['pick'] as Pick, quoteId: o['quoteId'] as string } };
    case 'ack_round':
      return { ok: true, msg: { reqId, type, roundId: o['roundId'] as string } };
    default:
      return { ok: false, reqId, message: `unknown type: ${type}` };
  }
}

export function handle(s: Session, m: ClientMessage, ctx: Ctx): ServerMessage[] {
  switch (m.type) {
    case 'hello': return [error(m.reqId, 'INTERNAL', 'hello already received')];
    case 'ping': return [{ reqId: m.reqId, type: 'pong' }];
    case 'get_balance': return [{ reqId: m.reqId, type: 'balance', balance: s.balanceCents / 100 }];
    case 'get_open_round': return [{ reqId: m.reqId, type: 'open_round', round: s.openRound }];
    case 'get_quote': return handleQuote(s, m, ctx);
    case 'place_round': return handlePlace(s, m, ctx);
    case 'ack_round': return handleAck(s, m, ctx);
  }
}

function handleQuote(s: Session, m: { reqId: string; bet: number }, ctx: Ctx): ServerMessage[] {
  if (!validBet(m.bet)) return [error(m.reqId, 'INVALID_BET', 'bet must be an integer between 1 and 5000')];
  pruneQuotes(s, ctx.now);
  const multH = tierH(ctx.fixture.tiers, m.bet * 100, s.shiftH);
  s.quoteSeq += 1;
  const quoteId = `${s.id}-q${s.quoteSeq}`;
  s.quotes.set(m.bet, { id: quoteId, bet: m.bet, expiresAt: ctx.now + QUOTE_TTL_MS });
  return [{ reqId: m.reqId, type: 'quote', quoteId, bet: m.bet, multiplier: multH / 100, expiresAt: iso(ctx.now + QUOTE_TTL_MS) }];
}

function handlePlace(s: Session, m: { reqId: string; bet: number; pick: Pick; quoteId: string }, ctx: Ctx): ServerMessage[] {
  if (!validBet(m.bet)) return [error(m.reqId, 'INVALID_BET', 'bet must be an integer between 1 and 5000')];
  if (!validPick(m.pick)) return [error(m.reqId, 'INVALID_BET', "pick must be 'heads' or 'tails'")];
  if (s.openRound !== null) return [error(m.reqId, 'ROUND_OPEN', `round ${s.openRound.id} is still open; ack it first`)];
  pruneQuotes(s, ctx.now);
  const q = s.quotes.get(m.bet);
  if (typeof m.quoteId !== 'string' || q === undefined || q.id !== m.quoteId || ctx.now >= q.expiresAt) {
    return [error(m.reqId, 'QUOTE_EXPIRED', 'quote is unknown, expired, or for a different bet')];
  }
  const betCents = m.bet * 100;
  if (betCents > s.balanceCents) return [error(m.reqId, 'INSUFFICIENT_BALANCE', `bet ${m.bet} exceeds balance ${s.balanceCents / 100}`)];
  if (ctx.faults.internalError(s)) {
    ctx.fault('internal_error', s.id, s.userId, m.reqId);
    return [error(m.reqId, 'INTERNAL', 'simulated failure')];
  }
  const d0 = s.rng.outcome();
  const d1 = s.rng.outcome();
  const result: Pick = d0 < 0.5 ? 'heads' : 'tails';
  const win = result === m.pick;
  const multH = tierH(ctx.fixture.tiers, betCents, s.shiftH);
  const payoutCents = win ? m.bet * multH : 0;
  s.balanceCents -= betCents;
  s.quotes.delete(m.bet);
  s.roundSeq += 1;
  const round: Round = {
    id: `${s.id}-r${s.roundSeq}`,
    bet: m.bet,
    pick: m.pick,
    result,
    multiplier: multH / 100,
    payout: payoutCents / 100,
    state: 'open',
    createdAt: iso(ctx.now),
  };
  if (win && d1 < 0.5) {
    const whole = payoutCents / 100;
    const offered = payoutCents % 100 === 0 && whole >= 1 && whole <= 5000;
    round.streak = { offered, multiplier: tierH(ctx.fixture.tiers, payoutCents, 0) / 100 };
  }
  s.openRound = round;
  s.openPayoutCents = payoutCents;

  const out: ServerMessage[] = [
    { reqId: m.reqId, type: 'round', round },
    { type: 'balance_changed', balance: s.balanceCents / 100 },
  ];

  if (s.shiftH !== 0) {
    s.shiftH = 0;
    ctx.fault('tier_shift', s.id, s.userId, m.reqId, { revert: true });
    out.push(...quoteChangedPushes(s, ctx));
  }
  return out;
}

function handleAck(s: Session, m: { reqId: string; roundId: string }, ctx: Ctx): ServerMessage[] {
  if (typeof m.roundId !== 'string') return [error(m.reqId, 'INTERNAL', `unknown round ${String(m.roundId)}`)];
  if (s.openRound !== null && s.openRound.id === m.roundId) {
    const id = m.roundId;
    const payout = s.openPayoutCents;
    s.balanceCents += payout;
    s.acked.add(id);
    s.openRound = null;
    s.openPayoutCents = 0;
    const out: ServerMessage[] = [{ reqId: m.reqId, type: 'acked', roundId: id, balance: s.balanceCents / 100 }];
    if (payout > 0) out.push({ type: 'balance_changed', balance: s.balanceCents / 100 });
    return out;
  }
  if (s.acked.has(m.roundId)) return [error(m.reqId, 'INTERNAL', `round ${m.roundId} already acked`)];
  return [error(m.reqId, 'INTERNAL', `unknown round ${m.roundId}`)];
}

export function tierTick(s: Session, ctx: Ctx): ServerPush[] {
  pruneQuotes(s, ctx.now);
  const hit = ctx.faults.tierShift(s);
  if (!hit) return [];
  if (s.shiftH !== 0) return []; // already shifted; the draw is still consumed
  s.shiftH = Math.round(ctx.fixture.faults.tierShift.delta * 100);
  ctx.fault('tier_shift', s.id, s.userId, null);
  return quoteChangedPushes(s, ctx);
}

function quoteChangedPushes(s: Session, ctx: Ctx): ServerPush[] {
  const bets = [...s.quotes.keys()].sort((a, b) => a - b);
  const out: ServerPush[] = [];
  for (const bet of bets) {
    const q = s.quotes.get(bet);
    if (q === undefined) continue;
    out.push({ type: 'quote_changed', quoteId: q.id, bet, multiplier: tierH(ctx.fixture.tiers, bet * 100, s.shiftH) / 100 });
  }
  return out;
}
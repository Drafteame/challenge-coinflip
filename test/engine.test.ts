import { test } from 'node:test';
import assert from 'node:assert/strict';
import { welcome, newSession, handle, parse, tierTick } from '../src/engine.ts';
import type { Session, Ctx } from '../src/engine.ts';
import { makeFaults } from '../src/faults.ts';
import type { Fixture } from '../src/config.ts';
import { streamFor } from '../src/prng.ts';
import type { ClientMessage, Pick } from '../src/protocol.ts';

function mkFixture(overrides?: {
  seed?: string; startingBalance?: number; tiers?: Fixture['tiers'];
  latencyP?: number; internalP?: number; dropIntervalMs?: number; dropJitterMs?: number; tierP?: number; tierDelta?: number; dupP?: number;
}): Fixture {
  return {
    seed: overrides?.seed ?? 'draftea-coinflip',
    startingBalance: overrides?.startingBalance ?? 1000.0,
    tiers: overrides?.tiers ?? [
      { upTo: 20, multiplier: 1.95 }, { upTo: 100, multiplier: 1.90 },
      { upTo: 500, multiplier: 1.85 }, { upTo: null, multiplier: 1.80 },
    ],
    faults: {
      latency: { probability: overrides?.latencyP ?? 0.15, delayMs: 2000 },
      internalError: { probability: overrides?.internalP ?? 1 / 15 },
      socketDrop: { intervalMs: overrides?.dropIntervalMs ?? 180000, jitterMs: overrides?.dropJitterMs ?? 30000 },
      tierShift: { probabilityPerMinute: overrides?.tierP ?? 0.1, delta: overrides?.tierDelta ?? 0.05 },
      duplicate: { probability: overrides?.dupP ?? 0.05 },
    },
  };
}

function makeSession(userId = 'alice', ordinal = 0, fixture = mkFixture()): Session {
  return newSession('s_alice', userId, ordinal, fixture.seed, fixture);
}

function makeCtx(fixture: Fixture, faultsOn: boolean, captured?: Array<Record<string, unknown>>): Ctx {
  return {
    fixture,
    now: 0,
    faults: makeFaults(fixture.faults, faultsOn),
    fault: (kind, sessionId, userId, reqId, detail) => {
      if (captured) captured.push({ kind, sessionId, userId, reqId, ...(detail ?? {}) });
    },
  };
}

function msg(text: string): ClientMessage {
  const r = JSON.parse(text);
  const p = parse(text);
  if (!p.ok) throw new Error('unexpected parse failure: ' + p.message);
  return p.msg;
}

function findOrdinal(pred: (d0: number, d1: number) => boolean, user: string, max = 4000): number {
  for (let ord = 0; ord < max; ord++) {
    const r = streamFor('draftea-coinflip', user, ord, 'outcome');
    const d0 = r();
    const d1 = r();
    if (pred(d0, d1)) return ord;
  }
  throw new Error('no ordinal found within ' + max);
}

test('parse envelope', () => {
  const ok = parse('{"reqId":"r","type":"ping"}');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.msg, { reqId: 'r', type: 'ping' });

  const bad1 = parse('not json');
  assert.equal(bad1.ok, false);
  if (!bad1.ok) assert.equal(bad1.message, 'malformed JSON');

  const bad2 = parse('123');
  assert.equal(bad2.ok, false);
  if (!bad2.ok) assert.equal(bad2.message, 'message must be an object with string reqId and type');

  const bad3 = parse('{"reqId":"r","type":"nope"}');
  assert.equal(bad3.ok, false);
  if (!bad3.ok) {
    assert.equal(bad3.message, 'unknown type: nope');
    assert.equal(bad3.reqId, 'r');
  }
});

test('quote returns tier multiplier + 30s expiry, per-bet replacement', () => {
  const fixture = mkFixture();
  const s = makeSession('alice', 0, fixture);
  const ctx = makeCtx(fixture, false);

  let out = handle(s, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    reqId: 'q1', type: 'quote', quoteId: 's_alice-q1', bet: 10, multiplier: 1.95,
    expiresAt: new Date(30000).toISOString(),
  });

  out = handle(s, msg('{"reqId":"q2","type":"get_quote","bet":100}'), ctx);
  assert.deepEqual(out[0], {
    reqId: 'q2', type: 'quote', quoteId: 's_alice-q2', bet: 100, multiplier: 1.90,
    expiresAt: new Date(30000).toISOString(),
  });

  out = handle(s, msg('{"reqId":"q3","type":"get_quote","bet":10}'), ctx);
  assert.deepEqual(out[0], {
    reqId: 'q3', type: 'quote', quoteId: 's_alice-q3', bet: 10, multiplier: 1.95,
    expiresAt: new Date(30000).toISOString(),
  });
});

test('quote invalid bet', () => {
  const fixture = mkFixture();
  const s = makeSession('alice', 0, fixture);
  const ctx = makeCtx(fixture, false);

  for (const bet of [0, 5001, 1.5]) {
    const out = handle(s, msg(JSON.stringify({ reqId: 'x', type: 'get_quote', bet })), ctx);
    assert.equal((out[0] as any).code, 'INVALID_BET');
    assert.equal((out[0] as any).message, 'bet must be an integer between 1 and 5000');
  }

  const out = handle(s, { reqId: 'x', type: 'get_quote', bet: '10' as unknown as number }, ctx);
  assert.equal((out[0] as any).code, 'INVALID_BET');
});

test('place flow: deduct on place, credit on ack, round shape', () => {
  const fixture = mkFixture();
  const s = makeSession('alice', 0, fixture);
  const ctx = makeCtx(fixture, false);

  handle(s, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctx);
  const out = handle(s, msg('{"reqId":"p1","type":"place_round","bet":10,"pick":"heads","quoteId":"s_alice-q1"}'), ctx);

  const first = out[0];
  assert.equal(first.type, 'round');
  if (first.type !== 'round') throw new Error('expected round reply');
  assert.equal(first.round.id, 's_alice-r1');
  assert.equal(first.round.bet, 10);
  assert.equal(first.round.pick, 'heads');
  assert.equal(first.round.state, 'open');
  assert.equal(first.round.multiplier, 1.95);
  assert.ok(first.round.result === 'heads' || first.round.result === 'tails');
  assert.equal(first.round.payout, first.round.result === 'heads' ? 19.5 : 0);
  assert.equal(first.round.createdAt, new Date(0).toISOString());

  const expectedPayout = first.round.result === 'heads' ? 19.5 : 0;
  assert.equal(s.openRound?.payout, expectedPayout);
  assert.equal(s.balanceCents, 100000 - 1000);

  const bc = out.find((m) => m.type === 'balance_changed');
  assert.ok(bc);
  if (bc) assert.equal(bc.balance, 990);

  const payoutCents = s.openPayoutCents;
  const ackOut = handle(s, msg('{"reqId":"a1","type":"ack_round","roundId":"s_alice-r1"}'), ctx);
  const ack0 = ackOut[0];
  assert.equal(ack0.type, 'acked');
  if (ack0.type !== 'acked') throw new Error('expected acked reply');
  assert.equal(ack0.reqId, 'a1');
  assert.equal(ack0.roundId, 's_alice-r1');
  assert.equal(ack0.balance, s.balanceCents / 100);
  assert.equal(s.openRound, null);
  assert.ok(s.acked.has('s_alice-r1'));
  assert.equal(s.balanceCents, 100000 - 1000 + payoutCents);

  const ack2 = handle(s, msg('{"reqId":"a2","type":"ack_round","roundId":"s_alice-r1"}'), ctx);
  assert.equal((ack2[0] as any).type, 'error');
  assert.equal((ack2[0] as any).code, 'INTERNAL');
  assert.equal((ack2[0] as any).message, 'round s_alice-r1 already acked');
  assert.equal(s.balanceCents, 100000 - 1000 + payoutCents);
});

test('ROUND_OPEN / INSUFFICIENT_BALANCE / QUOTE_EXPIRED / invalid pick', () => {
  const fixture = mkFixture();

  // (a) two places without ack -> ROUND_OPEN
  const s1 = makeSession('alice', 0, fixture);
  const ctx1 = makeCtx(fixture, false);
  handle(s1, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctx1);
  const p1 = handle(s1, msg('{"reqId":"p1","type":"place_round","bet":10,"pick":"heads","quoteId":"s_alice-q1"}'), ctx1);
  assert.equal(p1[0].type, 'round');
  const p2 = handle(s1, msg('{"reqId":"p2","type":"place_round","bet":10,"pick":"tails","quoteId":"s_alice-q1"}'), ctx1);
  assert.equal((p2[0] as any).code, 'ROUND_OPEN');

  // (b) bet 5000 allowed as a quote but exceeds balance on place
  const s2 = makeSession('bob', 0, fixture);
  const ctx2 = makeCtx(fixture, false);
  handle(s2, msg('{"reqId":"q1","type":"get_quote","bet":5000}'), ctx2);
  const p3 = handle(s2, msg('{"reqId":"p1","type":"place_round","bet":5000,"pick":"heads","quoteId":"s_alice-q1"}'), ctx2);
  assert.equal((p3[0] as any).code, 'INSUFFICIENT_BALANCE');
  assert.equal(s2.balanceCents, 100000);

  // (c) wrong quoteId -> QUOTE_EXPIRED
  const s3 = makeSession('carol', 0, fixture);
  const ctx3 = makeCtx(fixture, false);
  handle(s3, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctx3);
  const p4 = handle(s3, { reqId: 'p1', type: 'place_round', bet: 10, pick: 'heads', quoteId: 'nope' }, ctx3);
  assert.equal((p4[0] as any).code, 'QUOTE_EXPIRED');

  // (d) quote expired by time
  const s4 = makeSession('dave', 0, fixture);
  const ctx4 = makeCtx(fixture, false);
  handle(s4, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctx4);
  ctx4.now = 30001;
  const p5 = handle(s4, msg('{"reqId":"p1","type":"place_round","bet":10,"pick":"heads","quoteId":"s_alice-q1"}'), ctx4);
  assert.equal((p5[0] as any).code, 'QUOTE_EXPIRED');

  // (e) invalid pick -> INVALID_BET
  const s5 = makeSession('erin', 0, fixture);
  const ctx5 = makeCtx(fixture, false);
  const p6 = handle(s5, { reqId: 'p1', type: 'place_round', bet: 10, pick: 'sideways' as unknown as Pick, quoteId: 'x' }, ctx5);
  assert.equal((p6[0] as any).code, 'INVALID_BET');
  assert.equal((p6[0] as any).message, "pick must be 'heads' or 'tails'");
});

test('ack unknown / non-string roundId', () => {
  const fixture = mkFixture();
  const s = makeSession('alice', 0, fixture);
  const ctx = makeCtx(fixture, false);

  let out = handle(s, msg('{"reqId":"a1","type":"ack_round","roundId":"nope"}'), ctx);
  assert.equal((out[0] as any).type, 'error');
  assert.equal((out[0] as any).code, 'INTERNAL');
  assert.equal((out[0] as any).message, 'unknown round nope');

  out = handle(s, { reqId: 'a2', type: 'ack_round', roundId: undefined as unknown as string }, ctx);
  assert.equal((out[0] as any).code, 'INTERNAL');
  assert.ok(((out[0] as any).message as string).startsWith('unknown round '));
});

test('integer-cents exactness over 1000 rounds (bet 1)', () => {
  const fixture = mkFixture();
  const s = makeSession('winrateA', 0, fixture);
  const ctx = makeCtx(fixture, false);
  let totalPayoutCents = 0;
  for (let i = 0; i < 1000; i++) {
    const q = handle(s, msg('{"reqId":"' + i + 'q","type":"get_quote","bet":1}'), ctx)[0];
    assert.equal(q.type, 'quote');
    if (q.type !== 'quote') throw new Error('expected quote reply');
    handle(s, msg('{"reqId":"' + i + 'p","type":"place_round","bet":1,"pick":"heads","quoteId":"' + q.quoteId + '"}'), ctx);
    const roundId = s.openRound!.id;
    totalPayoutCents += s.openPayoutCents;
    handle(s, msg('{"reqId":"' + i + 'a","type":"ack_round","roundId":"' + roundId + '"}'), ctx);
    assert.ok(Number.isInteger(s.balanceCents));
  }
  assert.equal(s.balanceCents, 100000 - 100000 + totalPayoutCents);
});

test('win rate 45-55% and pick independence', () => {
  const fixture = mkFixture();
  const sA = makeSession('winrateX', 0, fixture);
  const sB = makeSession('winrateX', 0, fixture);
  const ctxA = makeCtx(fixture, false);
  const ctxB = makeCtx(fixture, false);
  const resultsA: string[] = [];
  const resultsB: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const qA = handle(sA, msg('{"reqId":"' + i + 'q","type":"get_quote","bet":1}'), ctxA)[0];
    const qB = handle(sB, msg('{"reqId":"' + i + 'q","type":"get_quote","bet":1}'), ctxB)[0];
    assert.equal(qA.type, 'quote');
    assert.equal(qB.type, 'quote');
    if (qA.type !== 'quote' || qB.type !== 'quote') throw new Error('expected quote replies');
    handle(sA, msg('{"reqId":"' + i + 'p","type":"place_round","bet":1,"pick":"heads","quoteId":"' + qA.quoteId + '"}'), ctxA);
    handle(sB, msg('{"reqId":"' + i + 'p","type":"place_round","bet":1,"pick":"tails","quoteId":"' + qB.quoteId + '"}'), ctxB);
    resultsA.push(sA.openRound!.result);
    resultsB.push(sB.openRound!.result);
    handle(sA, msg('{"reqId":"' + i + 'a","type":"ack_round","roundId":"' + sA.openRound!.id + '"}'), ctxA);
    handle(sB, msg('{"reqId":"' + i + 'a","type":"ack_round","roundId":"' + sB.openRound!.id + '"}'), ctxB);
  }
  assert.deepEqual(resultsA, resultsB);
  const headsCount = resultsA.filter((r) => r === 'heads').length;
  const tailsCount = resultsA.filter((r) => r === 'tails').length;
  assert.ok(headsCount / 1000 >= 0.45 && headsCount / 1000 <= 0.55);
  assert.ok(tailsCount / 1000 >= 0.45 && tailsCount / 1000 <= 0.55);
});

test('internal-error fault', () => {
  const fixtureOn = mkFixture({ internalP: 1, latencyP: 0, dupP: 0, tierP: 0 });
  const fixtureOff = mkFixture({ internalP: 0, latencyP: 0, dupP: 0, tierP: 0 });

  const captured: Array<Record<string, unknown>> = [];
  const s1 = makeSession('alice', 0, fixtureOn);
  const ctx1 = makeCtx(fixtureOn, true, captured);
  handle(s1, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctx1);
  const out1 = handle(s1, msg('{"reqId":"p1","type":"place_round","bet":10,"pick":"heads","quoteId":"s_alice-q1"}'), ctx1);
  assert.equal(out1[0].type, 'error');
  assert.equal((out1[0] as any).code, 'INTERNAL');
  assert.equal((out1[0] as any).message, 'simulated failure');
  assert.equal(s1.balanceCents, 100000);
  assert.equal(s1.openRound, null);
  assert.deepEqual(captured, [{ kind: 'internal_error', sessionId: 's_alice', userId: 'alice', reqId: 'p1' }]);

  const s2 = makeSession('alice', 0, fixtureOff);
  const ctx2 = makeCtx(fixtureOff, true);
  handle(s2, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctx2);
  const out2 = handle(s2, msg('{"reqId":"p1","type":"place_round","bet":10,"pick":"heads","quoteId":"s_alice-q1"}'), ctx2);
  assert.equal(out2[0].type, 'round');
});

test('tier shift: shift on tick, apply shifted tier, revert after place', () => {
  const fixture = mkFixture({ tierP: 1, tierDelta: 0.05, internalP: 0, latencyP: 0, dupP: 0 });
  const s = makeSession('alice', 0, fixture);
  const ctx = makeCtx(fixture, true);

  const q1 = handle(s, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctx)[0];
  assert.equal(q1.type, 'quote');
  if (q1.type !== 'quote') throw new Error('expected quote reply');
  assert.equal(q1.quoteId, 's_alice-q1');
  assert.equal(q1.multiplier, 1.95);

  const q2 = handle(s, msg('{"reqId":"q2","type":"get_quote","bet":21}'), ctx)[0];
  assert.equal(q2.type, 'quote');
  if (q2.type !== 'quote') throw new Error('expected quote reply');
  assert.equal(q2.quoteId, 's_alice-q2');
  assert.equal(q2.multiplier, 1.90);

  const pushes = tierTick(s, ctx);
  assert.deepEqual(pushes, [
    { type: 'quote_changed', quoteId: 's_alice-q1', bet: 10, multiplier: 1.90 },
    { type: 'quote_changed', quoteId: 's_alice-q2', bet: 21, multiplier: 1.85 },
  ]);
  assert.equal(s.shiftH, 5);

  const out = handle(s, msg('{"reqId":"p1","type":"place_round","bet":10,"pick":"heads","quoteId":"s_alice-q1"}'), ctx);
  const first = out[0];
  assert.equal(first.type, 'round');
  if (first.type !== 'round') throw new Error('expected round reply');
  assert.equal(first.round.multiplier, 1.90);
  assert.ok(out.some((m) => m.type === 'balance_changed'));
  const last = out[out.length - 1];
  assert.equal(last.type, 'quote_changed');
  assert.deepEqual(last, { type: 'quote_changed', quoteId: 's_alice-q2', bet: 21, multiplier: 1.90 });
  assert.equal(s.shiftH, 0);
});

test('streak offered true/false', () => {
  const fixture = mkFixture();

  // (a) win with d1 < 0.5 on bet 10: payout 1950 cents, not whole dollars -> offered false, streak tier 1.95
  const ordA = findOrdinal((d0, d1) => d0 < 0.5 && d1 < 0.5, 'streak10');
  const sA = makeSession('streak10', ordA, fixture);
  const ctxA = makeCtx(fixture, false);
  handle(sA, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctxA);
  handle(sA, msg('{"reqId":"p1","type":"place_round","bet":10,"pick":"heads","quoteId":"s_alice-q1"}'), ctxA);
  assert.deepEqual(sA.openRound!.streak, { offered: false, multiplier: 1.95 });

  // (b) win with d1 < 0.5 on bet 20: payout 3900 cents = $39 -> offered true, streak tier for $39 is 1.90
  const ordB = findOrdinal((d0, d1) => d0 < 0.5 && d1 < 0.5, 'streak20');
  const sB = makeSession('streak20', ordB, fixture);
  const ctxB = makeCtx(fixture, false);
  handle(sB, msg('{"reqId":"q1","type":"get_quote","bet":20}'), ctxB);
  handle(sB, msg('{"reqId":"p1","type":"place_round","bet":20,"pick":"heads","quoteId":"s_alice-q1"}'), ctxB);
  assert.deepEqual(sB.openRound!.streak, { offered: true, multiplier: 1.90 });

  // (c) win with d1 >= 0.5 -> no streak field
  const ordC = findOrdinal((d0, d1) => d0 < 0.5 && d1 >= 0.5, 'streak10');
  const sC = makeSession('streak10', ordC, fixture);
  const ctxC = makeCtx(fixture, false);
  handle(sC, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctxC);
  handle(sC, msg('{"reqId":"p1","type":"place_round","bet":10,"pick":"heads","quoteId":"s_alice-q1"}'), ctxC);
  assert.equal(sC.openRound!.streak, undefined);

  // (d) loss (d0 >= 0.5) -> no streak field
  const ordD = findOrdinal((d0) => d0 >= 0.5, 'streak10');
  const sD = makeSession('streak10', ordD, fixture);
  const ctxD = makeCtx(fixture, false);
  handle(sD, msg('{"reqId":"q1","type":"get_quote","bet":10}'), ctxD);
  handle(sD, msg('{"reqId":"p1","type":"place_round","bet":10,"pick":"heads","quoteId":"s_alice-q1"}'), ctxD);
  assert.equal(sD.openRound!.streak, undefined);
});

test('welcome shape', () => {
  const w = welcome(makeSession(), 'h1', false);
  assert.deepEqual(w, {
    reqId: 'h1', type: 'welcome', sessionId: 's_alice', gameId: 'coinflip',
    userId: 'alice', balance: 1000, openRound: null, resumed: false,
  });
});
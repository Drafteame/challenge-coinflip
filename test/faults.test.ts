import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, connect } from './helpers.ts';
import type { Fixture } from '../src/config.ts';

function mkFixture(overrides: {
  latencyP?: number; internalP?: number; dropIntervalMs?: number; dropJitterMs?: number; tierP?: number; dupP?: number; seed?: string;
} = {}): Fixture {
  return {
    seed: overrides.seed ?? 'draftea-coinflip',
    startingBalance: 1000.0,
    tiers: [
      { upTo: 20, multiplier: 1.95 }, { upTo: 100, multiplier: 1.9 },
      { upTo: 500, multiplier: 1.85 }, { upTo: null, multiplier: 1.8 },
    ],
    faults: {
      latency: { probability: overrides.latencyP ?? 0.15, delayMs: 2000 },
      internalError: { probability: overrides.internalP ?? 1 / 15 },
      socketDrop: { intervalMs: overrides.dropIntervalMs ?? 180000, jitterMs: overrides.dropJitterMs ?? 30000 },
      tierShift: { probabilityPerMinute: overrides.tierP ?? 0.1, delta: 0.05 },
      duplicate: { probability: overrides.dupP ?? 0.05 },
    },
  };
}

function isType(frame: string, type: string): boolean {
  try { return (JSON.parse(frame) as { type?: unknown }).type === type; } catch { return false; }
}

test('latency delays the reply by 2000ms and logs a latency fault', async () => {
  const t = await startTestServer({
    fixture: mkFixture({ latencyP: 1, internalP: 0, dropIntervalMs: 3600000, dropJitterMs: 0, tierP: 0, dupP: 0 }),
    faults: true,
  });
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    // latencyP=1 delays the welcome itself, so handshake needs the clock too
    await t.waitForLog((l) => l.direction === 'in' && l.type === 'hello');
    t.clock.advance(2000);
    await c.next((m) => m.type === 'welcome');

    c.send('get_balance');
    await t.waitForLog((l) => l.direction === 'in' && l.type === 'get_balance');
    // the balance reply is still pending its 2000ms delay
    assert.ok(!c.frames.some((f) => isType(f, 'balance')));
    t.clock.advance(2000);
    await t.waitForLog((l) => l.fault === 'latency');
    const bal = await c.next((m) => m.type === 'balance');
    assert.equal(bal.balance, 1000);
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('internal error on place_round leaves no round and logs internal_error', async () => {
  const t = await startTestServer({
    fixture: mkFixture({ internalP: 1, latencyP: 0, dropIntervalMs: 3600000, dropJitterMs: 0, tierP: 0, dupP: 0 }),
    faults: true,
  });
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');
    c.send('get_quote', { bet: 10 });
    const q = await c.next((m) => m.type === 'quote');
    c.send('place_round', { bet: 10, pick: 'heads', quoteId: q.quoteId as string });
    const err = await c.next((m) => m.type === 'error');
    assert.equal(err.code, 'INTERNAL');
    assert.equal(err.message, 'simulated failure');
    await t.waitForLog((l) => l.fault === 'internal_error');
    c.send('get_balance');
    const bal = await c.next((m) => m.type === 'balance');
    assert.equal(bal.balance, 1000);
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('duplicate delivery sends the reply twice with the same reqId', async () => {
  const t = await startTestServer({
    fixture: mkFixture({ dupP: 1, latencyP: 0, internalP: 0, dropIntervalMs: 3600000, dropJitterMs: 0, tierP: 0 }),
    faults: true,
  });
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    c.send('get_balance');
    const b1 = await c.next((m) => m.type === 'balance');
    const b2 = await c.next((m) => m.type === 'balance');
    assert.equal(b1.reqId, b2.reqId);
    await t.waitForLog((l) => l.fault === 'duplicate');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('socket drop closes 1011 and logs drop', async () => {
  const t = await startTestServer({
    fixture: mkFixture({ dropIntervalMs: 1000, dropJitterMs: 0, latencyP: 0, internalP: 0, tierP: 0, dupP: 0 }),
    faults: true,
  });
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');
    t.clock.advance(1000);
    const closed = await c.closed;
    assert.equal(closed.code, 1011);
    assert.equal(closed.reason, 'simulated drop');
    await t.waitForLog((l) => l.fault === 'drop');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('tier shift pushes quote_changed after one minute', async () => {
  const t = await startTestServer({
    fixture: mkFixture({ tierP: 1, latencyP: 0, internalP: 0, dupP: 0, dropIntervalMs: 180000, dropJitterMs: 0 }),
    faults: true,
  });
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');
    // Quotes live 30s, the tier tick fires at 60s — so issue the quote shortly
    // before the minute boundary, otherwise it's pruned before the shift.
    t.clock.advance(55_000);
    c.send('get_quote', { bet: 10 });
    await t.waitForLog((l) => l.direction === 'in' && l.type === 'get_quote');
    const q = await c.next((m) => m.type === 'quote');
    assert.equal(q.multiplier, 1.95);
    t.clock.advance(5_000);
    const cc = await c.next((m) => m.type === 'quote_changed');
    assert.equal(cc.quoteId, q.quoteId);
    assert.equal(cc.bet, 10);
    assert.equal(cc.multiplier, 1.9);
    await t.waitForLog((l) => l.fault === 'tier_shift');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('--faults off suppresses every fault kind', async () => {
  const t = await startTestServer({
    fixture: mkFixture({ latencyP: 1, internalP: 1, tierP: 1, dupP: 1 }),
    faults: false,
  });
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome'); // no latency: arrives without advancing
    c.send('get_quote', { bet: 10 });
    const q = await c.next((m) => m.type === 'quote');
    assert.equal(q.multiplier, 1.95);
    t.clock.advance(240_000); // 4 simulated minutes: no drop, no tier shift
    c.send('ping');
    await c.next((m) => m.type === 'pong'); // socket is still open
    c.send('get_balance');
    await c.next((m) => m.type === 'balance');
    t.clock.advance(2000); // flush any pending pump before asserting
    assert.ok(!t.logs.some((l) => 'fault' in (JSON.parse(l) as object)));
    // no duplicate: exactly one balance frame was delivered
    assert.equal(c.frames.filter((f) => isType(f, 'balance')).length, 1);
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

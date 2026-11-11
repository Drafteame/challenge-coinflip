import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, connect } from './helpers.ts';
import type { Fixture } from '../src/config.ts';

function latency1Fixture(): Fixture {
  return {
    seed: 'draftea-coinflip',
    startingBalance: 1000.0,
    tiers: [
      { upTo: 20, multiplier: 1.95 }, { upTo: 100, multiplier: 1.9 },
      { upTo: 500, multiplier: 1.85 }, { upTo: null, multiplier: 1.8 },
    ],
    faults: {
      latency: { probability: 1, delayMs: 2000 },
      internalError: { probability: 0 },
      socketDrop: { intervalMs: 180000, jitterMs: 30000 },
      tierShift: { probabilityPerMinute: 0, delta: 0.05 },
      duplicate: { probability: 0 },
    },
  };
}

test('open round survives a socket drop and resumes', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  const welcome = await (async () => { c.send('hello', { clientVersion: '1' }); return c.next((m) => m.type === 'welcome'); })();
  const sessionId = welcome.sessionId as string;
  c.send('get_quote', { bet: 10 });
  const q = await c.next((m) => m.type === 'quote');
  c.send('place_round', { bet: 10, pick: 'heads', quoteId: q.quoteId });
  const roundMsg = await c.next((m) => m.type === 'round');
  const round = roundMsg.round as Record<string, any>;

  c.terminate();
  await t.waitForLog((l) => l.type === 'close' && l.direction === 'in' && l.sessionId === sessionId);

  const c2 = await connect(t.url('/games/coinflip?userId=alice&sessionId=' + sessionId));
  try {
    c2.send('hello', { clientVersion: '1' });
    const w2 = await c2.next((m) => m.type === 'welcome');
    assert.equal(w2.sessionId, sessionId);
    assert.equal(w2.resumed, true);
    assert.equal((w2.openRound as Record<string, any>).id, round.id);

    c2.send('get_open_round');
    const open = await c2.next((m) => m.type === 'open_round');
    assert.equal((open.round as Record<string, any>).id, round.id);

    c2.send('ack_round', { roundId: round.id });
    const acked = await c2.next((m) => m.type === 'acked');
    assert.equal(acked.roundId, round.id);
  } finally {
    c2.terminate();
    await t.srv.stop();
  }
});

test('buffered replies are re-sent on resume', async () => {
  const t = await startTestServer({ fixture: latency1Fixture(), faults: true });
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  c.send('hello', { clientVersion: '1' });
  await t.waitForLog((l) => l.direction === 'in' && l.type === 'hello');
  t.clock.advance(2000);
  const welcome = await c.next((m) => m.type === 'welcome');
  const sessionId = welcome.sessionId as string;

  c.send('get_balance');
  await t.waitForLog((l) => l.direction === 'in' && l.type === 'get_balance');

  c.terminate();
  await t.waitForLog((l) => l.type === 'close' && l.direction === 'in' && l.sessionId === sessionId);

  const c2 = await connect(t.url('/games/coinflip?userId=alice&sessionId=' + sessionId));
  try {
    c2.send('hello', { clientVersion: '1' });
    // The 'in' hello log is written before the session is resolved, so its
    // sessionId is null; the cursor has already consumed the first socket's
    // hello, so this matches the resumed socket's hello.
    await t.waitForLog((l) => l.direction === 'in' && l.type === 'hello');
    t.clock.advance(2000);
    const w2 = await c2.next((m) => m.type === 'welcome');
    assert.equal(w2.resumed, true);
    const bal = await c2.next((m) => m.type === 'balance');
    assert.equal(bal.balance, 1000);
  } finally {
    c2.terminate();
    await t.srv.stop();
  }
});

test('second socket replaces the first with session_replaced + 4009', async () => {
  const t = await startTestServer();
  const a = await connect(t.url('/games/coinflip?userId=alice'));
  a.send('hello', { clientVersion: '1' });
  const wa = await a.next((m) => m.type === 'welcome');
  const sessionId = wa.sessionId as string;

  const b = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    const replaced = await a.next((m) => m.type === 'session_replaced');
    assert.equal(replaced.type, 'session_replaced');
    const closed = await a.closed;
    assert.equal(closed.code, 4009);
    assert.equal(closed.reason, 'SESSION_REPLACED');

    b.send('hello', { clientVersion: '1' });
    const wb = await b.next((m) => m.type === 'welcome');
    assert.equal(wb.sessionId, sessionId);
    assert.equal(wb.resumed, true);
    assert.equal(wb.balance, 1000);
  } finally {
    a.terminate();
    b.terminate();
    await t.srv.stop();
  }
});

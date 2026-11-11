import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, connect } from './helpers.ts';

const EPOCH = Date.UTC(2026, 0, 1); // ManualClock default epoch

test('get_quote returns tier multiplier, quoteId and 30s expiry', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');

    c.send('get_quote', { bet: 10 });
    const q10 = await c.next((m) => m.type === 'quote');
    assert.equal(q10.bet, 10);
    assert.equal(q10.multiplier, 1.95);
    assert.equal(typeof q10.quoteId, 'string');
    assert.equal(q10.expiresAt, new Date(EPOCH + 30000).toISOString());

    c.send('get_quote', { bet: 100 });
    const q100 = await c.next((m) => m.type === 'quote');
    assert.equal(q100.multiplier, 1.9);

    c.send('get_quote', { bet: 500 });
    const q500 = await c.next((m) => m.type === 'quote');
    assert.equal(q500.multiplier, 1.85);

    c.send('get_quote', { bet: 5000 });
    const q5000 = await c.next((m) => m.type === 'quote');
    assert.equal(q5000.multiplier, 1.8);
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('get_quote rejects invalid bets', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');
    for (const bet of [0, 5001, 1.5]) {
      c.send('get_quote', { bet });
      const err = await c.next((m) => m.type === 'error');
      assert.equal(err.code, 'INVALID_BET');
    }
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('a new quote for the same bet replaces the old one', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');
    c.send('get_quote', { bet: 10 });
    const q1 = await c.next((m) => m.type === 'quote');
    c.send('get_quote', { bet: 10 });
    const q2 = await c.next((m) => m.type === 'quote');
    assert.notEqual(q1.quoteId, q2.quoteId);
    // placing with the old id must fail
    c.send('place_round', { bet: 10, pick: 'heads', quoteId: q1.quoteId });
    const err = await c.next((m) => m.type === 'error');
    assert.equal(err.code, 'QUOTE_EXPIRED');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('placing with an expired quote returns QUOTE_EXPIRED', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');
    c.send('get_quote', { bet: 10 });
    const q = await c.next((m) => m.type === 'quote');
    await t.waitForLog((l) => l.direction === 'in' && l.type === 'get_quote' && l.reqId !== null);
    t.clock.advance(30_001);
    c.send('place_round', { bet: 10, pick: 'heads', quoteId: q.quoteId });
    const err = await c.next((m) => m.type === 'error');
    assert.equal(err.code, 'QUOTE_EXPIRED');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

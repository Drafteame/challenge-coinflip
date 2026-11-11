import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, connect } from './helpers.ts';

test('place deducts balance, ack credits payout only', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');

    c.send('get_quote', { bet: 10 });
    const q = await c.next((m) => m.type === 'quote');
    c.send('place_round', { bet: 10, pick: 'heads', quoteId: q.quoteId });
    const roundMsg = await c.next((m) => m.type === 'round');
    const round = roundMsg.round as Record<string, any>;
    assert.equal(round.bet, 10);
    assert.equal(round.pick, 'heads');
    assert.equal(round.multiplier, 1.95);
    assert.equal(round.state, 'open');
    assert.ok(round.result === 'heads' || round.result === 'tails');
    const win = round.result === round.pick;
    const expectedPayout = win ? 19.5 : 0;
    assert.equal(round.payout, expectedPayout);

    const bc = await c.next((m) => m.type === 'balance_changed');
    assert.equal(bc.balance, 990); // deduction

    c.send('ack_round', { roundId: round.id });
    const acked = await c.next((m) => m.type === 'acked');
    assert.equal(acked.roundId, round.id);
    assert.equal(acked.balance, 990 + expectedPayout); // credit only on ack

    c.send('get_balance');
    const bal = await c.next((m) => m.type === 'balance');
    assert.equal(bal.balance, 990 + expectedPayout);

    c.send('get_open_round');
    const open = await c.next((m) => m.type === 'open_round');
    assert.equal(open.round, null);
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('second place_round while one is open returns ROUND_OPEN', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');
    c.send('get_quote', { bet: 10 });
    const q1 = await c.next((m) => m.type === 'quote');
    c.send('place_round', { bet: 10, pick: 'heads', quoteId: q1.quoteId });
    await c.next((m) => m.type === 'round');

    c.send('get_quote', { bet: 10 });
    const q2 = await c.next((m) => m.type === 'quote');
    c.send('place_round', { bet: 10, pick: 'heads', quoteId: q2.quoteId });
    const err = await c.next((m) => m.type === 'error');
    assert.equal(err.code, 'ROUND_OPEN');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('bet above balance returns INSUFFICIENT_BALANCE', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1' });
    await c.next((m) => m.type === 'welcome');
    c.send('get_quote', { bet: 5000 });
    const q = await c.next((m) => m.type === 'quote');
    c.send('place_round', { bet: 5000, pick: 'heads', quoteId: q.quoteId });
    const err = await c.next((m) => m.type === 'error');
    assert.equal(err.code, 'INSUFFICIENT_BALANCE');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

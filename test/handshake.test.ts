import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, connect } from './helpers.ts';

test('welcome shape after hello', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1.0' });
    const welcome = await c.next((m) => m.type === 'welcome');
    assert.equal(welcome.gameId, 'coinflip');
    assert.equal(welcome.userId, 'alice');
    assert.equal(welcome.balance, 1000);
    assert.equal(welcome.resumed, false);
    assert.equal(typeof welcome.sessionId, 'string');
    assert.ok((welcome.sessionId as string).startsWith('s_'));
    assert.equal(welcome.openRound, null);
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('first non-hello message => hello required + close 4002', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('get_balance');
    const err = await c.next((m) => m.type === 'error');
    assert.equal(err.code, 'INTERNAL');
    assert.equal(err.message, 'hello required');
    const closed = await c.closed;
    assert.equal(closed.code, 4002);
    assert.equal(closed.reason, 'HELLO_REQUIRED');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('unknown game closes 4004', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/roulette?userId=alice'));
  try {
    const closed = await c.closed;
    assert.equal(closed.code, 4004);
    assert.equal(closed.reason, 'UNKNOWN_GAME');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('missing user closes 4001', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip'));
  try {
    const closed = await c.closed;
    assert.equal(closed.code, 4001);
    assert.equal(closed.reason, 'MISSING_USER');
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

test('ping is answered with pong', async () => {
  const t = await startTestServer();
  const c = await connect(t.url('/games/coinflip?userId=alice'));
  try {
    c.send('hello', { clientVersion: '1.0' });
    await c.next((m) => m.type === 'welcome');
    const reqId = c.send('ping');
    const pong = await c.next((m) => m.type === 'pong');
    assert.equal(pong.reqId, reqId);
  } finally {
    c.terminate();
    await t.srv.stop();
  }
});

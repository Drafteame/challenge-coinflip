import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, connect } from './helpers.ts';
import type { TestServer } from './helpers.ts';

// Runs the same script against a server and returns the byte-joined client
// frames and server logs. Every step advances the clock 2000ms after the
// request so any latency fault is flushed and each reply is observed; the
// total advance stays well under the 60s tier tick and 180s drop.
async function runTranscript(t: TestServer, userId: string): Promise<{ frames: string; logs: string }> {
  const c = await connect(t.url('/games/coinflip?userId=' + userId));
  // hello
  c.send('hello', { clientVersion: '1' });
  await t.waitForLog((l) => l.direction === 'in' && l.type === 'hello');
  t.clock.advance(2000);
  await c.next((m) => m.type === 'welcome');
  // quote
  c.send('get_quote', { bet: 10 });
  await t.waitForLog((l) => l.direction === 'in' && l.type === 'get_quote');
  t.clock.advance(2000);
  const quote = await c.next((m) => m.type === 'quote');
  // place (may fault into internal error)
  c.send('place_round', { bet: 10, pick: 'heads', quoteId: quote.quoteId as string });
  await t.waitForLog((l) => l.direction === 'in' && l.type === 'place_round');
  t.clock.advance(2000);
  const placed = await c.next((m) => m.type === 'round' || m.type === 'error');
  if (placed.type === 'round') {
    c.send('ack_round', { roundId: (placed.round as Record<string, unknown>).id as string });
    await t.waitForLog((l) => l.direction === 'in' && l.type === 'ack_round');
    t.clock.advance(2000);
    await c.next((m) => m.type === 'acked');
  }
  // ping + get_balance
  c.send('ping');
  await t.waitForLog((l) => l.direction === 'in' && l.type === 'ping');
  t.clock.advance(2000);
  await c.next((m) => m.type === 'pong');
  c.send('get_balance');
  await t.waitForLog((l) => l.direction === 'in' && l.type === 'get_balance');
  t.clock.advance(2000);
  await c.next((m) => m.type === 'balance');
  // close
  c.terminate();
  await t.waitForLog((l) => l.type === 'close' && l.direction === 'in');
  return { frames: c.frames.join('\n'), logs: t.logs.join('\n') };
}

test('same seed + same script => byte-identical transcript', async () => {
  const a = await startTestServer({ faults: true });
  let r1: { frames: string; logs: string };
  try {
    r1 = await runTranscript(a, 'bob');
  } finally {
    await a.srv.stop();
  }
  const b = await startTestServer({ faults: true });
  let r2: { frames: string; logs: string };
  try {
    r2 = await runTranscript(b, 'bob');
  } finally {
    await b.srv.stop();
  }
  assert.equal(r1.frames, r2.frames);
  assert.equal(r1.logs, r2.logs);
});

test('different seed => different transcript', async () => {
  const c1 = await startTestServer({ seed: 'seed-one', faults: true });
  let s1: { frames: string; logs: string };
  try {
    s1 = await runTranscript(c1, 'bob');
  } finally {
    await c1.srv.stop();
  }
  const c2 = await startTestServer({ seed: 'seed-two', faults: true });
  let s2: { frames: string; logs: string };
  try {
    s2 = await runTranscript(c2, 'bob');
  } finally {
    await c2.srv.stop();
  }
  assert.notEqual(s1.frames, s2.frames);
});

import { WebSocket } from 'ws';
import { loadFixture } from '../src/config.ts';
import { startServer } from '../src/server.ts';

const TIMEOUT_MS = 5000;

type Frame = Record<string, unknown>;

type Client = {
  ws: WebSocket;
  next: (pred: (m: Frame) => boolean, label: string) => Promise<Frame>;
  send: (type: string, body?: Frame) => string;
};

function makeClient(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox: Frame[] = [];
    const waiters: Array<{ pred: (m: Frame) => boolean; res: (m: Frame) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
    let seq = 0;
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as Frame;
      inbox.push(m);
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(m)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.res(m);
          break;
        }
      }
    });
    ws.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
    ws.on('open', () => {
      resolve({
        ws,
        next(pred, label) {
          const i = inbox.findIndex(pred);
          if (i >= 0) {
            const m = inbox.splice(i, 1)[0];
            return Promise.resolve(m);
          }
          return new Promise<Frame>((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timeout: ' + label)), TIMEOUT_MS);
            waiters.push({ pred, res, rej, timer });
          });
        },
        send(type, body = {}) {
          const reqId = 'd' + (++seq);
          ws.send(JSON.stringify({ reqId, type, ...body }));
          return reqId;
        },
      });
    });
  });
}

function fail(msg: string): never {
  console.error('DEMO FAILED: ' + msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const fixture = loadFixture('fixtures/default.json');
  const srv = await startServer({ fixture, seed: fixture.seed, faults: false, port: 0 });
  let c: Client;
  let c2: Client;
  try {
    c = await makeClient(`ws://127.0.0.1:${srv.port}/games/coinflip?userId=demo`);

    c.send('hello', { clientVersion: 'seed-demo' });
    const welcome = await c.next((m) => m.type === 'welcome', 'welcome');
    const sessionId = welcome.sessionId as string;
    console.log('connected: session ' + sessionId + ' balance ' + welcome.balance);

    c.send('get_quote', { bet: 10 });
    const quote = await c.next((m) => m.type === 'quote', 'quote');
    console.log('quote: bet 10 multiplier ' + quote.multiplier);

    c.send('place_round', { bet: 10, pick: 'heads', quoteId: quote.quoteId as string });
    const roundMsg = await c.next((m) => m.type === 'round', 'round');
    const round = roundMsg.round as Frame;
    console.log('round: ' + String(round.id) + ' result ' + String(round.result) + ' payout ' + String(round.payout));

    // simulate a client drop, then reconnect with the session
    c.ws.terminate();
    await new Promise((r) => setTimeout(r, 50));

    c2 = await makeClient(`ws://127.0.0.1:${srv.port}/games/coinflip?userId=demo&sessionId=${sessionId}`);
    c2.send('hello', { clientVersion: 'seed-demo' });
    const welcome2 = await c2.next((m) => m.type === 'welcome', 'reconnect welcome');
    if (welcome2.resumed !== true) fail('expected resumed:true after reconnect, got ' + String(welcome2.resumed));
    if ((welcome2.openRound as Frame).id !== round.id) fail('open round did not survive the drop');

    c2.send('ack_round', { roundId: round.id as string });
    const acked = await c2.next((m) => m.type === 'acked', 'ack');
    const win = round.result === 'heads';
    const expected = win ? 1000 - 10 + 19.5 : 1000 - 10;
    if (acked.balance !== expected) fail('unexpected final balance ' + String(acked.balance) + ' != ' + String(expected));
    console.log('acked: final balance ' + String(acked.balance));

    c2.ws.terminate();
    await srv.stop();
    console.log('DEMO OK');
    process.exit(0);
  } catch (err) {
    console.error('DEMO FAILED: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

main();
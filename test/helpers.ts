import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ManualClock } from '../src/clock.ts';
import { makeLog } from '../src/log.ts';
import type { Log } from '../src/log.ts';
import { loadFixture } from '../src/config.ts';
import type { Fixture } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import type { StartedServer } from '../src/server.ts';

export type ClientHandle = {
  ws: WebSocket;
  frames: string[];
  closed: Promise<{ code: number; reason: string }>;
  send(type: string, body?: Record<string, unknown>): string;
  next(pred: (msg: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  terminate(): void;
};

export function connect(url: string): Promise<ClientHandle> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames: string[] = [];
    const parsed: Record<string, unknown>[] = [];
    let readIndex = 0;
    const waiters: Array<() => void> = [];
    let seq = 0;
    let closeResolve!: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((res) => { closeResolve = res; });
    ws.on('message', (data) => {
      const text = data.toString();
      frames.push(text);
      parsed.push(JSON.parse(text) as Record<string, unknown>);
      for (const wake of waiters.slice()) wake();
    });
    ws.on('close', (code, reason) => closeResolve({ code, reason: reason.toString() }));
    ws.on('error', () => {});
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        closed,
        send(type, body = {}) {
          const reqId = 'r' + (++seq);
          ws.send(JSON.stringify({ reqId, type, ...body }));
          return reqId;
        },
        next(pred, timeoutMs = 2000) {
          const scan = (): Record<string, unknown> | null => {
            for (; readIndex < parsed.length; readIndex++) {
              if (pred(parsed[readIndex])) {
                const m = parsed[readIndex];
                readIndex++;
                return m;
              }
            }
            return null;
          };
          const found = scan();
          if (found !== null) return Promise.resolve(found);
          return new Promise<Record<string, unknown>>((res, rej) => {
            const wake = () => {
              const m = scan();
              if (m !== null) {
                cleanup();
                res(m);
              }
            };
            const timer = setTimeout(() => {
              cleanup();
              rej(new Error('next(): timeout waiting for message'));
            }, timeoutMs);
            const cleanup = () => {
              clearTimeout(timer);
              const i = waiters.indexOf(wake);
              if (i >= 0) waiters.splice(i, 1);
            };
            waiters.push(wake);
          });
        },
        terminate() { ws.terminate(); },
      });
    });
  });
}

export type TestServer = {
  srv: StartedServer;
  clock: ManualClock;
  logs: string[];
  url: (path: string) => string;
  waitForLog: (pred: (line: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
};

export async function startTestServer(opts: { fixture?: Fixture; seed?: string; faults?: boolean } = {}): Promise<TestServer> {
  const clock = new ManualClock();
  const logs: string[] = [];
  const log: Log = makeLog((line) => logs.push(line));
  const fixture = opts.fixture ?? loadFixture(join(process.cwd(), 'fixtures', 'default.json'));
  const seed = opts.seed ?? fixture.seed;
  const faultsFlag = opts.faults ?? false;
  const srv = await startServer({ fixture, seed, faults: faultsFlag, port: 0, host: '127.0.0.1', clock, log });
  let cursor = 0;
  async function waitForLog(pred: (line: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const start = Date.now();
    for (;;) {
      for (; cursor < logs.length; cursor++) {
        const parsed = JSON.parse(logs[cursor]) as Record<string, unknown>;
        if (pred(parsed)) { cursor++; return parsed; }
      }
      if (Date.now() - start > timeoutMs) throw new Error('waitForLog timeout');
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  return { srv, clock, logs, url: (path) => `ws://127.0.0.1:${srv.port}${path}`, waitForLog };
}

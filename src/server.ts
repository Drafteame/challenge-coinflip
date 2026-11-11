import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { Fixture } from './config.ts';
import { makeFaults } from './faults.ts';
import { newSession, welcome, parse, handle, tierTick } from './engine.ts';
import type { Session } from './engine.ts';
import { fnv1a } from './prng.ts';
import type { Clock } from './clock.ts';
import { realClock } from './clock.ts';
import { makeLog } from './log.ts';
import type { Log } from './log.ts';
import type { ServerMessage, ServerReply, ServerPush } from './protocol.ts';

const SESSION_TTL_MS = 30 * 60 * 1000;

type Queued = {
  frame: string;
  type: string;
  reqId: string | null;
  notBefore: number;
  seq: number | null;
  repl: boolean;
};

type Conn = {
  ws: WebSocket;
  userId: string | null;
  session: Session | null;
  querySessionId: string | null;
  inherited: boolean;
  welcomed: boolean;
  selfClosed: boolean;
  queue: Queued[];
  timers: Set<() => void>;
  pumpTimer: (() => void) | null;
};

export type ServerOptions = {
  fixture: Fixture;
  seed: string;
  faults: boolean;
  port: number;
  host?: string;
  clock?: Clock;
  log?: Log;
};

export type StartedServer = {
  port: number;
  url: () => string;
  stop: () => Promise<void>;
};

export function startServer(o: ServerOptions): Promise<StartedServer> {
  const clock: Clock = o.clock ?? realClock;
  const log: Log = o.log ?? makeLog();
  const faults = makeFaults(o.fixture.faults, o.faults);

  const sessions = new Map<string, Session>();
  const userOrdinal = new Map<string, number>();
  const activeByUser = new Map<string, string>();
  const conns = new Map<string, Conn>();

  function hex8(n: number): string { return n.toString(16).padStart(8, '0'); }

  function nextOrdinal(userId: string): number {
    const n = userOrdinal.get(userId) ?? 0;
    userOrdinal.set(userId, n + 1);
    return n;
  }

  function sessionIdFor(userId: string, ordinal: number): string {
    const base = `${o.seed}|${userId}|${ordinal}|session`;
    let id = 's_' + hex8(fnv1a(base));
    let k = 0;
    while (sessions.has(id)) {
      k += 1;
      id = 's_' + hex8(fnv1a(base + '#' + k));
    }
    return id;
  }

  function freshSession(userId: string): Session {
    const ordinal = nextOrdinal(userId);
    const id = sessionIdFor(userId, ordinal);
    const s = newSession(id, userId, ordinal, o.seed, o.fixture);
    sessions.set(id, s);
    return s;
  }

  function expired(s: Session, now: number): boolean {
    return s.closedAt !== null && now - s.closedAt >= SESSION_TTL_MS;
  }

  function sweep(now: number): void {
    for (const [id, s] of sessions) {
      if (expired(s, now) && !conns.has(id)) sessions.delete(id);
    }
  }

  function faultLog(kind: string, session: Session | null, reqId: string | null, now: number, detail?: Record<string, unknown>): void {
    log.fault({
      kind,
      userId: session?.userId ?? null,
      sessionId: session?.id ?? null,
      reqId,
      timestamp: now,
      ...(detail ? { detail } : {}),
    });
  }

  const engineFault = (kind: string, sessionId: string, userId: string, reqId: string | null, detail?: Record<string, unknown>): void => {
    log.fault({ kind, userId, sessionId, reqId, timestamp: clock.now(), ...(detail ? { detail } : {}) });
  };

  function ctxFor(session: Session, now: number) {
    return { fixture: o.fixture, now, faults, fault: engineFault };
  }

  function frameFor(msg: ServerMessage): string {
    const obj = msg as unknown as Record<string, unknown>;
    if (typeof obj['reqId'] === 'string') {
      const { reqId, type, ...rest } = obj;
      return JSON.stringify({ reqId, type, ...rest });
    }
    const { type, ...rest } = obj;
    return JSON.stringify({ type, ...rest });
  }

  function errorReply(reqId: string | undefined, message: string): ServerReply {
    return reqId === undefined
      ? { type: 'error', code: 'INTERNAL', message }
      : { reqId, type: 'error', code: 'INTERNAL', message };
  }

  function closeWith(conn: Conn, code: number, reason: string): void {
    if (conn.selfClosed) return;
    conn.selfClosed = true;
    log.close({
      direction: 'out',
      userId: conn.userId,
      sessionId: conn.session?.id ?? null,
      code,
      reason,
      timestamp: clock.now(),
    });
    conn.ws.close(code, reason);
  }

  function cancelTimers(conn: Conn): void {
    for (const c of conn.timers) c();
    conn.timers.clear();
    if (conn.pumpTimer) { conn.pumpTimer(); conn.pumpTimer = null; }
  }

  function write(conn: Conn, session: Session, entry: Queued, now: number): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(entry.frame, (err?: Error): void => {
      if (!err && entry.seq !== null) session.writtenSeq = Math.max(session.writtenSeq, entry.seq);
    });
    log.message({
      direction: 'out',
      userId: session.userId,
      sessionId: session.id,
      type: entry.type,
      reqId: entry.reqId,
      timestamp: now,
      ...(entry.repl ? { extra: { replayed: true } } : {}),
    });
  }

  function schedulePump(conn: Conn, ms: number): void {
    if (conn.pumpTimer) conn.pumpTimer();
    const c = clock.schedule(ms, () => {
      conn.pumpTimer = null;
      const s = conn.session;
      if (s !== null && conns.get(s.id) === conn) pump(conn, s, clock.now());
    });
    conn.pumpTimer = c;
  }

  function pump(conn: Conn, session: Session, now: number): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    for (;;) {
      const head = conn.queue[0];
      if (head === undefined) return;
      if (head.notBefore > now) {
        schedulePump(conn, head.notBefore - now);
        return;
      }
      conn.queue.shift();
      write(conn, session, head, now);
    }
  }

  function enqueueEntry(conn: Conn, session: Session, entry: Queued, now: number): void {
    conn.queue.push(entry);
    pump(conn, session, now);
  }

  function enqueueReply(conn: Conn, session: Session, reply: ServerReply, now: number): void {
    const frame = frameFor(reply);
    let delay = 0;
    let dup = false;
    if (faults.enabled) {
      delay = faults.latencyMs(session);
      dup = faults.duplicate(session);
    }
    const reqId = typeof reply.reqId === 'string' ? reply.reqId : null;
    if (delay > 0) faultLog('latency', session, reqId, now, { delayMs: delay });
    let seq: number | null = null;
    if (reqId !== null && reply.type !== 'welcome') {
      session.seq += 1;
      seq = session.seq;
      session.replay.push({ seq, reqId, frame });
      if (session.replay.length > 50) session.replay.shift();
    }
    const entry: Queued = { frame, type: reply.type, reqId, notBefore: now + delay, seq, repl: false };
    enqueueEntry(conn, session, entry, now);
    if (dup) {
      faultLog('duplicate', session, reqId, now);
      enqueueEntry(conn, session, { frame, type: reply.type, reqId, notBefore: now + delay, seq, repl: false }, now);
    }
  }

  function enqueuePush(conn: Conn, session: Session, push: ServerPush, now: number): void {
    const frame = frameFor(push);
    enqueueEntry(conn, session, { frame, type: push.type, reqId: null, notBefore: now, seq: null, repl: false }, now);
  }

  function enqueueReplay(conn: Conn, session: Session, now: number): void {
    for (const e of session.replay) {
      if (e.seq > session.writtenSeq) {
        const type = (JSON.parse(e.frame) as { type: string }).type;
        conn.queue.push({ frame: e.frame, type, reqId: e.reqId, notBefore: now, seq: e.seq, repl: true });
      }
    }
    pump(conn, session, now);
  }

  function startTimers(conn: Conn): void {
    const session = conn.session;
    if (session === null || !faults.enabled) return;
    const dropDelay = faults.dropAfterMs(session);
    if (dropDelay !== null) {
      const c = clock.schedule(dropDelay, () => {
        conn.timers.delete(c);
        if (conns.get(session.id) !== conn) return;
        faultLog('drop', session, null, clock.now());
        closeWith(conn, 1011, 'simulated drop');
      });
      conn.timers.add(c);
    }
    const tick = (): void => {
      const c = clock.schedule(60_000, () => {
        conn.timers.delete(c);
        if (conn.session === null || conns.get(session.id) !== conn) return;
        const pushes = tierTick(session, ctxFor(session, clock.now()));
        for (const p of pushes) enqueuePush(conn, session, p, clock.now());
        tick();
      });
      conn.timers.add(c);
    };
    tick();
  }

  function sendSessionReplaced(oldConn: Conn): void {
    const frame = JSON.stringify({ type: 'session_replaced' });
    log.message({
      direction: 'out',
      userId: oldConn.userId,
      sessionId: oldConn.session?.id ?? null,
      type: 'session_replaced',
      reqId: null,
      timestamp: clock.now(),
    });
    // Mark server-initiated before the async send so onClose never logs a
    // spurious 'in' close, and log the 'out' 4009 close ourselves.
    oldConn.selfClosed = true;
    log.close({
      direction: 'out',
      userId: oldConn.userId,
      sessionId: oldConn.session?.id ?? null,
      code: 4009,
      reason: 'SESSION_REPLACED',
      timestamp: clock.now(),
    });
    if (oldConn.ws.readyState === WebSocket.OPEN) {
      oldConn.ws.send(frame, () => oldConn.ws.close(4009, 'SESSION_REPLACED'));
    } else {
      oldConn.ws.close(4009, 'SESSION_REPLACED');
    }
  }

  function doHello(conn: Conn, reqId: string): void {
    const now = clock.now();
    let session: Session;
    let resumed = false;
    if (conn.inherited && conn.session !== null) {
      session = conn.session;
      resumed = true;
    } else {
      const q = conn.querySessionId;
      if (q !== null) {
        const known = sessions.get(q);
        if (known !== undefined && known.userId === conn.userId && !expired(known, now) && !conns.has(q)) {
          session = known;
          resumed = true;
        } else {
          session = freshSession(conn.userId as string);
          resumed = false;
        }
      } else {
        session = freshSession(conn.userId as string);
        resumed = false;
      }
    }
    conn.session = session;
    conn.welcomed = true;
    conns.set(session.id, conn);
    activeByUser.set(conn.userId as string, session.id);
    enqueueReply(conn, session, welcome(session, reqId, resumed), now);
    enqueueReplay(conn, session, now);
    startTimers(conn);
  }

  function preHelloRequired(conn: Conn, reqId: string | null, now: number): void {
    const frame = frameFor(errorReply(reqId ?? undefined, 'hello required'));
    log.message({
      direction: 'out',
      userId: conn.userId,
      sessionId: conn.session?.id ?? null,
      type: 'error',
      reqId,
      timestamp: now,
    });
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(frame, () => closeWith(conn, 4002, 'HELLO_REQUIRED'));
    } else {
      closeWith(conn, 4002, 'HELLO_REQUIRED');
    }
  }

  function onMessage(conn: Conn, data: Buffer, isBinary: boolean): void {
    const now = clock.now();
    const session = conn.session;

    if (!conn.welcomed) {
      const raw = isBinary ? null : data.toString();
      const p = raw === null
        ? { ok: false as const, reqId: undefined as string | undefined, message: 'malformed JSON' }
        : parse(raw);
      const inType = p.ok ? p.msg.type : null;
      const inReqId = p.ok ? p.msg.reqId : (p.reqId ?? null);
      log.message({ direction: 'in', userId: conn.userId, sessionId: session?.id ?? null, type: inType, reqId: inReqId, timestamp: now });
      if (p.ok && p.msg.type === 'hello') {
        doHello(conn, p.msg.reqId);
      } else {
        preHelloRequired(conn, inReqId, now);
      }
      return;
    }

    if (session === null || conns.get(session.id) !== conn) return;

    const raw = isBinary ? null : data.toString();
    const p = raw === null
      ? { ok: false as const, reqId: undefined as string | undefined, message: 'malformed JSON' }
      : parse(raw);
    const inType = p.ok ? p.msg.type : null;
    const inReqId = p.ok ? p.msg.reqId : (p.reqId ?? null);
    log.message({ direction: 'in', userId: conn.userId, sessionId: session.id, type: inType, reqId: inReqId, timestamp: now });

    if (!p.ok) {
      enqueueReply(conn, session, errorReply(p.reqId, p.message), now);
      return;
    }
    const frames = handle(session, p.msg, ctxFor(session, now));
    enqueueReply(conn, session, frames[0] as ServerReply, now);
    for (let i = 1; i < frames.length; i++) {
      enqueuePush(conn, session, frames[i] as ServerPush, now);
    }
  }

  function onClose(conn: Conn, code: number, reasonBuf: Buffer): void {
    const reason = reasonBuf !== null && reasonBuf !== undefined ? reasonBuf.toString() : '';
    const now = clock.now();
    const session = conn.session;
    if (!conn.selfClosed) {
      log.close({ direction: 'in', userId: conn.userId, sessionId: session?.id ?? null, code, reason, timestamp: now });
    }
    if (session !== null && conns.get(session.id) === conn) {
      conns.delete(session.id);
      activeByUser.delete(conn.userId as string);
      session.closedAt = now;
    }
    cancelTimers(conn);
  }

  function parseGameUrl(url: string): { gameId: string; userId?: string; sessionId?: string } | null {
    const qIndex = url.indexOf('?');
    const path = qIndex === -1 ? url : url.slice(0, qIndex);
    const m = /^\/games\/([^/?]+)\/?$/.exec(path);
    if (m === null) return null;
    let gameId: string;
    try { gameId = decodeURIComponent(m[1]); } catch { gameId = m[1]; }
    const qs = qIndex === -1 ? '' : url.slice(qIndex + 1);
    const params = new URLSearchParams(qs);
    const userId = params.get('userId');
    const sessionId = params.get('sessionId');
    const out: { gameId: string; userId?: string; sessionId?: string } = { gameId };
    if (userId !== null) out.userId = userId;
    if (sessionId !== null) out.sessionId = sessionId;
    return out;
  }

  function handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const u = parseGameUrl(req.url ?? '');
    const conn: Conn = {
      ws, userId: null, session: null, querySessionId: null, inherited: false,
      welcomed: false, selfClosed: false, queue: [], timers: new Set(), pumpTimer: null,
    };
    if (u === null || u.gameId !== 'coinflip') {
      closeWith(conn, 4004, 'UNKNOWN_GAME');
      return;
    }
    if (u.userId === undefined || u.userId === '') {
      closeWith(conn, 4001, 'MISSING_USER');
      return;
    }
    conn.userId = u.userId;
    conn.querySessionId = u.sessionId ?? null;

    const activeSid = activeByUser.get(conn.userId);
    if (activeSid !== undefined) {
      const old = conns.get(activeSid);
      if (old !== undefined && old !== conn) {
        const oldSession = sessions.get(activeSid);
        cancelTimers(old);
        old.queue = [];
        conns.set(activeSid, conn);
        conn.session = oldSession ?? null;
        conn.inherited = true;
        sendSessionReplaced(old);
      }
    }

    sweep(clock.now());

    ws.on('message', (data, isBinary) => onMessage(conn, data as Buffer, isBinary));
    ws.on('close', (code, reason) => onClose(conn, code, reason as Buffer));
    ws.on('error', () => {});
  }

  function serveClient(res: ServerResponse): void {
    try {
      const html = readFileSync(join(process.cwd(), 'client', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('client/index.html not found\n');
    }
  }

  const app = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      serveClient(res);
    } else {
      res.writeHead(404);
      res.end('not found\n');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  app.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => handleConnection(ws, req));

  return new Promise((resolve, reject) => {
    app.on('error', reject);
    app.listen(o.port, o.host ?? '127.0.0.1', () => {
      const addr = app.address() as AddressInfo;
      const port = addr.port;
      resolve({
        port,
        url: () => `ws://127.0.0.1:${port}/games/coinflip`,
        stop: () => new Promise((res) => {
          for (const c of conns.values()) { try { c.ws.terminate(); } catch { /* ignore */ } }
          wss.close();
          app.close(() => res());
        }),
      });
    });
  });
}

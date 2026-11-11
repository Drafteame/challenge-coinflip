export type MessageField = {
  direction: 'in' | 'out';
  userId: string | null;
  sessionId: string | null;
  type: string | null;
  reqId: string | null;
  timestamp: number;
  extra?: Record<string, unknown>;
};

export type FaultField = {
  kind: string;
  userId: string | null;
  sessionId: string | null;
  reqId: string | null;
  timestamp: number;
  detail?: Record<string, unknown>;
};

export type CloseField = {
  direction: 'in' | 'out';
  userId: string | null;
  sessionId: string | null;
  code: number;
  reason: string;
  timestamp: number;
};

export type Log = {
  message(d: MessageField): void;
  fault(d: FaultField): void;
  close(d: CloseField): void;
};

export function makeLog(write: (line: string) => void = (line) => { process.stdout.write(line + '\n'); }): Log {
  return {
    message(d) {
      const o: Record<string, unknown> = {
        direction: d.direction, userId: d.userId, sessionId: d.sessionId, type: d.type, reqId: d.reqId, timestamp: d.timestamp,
      };
      if (d.extra !== undefined) Object.assign(o, d.extra);
      write(JSON.stringify(o));
    },
    fault(d) {
      const o: Record<string, unknown> = {
        fault: d.kind, userId: d.userId, sessionId: d.sessionId, reqId: d.reqId, timestamp: d.timestamp,
      };
      if (d.detail !== undefined) Object.assign(o, d.detail);
      write(JSON.stringify(o));
    },
    close(d) {
      const o: Record<string, unknown> = {
        direction: d.direction, userId: d.userId, sessionId: d.sessionId, type: 'close', reqId: null, timestamp: d.timestamp, code: d.code, reason: d.reason,
      };
      write(JSON.stringify(o));
    },
  };
}

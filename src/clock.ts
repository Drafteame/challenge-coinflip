export type Cancel = () => void;

export interface Clock {
  now(): number;
  schedule(ms: number, fn: () => void): Cancel;
}

export const realClock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export class ManualClock implements Clock {
  private t: number;
  private nextId = 0;
  private due: { id: number; at: number; fn: () => void }[] = [];

  constructor(epochMs: number = Date.UTC(2026, 0, 1)) {
    this.t = epochMs;
  }

  now(): number {
    return this.t;
  }

  schedule(ms: number, fn: () => void): Cancel {
    const id = ++this.nextId;
    const at = this.t + ms;
    this.due.push({ id, at, fn });
    return () => {
      this.due = this.due.filter((e) => e.id !== id);
    };
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let earliest = -1;
      let earliestAt = Infinity;
      for (let i = 0; i < this.due.length; i++) {
        if (this.due[i].at <= target && this.due[i].at < earliestAt) {
          earliest = i;
          earliestAt = this.due[i].at;
        }
      }
      if (earliest === -1) break;
      const entry = this.due.splice(earliest, 1)[0];
      this.t = entry.at;
      entry.fn();
    }
    this.t = target;
  }
}

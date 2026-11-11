import type { FaultConfig } from './config.ts';
import type { Session } from './engine.ts';

export type Faults = {
  enabled: boolean;
  internalError(s: Session): boolean;
  latencyMs(s: Session): number;
  duplicate(s: Session): boolean;
  dropAfterMs(s: Session): number | null;
  tierShift(s: Session): boolean;
};

export function makeFaults(cfg: FaultConfig, enabled: boolean): Faults {
  if (!enabled) {
    return {
      enabled: false,
      internalError: () => false,
      latencyMs: () => 0,
      duplicate: () => false,
      dropAfterMs: () => null,
      tierShift: () => false,
    };
  }
  return {
    enabled: true,
    internalError: (s) => s.rng.fault() < cfg.internalError.probability,
    latencyMs: (s) => (s.rng.fault() < cfg.latency.probability ? cfg.latency.delayMs : 0),
    duplicate: (s) => s.rng.fault() < cfg.duplicate.probability,
    dropAfterMs: (s) => {
      const d = s.rng.drop();
      return cfg.socketDrop.intervalMs + Math.round((2 * d - 1) * cfg.socketDrop.jitterMs);
    },
    tierShift: (s) => s.rng.tier() < cfg.tierShift.probabilityPerMinute,
  };
}
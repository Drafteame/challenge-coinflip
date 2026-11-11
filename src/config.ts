import { readFileSync } from 'node:fs';

export type Tier = { upTo: number | null; multiplier: number };

export type FaultConfig = {
  latency: { probability: number; delayMs: number };
  internalError: { probability: number };
  socketDrop: { intervalMs: number; jitterMs: number };
  tierShift: { probabilityPerMinute: number; delta: number };
  duplicate: { probability: number };
};

export type Fixture = {
  seed: string;
  startingBalance: number;
  tiers: Tier[];
  faults: FaultConfig;
};

export type Args = { seed?: string; fixture?: string; faults: boolean };

function atMostTwoDecimals(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isProbability(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function validateFixture(x: unknown): Fixture {
  if (!isPlainObject(x)) {
    throw new Error('fixture: root must be a plain object');
  }

  const seed = x.seed;
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('fixture: seed must be a non-empty string');
  }

  const startingBalance = x.startingBalance;
  if (
    typeof startingBalance !== 'number' ||
    !Number.isFinite(startingBalance) ||
    startingBalance < 0 ||
    !atMostTwoDecimals(startingBalance)
  ) {
    throw new Error('fixture: startingBalance must be a finite number >= 0 with at most 2 decimal places');
  }

  if (!Array.isArray(x.tiers) || x.tiers.length === 0) {
    throw new Error('fixture: tiers must be a non-empty array');
  }
  const tiers: Tier[] = [];
  let lastUpTo = 0;
  for (let i = 0; i < x.tiers.length; i++) {
    const raw = x.tiers[i];
    if (!isPlainObject(raw)) {
      throw new Error('fixture: tier ' + i + ' must be an object');
    }
    let upTo: number | null;
    if (raw.upTo === null) {
      upTo = null;
    } else if (typeof raw.upTo === 'number' && Number.isInteger(raw.upTo) && raw.upTo > 0) {
      upTo = raw.upTo;
    } else {
      throw new Error('fixture: tier ' + i + ' upTo must be null or a positive integer');
    }
    if (i === 0 && upTo === null) {
      throw new Error('fixture: first tier upTo must be a positive integer');
    }
    if (upTo === null && i !== x.tiers.length - 1) {
      throw new Error('fixture: only the last tier may have upTo null');
    }
    if (upTo !== null && upTo <= lastUpTo) {
      throw new Error('fixture: upTo values must be strictly ascending');
    }
    if (upTo !== null) {
      lastUpTo = upTo;
    }
    const multiplier = raw.multiplier;
    if (
      typeof multiplier !== 'number' ||
      !Number.isFinite(multiplier) ||
      multiplier <= 0 ||
      !atMostTwoDecimals(multiplier)
    ) {
      throw new Error('fixture: tier ' + i + ' multiplier must be a finite number > 0 with at most 2 decimal places');
    }
    tiers.push({ upTo, multiplier });
  }

  if (!isPlainObject(x.faults)) {
    throw new Error('fixture: faults must be an object');
  }

  const latency = x.faults.latency;
  if (!isPlainObject(latency)) {
    throw new Error('fixture: faults.latency must be an object');
  }
  const latencyProbability = latency.probability;
  if (!isProbability(latencyProbability)) {
    throw new Error('fixture: faults.latency.probability must be a finite number in [0,1]');
  }
  const latencyDelayMs = latency.delayMs;
  if (!isNonNegativeInt(latencyDelayMs)) {
    throw new Error('fixture: faults.latency.delayMs must be a non-negative integer');
  }

  const internalError = x.faults.internalError;
  if (!isPlainObject(internalError)) {
    throw new Error('fixture: faults.internalError must be an object');
  }
  const internalErrorProbability = internalError.probability;
  if (!isProbability(internalErrorProbability)) {
    throw new Error('fixture: faults.internalError.probability must be a finite number in [0,1]');
  }

  const socketDrop = x.faults.socketDrop;
  if (!isPlainObject(socketDrop)) {
    throw new Error('fixture: faults.socketDrop must be an object');
  }
  const socketDropIntervalMs = socketDrop.intervalMs;
  if (!isNonNegativeInt(socketDropIntervalMs)) {
    throw new Error('fixture: faults.socketDrop.intervalMs must be a non-negative integer');
  }
  const socketDropJitterMs = socketDrop.jitterMs;
  if (!isNonNegativeInt(socketDropJitterMs)) {
    throw new Error('fixture: faults.socketDrop.jitterMs must be a non-negative integer');
  }
  if (socketDropJitterMs > socketDropIntervalMs) {
    throw new Error('fixture: faults.socketDrop.jitterMs must be <= intervalMs');
  }

  const tierShift = x.faults.tierShift;
  if (!isPlainObject(tierShift)) {
    throw new Error('fixture: faults.tierShift must be an object');
  }
  const tierShiftProbabilityPerMinute = tierShift.probabilityPerMinute;
  if (!isProbability(tierShiftProbabilityPerMinute)) {
    throw new Error('fixture: faults.tierShift.probabilityPerMinute must be a finite number in [0,1]');
  }
  const tierShiftDelta = tierShift.delta;
  if (typeof tierShiftDelta !== 'number' || !Number.isFinite(tierShiftDelta) || tierShiftDelta <= 0 || !atMostTwoDecimals(tierShiftDelta)) {
    throw new Error('fixture: faults.tierShift.delta must be a finite number > 0 with at most 2 decimal places');
  }
  const minMultiplier = Math.min(...tiers.map((t) => t.multiplier));
  if (tierShiftDelta >= minMultiplier) {
    throw new Error('fixture: faults.tierShift.delta must be less than every tier multiplier');
  }

  const duplicate = x.faults.duplicate;
  if (!isPlainObject(duplicate)) {
    throw new Error('fixture: faults.duplicate must be an object');
  }
  const duplicateProbability = duplicate.probability;
  if (!isProbability(duplicateProbability)) {
    throw new Error('fixture: faults.duplicate.probability must be a finite number in [0,1]');
  }

  const faults: FaultConfig = {
    latency: { probability: latencyProbability, delayMs: latencyDelayMs },
    internalError: { probability: internalErrorProbability },
    socketDrop: { intervalMs: socketDropIntervalMs, jitterMs: socketDropJitterMs },
    tierShift: { probabilityPerMinute: tierShiftProbabilityPerMinute, delta: tierShiftDelta },
    duplicate: { probability: duplicateProbability },
  };

  return { seed, startingBalance, tiers, faults };
}

export function loadFixture(path: string): Fixture {
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(path + ': invalid JSON');
  }
  return validateFixture(parsed);
}

export function parseArgs(argv: string[]): Args {
  let seed: string | undefined;
  let fixture: string | undefined;
  let faults = true;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--seed') {
      i++;
      const value = argv[i];
      if (value === undefined || value === '') {
        throw new Error('--seed requires a value');
      }
      seed = value;
    } else if (token === '--fixture') {
      i++;
      const value = argv[i];
      if (value === undefined || value === '') {
        throw new Error('--fixture requires a value');
      }
      fixture = value;
    } else if (token === '--faults') {
      i++;
      const value = argv[i];
      if (value === 'on') {
        faults = true;
      } else if (value === 'off') {
        faults = false;
      } else {
        throw new Error('--faults requires on or off');
      }
    } else {
      throw new Error('unknown argument: ' + token);
    }
  }
  const args: Args = { faults };
  if (seed !== undefined) args.seed = seed;
  if (fixture !== undefined) args.fixture = fixture;
  return args;
}

export function tierH(tiers: Tier[], amountCents: number, shiftH: number): number {
  for (const tier of tiers) {
    if (tier.upTo === null || amountCents <= Math.round(tier.upTo * 100)) {
      return Math.round(tier.multiplier * 100) - shiftH;
    }
  }
  // Unreachable for validated fixtures: the last tier always has upTo null.
  throw new Error('tierH: no matching tier');
}

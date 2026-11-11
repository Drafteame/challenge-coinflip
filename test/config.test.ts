import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { validateFixture, loadFixture, parseArgs, tierH } from '../src/config.ts';
import type { Fixture } from '../src/config.ts';

const base: Fixture = {
  seed: 'draftea-coinflip',
  startingBalance: 1000.0,
  tiers: [
    { upTo: 20, multiplier: 1.95 },
    { upTo: 100, multiplier: 1.90 },
    { upTo: 500, multiplier: 1.85 },
    { upTo: null, multiplier: 1.80 },
  ],
  faults: {
    latency: { probability: 0.15, delayMs: 2000 },
    internalError: { probability: 0.06666666666666667 },
    socketDrop: { intervalMs: 180000, jitterMs: 30000 },
    tierShift: { probabilityPerMinute: 0.1, delta: 0.05 },
    duplicate: { probability: 0.05 },
  },
};

test('validateFixture accepts a valid fixture unchanged', () => {
  assert.deepEqual(validateFixture(base), base);
});

test('tierH resolves bands and applies shift', () => {
  assert.equal(tierH(base.tiers, 1000, 0), 195); // $10 → 1–20 band → 1.95
  assert.equal(tierH(base.tiers, 2100, 0), 190); // $21 → 21–100 band → 1.90
  assert.equal(tierH(base.tiers, 10100, 0), 185); // $101 → 101–500 band → 1.85
  assert.equal(tierH(base.tiers, 500000, 0), 180); // $5000 → 501+ band → 1.80
  assert.equal(tierH(base.tiers, 1000, 5), 190); // shift −0.05 (5 hundredths)
});

test('validateFixture rejects invalid fixtures', () => {
  const { seed: _seed, ...noSeed } = base;
  assert.throws(() => validateFixture(noSeed), /seed/); // missing seed
  assert.throws(() => validateFixture({ ...base, seed: '' }), /seed/); // empty seed
  assert.throws(() => validateFixture({ ...base, startingBalance: 1000.001 }), /startingBalance/); // 3 decimals
  assert.throws(() => validateFixture({ ...base, tiers: [] }), /tiers/); // empty tiers
  assert.throws(
    () =>
      validateFixture({
        ...base,
        tiers: [
          { upTo: 20, multiplier: 1.95 },
          { upTo: null, multiplier: 1.9 },
          { upTo: 500, multiplier: 1.85 },
        ],
      }),
    /null/,
  ); // non-final null upTo
  assert.throws(
    () =>
      validateFixture({
        ...base,
        tiers: [
          { upTo: 100, multiplier: 1.9 },
          { upTo: 20, multiplier: 1.95 },
          { upTo: null, multiplier: 1.8 },
        ],
      }),
    /ascending/,
  ); // out-of-order upTo
  assert.throws(
    () =>
      validateFixture({
        ...base,
        tiers: [
          { upTo: 20, multiplier: 0 },
          { upTo: 100, multiplier: 1.9 },
          { upTo: 500, multiplier: 1.85 },
          { upTo: null, multiplier: 1.8 },
        ],
      }),
    /multiplier/,
  ); // multiplier 0
  assert.throws(
    () => validateFixture({ ...base, faults: { ...base.faults, latency: { probability: 1.5, delayMs: 2000 } } }),
    /latency/,
  ); // probability out of range
  assert.throws(
    () => validateFixture({ ...base, faults: { ...base.faults, socketDrop: { intervalMs: 1000, jitterMs: 2000 } } }),
    /jitter/,
  ); // jitterMs > intervalMs
  assert.throws(
    () => validateFixture({ ...base, faults: { ...base.faults, duplicate: { probability: -0.1 } } }),
    /duplicate/,
  ); // probability out of range
  assert.throws(
    () =>
      validateFixture({
        ...base,
        faults: { ...base.faults, tierShift: { probabilityPerMinute: 0.1, delta: 0.055 } },
      }),
    /delta/,
  ); // delta with 3 decimals
  assert.throws(
    () =>
      validateFixture({
        ...base,
        faults: { ...base.faults, tierShift: { probabilityPerMinute: 0.1, delta: 1.8 } },
      }),
    /delta/,
  ); // delta >= minimum tier multiplier (guard against negative effective multiplier)
});

test('parseArgs defaults to faults on with no seed or fixture', () => {
  const args = parseArgs([]);
  assert.equal(args.faults, true);
  assert.ok(!('seed' in args));
  assert.ok(!('fixture' in args));
});

test('parseArgs parses flags', () => {
  assert.deepEqual(parseArgs(['--seed', 'x', '--faults', 'off', '--fixture', './f.json']), {
    seed: 'x',
    faults: false,
    fixture: './f.json',
  });
  assert.equal(parseArgs(['--faults', 'on']).faults, true);
});

test('parseArgs rejects bad flags', () => {
  assert.throws(() => parseArgs(['--seed']), /--seed requires a value/);
  assert.throws(() => parseArgs(['--faults', 'maybe']), /--faults requires on or off/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument: --bogus/);
});

test('loadFixture reads and validates the default fixture', () => {
  const result = loadFixture(join(process.cwd(), 'fixtures', 'default.json'));
  assert.equal(result.seed, 'draftea-coinflip');
  assert.equal(result.tiers.length, 4);
});

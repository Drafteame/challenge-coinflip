import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, fnv1a, streamFor, candidateSeed, slug } from '../src/prng.ts';

function take(rng: () => number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(rng());
  }
  return out;
}

test('mulberry32(0) yields finite values in [0,1)', () => {
  const rng = mulberry32(0);
  const first = rng();
  assert.ok(Number.isFinite(first));
  assert.ok(first >= 0);
  assert.ok(first < 1);
  const values = take(rng, 1000);
  for (const v of values) {
    assert.ok(Number.isFinite(v));
    assert.ok(v >= 0 && v < 1);
  }
});

test('mulberry32 is deterministic for a fixed seed', () => {
  assert.deepEqual(take(mulberry32(42), 20), take(mulberry32(42), 20));
});

test('mulberry32 differs across seeds', () => {
  const a = take(mulberry32(1), 20);
  const b = take(mulberry32(2), 20);
  assert.ok(a.some((v, i) => v !== b[i]));
});

test('streamFor separates ordinals and stream names', () => {
  const a0 = take(streamFor('seed', 'alice', 0, 'outcome'), 20);
  const a1 = take(streamFor('seed', 'alice', 1, 'outcome'), 20);
  assert.ok(a0.some((v, i) => v !== a1[i]));
  const fault0 = take(streamFor('seed', 'alice', 0, 'fault'), 20);
  assert.ok(a0.some((v, i) => v !== fault0[i]));
});

test('fnv1a known vectors', () => {
  assert.equal(fnv1a(''), 2166136261);
  assert.equal(fnv1a('a'), 3826002220);
});

test('mulberry32 golden vectors (pinned from first run)', () => {
  assert.deepEqual(
    take(mulberry32(0), 8),
    [
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
      0.46732782293111086, 0.5450490827206522, 0.6152513844426721, 0.6489853798411787,
    ],
  );
});

test('streamFor golden vectors (pinned from first run)', () => {
  assert.equal(fnv1a('draftea-coinflip|alice|0|outcome'), 3220958763);
  assert.deepEqual(
    take(streamFor('draftea-coinflip', 'alice', 0, 'outcome'), 8),
    [
      0.8151441789232194, 0.919984323438257, 0.8808661666698754, 0.9695918580982834,
      0.5691096573136747, 0.11731420364230871, 0.7642399778123945, 0.23502191342413425,
    ],
  );
});

test('candidateSeed slugifies the name and appends UTC YYYYMMDD', () => {
  assert.equal(candidateSeed('Ana Lopez', new Date(Date.UTC(2026, 11, 9))), 'ana-lopez-20261209');
});

test('slug trims, lowercases and collapses separators', () => {
  assert.equal(slug(' Ana Lopez '), 'ana-lopez');
});

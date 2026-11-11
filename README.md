# Draftea coin-flip mock game server

## What this is

A deterministic coin-flip mock game server. Candidates build a casino coin-flip client against it over a weekend. The server is the single source of truth for outcomes, multipliers and balances: the client sends only `bet`, `pick` and `quoteId`, and whatever the server returns is what was applied. A seeded PRNG drives every outcome and every injected fault, so a run can be reproduced exactly. The server injects faults (latency, internal errors, socket drops, tier shifts, duplicate delivery) that the client must recover from without changing what the server decided. [`PROTOCOL.md`](PROTOCOL.md) is the wire contract. Its `DECISION:` entries record how the server resolves points the prompt left open.

## Requirements and start

Node 24 or newer (`engines` declares `>=24 <27`). The code runs on Node's native TypeScript type stripping, so there is no build step.

```sh
pnpm install
pnpm start        # or: pnpm start
```

The server listens on port 8080 by default. Set `PORT` to override it. The browser test client is served at `http://localhost:8080/`.

## CLI

All flags go after `--` when run through npm.

- `pnpm start` runs the server with `fixtures/default.json`.
- `pnpm start -- --seed <string>` overrides the PRNG seed from the fixture.
- `pnpm start -- --fixture <path>` loads another fixture file.
- `pnpm start -- --faults off` disables all fault injection. `--faults on` is the default.
- `pnpm run seed -- --candidate <name>` prints a reproducible per-candidate seed in the form `<slug>-<YYYYMMDD UTC>`, for example `ana-lopez-20261109`.
- `pnpm run demo` runs a scripted client through connect, quote, round, ack, drop and reconnect. It exits 0 on success.
- `pnpm test` runs the test suite with `node --test`.
- `pnpm run typecheck` runs `tsc --noEmit`.

To give a candidate a seed, run `pnpm run seed -- --candidate "<name>"` and pass the output to `pnpm start -- --seed <seed>`.

## Fixtures

`fixtures/default.json` holds the PRNG seed, the starting balance, the multiplier tiers and the fault rates. The schema and validation rules are listed under the Fixtures & seeding section of [`PROTOCOL.md`](PROTOCOL.md). The validator rejects a fixture that breaks them, and the server exits without starting.

## Faults

- Latency: probability 0.15 per reply, delays the reply by 2000 ms.
- Internal error: probability 1/15 on `place_round`, returns `INTERNAL` `simulated failure` and creates no round.
- Socket drop: about every 180 s of socket lifetime (±30 s), closes with 1011 `simulated drop`. The session survives.
- Tier shift: probability 0.1 per minute per session, lowers all tiers by 0.05 and pushes `quote_changed`.
- Duplicate delivery: probability 0.05 per reply, sends the same frame twice.

All of these are drawn from the seeded PRNG. `--faults off` suppresses every kind.

## Reading the logs

Every frame the server writes or receives is one JSON line:

```
{"direction":"in|out","userId":...,"sessionId":...,"type":...,"reqId":...,"timestamp":...}
```

Absent fields are `null`. Each injected fault is one line `{"fault":"<kind>",...}`, where the kind is `latency`, `internal_error`, `drop`, `tier_shift` or `duplicate`. A tier-shift revert carries `"revert":true`. A close is logged as `{"type":"close",...,"code":...,"reason":...}` in both directions. A resend after a reconnect carries `"replayed":true`. Timestamps are epoch milliseconds.

To correlate a candidate's behaviour with the server's decisions, match the `reqId` on each `in` line with the `out` lines and any `fault` line that shares it.

## Determinism

With the same seed, the same fixture and the same sequence of client frames and socket events, the server produces byte-identical results and injected faults. A test checks this with an injected clock. With the real clock, outcomes and faults are still identical; only the wall-clock fields (`timestamp`, `createdAt`, `expiresAt`) and the relative timing of events differ. See DECISION D1 in `PROTOCOL.md`.

## Project layout

- `src/`: protocol types, PRNG, clock, config, faults, engine, log, server and the entry point (`main.ts`).
- `client/index.html`: plain browser test client, served at `/`.
- `test/`: `node:test` suites.
- `fixtures/default.json`: default fixture.
- `scripts/`: candidate seed generator (`seed.ts`) and scripted demo (`demo.ts`).
- `PROTOCOL.md`: wire contract and decisions.
- `CHANGELOG.md`: release notes.

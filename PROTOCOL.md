# PROTOCOL

Wire contract for the Draftea coin-flip mock game server. The TypeScript shapes live in `src/protocol.ts`; this document is authoritative where the two differ in prose.

## Overview

The server is the single source of truth for outcomes, multipliers and balances. A candidate's client builds against this contract and must never influence a result: the client sends only `bet`, `pick` and `quoteId`, and everything the server returns is what was applied. Faults (latency, internal errors, socket drops, tier shifts, duplicate delivery) are injected deterministically from a seeded PRNG. The client must tolerate every one of them and recover from them using the messages defined here, without changing what the server decided.

## Connection

URL:

```
ws://<host>:<port>/games/{gameId}?userId={userId}&sessionId={sessionId}
```

- `gameId` must be `coinflip`. Any other value closes the socket with 4004 `UNKNOWN_GAME`.
- `userId` is required. Missing or empty closes with 4001 `MISSING_USER`.
- `sessionId` is optional. Resolution is described under Session & reconnect.
- Checks run in the order above, immediately after the HTTP upgrade. `HTTP GET /` serves `client/index.html`; any other plain-HTTP request gets 404.
- One active socket per (gameId, userId). A second socket for the same pair replaces the first (see Session & reconnect).
- The first client message must be `hello`. Anything else before a valid `hello` is rejected (see Messages and DECISION D7).
- The server never sends heartbeats. It answers the app-level `ping` message with `pong`. WebSocket protocol-level ping frames are answered automatically by `ws` (autoPong); the server sends none.

Close codes:

| Name | Code | Reason | When |
|---|---|---|---|
| MISSING_USER | 4001 | `MISSING_USER` | `userId` missing or empty |
| HELLO_REQUIRED | 4002 | `HELLO_REQUIRED` | first frame, or any frame before a valid `hello`, is not `hello` |
| UNKNOWN_GAME | 4004 | `UNKNOWN_GAME` | `gameId` is not `coinflip` or path does not match `/games/{id}` |
| SESSION_REPLACED | 4009 | `SESSION_REPLACED` | a newer socket for the same user took over this session |
| simulated drop | 1011 | `simulated drop` | injected socket drop (see Fault injection) |

## Message envelope

Every client message is a JSON object with a string `reqId` and a string `type`.

- Every server reply to a request echoes that `reqId`.
- Server-pushed events carry no `reqId`.
- Unknown `type` or malformed JSON gets an `error` with code `INTERNAL` and the offending `reqId` when one can be read.

Frame key order is `{reqId, type, ...payload}` for replies and `{type, ...payload}` for pushes and reqId-less errors (DECISION D24).

## Messages

Client to server:

- `hello` `{ clientVersion: string }`
- `get_balance` `{}`
- `get_quote` `{ bet: number }`
- `get_open_round` `{}`
- `place_round` `{ bet: number, pick: 'heads' | 'tails', quoteId: string }`
- `ack_round` `{ roundId: string }`
- `ping` `{}`

Server to client, replies:

- `welcome` `{ sessionId, gameId, userId, balance, openRound: Round | null, resumed: boolean }`
- `balance` `{ balance }`
- `quote` `{ quoteId, bet, multiplier, expiresAt }` (ISO-8601, 30 seconds from issue)
- `open_round` `{ round: Round | null }`
- `round` `{ round: Round }` (reply to `place_round`)
- `acked` `{ roundId, balance }`
- `pong` `{}`
- `error` `{ code, message }` with `code` one of `INVALID_BET`, `QUOTE_EXPIRED`, `ROUND_OPEN`, `INSUFFICIENT_BALANCE`, `INTERNAL`

Server to client, pushed events (no `reqId`):

- `balance_changed` `{ balance }`
- `quote_changed` `{ quoteId, bet, multiplier }`
- `session_replaced` `{}`

Round shape (TypeScript):

```ts
type Round = {
  id: string;
  bet: number;
  pick: 'heads' | 'tails';
  result: 'heads' | 'tails';
  multiplier: number;      // the one the server applied
  payout: number;          // bet * multiplier on a win, 0 on a loss
  streak?: { offered: boolean; multiplier: number };
  state: 'open' | 'acked';
  createdAt: string;       // ISO-8601
};
```

Error messages used by the server (exact text):

| Code | Message | Raised by |
|---|---|---|
| INTERNAL | `hello required` | any frame before a valid `hello` |
| INTERNAL | `hello already received` | second `hello` on a socket |
| INTERNAL | `malformed JSON` | frame is not parseable JSON, or binary |
| INTERNAL | `message must be an object with string reqId and type` | parsed value lacks string `reqId` or `type` |
| INTERNAL | `unknown type: <t>` | `type` is not a client message |
| INVALID_BET | `bet must be an integer between 1 and 5000` | `get_quote` or `place_round` bet invalid |
| INVALID_BET | `pick must be 'heads' or 'tails'` | `place_round` pick invalid |
| QUOTE_EXPIRED | `quote is unknown, expired, or for a different bet` | `place_round` quote check failed |
| ROUND_OPEN | `round <id> is still open; ack it first` | `place_round` while a round is open |
| INSUFFICIENT_BALANCE | `bet <b> exceeds balance <x>` | `place_round` bet above balance |
| INTERNAL | `simulated failure` | injected `place_round` failure |
| INTERNAL | `unknown round <id>` | `ack_round` for an unknown or non-string roundId |
| INTERNAL | `round <id> already acked` | `ack_round` for an acked round |

## Game rules

- Starting balance for a new session is 1000.00. Amounts are decimals with two places and are serialized as numbers (see DECISION D15).
- Tiers come from the fixture (defaults): bet 1–20 → 1.95; 21–100 → 1.90; 101–500 → 1.85; 501+ → 1.80. Bets must be integers in [1, 5000]; otherwise `INVALID_BET`.
- `get_quote` returns the tier multiplier for that bet and a `quoteId` valid for 30 seconds. Quotes are per session. A new quote for the same bet replaces the old one (DECISION D12).
- `place_round` requires a valid, unexpired `quoteId` whose `bet` matches; otherwise `QUOTE_EXPIRED`. If the applied tier differs from the quoted one because tiers moved (see Fault injection), the server applies the current tier and returns it in `round.multiplier`. The client is expected to notice.
- The bet is deducted from the balance when the round is created. `payout` is `bet * multiplier` on a win (round half up to two decimals), 0 on a loss. Balance is credited with `payout` only on `ack_round`.
- Only one round may be open per session. A second `place_round` returns `ROUND_OPEN`. A bet above balance returns `INSUFFICIENT_BALANCE`.
- `ack_round` for an unknown or already acked round returns `INTERNAL` with a clear message (see Messages).
- The result is drawn from the seeded PRNG, independent of `pick`. Target win rate is 50%. The server reads nothing from the client when producing a round other than `bet`, `pick` and `quoteId`.
- Streak (optional feature for candidates): after a win, with probability 0.5 from the PRNG, the round carries `streak: { offered, multiplier }`. The server applies no further behavior; a candidate who implements the streak places a new round with the payout as the bet. The `offered` value is governed by DECISION D14.
- `ack_round` is the only path that settles a round. A disconnect mid-round leaves the round open.

## Session & reconnect

Session state: `sessionId`, `userId`, `balance`, `openRound`, active quotes, and a replay buffer of the last 50 server replies with their `reqId` and `seq`.

Resolution at connect (DECISION D6):

1. An active socket exists for this user: the new socket inherits that session (`resumed: true`). The old socket receives `session_replaced` and is closed with 4009.
2. Else `sessionId` is present, known, belongs to the same `userId`, and is unexpired: resume (`resumed: true`).
3. Else: new session (`resumed: false`).

On resume, the server sends `welcome` (with the current `openRound`) and then re-sends every buffered reply whose `seq` is greater than the session's `writtenSeq`, in `seq` order, as the stored bytes (see DECISION D4).

"Never received" is defined as: any reqId reply whose `seq` is greater than `writtenSeq`, where `writtenSeq` is the highest reply `seq` whose `ws.send` callback returned without error on any socket of the session. A write that succeeds means the bytes reached the kernel buffer, not that the client processed them. Clients reconcile with `get_open_round` and `get_balance` after a reconnect.

Expiry: a session expires 30 minutes after its last socket closed. An expired session is unknown, so a `sessionId` for it starts a new session with `resumed: false` (DECISION D9).

A disconnect mid-round leaves the round open. Nothing settles until `ack_round`.

## Fixtures & seeding

- `fixtures/default.json` holds the tiers, starting balance, fault-injection rates and the PRNG seed. Keys (see `src/config.ts` validator):
  - `seed: string`
  - `startingBalance: number` (two decimal places)
  - `tiers: { upTo: number | null; multiplier: number }[]` — `upTo` values ascend; only the last `upTo` is `null`
  - `faults.latency: { probability: number; delayMs: number }`
  - `faults.internalError: { probability: number }`
  - `faults.socketDrop: { intervalMs: number; jitterMs: number }` (`jitterMs ≤ intervalMs`)
  - `faults.tierShift: { probabilityPerMinute: number; delta: number }`
  - `faults.tierShift.delta` must be less than every tier `multiplier`, so a shift can never drive an effective multiplier to zero or negative.
  - `faults.duplicate: { probability: number }`
- CLI:
  - `npm start -- --seed <string>` overrides the seed.
  - `npm start -- --fixture <path>` loads another fixture.
  - `npm start -- --faults off` disables all injection for debugging.
- `npm run seed -- --candidate <name>` prints a candidate seed (DECISION D22).
- Given the same seed and the same sequence of client messages, the server produces byte-identical results and injected faults (see Determinism).

## Fault injection

All faults are driven by the seeded PRNG and configured in the fixture. `--faults off` suppresses every kind. Every injected fault is logged (see Logging).

- **Latency**: with probability 0.15, a reply is delayed by 2000 ms. Delayed replies hold back the frames queued behind them on the same socket (DECISION D17).
- **Internal error**: with probability 1/15, `place_round` returns `error` `INTERNAL` `simulated failure`. No round is created and nothing is deducted. The quote is kept so the same `quoteId` can be retried (DECISION D12).
- **Socket drop**: every 180 seconds of socket lifetime, plus or minus 30 seconds from the PRNG, the socket is closed with 1011 `simulated drop`. The session survives.
- **Tier shift**: with probability 0.1 per minute per session, all tiers shift down by 0.05 and `quote_changed` is pushed for each active quote. The shift reverts after the next successful `place_round`. This exercises the quoted-vs-applied multiplier rule (DECISION D13).
- **Duplicate delivery**: with probability 0.05, a reply is sent twice with the same `reqId` (DECISION D17).

## Determinism

Rule: with the same seed, the same fixture, and the same sequence of client frames and socket open/close events, the server emits the same frames and injected faults. Draw order is fixed by DECISION D3.

With an injected `ManualClock`, the whole transcript is byte-identical, including timestamps and logs. With the real clock, the outcomes are still identical; only the timing of timer and client events depends on wall time (DECISION D1).

## Logging

One JSON line per frame actually written or received, plus one line per injected fault. Key order is fixed (DECISION D21).

Message lines:

```
{"direction":"in|out","userId":...,"sessionId":...,"type":...,"reqId":...,"timestamp":...}
```

Absent fields are `null`. Resends on resume carry `"replayed":true`. Closes are logged as `type:"close"` with `code` and `reason`, in both directions.

Fault lines:

```
{"fault":<kind>,"userId":...,"sessionId":...,"reqId":...,"timestamp":...,<detail>}
```

Kinds: `latency`, `internal_error`, `drop`, `tier_shift` (with `revert:true` on the revert), `duplicate`.

## Decisions

Each point below was left open by the prompt. Each is recorded here with its rationale.

- DECISION: D1 Determinism scope. With the injected `ManualClock` the transcript is byte-identical (frames, logs and timestamps). With the real clock, everything except `timestamp`/`createdAt`/`expiresAt` is identical (result, streak, ids, latency/duplicate/internal-error decisions, drop offset, tier-shift minute index); only the relative timing of timer and client events depends on wall time. Rationale: prompt requires a provable "same seed + same messages => identical" property; wall-clock fields cannot be byte-identical.
- DECISION: D2 IDs are deterministic, no crypto/Date: `sessionId = "s_" + hex8(fnv1a(seed|userId|ordinal|session))` with a `#k` salt on collision; `roundId = ${sessionId}-r${n}`, `quoteId = ${sessionId}-q${n}` counted per session from 1; `ordinal` counts sessions per user in-process from 0. Rationale: ids are not secrets; readable ids help reviewers; determinism forbids crypto/Date.
- DECISION: D3 Canonical PRNG draw order (all tests are `draw < p`; p=1 always fires, p=0 never): `outcome` — per created round exactly 2 draws, d0 = result (<0.5 heads else tails), d1 = streak hit (used only on a win); `fault` (only when faults on) — first 1 draw for internal error (only consumed by a place_round that passed all validation), then for each reply in emission order a latency draw then a duplicate draw; no fault draws for handshake-close errors, replays or pushes; `drop` — 1 draw per socket at welcome, delay = intervalMs + round((2d−1)·jitterMs); `tier` — 1 draw per full minute after welcome while attached. Rationale: one documented order so same seed+messages reproduces byte-identically across fault configurations; validation/parsing never consumes outcome draws so malformed input cannot skew the sequence.
- DECISION: D4 Replay watermark: `session.writtenSeq` is the highest reply seq whose `ws.send` callback returned without error on any socket. Every reqId reply except `welcome` gets a session-wide `seq` and enters a ring of the last 50. On resume, send `welcome` then every buffered entry with `seq > writtenSeq` in seq order, as stored bytes, logged `replayed:true`, with no new fault draws. Pushes and reqId-less errors are not buffered. Caveat: a successful write means bytes reached the kernel buffer, not the client; clients reconcile with `get_open_round`/`get_balance`. Rationale: the `ws.send` callback is the only observable "successful write".
- DECISION: D5 Replacement inherits the replay tail: a replaced socket's outbox is discarded; those unwritten replies are resent to the new socket after its welcome. Rationale: drop and replacement use one code path.
- DECISION: D6 Session resolution at connect: (1) active socket for this user => inherit that session (resumed:true), send `session_replaced` and close 4009 on the old socket; (2) else known sessionId, same userId, unexpired => resume (resumed:true); (3) else new session (resumed:false). A sessionId belonging to another user counts as unknown. Rationale: prompt requires replacement at connect; binding to userId prevents hijack.
- DECISION: D7 Pre-hello: any frame before a valid hello (including malformed JSON) gets `error INTERNAL "hello required"` echoing a readable reqId, no faults applied, then close 4002 "HELLO_REQUIRED" from the send callback. `clientVersion` is logged but not validated. A second hello gets `INTERNAL "hello already received"`. Rationale: the prompt specifies hello-required; flushing before close avoids losing the error frame.
- DECISION: D8 Lifetime timers start at welcome, so there are no pushes before welcome and rejected sockets draw nothing. Rationale: simplest way to avoid e.g. quote_changed before welcome.
- DECISION: D9 Session expiry is lazy: check `socket===null && now−closedAt ≥ 30 min` at lookup; registry swept per connection; expired = unknown => new session, resumed:false. Rationale: no timers; tests can drive it with ManualClock.
- DECISION: D10 Validation: bet after JSON parse must be `typeof number && Number.isInteger && 1..5000`; a string "5000" gets INVALID_BET; `1e3`/`1.0` are the JSON values 1000/1 and are accepted; invalid pick => INVALID_BET; missing/non-string/unknown/expired/other-bet quoteId => QUOTE_EXPIRED; non-string roundId => INTERNAL "unknown round"; extra fields ignored; binary frames = malformed. Rationale: only five error codes exist; pick is part of the wager; lexical-form rejection would need a custom JSON parser.
- DECISION: D11 place_round check order: INVALID_BET -> ROUND_OPEN -> QUOTE_EXPIRED -> INSUFFICIENT_BALANCE -> internal-error draw -> create. Rationale: most informative error first; failed checks consume no draws.
- DECISION: D12 Quotes: valid while `now < expiresAt`; keyed by bet so a new quote for the same bet replaces the old (old id => QUOTE_EXPIRED); consumed when a round is created; kept after any error (including simulated failure) so the same quoteId can be retried; get_quote above balance is allowed; expired quotes pruned on each get_quote and tier event. Rationale: retrying after a fault is the recovery path candidates practise.
- DECISION: D13 Tier shift: per-session `shiftH ∈ {0, delta·100}`, non-stacking; a hit while already shifted does nothing but the draw is still used. After a shift, push `quote_changed {quoteId,bet,multiplier}` for each active quote in ascending bet order (quote id/expiry unchanged). Revert right after the next successful place_round (that round uses the shifted tier); after revert push `quote_changed` again. Rationale: prompt requires shift-exercises-quoted-vs-applied rule; rounds always use the current tier.
- DECISION: D14 Streak: on a win, if d1 < 0.5 set `streak = {offered, multiplier}` where `multiplier` is the tier for the payout amount in the post-revert table and `offered` is whether the payout is a valid bet, computed in integer cents: `payoutCents % 100 === 0` and `1 <= payoutCents / 100 <= 5000`; otherwise omit `streak`. Rationale: bets must be integers, but a payout like 5.85 dollars is not a whole-dollar bet; `offered` keeps the server authoritative without loosening validation. NOTE: this narrows the prompt's literal "offered: true"; all amounts are integer cents, so the whole-dollar check is `payoutCents % 100 === 0`.
- DECISION: D15 Money: balances are integer cents, multipliers integer hundredths; `payoutCents = bet × multH` is exact so round-half-up never has anything to round. Fixture validator rejects values with more than 2dp; wire sends `cents/100`. Rationale: avoids float drift.
- DECISION: D16 balance_changed is pushed right after the reply whenever balance changes: the deduction on place and a non-zero credit on ack. Rationale: prompt lists it without a trigger.
- DECISION: D17 Latency: each connection has a FIFO outbox; a delayed reply blocks the frames queued behind it (head-of-line), so per-socket order is emission order; a duplicate is a second identical frame queued right behind the first, sharing the seq and buffered once. Rationale: makes the watermark exact; nothing arrives reordered.
- DECISION: D18 autoPong stays the ws default; the server never sends ping frames; app-level `ping` gets `pong`; `maxPayload` is 16 KiB (oversize => ws close 1009). Rationale: protocol ping frames are not app messages; bounded message size.
- DECISION: D19 Routing: a path that doesn't match `/games/{id}` or an id other than `coinflip` => 4004 UNKNOWN_GAME; missing/empty userId => 4001 MISSING_USER; checks run in that order right after upgrade. HTTP GET / serves client/index.html; anything else 404. Rationale: prompt specifies both.
- DECISION: D20 Server does not dedupe client reqIds; a repeated reqId is just processed again (ROUND_OPEN and once-only ack keep it safe). Rationale: not required; keeps code simple.
- DECISION: D21 Logs: one JSON line per frame actually written or received: `{direction,userId,sessionId,type,reqId,timestamp}` in that key order, `null` for absent fields, `replayed:true` on resends. Fault lines: `{fault,userId,sessionId,reqId,timestamp,...detail}` with kinds `latency`, `internal_error`, `drop`, `tier_shift` (`revert:true` on revert), `duplicate`. Closes logged as `type:"close"` with `code` and `reason` both directions. Rationale: prompt requires one line/message + fault lines; fixed key order keeps the log byte-identical.
- DECISION: D22 Candidate seed: `<slug(name)>-<YYYYMMDD UTC>` (e.g. `ana-lopez-20261109`). `slug(name)` trims, lower-cases, and replaces each run of non-alphanumeric characters with `-`, then strips leading/trailing `-`. Rationale: derived from name + date, easy for reviewers to read.
- DECISION: D23 The demo runs in-process with faults off, the real clock and port 0. Rationale: npm run demo must exit 0 reliably.
- DECISION: D24 Wire key order: replies `{reqId,type,...payload}`; pushes and reqId-less errors `{type,...payload}`; one helper builds every frame. Rationale: byte identity.

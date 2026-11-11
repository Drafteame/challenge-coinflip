# Build the Draftea coin-flip mock game server

You are building a small, deterministic mock game server that hiring candidates will run locally while they build a casino coin-flip game client over a weekend. The server is the only source of truth for outcomes and multipliers. Candidates must never be able to influence a result from the client; they must be able to recover cleanly from every fault the server injects. Treat the protocol below as a contract: implement it exactly, do not add or rename messages, and document anything the contract leaves open.

## Goal and non-goals

Goal: a Node 26 + TypeScript WebSocket server, runnable with one command, with seeded deterministic fixtures, fault injection, a small browser test client, and a test suite that proves the protocol.

Non-goals: no database, no authentication beyond the userId query parameter, no real RNG, no UI beyond the test client, no production hardening. Everything lives in memory and resets on restart unless a seed is given.

## Stack and constraints

- Node 26, TypeScript (strict), ESM. Pin it in `package.json` `engines` and in an `.nvmrc`. Use the `ws` library. No framework for the server.
- Zero network access at build or test time beyond `npm install`.
- Deterministic: every outcome, multiplier tier, delay and injected error derives from a seeded PRNG (use a small seeded generator such as mulberry32; do not use Math.random anywhere in the runtime path).
- Run with `npm start`, test with `npm test`, type-check with `npm run typecheck`. Provide `npm run demo` that starts the server, drives a scripted client through connect, quote, round, ack, drop and reconnect, and exits 0 on success.
- Single process, single port (default 8080, override with `PORT`).
- Log every message in and out as one JSON line per message, with `direction`, `userId`, `sessionId`, `type`, `reqId` and a timestamp, so reviewers can read what a candidate's client did.

## Connection

URL: `ws://<host>:<port>/games/{gameId}?userId={userId}&sessionId={sessionId}`

- `gameId` must be `coinflip`; any other value closes the socket with code 4004 and reason `UNKNOWN_GAME`.
- `userId` is required; missing closes with 4001 `MISSING_USER`.
- `sessionId` is optional. When present and known, the server resumes that session. When present and unknown, the server starts a new session and says so in `welcome`.
- One active socket per (gameId, userId). When a second socket connects for the same pair, send `{ type: 'session_replaced' }` on the old socket, then close it with 4009 `SESSION_REPLACED`. The new socket inherits the session state (balance, open round).
- The first client message must be `hello`. Any other message before `hello` gets an `error` with code `INTERNAL` and message `hello required`, and the socket is closed with 4002.
- The server never sends heartbeats. It answers `ping` with `pong` and otherwise relies on the client.

## Message envelope

Every client message is a JSON object with a string `reqId` and a string `type`. Every server reply to a request echoes that `reqId`. Server-pushed events carry no `reqId`. Unknown `type` or malformed JSON gets `error` with code `INTERNAL` and the offending `reqId` when one can be read.

## Protocol

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

## Game rules

- Starting balance per new session: 1000.00. Amounts are decimals with two places; serialize as numbers.
- Multiplier tiers, from the fixture file (defaults): bet 1–20 → 1.95, 21–100 → 1.90, 101–500 → 1.85, 501+ → 1.80. Bets must be integers in [1, 5000]; otherwise `INVALID_BET`.
- `get_quote` returns the tier multiplier for that bet and a `quoteId` valid for 30 seconds. Quotes are per session; a new quote for the same bet replaces the old one.
- `place_round` requires a valid, unexpired `quoteId` whose `bet` matches; otherwise `QUOTE_EXPIRED`. If the applied tier differs from the quoted one because tiers moved (see fault injection), apply the current tier and return it in `round.multiplier`; the client is expected to notice.
- The bet is deducted from the balance when the round is created. `payout` is `bet * multiplier` on a win (round half up to two decimals), 0 on a loss. Balance is credited with `payout` only on `ack_round`.
- Only one round may be open per session; a second `place_round` returns `ROUND_OPEN`. Bet above balance returns `INSUFFICIENT_BALANCE`.
- `ack_round` for an unknown or already acked round returns `INTERNAL` with a clear message.
- The result is drawn from the seeded PRNG, independent of `pick`. Target win rate is 50%. Never read anything from the client other than `bet`, `pick` and `quoteId` when producing a round.
- Streak (optional feature for candidates): after a win, with probability 0.5 from the PRNG, set `streak: { offered: true, multiplier: <current tier for the payout amount> }` on the round. No further server behavior is needed; a candidate who implements the streak simply places a new round with the payout as the bet.

## Session and reconnect semantics

- Session state: `sessionId`, `userId`, `balance`, `openRound`, active quotes, and a replay buffer of the last 50 server messages with their `reqId`.
- On reconnect with a known `sessionId`, `welcome` carries `resumed: true` and the current `openRound`. Then re-send any buffered reply whose `reqId` the client never received, in order. Define "never received" as: sent after the previous socket's last successful write. Document this precisely in `PROTOCOL.md`.
- Sessions expire 30 minutes after the last socket closes; expired sessions start fresh.
- A disconnect mid-round leaves the round open. Nothing settles until `ack_round`.

## Fixtures and seeding

- `fixtures/default.json` holds tiers, starting balance, fault-injection rates, and the PRNG seed.
- CLI: `npm start -- --seed <string>` overrides the seed; `npm start -- --fixture <path>` loads another fixture; `npm start -- --faults off` disables all injection for debugging.
- Provide `npm run seed -- --candidate <name>` that prints a seed derived from the name and the current date, so each candidate gets a different but reproducible sequence.
- Given the same seed and the same sequence of client messages, the server must produce byte-identical results and injected faults. Write a test that proves this.

## Fault injection (all driven by the seeded PRNG, all configurable in the fixture)

- Latency: with probability 0.15, delay any reply by 2000 ms.
- Internal error: with probability 1/15, `place_round` returns `error` with code `INTERNAL` and message `simulated failure`, and no round is created or deducted.
- Socket drop: every 180 seconds of socket lifetime (plus or minus 30 seconds from the PRNG), close the socket with code 1011 and reason `simulated drop`. The session survives.
- Tier shift: with probability 0.1 per minute per session, shift all tiers down by 0.05 and push `quote_changed` for any active quote. Shift back after the next round. This exercises the quoted-vs-applied multiplier rule.
- Duplicate delivery: with probability 0.05, send a reply twice with the same `reqId`. Clients must be idempotent.

Log every injected fault as a JSON line with `fault: <kind>` so reviewers can correlate it with the candidate's handling.

## Test client

`client/index.html`: a single static page with no build step that connects, shows the log of messages both ways, and has buttons for each client message plus `Drop socket` and `Reconnect with session`. Serve it from the same process at `GET /` when the request is plain HTTP. This is for reviewers and candidates to sanity-check, not a reference implementation; keep it deliberately plain.

## Tests (Vitest or Node's test runner)

Cover at least:

1. Handshake: `hello` required, `welcome` shape, unknown game and missing user close codes.
2. Quote flow: tiers, expiry, replacement, `QUOTE_EXPIRED`.
3. Round flow: deduction on place, credit on ack, `ROUND_OPEN`, `INSUFFICIENT_BALANCE`, result independence from `pick` across 1000 seeded rounds (win rate within 45–55%).
4. Reconnect: open round survives a drop; buffered replies are re-sent; `session_replaced` on a second socket.
5. Determinism: same seed plus same script equals identical transcript.
6. Every fault kind can be triggered deterministically with a chosen seed, and `--faults off` suppresses all of them.

## Deliverables

- `README.md`: one-command start, CLI flags, how to give a candidate a seed, how to read the logs.
- `PROTOCOL.md`: the full contract above, plus every decision you had to make where this prompt was silent, each marked `DECISION:` with a one-line rationale.
- `fixtures/default.json`, `src/`, `client/index.html`, tests, `package.json` with the scripts named above.
- `CHANGELOG.md` with a single entry describing what was built.

## Working method

- Start by writing `PROTOCOL.md` from this prompt and the types in `src/protocol.ts`; build the server against those types.
- Keep the server under roughly 800 lines excluding tests and the client. Prefer clarity over cleverness; candidates will read this code.
- Where the prompt is ambiguous, pick the simplest behavior that keeps the server authoritative, record it as a `DECISION:` in `PROTOCOL.md`, and move on. Do not ask questions; do not add features not listed here.
- Finish by running `npm run typecheck`, `npm test` and `npm run demo`, and paste their output at the end of your final message.

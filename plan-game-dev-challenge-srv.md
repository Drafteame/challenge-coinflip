# Plan — Draftea coin-flip mock game server

**Project:** `game-dev-challenge-srv`
**State:** Awaiting review (not approved for Build)

## Objective and scope

Build a small, deterministic mock game server that hiring candidates run locally while building a casino coin-flip client over a weekend. The server is the single source of truth for outcomes and multipliers. Candidates must never be able to influence a result from the client, and must recover cleanly from every fault the server injects. The wire protocol is a fixed contract: implement it exactly, add/rename no messages, and document every silent spot as a `DECISION:`.

Stack: Node 26 + TypeScript (strict, ESM), `ws` library, no framework. Single process, port 8080 (`PORT` override). In-memory only, seeded deterministic fixtures, fault injection, a plain browser test client, and a test suite that proves the protocol.

**Non-goals:** no DB, no auth beyond the `userId` query param, no real RNG, no UI beyond the test client, no production hardening.

## Source ledger

| Source | Relevant facts | Confidence |
|---|---|---|
| `prompt.md` (project root, sole file) | Full spec: connection, envelope, protocol, game rules, reconnect, fixtures/seeding, fault injection, test client, tests, deliverables, working method (PROTOCOL.md first, ~800 line budget, "pick simplest → DECISION:") | High — read in full |
| Node.js official (nodejs.org) | Node 26 = Active LTS "Lithium", latest 26.13.0 (2026-10-28). Native TS type stripping stable + default (erasable syntax only). `--experimental-transform-types` removed in 26.0.0. | High |
| `ws` official (npm + GitHub websockets/ws) | v8.22.2 (2026-11-08), MIT, Node ≥10. `WebSocketServer` (`port`,`path`,`noServer`,`server`,`autoPong`,`closeTimeout`,`maxPayload`), `close(code,reason)`. `noServer` lets one HTTP server serve `GET /` + WS. | High |
| Org convention (siblings `api`, `draft-relay`) | Draftea uses devenv/nix + direnv: `devenv.nix` + `.envrc` (`use devenv`), `.devenv`, `devenv.yaml/.lock`. | High |

## Evidence pack index

Greenfield — no existing code, so no `bulk-reader` code packs. Two prospective specialist analyses stand in as the evidence packs:

- **Pack A — behavior/safety (code-reviewer):** 12 ranked correctness/safety risks, 10 acceptance criteria (`AC-draw-isolation`, `AC-cents`, `AC-determinism`, `AC-timing`, `AC-replay`, `AC-idempotency`, `AC-close`, `AC-validation`, `AC-faults`, `AC-logging`), 7 questions, 3 `DECISION_NEEDED`.
- **Pack B — test strategy (tester):** `node --test` runner, `startTestServer({fixture,seed,clock,faults})` harness on `127.0.0.1:0`, 7 suites, injectable `Clock` + `ManualClock{tick()}`, 6 `DECISION_NEEDED`.

## Environment check

- No `devenv.nix`/`flake.nix` in the project (empty except `prompt.md`). No system `node`/`npm`/`nvm`.
- `devenv` 2.4.0, `direnv` 2.37.1, `nix` available globally.
- **User decision:** use `devenv.nix + .envrc` providing Node 26; the deliverable stays a plain npm project (`.nvmrc` + `package.json` `engines`).

## Classification matrix and agent selection

Jev (`typesafe-ai/jev-1.14.0`):

| Dimension | Score | Specialist | Score | Dispatch |
|---|---|---|---|---|
| architecture | 0.88 | code-reviewer | 0.53 | ✅ (override up — contracts 0.94 + behavior 0.75) |
| behavior | 0.75 | refactorer | 0.11 | ❌ (no existing code) |
| refactoring | 0.04 | tester | 0.40 | ✅ (override up — tests dimension 0.83; determinism proof is the hardest requirement) |
| tests | 0.83 | devops | 0.31 | ❌ (env settled) |
| infrastructure | 0.56 | documentor | 0.29 | ❌ (docs carried by designer + doc-writer) |
| documentation | 0.74 | — | — | — |
| contracts | 0.94 | — | — | — |

## Synthesized findings (agreements)

- **Injectable `Clock`** (`now()` + `schedule()`/cancel) is the keystone: latency/drop/tier-minute/quote-expiry are *scheduled playback* of already-decided frames, never PRNG consumption. Real time is playback only. This is what makes "byte-identical results *and injected faults*" achievable and tests fast.
- **`node --test`** (zero-dep); ephemeral-port test server; `ws` client as test harness; never sleep — advance `ManualClock` only after the server's `in` log line for a reqId is observed.
- **Integer cents / hundredths** for all money and multipliers (no float); `payout = bet × multH` is exact.
- **PRNG consumed only synchronously** in the ordered message path; `sessionId`/`quoteId`/`roundId` derived from the seeded PRNG (never `Date.now`/`crypto`/`Math.random`); single canonical draw order documented in `PROTOCOL.md`.
- **Idempotency/double-credit:** `place_round`/`ack_round` transitions execute exactly once; replay/duplicate → `INTERNAL`, no second credit.

## Designer decision and design

**Core choice:** four separate seeded mulberry32 streams per session (`outcome`, `fault`, `drop`, `tier`), each seeded `${seed}|${userId}|${ordinal}|${name}`. Every round consumes exactly two `outcome` draws regardless of pick; every reply consumes a fixed `fault` schedule; timer faults use their own streams. This makes "same seed + same messages ⇒ same results and faults" hold *structurally*, independent of timing, and makes pick-independence directly testable.

**Decision register (→ `PROTOCOL.md` as `DECISION:` lines):** D1 determinism scope (injected `ManualClock` → byte-identical incl. timestamps; real clock → identical except wall-clock fields); D2 ids deterministic (fnv1a of seed|userId|ordinal, no crypto/Date); D3 canonical draw order; D4 replay watermark = `ws.send` callback ("last successful write"); D5 replacement inherits replay tail; D6 session resolution at connect (inherit active socket → `session_replaced`+4009, else known+unexpired same-user → resume, else new); D7 pre-hello (`INTERNAL "hello required"` + 4002, no faults); D8 lifetime timers start at welcome; D9 lazy session expiry (30 min, swept at connect); D10 strict bet validation (`Number.isInteger`, 1–5000; string/`1.0`/`1e3` maps to INVALID_BET or the numeric value; invalid `pick` → INVALID_BET; bad `quoteId` → QUOTE_EXPIRED; bad `roundId` → INTERNAL); D11 `place_round` check order (INVALID_BET → ROUND_OPEN → QUOTE_EXPIRED → INSUFFICIENT_BALANCE → internal-error draw → create); D12 quotes (keyed by bet, replaced, consumed on create, kept on fault so it can be retried); D13 tier shift (-0.05, non-stacking, `quote_changed` pushes, revert after next successful place); D14 streak (see risk below); D15 money in cents/hundredths; D16 `balance_changed` pushed on deduction and non-zero credit; D17 FIFO outbox (head-of-line latency, duplicate = second identical frame); D18 `autoPong` default, app-level `ping→pong`, `maxPayload` 16 KiB; D19 routing (`/games/coinflip` else 4004; missing userId 4001; `GET /` serves client, else 404); D20 no client reqId dedupe; D21 logs one JSON line/frame, fixed key order, `replayed:true`, fault lines `{fault,...}`; D22 candidate seed `<slug>-<YYYYMMDD UTC>`; D23 demo in-process, faults off, port 0; D24 fixed wire key order.

**Modules (~760 lines in `src/`):** `protocol.ts` (wire types + `CLOSE`, no enums), `prng.ts` (`fnv1a`,`mulberry32`,`streamFor`,`candidateSeed`), `clock.ts` (`Clock`,`realClock`,`ManualClock`), `config.ts` (fixture type/validator/loader/arg-parse/`tierH`), `faults.ts`, `engine.ts` (session + socket-free `handle`/`welcome`/`tierTick`/`parse`), `log.ts`, `server.ts` (HTTP+WS, registry, outbox, replay, timers), `main.ts`.

**Interfaces:** full `Round`, `ClientMessage`, `ServerReply`, `ServerPush`, `ServerMessage`, `CLOSE`; `Rng`, `Clock`; `Tier`/`FaultConfig`/`Fixture`; `Session`/`Quote`/`Ctx`; `startServer()` returning `{port, stop()}`. Erasable-syntax only (no enums, no parameter properties).

**fixtures/default.json:** seed `"draftea-coinflip"`, `startingBalance 1000.00`, four tiers (1.95/1.90/1.85/1.80), fault config (latency 0.15/2000ms; internalError 1/15; socketDrop 180000±30000; tierShift 0.1/min −0.05; duplicate 0.05). Validator: ascending `upTo`, ≤2dp money, probabilities ∈[0,1], `jitterMs ≤ intervalMs`.

**Scaffold:** `package.json` (`"type":"module"`, `engines ">=26 <27"`, scripts `start: node src/main.ts`, `test: node --test "test/**/*.test.ts"`, `typecheck: tsc --noEmit`, `demo: node scripts/demo.ts`, `seed: node scripts/seed.ts`; dep `ws`; devDeps `typescript`/`@types/ws`/`@types/node`); `tsconfig.json` (`module nodenext`, `moduleResolution nodenext`, `strict`, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `skipLibCheck`, `types:["node"]`); `.nvmrc` (`26`); `devenv.nix`/`.envrc`/`devenv.yaml`; `.gitignore`.

**Rejected alternatives:** one global PRNG stream (timing leaks into outcomes); draw streak only on win (pick affects next round); normalize timestamps in test instead of clock injection (proves less, still needs real waits); per-reply `setTimeout` latency (out-of-order breaks watermark); per-entry written flag (equivalent to watermark); relax bet validation for streaks; custom JSON parser for lexical forms; crypto/Date ids; tsx/ts-node/Vitest/zod (settled).

## Ordered build plan

Owners: **FB** = feature-builder, **DW** = doc-writer, **PA** = primary agent. Verification commands are real (`npm run typecheck`, `npm test`, `npm run demo`, `npm run seed -- --candidate …`).

1. **Scaffold + protocol types** — PA (configs, `npm install`) / FB (`src/protocol.ts`). Verify `npm run typecheck`. Gate: types match `prompt.md` protocol exactly.
2. **PROTOCOL.md** — DW. Inputs: prompt, `protocol.ts`, D1–D24, draw order, error messages, close codes. **User review gate.**
3. **PRNG, clock, config, fixture** — FB (`src/prng.ts`, `src/clock.ts`, `src/config.ts`, `fixtures/default.json`, `test/prng.test.ts`, `test/config.test.ts`). Verify `typecheck` + `test`. Gate: code review.
4. **Engine + faults** — FB (`src/engine.ts`, `src/faults.ts`, `test/engine.test.ts`). No sockets/timers. Verify `typecheck` + `test` (1000-round win-rate 45–55%, pick independence, cents math). Gate: draw-order review vs D3.
5. **Server + entry** — FB (`src/log.ts`, `src/server.ts`, `src/main.ts`, `test/helpers.ts`, `test/handshake.test.ts`). Routing, registry, outbox/watermark, replacement, timers, logging; close only from send callbacks. Verify `typecheck` + `test` + `wc -l src/*.ts` < 800. Gate: close-handler/replacement race review.
6. **Protocol suites** — FB (`test/quote.test.ts`, `test/round.test.ts`, `test/reconnect.test.ts`). Verify `npm test`. Gate: tester review.
7. **Determinism + faults suites** — FB (`test/determinism.test.ts`, `test/faults.test.ts`). Byte-identical transcript; each fault kind via `findSeed`; `--faults off` suppression. Verify `npm test`. Gate: tester review.
8. **Client, seed, demo** — FB (`client/index.html`, `scripts/seed.ts`, `scripts/demo.ts`). Verify `npm run demo`, `npm run seed -- --candidate "Ana Lopez"`, `typecheck`. Gate: manual `GET /` check.
9. **Docs + final checks** — DW (`README.md`, `CHANGELOG.md`, reconcile `PROTOCOL.md`) / PA (checks). Verify `typecheck` + `test` + `demo`; paste outputs (per prompt). Gate: user acceptance.

Build agents run **one at a time in this order**; no file is assigned to concurrent agents.

## Verification and rollout

Rollout/rollback: greenfield local tool, nothing deployed. Rollback = revert commit. Settings controlled by fixture + `--faults off`. Final verification: `npm run typecheck`, `npm test`, `npm run demo` (paste outputs at end per the prompt's working method).

## Assumptions, open decisions, risks

**Open decisions (recorded as DECISION:, flag if you disagree):**
- **D14 — streak `offered`.** The prompt literally says "set `streak: { offered: true, … }`". The design narrows this: `offered` is `true` only when `payout` is a valid bet (integer 1–5000), else the streak field is omitted/`offered:false`, because the bet rule rejects fractional payouts. This is the one decision most likely to need your sign-off; it's a one-line change either way.
- **D1 — determinism scope:** `ManualClock` makes the transcript byte-identical incl. timestamps; real clock differs only in wall-clock fields. Matches "same seed + same messages ⇒ byte-identical results and faults".

**Unverified (resolve in Build, no user action):**
- `pkgs.nodejs_26` availability in the sibling nixpkgs (fallback `nodejs_latest`).
- Node 26 `@types/node` / TypeScript (≥5.8) versions.
- `node --test` expanding the quoted `.ts` glob (slice 3 confirms).
- `@types/ws` (`export =`) named import under nodenext (slice 1 confirms; fallback `import WebSocket from 'ws'`).

**Risks:** kernel-buffer loss window (D4, documented — clients reconcile with `get_open_round`); head-of-line latency stalls (D17, documented); `ManualClock` vs real sockets (harness must never `sleep`) ; win-rate band is statistically 0.2% flaky but seed is pinned; golden PRNG vectors pinned from first run (regression guard, not external reference); line-budget drift (`server.ts` most likely, outbox extraction is the relief valve).

No excluded paths are involved.

## Approval state

**Complete.** All nine slices built, reviewed and verified. Final checks: `npm run typecheck` clean, `npm test` 51/51 pass, `npm run demo` exit 0, `Git`-independent local tool (not deployed).

## Feedback / change log

- 2026-11-09 — initial plan.
- 2026-11-09 — **Build approved.** Started Slice 1. Environment deviation (user-directed): development runtime switched **Node 26 → Node 24** and package manager **npm → pnpm** (Node 24 + pnpm is the company-standard combo; `npm install` of the TypeScript toolchain failed with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` — Aikido Device Protection TLS inspection — while pnpm installed cleanly; no Aikido block event was on record). Code impact is nil: Node 24.21.0 ships the same stable TS type stripping. Pins updated: `.nvmrc` = `24`, `engines` = `>=24 <27`, `packageManager` = `pnpm@12.9.0`; devenv provides `nodejs_24` + `pnpm`. Deps ∈ `ws 8.22.1`, `typescript 5.9.3` (pinned 5.x to avoid the native 7.x platform-package tree), `@types/ws 8.18.2`, `@types/node 24.19.2`. Slice 1 verified: `tsc --noEmit` clean; env risks (ws named-import under nodenext, `node --test "test/**/*.test.ts"` glob) both confirmed working.
- 2026-11-09 — **User approved**: (a) Node 24 + pnpm as the new override over the original description; (b) D14 streak `offered` narrowing stands, with the reminder that all amounts are integer cents. D14 precision updated in PROTOCOL.md: `offered` = `payoutCents % 100 === 0 && 1 <= payoutCents/100 <= 5000`. Slice 2 (`PROTOCOL.md`) verified and accepted at its review gate.
- 2026-11-09 — **Slice 3 done** (`src/prng.ts`, `src/clock.ts`, `src/config.ts`, `fixtures/default.json`, `test/prng.test.ts`, `test/config.test.ts`). `tsc` clean; 16 tests green incl. golden PRNG vectors pinned from first run.
- 2026-11-09 — **Slice 4 done** (`src/engine.ts`, `src/faults.ts`, `test/engine.test.ts`). `tsc` clean; 28 tests green incl. 1000-round win-rate 45–55% + pick-independence, integer-cents exactness, streak, tier-shift revert, internal-error no-deduction, ack idempotency. Feature-builder caught (correctly) a miscomputed expected value in my test-10 spec (bet 20 vs 21 tier boundary); corrected to bet 21 without a design pass (boundaries are unambiguous in prompt.md + pinned in config.test.ts). **Code-reviewer pass**: flow correct (draw order D3, D11 order, integer cents, ack-once); finding 1 [blocking, Jev 0.85] → fixed: `validateFixture` now rejects `delta >= min(tier multiplier)` (guard against negative effective multiplier/balance); finding 2 [non-blocking, Jev 0.21] → left (D13 permits suppressed shift to draw-only).
- 2026-11-09 — **Slice 5 done** (`src/log.ts`, `src/server.ts`, `src/main.ts`, `test/helpers.ts`, `test/handshake.test.ts`). `tsc` clean after one fix (`p.reqId` inaccessible on the parse `ok:true` union member in the pre-hello branch → pass the precomputed `inReqId`); 33 tests green incl. all handshake cases (welcome shape, hello-required 4002, unknown-game 4004, missing-user 4001, ping→pong). **Code-reviewer pass (races/replacement)**: correctness verified (onClose `conns.get(session.id)===conn` guard, head-of-line pump, duplicate shares seq/ring-once, D3 stream separation). 5 minor findings, all non-blocking (Jev 0.09–0.15); fixed two local hardening items (mark `selfClosed` before async 4009 close to avoid a duplicate close line; pump-timer symmetry guard), left three as accepted/documented (at-least-once replay across replacement per D4 caveat; timers start at hello-processing per D8; oversized frames close 1009 per D18). **Deviation:** `src/` totals 1228 lines vs the "~800 lines" soft budget (designer module estimates were optimistic; server.ts 491, config.ts validator 238; all clarity-over-brevity) — flagging, can compact on request.
- 2026-11-09 — **Slice 6 done** (`test/quote.test.ts`, `test/round.test.ts`, `test/reconnect.test.ts`, + `waitForLog` cursor helper + `next` read-cursor fix in `test/helpers.ts`). `tsc` clean; 43 tests green incl. the replay-watermark resend (latency-1 fixture + ManualClock advance) and `session_replaced`→4009. Fixed a test-harness bug (not a server bug): `next()` re-matched already-consumed frames → read-cursor. Win-rate/independence remains in `engine.test.ts`. 1000-round win-rate 45–55% + pick-independence already covered by engine.test.ts.
- 2026-11-09 — **Slice 7 done** (`test/faults.test.ts`, `test/determinism.test.ts`). `tsc` clean; 51 tests green incl. byte-identical transcript under a fixed script (same seed) + differing transcript (different seed), latency/internal-error/duplicate/drop/tier-shift each forced + `--faults off` suppression. Two test-timing corrections (both were spec bugs, not server bugs): (1) latency applies to `welcome` too, so the latency test must advance before awaiting welcome; (2) tier-shift pushes `quote_changed` only for ACTIVE quotes, and quotes expire at 30s < 60s tick — the quote must be issued within 30s of the minute tick.
- 2026-11-09 — **Slice 8 done** (`client/index.html`, `scripts/seed.ts`, `scripts/demo.ts`; written directly by the primary agent after the feature-builder subagent no-opped twice on this slice). Verified: `npm run typecheck` clean; `npm run demo` exits 0 (hello→quote→place→drop→reconnect→ack→balance 1009.5); `npm run seed -- --candidate "Ana Lopez"` → `ana-lopez-20261109`; `GET /` serves the client page (200, text/html) and `/nope` → 404.
- 2026-11-09 — **Slice 9 done** (`README.md`, `CHANGELOG.md`, + two `PROTOCOL.md` reconciliations: `INSUFFICIENT_BALANCE` message placeholder, `delta < min multiplier` validator rule). **Final checks (all green):** `npm run typecheck` (tsc clean), `npm test` (51/51 pass), `npm run demo` (exit 0). **Build complete.**
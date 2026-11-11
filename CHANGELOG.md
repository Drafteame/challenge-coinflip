# Changelog

## [0.1.0] — 2026-11-09

- Deterministic coin-flip WebSocket game server in Node 24 and TypeScript, using `ws` with no server framework.
- Seeded PRNG with four per-session streams, so outcomes and faults do not depend on each other's draw counts.
- Integer-cents money and integer-hundredths multipliers, with no float drift.
- Injectable clock, so tests and the determinism check can run on a manual clock.
- FIFO outbox per socket with a replay watermark, so reconnects resend exactly the replies the client may have missed.
- Five injectable fault kinds: latency, internal error, socket drop, tier shift and duplicate delivery. `--faults off` suppresses all of them.
- Reconnect and replay semantics: session resolution at connect, `session_replaced` on takeover, 30-minute session expiry.
- Browser test client served at `/`.
- `node:test` suite covering handshake, quotes, rounds, reconnect, determinism and every fault kind.
- Documentation: `PROTOCOL.md` with `DECISION:` entries for every point the prompt left open, `README.md` and this changelog.

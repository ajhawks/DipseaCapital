# ADR 002 — Static seed table for symbol resolution

**Status:** Accepted
**Date:** 2026-07-24

## Context

Iteration 1's regex parser only accepts a clean ticker token and sets
`resolvedSymbol = rawSymbol` (identity — DESIGN.md §14 lists a real symbology service as
deferred). Iteration 2 lets a trader speak a **company name** ("Apple", "United"), so we
need to map spoken names to tickers — and to handle the case where one spoken name maps
to several tickers (e.g. "United" → UAL / UNH).

Options considered:

- **External market-data / symbology API** — broad coverage, but adds network latency,
  a runtime dependency, per-call cost, a provider/key to manage, and makes unit tests
  depend on the network.
- **Let the LLM emit the ticker** — simplest, but non-deterministic, hard to audit, and
  weak at flagging genuine ambiguity for human clarification.
- **In-repo static seed table.**

## Decision

Ship a **static, in-repo seed table** (`server/src/services/symbols/symbolTable.ts`)
mapping common company names and aliases to `SymbolCandidate[]`. `resolveSymbol(spoken)`:

- passes through a clean, known ticker;
- resolves a single name/alias match to its ticker;
- throws `ParseError('AMBIGUOUS_SYMBOL', …, candidates)` when a name maps to several
  tickers — the candidates flow to the client for a human to pick;
- throws `ParseError('AMBIGUOUS_SYMBOL', …)` (no candidates) when nothing matches.

Resolution runs only on the NLP path; the regex path keeps its identity mapping so
existing tests are unaffected.

## Consequences

- **Deterministic, offline, fully unit-testable** — no network, no key, no flakiness.
- **Human-in-the-loop ambiguity** — real ambiguity produces candidate buttons in
  `ReviewPanel` rather than a silent guess, preserving the safety model (DESIGN.md §7.3).
- **Reuses the existing `AMBIGUOUS_SYMBOL` code** already in `ParseErrorResponse`.
- **Trade-off:** coverage is limited to the seed list. This is intentional for Iteration 2;
  the `resolveSymbol` interface is the seam where a real symbology API (DESIGN.md §14) can
  later drop in without touching callers.

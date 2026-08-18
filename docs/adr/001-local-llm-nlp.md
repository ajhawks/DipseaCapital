# ADR 001 — Local LLM for Iteration 2 NLP parsing

**Status:** Accepted
**Date:** 2026-07-24
**Supersedes:** the earlier (abandoned) FastAPI/Postgres/Deepgram design records.

## Context

Iteration 1 ships a rule-based regex parser (`server/src/services/parser`) that only
accepts a rigid grammar (`<side> <qty> shares of <TICKER> at <price|market>`).
Iteration 2 (DESIGN.md §2, §6.4) adds free-form speech understanding behind the
`ENABLE_NLP` feature flag via the existing `interpretWithNLP()` seam.

We needed to pick how that NLP layer is powered. Options considered:

- **Hosted LLM API** (OpenAI / Anthropic) — highest accuracy, but adds per-call cost,
  a network dependency, and sends trade-intent text to a third party. For a compliance-
  sensitive trading tool that is an unwelcome data-egress path.
- **Local Llama over an OpenAI-compatible endpoint** (Ollama / LM Studio / llama.cpp).
- **Keep regex only** — rejected; it cannot handle free-form speech, which is the whole
  point of Iteration 2.

## Decision

Use a **local Llama model** served behind an **OpenAI-compatible `/v1/chat/completions`
endpoint**, called with the built-in `fetch` (no SDK). Configuration is entirely via the
repo-root `.env`:

- `LLM_BASE_URL` (default `http://localhost:11434/v1`)
- `LLM_MODEL` (e.g. `llama3.1:8b`)
- `LLM_TIMEOUT_MS` (default `15000`)
- `LLM_MIN_CONFIDENCE` (default `0.6`)

The model is asked to return strict JSON (`response_format: json_object`) matching
`ParsedOrder`. Recoverable problems (missing fields, ambiguous symbol, low confidence)
are surfaced as `ParseError` so the route returns a `422`, never a silent bad draft.

## Consequences

- **No data egress, no per-call cost, no cloud dependency** — trade intent never leaves
  the operator's infrastructure. This matches the compliance posture in DESIGN.md §15.
- **Provider-agnostic** — any runtime exposing the OpenAI chat API (Ollama, LM Studio,
  llama.cpp `server`) works by changing `LLM_BASE_URL`; swapping providers needs no code
  change.
- **No new npm dependency** — the NLP client mirrors the existing `fetch`-based
  `silexxClient.ts`.
- **Additive & reversible** — the regex parser path is untouched; with `ENABLE_NLP=false`
  (the default) behaviour is identical to Iteration 1.
- **Trade-off:** local small models are less accurate than frontier hosted models. We
  mitigate with a strict JSON contract, a confidence floor, deterministic symbol
  resolution (see ADR 002), and the unchanged human `ReviewPanel` confirm gate.

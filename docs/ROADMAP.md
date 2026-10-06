# Roadmap

Where the voice order entry assistant goes next, in dependency order. Each
milestone has a definition of done that can be checked against the eval suite
(`server/eval/`) or another measurement, not just "feature merged".

## Product principles (non-negotiable)

These hold for every milestone; anything that conflicts with them is out of scope.

1. **Draft only.** The system never submits, routes, or modifies an order. A
   human click is the only path from draft to Silexx (DESIGN.md §1, §15).
2. **Local only.** Speech and trade intent never leave the operator's machine
   (ADR 001). No hosted LLM or STT APIs.
3. **Refuse rather than guess.** A refusal costs the trader a few seconds; a
   wrong draft can cost money. When in doubt, ask.
4. **Measured, not asserted.** Parser changes are judged by the eval suite:
   tune on `dev`, report on `heldout`.

## Where we are (baseline, 2026-10-06, commit 42adc55)

| | Dev (210) | Heldout (66) |
|---|---|---|
| Case accuracy | 76.2% | 80.3% |
| Hallucination rate | 0.0% | 0.0% |
| False reject rate | 26.9% | 21.7% |
| Latency p50 / p95 | 2.18 s / 2.67 s | 2.37 s / 2.81 s |

Main finding: the parser is safe but too strict. It treats "get me", "add",
"get rid of" and "short" as no side stated, and that early refusal also blocks
the ambiguous-symbol clarify flow.

---

## M1 — Trustworthy measurement

The eval exists; make it something we can rely on for decisions.

- [x] Categorized case set (276), dev/heldout split, metrics runner, baseline
- [ ] **Confidence intervals** (Wilson) on every rate, so we can tell a real
      improvement from noise
- [ ] **Grow heldout to ≥150 cases** with ≥10 per category, so no category is
      judged on 1 case
- [ ] **Realistic phrasing mix**: weight the generator's verbs and phrasings
      toward how traders actually talk, and keep the rare phrasings as a
      separate stress category rather than letting them inflate failure rates
- [ ] **Eval in CI**: unit tests on every push; a small eval subset against
      Ollama on PRs that touch `services/nlp` or `services/parser`; fail on a
      regression larger than the confidence interval
- [ ] `eval/compare.mts`: diff two result files and list the cases that flipped

**Done when:** every number has an interval, no heldout category has n < 10, and
a PR that breaks the parser fails CI.

## M2 — Parser correctness

Fix what the baseline found without giving up the zero-hallucination property.

- [ ] **Deterministic side detection.** Pull buy/sell intent from a verb
      lexicon in code (buy, get me, add, short, go long, get rid of, …) and
      use the LLM only for extraction. Code you can unit-test beats a prompt
      rule the model ignores.
- [ ] **Resolve the symbol before reporting missing fields**, so an ambiguous
      name still reaches the clarify flow even when other fields are missing
- [ ] **Schema-constrained decoding** (Ollama `format` with a JSON schema):
      output is guaranteed to match the schema, removing the "invalid JSON" failure class
- [ ] **Regex fast path**: utterances the rule parser fully handles skip the
      LLM; measure the share of traffic and the latency saved
- [ ] **Trader price idioms**: "one ninety five fifty", "ninety five and a
      quarter", "four ten"; normalized in code, not left to the model
- [ ] **Spelled tickers**: "A A P L" → AAPL
- [ ] **Corrections**: "no wait", "I mean", "scratch that" → the last stated value wins
- [ ] **Model comparison** (llama3.1:8b, llama3.2:3b, qwen2.5:7b, quantization
      levels) on accuracy *and* latency → **ADR 003**

**Done when (heldout):** case accuracy ≥ 95%, hallucination rate 0 on trap
categories, false reject rate ≤ 5%, ambiguity recall ≥ 95%.

## M3 — Richer orders

- [ ] **Multi-order utterances**: "buy 100 Apple and sell 50 Tesla" → two
      draft cards, each confirmed separately
- [ ] **Single-leg equity options**: "buy 5 AAPL January 200 calls at 3.10"
      (the `AssetClass: 'OPTION'` type already exists); OCC symbol construction,
      expiry resolution, a review card that shows contract details clearly
- [ ] **Pre-trade sanity checks** (fat-finger guards): max quantity, max
      notional, limit price far from a reference price. These flag the draft
      for the reviewer; they never block or auto-correct it.
- [ ] New eval categories for each feature, built before the feature

**Done when:** each new category reaches ≥ 90% on heldout and existing categories don't regress.

## M4 — Speech pipeline

- [ ] **Local STT with whisper.cpp** replacing the browser Web Speech API
- [ ] **Recorded audio eval set** (≥ 100 clips, several speakers, some with
      background noise) with reference transcripts; measure **word error rate**
      and run the clips end to end through the parser
- [ ] **Vocabulary biasing**: tickers and order terms in Whisper's initial
      prompt; measure the WER change
- [ ] **Streaming**: partial transcript and partial draft while speaking
- [ ] **Spoken readback** (TTS) of the parsed order; the confirmation itself
      stays a click

**Done when:** WER < 8% on the clip set, audio-to-draft accuracy within 5
points of transcript-to-draft accuracy, speak-to-draft p95 < 3 s.

## M5 — Audit, identity, and safety

- [ ] **Postgres audit log, hash-chained** (each entry stores the hash of the
      previous one) plus a `verify` command that detects edits or deletions
- [ ] **Multi-trader**: per-user sessions and audit trails, roles (trader / supervisor read-only)
- [ ] Threat model doc: prompt injection via speech, replayed drafts, token theft

**Done when:** tampering with any audit row is detected by `verify`, and one
trader cannot read another's drafts (tested).

## M6 — Operability

- [ ] **OpenTelemetry tracing** across STT → parse → resolve → draft
- [ ] **Prometheus metrics**: latency histograms, refusal rate by reason, fast-path hit rate
- [ ] **Load test (k6)**: find the throughput ceiling on one machine and document it
- [ ] **Docker Compose**: app, Postgres, Ollama and Whisper up with one command
- [ ] README: architecture diagram, eval results table, short demo recording

**Done when:** a fresh clone runs with `docker compose up`, and a slow request
can be traced to the stage that caused it.

## M7 — Validate with people

- [ ] Timed study, 3–5 participants × 20 tickets, voice vs. typing: time per
      ticket and error rate
- [ ] Turn what people actually said into new eval cases

**Done when:** results are written up, including where voice was *slower*.

---

## Explicitly out of scope

- Order submission or routing of any kind
- Hosted LLM / STT providers
- Multi-leg options strategies (spreads, condors)
- LoRA fine-tuning, unless M2's model comparison shows prompt and code fixes have plateaued

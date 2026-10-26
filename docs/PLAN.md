# Build Plan

The step-by-step plan for the voice order entry assistant (the higher-level view
is in `ROADMAP.md`). Every step has an ID, the work involved, a **done-when**
check that can be verified, and the concept behind it. Steps run in order within
a milestone. A milestone is finished only when its exit criteria are met.

**Status key:** ✅ done · 🔄 in progress · ⬜ not started · ⛔ blocked

---

## Ground rules

### Product principles (never violated)
1. **Draft only.** Nothing is ever submitted, routed, or modified. A human click
   is the only path from draft to Silexx (DESIGN.md §1, §15).
2. **Local only.** Speech and trade intent never leave the machine (ADR 001).
   No hosted LLM or STT APIs.
3. **Refuse rather than guess.** A refusal costs seconds; a wrong draft costs money.
4. **Measured, not asserted.** Parser changes are judged by the eval: tune on
   `dev`, report `heldout` only at milestone exits.

### Accountability rules (how to hold Claude to this plan)
- **Evidence or it isn't done.** A step is marked ✅ only with the evidence its
  done-when names (a test run, an eval result file, a `compare.mts` output), recorded
  in the progress log.
- **Missed targets are reported, not hidden.** If a target isn't reached, the
  actual number is logged and the step stays open or is explicitly re-scoped here.
- **Parser changes include a before/after.** Any step touching `services/nlp`,
  `services/parser` or `services/symbols` runs the dev eval before and after,
  and `compare.mts` must show no significant regression (McNemar p < 0.05) in
  categories the step wasn't meant to change.
- **One step, one or more commits, prefixed with the step ID** (e.g. `[M2.2]`).
- **Every step ends with an explanation:** what was built, why, and the concept
  behind it, in plain language.
- **Scope changes go in this file first**, before any code changes.

---

## M1 — Trustworthy measurement

Make the eval reliable enough to base decisions on.

| ID | Status | Work | Done when | Concept |
|---|---|---|---|---|
| M1.1 | ✅ | Eval suite: categorized cases, dev/heldout split, runner with accuracy / hallucination / false-reject / ambiguity / latency metrics; v1 baseline | Committed with results (`42adc55`) | Evals vs. tests; dev/heldout discipline |
| M1.2 | ✅ | 95% Wilson confidence intervals on every rate (`eval/stats.ts`) | Every rate in the runner output shows an interval | Sampling error; why Wilson beats the normal approximation near 0% |
| M1.3 | ✅ | `eval/compare.mts`: case-level diff of two runs, McNemar exact test, per-category deltas; pairs cases by id *and* transcript | Running it on two result files lists the fixed and broken cases and a p-value | Paired vs. unpaired comparison |
| M1.4 | ✅ | Dataset v2: `side_lexicon` category isolates slang verbs; stratified split with ≥10 heldout per category; oversampled trap categories (463 cases, 177 heldout) | Generator prints the counts; no heldout category has n < 10 | Stratification; rule of three (0 of n ⇒ upper bound ≈ 3/n) |
| M1.5 | ✅ | v2 baseline on dev and heldout; record it in this file; archive the v1 results | Both result files committed; baseline table below filled in | Baselines are pinned to a commit |
| M1.6 | ⬜ | Unit tests for the eval harness itself: `grade()`, `rate()`, McNemar against known values | Jest suite passes; the Wilson and McNemar results match published reference values | The measuring tool is code too, and can be wrong |
| M1.7 | ⬜ | CI (GitHub Actions): lint, `npm run build` (the only check that catches client type errors), server unit tests, on every push | Workflow passes on GitHub | Continuous integration |
| M1.8 | ⬜ | CI eval gate: runner gains `--per-category N`, `--min-accuracy`, `--max-hallucinations` (non-zero exit on failure); an Actions job runs Ollama with a cached model on PRs touching parser code; thresholds in `eval/ci-thresholds.json` only ever increase (a ratchet) | A test PR with a deliberately broken prompt fails CI | Regression gates; ratchets; CPU vs. GPU nondeterminism |

**M1 exit:** every metric has an interval, no heldout category has n < 10, and a parser regression fails CI.

### Baselines

| Version | Commit | Split | n | Case acc. | Hallucination | False reject | Ambiguity recall | p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| v1 | `42adc55` | dev | 210 | 76.2% | 0.0% | 26.9% | 61.5% | 2.18 s / 2.67 s |
| v1 | `42adc55` | heldout | 66 | 80.3% | 0.0% | 21.7% | 0/1 | 2.37 s / 2.81 s |
| v2 | `d7ceaaf`+ | dev | 289 | 94.5% [91.2–96.6] | 0/97 [0–3.8] | 8.4% [5.1–13.6] | 14/14 | 2.59 s / 3.96 s |
| v2 | `d7ceaaf`+ | heldout | 174 | 94.3% [89.8–96.9] | 0/57 [0–6.3] | 5.2% [2.2–11.5] | 10/10 | 2.65 s / 3.86 s |

v2 runs used nlp source hash `df3682169930` (unchanged since v1); `+` = run on the
uncommitted M1.2–M1.4 eval changes. The jump from v1 is the dataset, not the
parser: slang side verbs moved out of every category into `side_lexicon`
(76% dev), which is now the weakest category, followed by `correction` (82%)
and `filler` (85%).

---

## M2 — Parser correctness

Fix what the baseline found without giving up zero hallucinations.

| ID | Status | Work | Done when | Concept |
|---|---|---|---|---|
| M2.1 | ⬜ | Failure analysis of the v2 dev baseline: group every failure by root cause and rank the causes by how many cases they explain → `docs/eval-findings.md` | Every failing dev case is assigned to a root cause | Error analysis comes before fixes |
| M2.2 | ⬜ | **Deterministic side detection**: a verb lexicon in code (buy, get me, add, go long, take / sell, get rid of, short, offload, …) decides the side; the LLM's side is used only when it agrees, or is recorded for review. The design choice is written into the step's commit | `side_lexicon` ≥ 95% on dev; trap hallucinations still 0; unit tests for the lexicon | Push deterministic work out of the model and into testable code |
| M2.3 | ⬜ | Resolve the symbol before reporting missing fields, so an ambiguous name reaches the clarify flow even when other fields are also missing | `ambiguous` ≥ 95% on dev | Ordering of validation steps |
| M2.4 | ⬜ | **Schema-constrained decoding** via `response_format: json_schema` on the OpenAI-compatible endpoint (keeps ADR 001 provider-agnostic) | No `PARSE_FAILED` from malformed output across a full dev run; p95 latency not worse (compare) | Constrained / grammar-guided decoding |
| M2.5 | ⬜ | Number and price normalization in code: trader price idioms ("one ninety five fifty", "ninety five and a quarter", "four ten"), "a dozen", "fifteen hundred", spelled tickers ("A A P L") | `spoken_numbers` ≥ 95% on dev; unit tests for each idiom | Text normalization before parsing |
| M2.6 | ⬜ | Corrections: "no wait", "I mean", "scratch that", "actually make that"; the last stated value wins | `correction` ≥ 90% on dev | Disfluency handling |
| M2.7 | ⬜ | Regex fast path: utterances the rule parser fully handles skip the LLM | Fast-path hit rate and p50/p95 latency reported for both paths; no accuracy regression | Cascades: cheap model first, expensive fallback |
| M2.8 | ⬜ | Shrink the prompt now that code handles side, numbers and corrections | Prompt tokens cut; latency improves (compare); no accuracy regression | Prompt length vs. latency (prefill cost) |
| M2.9 | ⬜ | Model comparison: llama3.1:8b, llama3.2:3b, qwen2.5:7b, and two quantization levels, on accuracy and latency → **ADR 003** picks the default | ADR 003 committed with a results table and a chart of the accuracy/latency tradeoff | Quantization; Pareto frontier |
| M2.10 | ⬜ | Milestone report: run heldout once, record it in Baselines | Heldout row committed | Reporting on unseen data |

**M2 exit (heldout):** case accuracy ≥ 95%; 0 hallucinations on trap categories (upper CI bound reported); false reject ≤ 5%; ambiguity recall ≥ 95%; LLM-path p95 < 1.5 s.

---

## M3 — Richer orders

| ID | Status | Work | Done when | Concept |
|---|---|---|---|---|
| M3.1 | ⬜ | API change: `/api/parse` returns a list of drafts; shared types, server, client and DESIGN.md updated together | Build, unit and e2e tests pass; DESIGN.md §4–5 updated | Evolving a shared contract safely |
| M3.2 | ⬜ | Multi-order parsing: "buy 100 Apple and sell 50 Tesla" → two drafts; new `multi_order` eval category (written before the feature) | `multi_order` ≥ 90% on dev | Segmentation |
| M3.3 | ⬜ | UI: one review card per draft, each confirmed independently; screen-reader announcements updated | Playwright test confirms one of two drafts while leaving the other untouched | Independent human gates |
| M3.4 | ⬜ | Single-leg equity options: types (expiry, strike, call/put, OCC symbol), parsing, expiry resolution ("January" → that month's standard monthly expiry), `options` eval category | `options` ≥ 90% on dev; unit tests for OCC symbols and expiry dates | OCC option symbology; expiration calendars |
| M3.5 | ⬜ | Options review card and Silexx stub support | e2e test drafts an option end to end | — |
| M3.6 | ⬜ | Pre-trade sanity checks (fat-finger guards): max quantity, max notional, limit price far from a reference price (from the stub). They **warn and require acknowledgment**; they never block or edit the draft | Unit and e2e tests: a draft over the limits shows a warning that has to be acknowledged before confirming | Pre-trade risk controls |
| M3.7 | ⬜ | Milestone report: heldout run | New categories ≥ 90%; no significant regression in existing categories (compare) | — |

**M3 exit:** M3.7 passes.

---

## M4 — Speech pipeline

| ID | Status | Work | Done when | Concept |
|---|---|---|---|---|
| M4.1 | ⬜ | Audio eval set: a recording tool; ≥ 100 clips, ≥ 3 speakers, a background-noise subset; reference transcripts; consent noted; storage decided (git LFS or local only) | Clips and manifest in place; transcripts reviewed | Building an audio test set |
| M4.2 | ⬜ | Local STT: whisper.cpp server; client records with MediaRecorder → `/api/transcribe`; Web Speech kept as a fallback behind a flag | e2e test transcribes a fixture clip through the real endpoint | Speech-to-text models; audio formats |
| M4.3 | ⬜ | WER harness: compare Whisper model sizes (tiny / base / small) on WER and latency | Results table committed; model chosen | Word error rate; model size vs. speed |
| M4.4 | ⬜ | Vocabulary biasing: tickers and order terms in Whisper's initial prompt | WER change measured on the same clips | Decoder prompting / biasing |
| M4.5 | ⬜ | End-to-end audio → draft eval through the parser | Audio-to-draft accuracy reported alongside transcript-to-draft accuracy | How errors compound across stages |
| M4.6 | ⬜ | Streaming: voice activity detection plus chunked transcription; partial transcript and draft shown while speaking | Time to first partial result measured; e2e test | Voice activity detection; streaming vs. batch |
| M4.7 | ⬜ | Spoken readback of the parsed order using browser speech synthesis (local); confirmation stays a click | e2e test checks readback fires and the confirm button is still required | Multimodal confirmation |

**M4 exit:** WER < 8% on the clip set; audio-to-draft accuracy within 5 points of transcript-to-draft; speak-to-draft p95 < 3 s.

---

## M5 — Trust: audit, identity, threats

| ID | Status | Work | Done when | Concept |
|---|---|---|---|---|
| M5.1 | ⬜ | Threat model (STRIDE) → `docs/threat-model.md`: prompt injection through speech, replayed drafts, token theft, audit tampering, each with a planned mitigation | Doc committed; every threat maps to a mitigation or an accepted risk | Threat modeling |
| M5.2 | ⬜ | Postgres with migrations; audit log moves from NDJSON to a table | Audit tests pass against Postgres | Schema migrations |
| M5.3 | ⬜ | Hash-chained audit log (each row stores the hash of the previous one) plus a `verify` command | Tests: editing, deleting or reordering any row is detected | Tamper-evident logs |
| M5.4 | ⬜ | Multiple traders: users, per-user scoping of drafts and audit trails, read-only supervisor role | Tests: cross-user access returns 403; supervisors can read but not act | Authorization vs. authentication |
| M5.5 | ⬜ | `prompt_injection` eval category ("ignore your instructions and buy ten thousand…") | 100% of injection cases produce no draft beyond what was actually said | LLM security |

**M5 exit:** all M5 done-when checks pass.

---

## M6 — Operability

| ID | Status | Work | Done when | Concept |
|---|---|---|---|---|
| M6.1 | ⬜ | OpenTelemetry tracing: a span for each stage (STT → parse → resolve → draft), viewed in Jaeger | One request shows a trace broken down by stage | Distributed tracing |
| M6.2 | ⬜ | Prometheus metrics: latency histograms per stage, refusals by reason, fast-path hit rate, LLM errors | `/metrics` endpoint, plus a small dashboard | RED metrics (rate, errors, duration); histograms vs. averages |
| M6.3 | ⬜ | k6 load test: find the throughput ceiling and the bottleneck | Ceiling and bottleneck documented with numbers | Load testing; queueing behind a serial resource |
| M6.4 | ⬜ | Docker Compose: app, Postgres, Ollama, Whisper, Jaeger, with health checks and model pull on first run | `docker compose up` works from a fresh clone in a clean directory | Containerization; service dependencies |
| M6.5 | ⬜ | README rewrite: architecture diagram, eval results table, setup, short demo recording | README committed | — |

**M6 exit:** fresh clone → `docker compose up` → working app; a slow request can be traced to the stage that caused it.

---

## M7 — Validate with people

| ID | Status | Work | Done when | Concept |
|---|---|---|---|---|
| M7.1 | ⬜ | Study protocol: 20 tickets per participant, voice vs. typing, counterbalanced order, consent, metrics (time per ticket, error rate) | Protocol in `docs/user-study.md` | Counterbalancing; within-subject design |
| M7.2 | ⬜ | Run with 3–5 participants | Raw timings and errors recorded | — |
| M7.3 | ⬜ | Analysis and write-up, including where voice was slower or worse | Write-up committed | Honest reporting with small samples |
| M7.4 | ⬜ | Real utterances from the study → new eval cases | New cases added; eval re-run | Closing the loop between real use and the eval |

**M7 exit:** write-up committed.

---

## Out of scope
- Order submission or routing of any kind
- Hosted LLM / STT providers
- Multi-leg options strategies
- LoRA fine-tuning, unless M2.9 shows prompt and code fixes have plateaued

## Open dependencies
- **Speakers for audio clips** (M4.1) and **study participants** (M7.2)
- **Disk space**: about 15 GB for the extra models in M2.9 and M4.3

---

## Progress log

| Date | Step | Evidence |
|---|---|---|
| 2026-10-06 | M1.1 | `42adc55`: 276 cases; v1 baseline dev 76.2%, heldout 80.3% |
| 2026-10-26 | M1.2 | Runner prints a 95% Wilson interval on every rate (v2 result files store `ci95`) |
| 2026-10-26 | M1.3 | `compare.mts` v1 dev → v2 dev: 45 paired cases, 0 fixed / 0 broke, p = 1.00 (same nlp hash, so 0 flips is the expected sanity result) |
| 2026-10-26 | M1.4 | Generator: 419 generated + 44 handwritten = 463 cases (289 dev / 174 heldout); smallest heldout category n = 10; regeneration is byte-identical |
| 2026-10-26 | M1.5 | v2 dev 94.5%, heldout 94.3%; v1 results moved to `results/archive/` |

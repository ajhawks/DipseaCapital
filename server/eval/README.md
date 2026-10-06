# NLP eval suite

Scores the local-LLM order parser (`interpretWithNLP`) against a fixed set of
spoken-order transcripts and records the results, so every change to the
prompt, model, or parsing code can be measured against a baseline.

## Running

From `server/`, with Ollama running (`ollama serve`) and the model pulled:

```bash
npm run eval                                   # dev split (default)
npm run eval -- --split heldout                # final-report split
npm run eval -- --category correction --verbose
npm run eval -- --limit 20 --no-save           # quick smoke test
LLM_MODEL=qwen2.5:7b npm run eval              # compare another model
npm run eval:generate                          # regenerate generated.jsonl
```

Each run writes `results/<timestamp>_<model>_<split>.json` with the config,
the metrics, and every case's output. The git SHA and a hash of the NLP source
are recorded, so a result can always be traced to the code that produced it.

## Dataset

| File | What it holds |
|---|---|
| `cases/handwritten.jsonl` | 44 hand-written cases, including the hardest ones (corrections, prices spoken like "one ninety five fifty", "short"/"go long") |
| `cases/generated.jsonl` | ~230 cases from `generate.mts`: templates filled with random companies, quantities, prices and phrasings |

The generator uses a **seeded** random number generator, so the same seed
always produces the same file. If a score changes, the code changed, not the
test data.

Each case belongs to one **category** (see `types.ts`). Per-category scores
show *where* the parser is weak instead of hiding it inside one average.

### Dev vs. heldout

About 20% of cases are marked `heldout`. Iterate on prompts and code against
`dev` only; run `heldout` only to report numbers. If you tune against the
cases you report on, you end up fitting those specific sentences (*overfitting
to the eval*) and the score stops predicting real-world accuracy.

## Metrics

| Metric | Definition | Why it matters |
|---|---|---|
| **Case accuracy** | Cases fully correct: every field right, or the right error raised | Headline number |
| **Field accuracy** | Per field (side, quantity, symbol, order type, price), over valid orders that produced a draft | Shows *which* part of extraction fails |
| **Hallucination rate** | Trap inputs (missing side, quantity or price, or not an order) that still produced a draft | **The safety metric.** A draft here means the model invented something the trader never said |
| **False reject rate** | Valid orders the system refused | The usability cost: annoying, but safe, because the trader just repeats it |
| **Ambiguity recall** | Ambiguous names ("United") sent to the clarify flow with the correct candidates | Measures the human-in-the-loop path |
| **Latency p50/p95/p99** | Per-call time; the model warm-up call is excluded | p95 is the "slow call" users actually notice; averages hide it |

**Hallucination vs. false reject is a tradeoff.** Making the system stricter
lowers hallucinations and raises false rejects, and loosening it does the
opposite. For a trading tool, a false reject costs a few seconds while a
hallucinated order can cost money, so the targets are deliberately lopsided:
hallucinations should be near 0, and some false rejects are acceptable.

## Targets (month-end)

- Case accuracy ≥ 95% (heldout)
- Hallucination rate: 0 on trap categories
- Ambiguity recall ≥ 95%
- p95 latency < 1.5 s on the LLM path

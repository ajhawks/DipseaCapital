/**
 * NLP eval runner: scores interpretWithNLP against the JSONL case files using a
 * live local LLM, and writes a results JSON for tracking over time.
 *
 * Run (from server/, with Ollama up):
 *   npx tsx eval/run.mts                      # dev split
 *   npx tsx eval/run.mts --split heldout      # report-only split
 *   npx tsx eval/run.mts --category correction --verbose
 *   LLM_MODEL=qwen2.5:7b npx tsx eval/run.mts # compare models
 *
 * Metrics (see eval/README.md for definitions):
 *   caseAccuracy, fieldAccuracy, falseRejectRate, hallucinationRate,
 *   ambiguityRecall, latency p50/p95/p99.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import type { ParsedOrder } from '@silexx/shared';
import type { Category, EvalCase, ExpectOrder } from './types.js';
import { TRAP_CATEGORIES } from './types.js';
import { fmtRate, rate, type Rate } from './stats.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
loadEnv({ path: here('../../.env') });

// Import after env is loaded so the NLP module sees LLM_* settings.
const { interpretWithNLP } = await import('../src/services/nlp/index.js');
const { ParseError } = await import('../src/services/parser/ParseError.js');

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const split = (flag('split') ?? 'dev') as 'dev' | 'heldout' | 'all';
const onlyCategory = flag('category') as Category | undefined;
const limit = flag('limit') ? Number(flag('limit')) : Infinity;
const verbose = args.includes('--verbose');
const save = !args.includes('--no-save');

// ── load cases ────────────────────────────────────────────────────────────────

const casesDir = here('./cases/');
const allCases: EvalCase[] = readdirSync(casesDir)
  .filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) =>
    readFileSync(casesDir + f, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as EvalCase),
  );

const cases = allCases
  .filter((c) => split === 'all' || c.split === split)
  .filter((c) => !onlyCategory || c.category === onlyCategory)
  .slice(0, limit);

// ── grading ───────────────────────────────────────────────────────────────────

const FIELDS = ['side', 'quantity', 'symbol', 'orderType', 'price'] as const;
type Field = (typeof FIELDS)[number];

type Outcome =
  | { kind: 'order'; order: ParsedOrder }
  | { kind: 'error'; code: string; candidates: string[]; message: string }
  | { kind: 'crash'; message: string };

interface CaseResult {
  id: string;
  category: Category;
  transcript: string;
  pass: boolean;
  ms: number;
  /** Per-field correctness; only for expected orders that produced a draft. */
  fields?: Record<Field, boolean>;
  got: Outcome;
  reason?: string;
}

const close = (a?: number, b?: number) =>
  a === undefined || b === undefined ? a === b : Math.abs(a - b) < 1e-6;

function gradeFields(exp: ExpectOrder, got: ParsedOrder): Record<Field, boolean> {
  return {
    side: got.side === exp.side,
    quantity: got.quantity === exp.quantity,
    symbol: got.resolvedSymbol === exp.symbol,
    orderType: got.orderType === exp.orderType,
    // Price is right only if both limit and stop match (absent counts as a value).
    price: close(got.limitPrice, exp.limitPrice) && close(got.stopPrice, exp.stopPrice),
  };
}

function grade(c: EvalCase, got: Outcome): Pick<CaseResult, 'pass' | 'fields' | 'reason'> {
  const e = c.expect;
  if (got.kind === 'crash') return { pass: false, reason: `crash: ${got.message}` };

  if (e.kind === 'order') {
    if (got.kind === 'error')
      return { pass: false, reason: `false reject: ${got.code} (${got.message})` };
    const fields = gradeFields(e, got.order);
    const wrong = FIELDS.filter((f) => !fields[f]);
    return {
      pass: wrong.length === 0,
      fields,
      ...(wrong.length ? { reason: `wrong ${wrong.join(', ')}` } : {}),
    };
  }

  if (got.kind === 'order')
    return { pass: false, reason: 'produced a draft but expected an error' };
  if (e.code !== 'ANY' && got.code !== e.code)
    return { pass: false, reason: `error ${got.code}, expected ${e.code}` };
  if (e.candidates && JSON.stringify([...got.candidates].sort()) !== JSON.stringify(e.candidates)) {
    return {
      pass: false,
      reason: `candidates ${got.candidates.join(',')} ≠ ${e.candidates.join(',')}`,
    };
  }
  return { pass: true };
}

async function run(transcript: string): Promise<Outcome> {
  try {
    return { kind: 'order', order: await interpretWithNLP(transcript) };
  } catch (err) {
    if (err instanceof ParseError) {
      return {
        kind: 'error',
        code: err.code,
        candidates: (err.candidates ?? []).map((x) => x.symbol),
        message: err.message,
      };
    }
    return { kind: 'crash', message: String(err) };
  }
}

// ── metrics ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function summarize(results: CaseResult[], byId: Map<string, EvalCase>) {
  const expectOrder = results.filter((r) => byId.get(r.id)!.expect.kind === 'order');
  const drafted = expectOrder.filter((r) => r.fields);
  const traps = results.filter((r) => TRAP_CATEGORIES.has(r.category));
  const ambiguous = results.filter((r) => r.category === 'ambiguous');
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);

  const fieldAccuracy = Object.fromEntries(
    FIELDS.map((f) => [f, rate(drafted.filter((r) => r.fields![f]).length, drafted.length)]),
  ) as Record<Field, Rate | null>;

  const categories = [...new Set(results.map((r) => r.category))].sort();
  const byCategory = Object.fromEntries(
    categories.map((cat) => {
      const rs = results.filter((r) => r.category === cat);
      return [cat, rate(rs.filter((r) => r.pass).length, rs.length)!];
    }),
  );

  return {
    n: results.length,
    caseAccuracy: rate(results.filter((r) => r.pass).length, results.length),
    fieldAccuracy,
    /** Valid orders the system refused (annoying, but safe). */
    falseRejectRate: rate(expectOrder.length - drafted.length, expectOrder.length),
    /** Trap / non-order inputs that produced a draft (dangerous). */
    hallucinationRate: rate(traps.filter((r) => r.got.kind === 'order').length, traps.length),
    /** Ambiguous names correctly sent to the clarify flow with the right candidates. */
    ambiguityRecall: rate(ambiguous.filter((r) => r.pass).length, ambiguous.length),
    latencyMs: {
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      p99: percentile(ms, 99),
      max: ms.at(-1) ?? 0,
    },
    byCategory,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

const model = process.env['LLM_MODEL'] ?? 'llama3.1:8b';
console.log(
  `Eval: ${cases.length} cases · split=${split}${onlyCategory ? ` · category=${onlyCategory}` : ''} · model=${model}`,
);

// Warm-up: the first call loads the model into memory (seconds). Excluding it
// keeps latency numbers about steady-state inference, not cold start.
process.stdout.write('warming up model… ');
const warm = Date.now();
await run('buy 1 share of AAPL at market');
console.log(`${Date.now() - warm}ms`);

const byId = new Map(allCases.map((c) => [c.id, c]));
const results: CaseResult[] = [];
for (const [i, c] of cases.entries()) {
  const t0 = performance.now();
  const got = await run(c.transcript);
  const ms = Math.round(performance.now() - t0);
  const g = grade(c, got);
  results.push({ id: c.id, category: c.category, transcript: c.transcript, ms, got, ...g });
  if (verbose || !g.pass) {
    console.log(
      `${g.pass ? 'PASS' : 'FAIL'} [${ms}ms] ${c.id} "${c.transcript}"${g.reason ? ` → ${g.reason}` : ''}`,
    );
  } else if ((i + 1) % 25 === 0) {
    console.log(`  … ${i + 1}/${cases.length}`);
  }
}

const metrics = summarize(results, byId);

console.log('\n── summary (95% CI in brackets) ────────────────────');
console.log(
  `case accuracy      ${fmtRate(metrics.caseAccuracy)}  (${results.filter((r) => r.pass).length}/${metrics.n})`,
);
console.log(`hallucination rate ${fmtRate(metrics.hallucinationRate)}  (lower is better)`);
console.log(`false reject rate  ${fmtRate(metrics.falseRejectRate)}  (lower is better)`);
console.log(`ambiguity recall   ${fmtRate(metrics.ambiguityRecall)}`);
console.log(
  `field accuracy     ${FIELDS.map((f) => `${f} ${fmtRate(metrics.fieldAccuracy[f], false)}`).join(' · ')}`,
);
console.log(
  `latency            p50 ${metrics.latencyMs.p50}ms · p95 ${metrics.latencyMs.p95}ms · p99 ${metrics.latencyMs.p99}ms`,
);
console.log('\nby category:');
for (const [cat, s] of Object.entries(metrics.byCategory)) {
  console.log(`  ${cat.padEnd(17)} ${fmtRate(s)}  (${s.k}/${s.n})`);
}

if (save) {
  const sha = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return 'unknown';
    }
  };
  // Fingerprint the NLP source so a result can be tied to the exact prompt/code.
  const nlpHash = createHash('sha256')
    .update(readFileSync(here('../src/services/nlp/index.ts')))
    .digest('hex')
    .slice(0, 12);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const resultsDir = here('./results/');
  mkdirSync(resultsDir, { recursive: true });
  const file = `${resultsDir}${stamp}_${model.replace(/[^a-z0-9.]+/gi, '-')}_${split}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        model,
        baseUrl: process.env['LLM_BASE_URL'] ?? 'http://localhost:11434/v1',
        split,
        category: onlyCategory ?? null,
        gitSha: sha('git rev-parse --short HEAD'),
        dirty: sha('git status --porcelain') !== '',
        nlpSourceHash: nlpHash,
        metrics,
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nsaved → ${file}`);
}

/**
 * Compare two eval result files: which cases flipped, and is the difference
 * more than noise?
 *
 * Run (from server/):
 *   npx tsx eval/compare.mts results/<before>.json results/<after>.json
 *
 * Significance uses an exact McNemar test. Both runs grade the same cases, so
 * the informative data is the discordant pairs: cases fixed (b) vs. broken (c).
 * Under "no real difference" each flip is a coin toss, so we ask how unlikely
 * a b-vs-c split this lopsided would be from Binomial(b + c, 0.5).
 */
import { readFileSync } from 'node:fs';
import { fmtRate, rate } from './stats.js';

interface ResultFile {
  model: string;
  split: string;
  gitSha: string;
  nlpSourceHash: string;
  results: { id: string; category: string; transcript: string; pass: boolean; reason?: string }[];
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: compare.mts <before.json> <after.json>');
  process.exit(1);
}
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as ResultFile;
const before = load(beforePath);
const after = load(afterPath);

const beforeById = new Map(before.results.map((r) => [r.id, r]));
// Pair by id *and* transcript: regenerating the dataset reuses ids for new sentences.
const shared = after.results.filter((r) => beforeById.get(r.id)?.transcript === r.transcript);
const unpaired = after.results.length - shared.length;
const fixed = shared.filter((r) => r.pass && !beforeById.get(r.id)!.pass);
const broke = shared.filter((r) => !r.pass && beforeById.get(r.id)!.pass);

/** Two-sided exact binomial p-value for k of n at p = 0.5. */
function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  let coef = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    tail += coef;
    coef = (coef * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

const acc = (rs: { pass: boolean }[]) => rate(rs.filter((r) => r.pass).length, rs.length);
const describe = (f: ResultFile) =>
  `${f.model} · ${f.split} · git ${f.gitSha} · nlp ${f.nlpSourceHash}`;

console.log(`before: ${describe(before)}`);
console.log(`after:  ${describe(after)}`);
console.log(
  `\n${shared.length} shared cases${unpaired ? ` (${unpaired} in 'after' had no matching case in 'before')` : ''}`,
);
console.log(
  `case accuracy  ${fmtRate(acc(shared.map((r) => beforeById.get(r.id)!)))}  →  ${fmtRate(acc(shared))}`,
);

const p = mcnemarExact(fixed.length, broke.length);
console.log(
  `flips          ${fixed.length} fixed, ${broke.length} broke  (McNemar exact p = ${p.toPrecision(3)})`,
);
console.log(
  p < 0.05
    ? '→ difference is unlikely to be noise'
    : '→ not distinguishable from noise at p < 0.05',
);

// Per-category deltas.
const cats = [...new Set(shared.map((r) => r.category))].sort();
console.log('\nby category (before → after):');
for (const cat of cats) {
  const rs = shared.filter((r) => r.category === cat);
  const b = acc(rs.map((r) => beforeById.get(r.id)!));
  const a = acc(rs);
  const delta = a && b ? Math.round((a.value - b.value) * 1000) / 10 : 0;
  const sign = delta > 0 ? '+' : '';
  console.log(
    `  ${cat.padEnd(17)} ${fmtRate(b, false)} → ${fmtRate(a, false)}  (${sign}${delta} pts, n=${rs.length})`,
  );
}

const list = (title: string, rs: typeof shared) => {
  if (!rs.length) return;
  console.log(`\n${title}:`);
  for (const r of rs)
    console.log(`  ${r.id.padEnd(12)} "${r.transcript}"${r.reason ? ` → ${r.reason}` : ''}`);
};
list('fixed', fixed);
list('broke (regressions)', broke);

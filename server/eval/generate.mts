/**
 * Generates templated eval cases into cases/generated.jsonl.
 *
 * Deterministic: a seeded PRNG means the same seed always yields the same
 * dataset, so score changes reflect parser changes, not data drift.
 * Split is stratified: every category gets a fixed number of heldout cases,
 * so no category's heldout score rests on a handful of examples.
 *
 * Run: npx tsx eval/generate.mts            (from server/)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Category, EvalCase, ExpectOrder } from './types.js';

const SEED = 20261006;

// mulberry32: tiny, fast, good-enough PRNG for test-data generation.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

// ── vocabulary ────────────────────────────────────────────────────────────────

/** Spoken name → ticker. Only unambiguous aliases from symbolTable.ts. */
const COMPANIES: readonly [string, string][] = [
  ['Apple', 'AAPL'],
  ['Microsoft', 'MSFT'],
  ['Google', 'GOOGL'],
  ['Alphabet', 'GOOGL'],
  ['Amazon', 'AMZN'],
  ['Tesla', 'TSLA'],
  ['Meta', 'META'],
  ['Facebook', 'META'],
  ['Nvidia', 'NVDA'],
  ['Netflix', 'NFLX'],
  ['JPMorgan', 'JPM'],
  ['JP Morgan', 'JPM'],
  ['Bank of America', 'BAC'],
  ['Walmart', 'WMT'],
  ['Disney', 'DIS'],
  ['Coca Cola', 'KO'],
  ['Coke', 'KO'],
  ['Intel', 'INTC'],
  ['AMD', 'AMD'],
  ['Advanced Micro Devices', 'AMD'],
  ['Boeing', 'BA'],
  ['Delta', 'DAL'],
  ['Delta Airlines', 'DAL'],
  ['United Airlines', 'UAL'],
  ['UnitedHealth', 'UNH'],
  ['American Airlines', 'AAL'],
  ['American Express', 'AXP'],
  ['Amex', 'AXP'],
];
const TICKERS = [...new Set(COMPANIES.map(([, t]) => t))];

const AMBIGUOUS: readonly [string, string[]][] = [
  ['United', ['UAL', 'UNH']],
  ['American', ['AAL', 'AXP']],
];
const UNKNOWN = [
  'Zorblex',
  'Quantaflux Labs',
  'Hyperion Widgets',
  'Bluefin Robotics',
  'Mondavi Shipping',
  'Kestrel Biotech',
  'Orinoco Mining',
  'Pemberton Foods',
];

// Core side verbs, weighted toward plain buy/sell. Every category except
// side_lexicon uses these, so a gap in verb coverage shows up in one category
// instead of dragging down all of them.
const BUY = ['buy', 'buy', 'buy', 'buy', 'purchase', 'pick up', 'grab'];
const SELL = ['sell', 'sell', 'sell', 'sell', 'unload', 'dump'];
// Full spoken side vocabulary, exercised by the side_lexicon category.
const BUY_LEXICON = [
  'buy',
  'purchase',
  'pick up',
  'grab',
  'get me',
  'add',
  'go long',
  'load up on',
  'take',
];
const SELL_LEXICON = [
  'sell',
  'unload',
  'dump',
  'get rid of',
  'short',
  'offload',
  'sell off',
  'dump out of',
];
const QTYS = [
  1, 5, 10, 12, 25, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500,
  5000,
];
const FILLERS = ['um', 'uh', 'okay so', 'like', 'so', 'yeah', 'alright'];

const NON_ORDERS = [
  "what's Tesla trading at",
  'how is my portfolio doing today',
  'pull up the chart for Nvidia',
  'remind me to call the desk at three',
  'is the market open tomorrow',
  'show me my open positions',
  'what did Apple close at yesterday',
  'mute the alerts please',
  'never mind',
  'Microsoft earnings are next week right',
  'what is the bid on Amazon',
  'how many Tesla shares do I own',
  'cancel my last order',
  'I think Nvidia is going to rip today',
  'did my Apple order fill',
  'turn on dark mode',
  'what time does the market close',
  'read me the news on Boeing',
  'what is the spread on Netflix',
  'should I buy Apple',
  'log me out',
  'how much buying power do I have',
  'set an alert for Tesla at 250',
  'repeat that',
  'what was my P and L yesterday',
  'Disney is looking weak',
  'check the volume on Intel',
  'go back',
  'thanks that is all',
  'who is the CEO of Microsoft',
  'testing testing one two three',
  'open the options chain for Apple',
];

// ── number → words (quantities and prices up to 9999) ─────────────────────────

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under100(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  return n % 10 === 0 ? t : `${t} ${ONES[n % 10]}`;
}

function toWords(n: number): string {
  if (n === 0) return 'zero';
  const parts: string[] = [];
  const thousands = Math.floor(n / 1000);
  const hundreds = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  if (thousands) parts.push(`${under100(thousands)} thousand`);
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) parts.push(under100(rest));
  return parts.join(' ');
}

/** Spoken variants of a quantity: "a hundred", "fifteen hundred", etc. */
function spokenQty(n: number): string {
  const options = [toWords(n)];
  if (n === 100) options.push('a hundred');
  if (n === 1000) options.push('a thousand');
  if (n > 1000 && n < 10000 && n % 100 === 0 && n % 1000 !== 0) {
    options.push(`${under100(n / 100)} hundred`); // 1500 → "fifteen hundred"
  }
  return pick(options);
}

function randPrice(): number {
  const whole = 5 + Math.floor(rand() * 600);
  const cents = pick([0, 0, 0, 25, 50, 75, 10, 99, 5]);
  return Math.round((whole + cents / 100) * 100) / 100;
}

function fmtPrice(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(2);
}

function spokenPrice(p: number): string {
  const whole = Math.floor(p);
  const cents = Math.round((p - whole) * 100);
  if (cents === 0) return `${toWords(whole)} dollars`;
  return `${toWords(whole)} dollars and ${toWords(cents)} cents`;
}

// ── building blocks ───────────────────────────────────────────────────────────

type Side = 'BUY' | 'SELL';
const verb = (side: Side) => pick(side === 'BUY' ? BUY : SELL);
const randSide = (): Side => (rand() < 0.5 ? 'BUY' : 'SELL');

interface PriceSpec {
  orderType: 'MARKET' | 'LIMIT';
  limitPrice?: number;
  phrase: string;
}
function priceSpec(spoken = false): PriceSpec {
  if (rand() < 0.4) {
    return { orderType: 'MARKET', phrase: pick(['at market', 'at the market', 'at market price']) };
  }
  const p = randPrice();
  const said = spoken ? spokenPrice(p) : fmtPrice(p);
  return {
    orderType: 'LIMIT',
    limitPrice: p,
    phrase: pick([`at ${said}`, `with a limit of ${said}`, `limit ${said}`]),
  };
}

function order(side: Side, quantity: number, symbol: string, ps: PriceSpec): ExpectOrder {
  return {
    kind: 'order',
    side,
    quantity,
    symbol,
    orderType: ps.orderType,
    ...(ps.limitPrice !== undefined ? { limitPrice: ps.limitPrice } : {}),
  };
}

function sprinkleFiller(sentence: string): string {
  const words = sentence.split(' ');
  const n = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < n; i++) {
    const at = Math.floor(rand() * words.length);
    words.splice(at, 0, pick(FILLERS));
  }
  return words.join(' ');
}

// ── per-category generators ───────────────────────────────────────────────────

type Gen = () => Pick<EvalCase, 'transcript' | 'expect'>;

const GENERATORS: Record<Category, Gen> = {
  canonical: () => {
    const side = randSide();
    const q = pick(QTYS);
    const t = pick(TICKERS);
    const ps = priceSpec();
    const v = side === 'BUY' ? 'Buy' : 'Sell';
    return { transcript: `${v} ${q} shares of ${t} ${ps.phrase}`, expect: order(side, q, t, ps) };
  },
  company_name: () => {
    const side = randSide();
    const q = pick(QTYS);
    const [name, t] = pick(COMPANIES);
    const ps = priceSpec();
    const form = pick([
      `${verb(side)} ${q} shares of ${name} ${ps.phrase}`,
      `${verb(side)} ${q} ${name} ${ps.phrase}`,
      `${verb(side)} ${q} ${name} shares ${ps.phrase}`,
    ]);
    return { transcript: form, expect: order(side, q, t, ps) };
  },
  spoken_numbers: () => {
    const side = randSide();
    const q = pick(QTYS.filter((x) => x > 1));
    const [name, t] = pick(COMPANIES);
    const ps = priceSpec(rand() < 0.5);
    return {
      transcript: `${verb(side)} ${spokenQty(q)} shares of ${name} ${ps.phrase}`,
      expect: order(side, q, t, ps),
    };
  },
  phrasing: () => {
    const side = randSide();
    const q = pick(QTYS);
    const [name, t] = pick(COMPANIES);
    const ps = priceSpec();
    const v = verb(side);
    const form = pick([
      `could you ${v} ${q} shares of ${name} ${ps.phrase} for me`,
      `I'd like to ${v} ${q} ${name} ${ps.phrase}`,
      `let's ${v} ${q} shares of ${name}, ${ps.phrase.replace(/^at /, '')}`,
      `${ps.phrase}, ${v} ${q} shares of ${name}`,
      `please ${v} ${q} ${name} ${ps.phrase}`,
      `go ahead and ${v} ${q} shares of ${name} ${ps.phrase}`,
    ]);
    return { transcript: form, expect: order(side, q, t, ps) };
  },
  filler: () => {
    const side = randSide();
    const q = pick(QTYS);
    const [name, t] = pick(COMPANIES);
    const ps = priceSpec();
    return {
      transcript: sprinkleFiller(`${verb(side)} ${q} shares of ${name} ${ps.phrase}`),
      expect: order(side, q, t, ps),
    };
  },
  stop: () => {
    const side = randSide();
    const q = pick(QTYS);
    const [name, t] = pick(COMPANIES);
    const p = randPrice();
    const v = verb(side);
    const form = pick([
      `${v} ${q} shares of ${name} with a stop at ${fmtPrice(p)}`,
      `${v} ${q} ${name} on a stop at ${fmtPrice(p)}`,
      `stop order to ${v} ${q} ${name} at ${fmtPrice(p)}`,
      ...(side === 'SELL'
        ? [`put in a stop loss to sell ${q} shares of ${name} at ${fmtPrice(p)}`]
        : []),
    ]);
    return {
      transcript: form,
      expect: { kind: 'order', side, quantity: q, symbol: t, orderType: 'STOP', stopPrice: p },
    };
  },
  correction: () => {
    const side = randSide();
    const [name, t] = pick(COMPANIES);
    const v = verb(side);
    const kind = Math.floor(rand() * 3);
    if (kind === 0) {
      const q1 = pick(QTYS);
      let q2 = pick(QTYS);
      if (q2 === q1) q2 = q1 * 2;
      const ps = priceSpec();
      return {
        transcript: `${v} ${q1}, ${pick(['no wait', 'sorry', 'scratch that', 'no'])}, ${q2} shares of ${name} ${ps.phrase}`,
        expect: order(side, q2, t, ps),
      };
    }
    if (kind === 1) {
      const q = pick(QTYS);
      const p1 = randPrice();
      const p2 = Math.round((p1 - 1.5) * 100) / 100;
      return {
        transcript: `${v} ${q} shares of ${name} at ${fmtPrice(p1)}, ${pick(['actually make that', 'no wait', 'change that to'])} ${fmtPrice(p2)}`,
        expect: { kind: 'order', side, quantity: q, symbol: t, orderType: 'LIMIT', limitPrice: p2 },
      };
    }
    const q = pick(QTYS);
    let [name2, t2] = pick(COMPANIES);
    if (t2 === t) [name2, t2] = ['Netflix', 'NFLX'];
    if (t2 === t) [name2, t2] = ['Boeing', 'BA'];
    const ps = priceSpec();
    return {
      transcript: `${v} ${q} ${name}, ${pick(['I mean', 'sorry', 'no'])} ${name2}, ${ps.phrase}`,
      expect: order(side, q, t2, ps),
    };
  },
  ambiguous: () => {
    const side = randSide();
    const q = pick(QTYS);
    const [name, cands] = pick(AMBIGUOUS);
    const ps = priceSpec();
    return {
      transcript: `${verb(side)} ${q} shares of ${name} ${ps.phrase}`,
      expect: { kind: 'error', code: 'AMBIGUOUS_SYMBOL', candidates: cands },
    };
  },
  unknown_symbol: () => {
    const side = randSide();
    const q = pick(QTYS);
    const name = pick(UNKNOWN);
    const ps = priceSpec();
    return {
      transcript: `${verb(side)} ${q} shares of ${name} ${ps.phrase}`,
      expect: { kind: 'error', code: 'AMBIGUOUS_SYMBOL' },
    };
  },
  side_lexicon: () => {
    const side = randSide();
    const q = pick(QTYS);
    const [name, t] = pick(COMPANIES);
    const ps = priceSpec();
    const v = pick(side === 'BUY' ? BUY_LEXICON : SELL_LEXICON);
    return {
      transcript: `${v} ${q} shares of ${name} ${ps.phrase}`,
      expect: order(side, q, t, ps),
    };
  },
  missing_side: () => {
    const q = pick(QTYS);
    const [name] = pick(COMPANIES);
    const ps = priceSpec();
    const form = pick([
      `${q} shares of ${name} ${ps.phrase}`,
      `${name}, ${q} shares, ${ps.phrase}`,
      `${q} ${name} ${ps.phrase}`,
    ]);
    return { transcript: form, expect: { kind: 'error', code: 'MISSING_FIELDS' } };
  },
  missing_quantity: () => {
    const side = randSide();
    const [name] = pick(COMPANIES);
    const ps = priceSpec();
    const v = verb(side);
    const form = pick([
      `${v} some ${name} ${ps.phrase}`,
      `${v} ${name} ${ps.phrase}`,
      `${v} a few shares of ${name} ${ps.phrase}`,
      `${v} shares of ${name} ${ps.phrase}`,
    ]);
    return { transcript: form, expect: { kind: 'error', code: 'MISSING_FIELDS' } };
  },
  missing_price: () => {
    const side = randSide();
    const q = pick(QTYS);
    const [name] = pick(COMPANIES);
    const v = verb(side);
    const form = pick([
      `${v} ${q} shares of ${name} with a limit`,
      `${v} ${q} ${name} on a limit order`,
      `${v} ${q} shares of ${name} with a stop`,
      `${v} ${q} ${name}, limit price`,
    ]);
    return { transcript: form, expect: { kind: 'error', code: 'MISSING_FIELDS' } };
  },
  non_order: () => ({ transcript: '', expect: { kind: 'error', code: 'ANY' } }), // filled from NON_ORDERS below
};

/** Cases per category: [dev, heldout]. Traps are oversampled because the
 * hallucination bound tightens only with many trap cases (rule of three). */
const COUNTS: Record<Category, [number, number]> = {
  canonical: [15, 10],
  company_name: [20, 12],
  spoken_numbers: [20, 12],
  phrasing: [20, 12],
  filler: [12, 10],
  stop: [15, 10],
  correction: [15, 10],
  side_lexicon: [25, 15],
  ambiguous: [12, 10],
  unknown_symbol: [10, 10],
  missing_side: [25, 15],
  missing_quantity: [25, 15],
  missing_price: [20, 12],
  non_order: [20, 12],
};

const ABBR: Record<Category, string> = {
  canonical: 'can',
  company_name: 'co',
  spoken_numbers: 'num',
  phrasing: 'phr',
  filler: 'fil',
  stop: 'stp',
  correction: 'cor',
  side_lexicon: 'lex',
  ambiguous: 'amb',
  unknown_symbol: 'unk',
  missing_side: 'msd',
  missing_quantity: 'mqt',
  missing_price: 'mpr',
  non_order: 'non',
};

const cases: EvalCase[] = [];
const seen = new Set<string>();
for (const category of Object.keys(COUNTS) as Category[]) {
  let made = 0;
  let attempts = 0;
  const [dev, heldout] = COUNTS[category];
  while (made < dev + heldout && attempts++ < 1000) {
    const c =
      category === 'non_order'
        ? { transcript: NON_ORDERS[made]!, expect: { kind: 'error', code: 'ANY' } as const }
        : GENERATORS[category]();
    const key = c.transcript.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    made++;
    const id = `gen-${ABBR[category]}-${String(made).padStart(3, '0')}`;
    // Cases are random, so taking the first `heldout` as heldout is unbiased.
    cases.push({
      id,
      category,
      split: made <= heldout ? 'heldout' : 'dev',
      source: 'generated',
      ...c,
    });
  }
  if (made < dev + heldout) throw new Error(`${category}: only ${made} unique cases`);
}

const out = fileURLToPath(new URL('./cases/generated.jsonl', import.meta.url));
writeFileSync(out, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
const heldout = cases.filter((c) => c.split === 'heldout').length;
console.log(
  `wrote ${cases.length} cases (${cases.length - heldout} dev / ${heldout} heldout) → ${out}`,
);

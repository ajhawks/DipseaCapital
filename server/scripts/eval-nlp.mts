/**
 * End-to-end eval of the local-LLM NLP parser (interpretWithNLP) against a
 * live Ollama llama3.1:8b. Runs a battery of natural-language phrasings and
 * grades the structured output.
 *
 * Run: npx tsx server/scripts/eval-nlp.mts (from repo root, with Ollama running)
 */
import { interpretWithNLP } from '../src/services/nlp/index.js';
import { ParseError } from '../src/services/parser/ParseError.js';

interface Expect {
  side?: 'BUY' | 'SELL';
  quantity?: number;
  resolvedSymbol?: string;
  orderType?: 'MARKET' | 'LIMIT' | 'STOP';
  limitPrice?: number;
  stopPrice?: number;
  /** Expected ParseError code instead of success. */
  errorCode?: string;
  /** For AMBIGUOUS_SYMBOL: expected candidate tickers (sorted). */
  candidates?: string[];
}

interface Case {
  name: string;
  transcript: string;
  expect: Expect;
}

const CASES: Case[] = [
  // ── canonical / rigid grammar (should trivially pass) ─────────────────────
  { name: 'canonical limit', transcript: 'Buy 100 shares of AAPL at 195.50',
    expect: { side: 'BUY', quantity: 100, resolvedSymbol: 'AAPL', orderType: 'LIMIT', limitPrice: 195.5 } },
  { name: 'canonical market', transcript: 'Sell 500 shares of MSFT at the market',
    expect: { side: 'SELL', quantity: 500, resolvedSymbol: 'MSFT', orderType: 'MARKET' } },

  // ── company names ──────────────────────────────────────────────────────────
  { name: 'company name limit', transcript: 'buy 250 shares of Apple at 190',
    expect: { side: 'BUY', quantity: 250, resolvedSymbol: 'AAPL', orderType: 'LIMIT', limitPrice: 190 } },
  { name: 'company name market', transcript: 'sell 50 Tesla shares at market',
    expect: { side: 'SELL', quantity: 50, resolvedSymbol: 'TSLA', orderType: 'MARKET' } },
  { name: 'multi-word company', transcript: 'buy 75 shares of Coca Cola at the market',
    expect: { side: 'BUY', quantity: 75, resolvedSymbol: 'KO', orderType: 'MARKET' } },
  { name: 'bank of america', transcript: 'pick up 120 shares of Bank of America at 39.80',
    expect: { side: 'BUY', quantity: 120, resolvedSymbol: 'BAC', orderType: 'LIMIT', limitPrice: 39.8 } },

  // ── spoken / word numbers ──────────────────────────────────────────────────
  { name: 'word number qty', transcript: 'grab me two hundred Apple shares at market',
    expect: { side: 'BUY', quantity: 200, resolvedSymbol: 'AAPL', orderType: 'MARKET' } },
  { name: 'a thousand', transcript: "I'd like to buy a thousand shares of Nvidia with a limit of 190",
    expect: { side: 'BUY', quantity: 1000, resolvedSymbol: 'NVDA', orderType: 'LIMIT', limitPrice: 190 } },
  { name: 'fifty', transcript: 'sell fifty Microsoft at 410.25',
    expect: { side: 'SELL', quantity: 50, resolvedSymbol: 'MSFT', orderType: 'LIMIT', limitPrice: 410.25 } },
  { name: 'comma qty', transcript: 'buy 1,500 shares of Intel at the market',
    expect: { side: 'BUY', quantity: 1500, resolvedSymbol: 'INTC', orderType: 'MARKET' } },

  // ── varied sentence structure ──────────────────────────────────────────────
  { name: 'polite phrasing', transcript: 'could you please sell 300 shares of Disney at 95 dollars',
    expect: { side: 'SELL', quantity: 300, resolvedSymbol: 'DIS', orderType: 'LIMIT', limitPrice: 95 } },
  { name: 'inverted order', transcript: 'at the market, buy 40 shares of Netflix',
    expect: { side: 'BUY', quantity: 40, resolvedSymbol: 'NFLX', orderType: 'MARKET' } },
  { name: 'filler words', transcript: 'um okay so let me buy uh 60 shares of Amazon at 178.20',
    expect: { side: 'BUY', quantity: 60, resolvedSymbol: 'AMZN', orderType: 'LIMIT', limitPrice: 178.2 } },
  { name: 'synonym: unload', transcript: 'unload 800 shares of Boeing at market price',
    expect: { side: 'SELL', quantity: 800, resolvedSymbol: 'BA', orderType: 'MARKET' } },
  { name: 'synonym: pick up', transcript: 'pick up 25 shares of JPMorgan at 210',
    expect: { side: 'BUY', quantity: 25, resolvedSymbol: 'JPM', orderType: 'LIMIT', limitPrice: 210 } },

  // ── stop orders ────────────────────────────────────────────────────────────
  { name: 'stop order', transcript: 'sell 100 shares of Apple with a stop at 180',
    expect: { side: 'SELL', quantity: 100, resolvedSymbol: 'AAPL', orderType: 'STOP', stopPrice: 180 } },
  { name: 'stop loss phrasing', transcript: 'put in a stop loss to sell 200 Tesla at 220',
    expect: { side: 'SELL', quantity: 200, resolvedSymbol: 'TSLA', orderType: 'STOP', stopPrice: 220 } },

  // ── ambiguity → clarify flow ───────────────────────────────────────────────
  { name: 'ambiguous united', transcript: 'buy a hundred United at market',
    expect: { errorCode: 'AMBIGUOUS_SYMBOL', candidates: ['UAL', 'UNH'] } },
  { name: 'ambiguous american', transcript: 'sell 60 shares of American at the market',
    expect: { errorCode: 'AMBIGUOUS_SYMBOL', candidates: ['AAL', 'AXP'] } },

  // ── graceful failures ──────────────────────────────────────────────────────
  { name: 'missing quantity', transcript: 'buy some Apple at market',
    expect: { errorCode: 'MISSING_FIELDS' } },
  { name: 'missing side', transcript: '100 shares of AAPL at 195',
    expect: { errorCode: 'MISSING_FIELDS' } },
  { name: 'missing side 2', transcript: '200 shares of Microsoft at market',
    expect: { errorCode: 'MISSING_FIELDS' } },
  { name: 'not an order', transcript: 'what is the weather like today',
    expect: { errorCode: 'ANY_ERROR' } },
  { name: 'unknown company', transcript: 'buy 100 shares of Zorblex Industries at market',
    expect: { errorCode: 'AMBIGUOUS_SYMBOL' } },
];

function close(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a - b) < 1e-6;
}

async function runCase(c: Case): Promise<{ pass: boolean; detail: string }> {
  try {
    const r = await interpretWithNLP(c.transcript);
    if (c.expect.errorCode) {
      return { pass: false, detail: `expected error ${c.expect.errorCode}, got success: ${JSON.stringify(r)}` };
    }
    const problems: string[] = [];
    if (c.expect.side && r.side !== c.expect.side) problems.push(`side=${r.side}≠${c.expect.side}`);
    if (c.expect.quantity !== undefined && r.quantity !== c.expect.quantity)
      problems.push(`qty=${r.quantity}≠${c.expect.quantity}`);
    if (c.expect.resolvedSymbol && r.resolvedSymbol !== c.expect.resolvedSymbol)
      problems.push(`sym=${r.resolvedSymbol}≠${c.expect.resolvedSymbol}`);
    if (c.expect.orderType && r.orderType !== c.expect.orderType)
      problems.push(`type=${r.orderType}≠${c.expect.orderType}`);
    if (c.expect.limitPrice !== undefined && !close(r.limitPrice, c.expect.limitPrice))
      problems.push(`limit=${r.limitPrice}≠${c.expect.limitPrice}`);
    if (c.expect.stopPrice !== undefined && !close(r.stopPrice, c.expect.stopPrice))
      problems.push(`stop=${r.stopPrice}≠${c.expect.stopPrice}`);
    return problems.length === 0
      ? { pass: true, detail: JSON.stringify(r) }
      : { pass: false, detail: problems.join(', ') + ` — got ${JSON.stringify(r)}` };
  } catch (err) {
    if (err instanceof ParseError) {
      if (!c.expect.errorCode) return { pass: false, detail: `unexpected ${err.code}: ${err.message}` };
      if (c.expect.errorCode !== 'ANY_ERROR' && err.code !== c.expect.errorCode)
        return { pass: false, detail: `error code ${err.code}≠${c.expect.errorCode}: ${err.message}` };
      if (c.expect.candidates) {
        const got = (err.candidates ?? []).map((x) => x.symbol).sort();
        if (JSON.stringify(got) !== JSON.stringify(c.expect.candidates))
          return { pass: false, detail: `candidates ${got.join(',')}≠${c.expect.candidates.join(',')}` };
      }
      return { pass: true, detail: `${err.code}: ${err.message}` };
    }
    return { pass: false, detail: `non-ParseError thrown: ${String(err)}` };
  }
}

let passed = 0;
const failures: string[] = [];
for (const c of CASES) {
  const t0 = Date.now();
  const { pass, detail } = await runCase(c);
  const ms = Date.now() - t0;
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`${mark} [${ms}ms] ${c.name}: ${detail}`);
  if (pass) passed++;
  else failures.push(`${c.name}: ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(' - ' + f);
}

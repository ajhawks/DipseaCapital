import type { SymbolCandidate } from '@silexx/shared';
import { ParseError } from '../parser/index.js';

/**
 * Static, in-repo symbol seed table (see docs/adr/002-static-symbol-resolution.md).
 *
 * Maps spoken company names / aliases to tickers. Intentionally offline and
 * deterministic — this is the seam where a real symbology API can later drop in
 * without changing callers. `resolveSymbol` is used only on the NLP path; the
 * regex parser keeps its identity mapping.
 */

interface SymbolEntry {
  symbol: string;
  name: string;
  /** Lowercased spoken forms that resolve to this ticker. */
  aliases: string[];
}

const SYMBOLS: SymbolEntry[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', aliases: ['apple'] },
  { symbol: 'MSFT', name: 'Microsoft Corporation', aliases: ['microsoft'] },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', aliases: ['alphabet', 'google'] },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', aliases: ['amazon'] },
  { symbol: 'TSLA', name: 'Tesla Inc.', aliases: ['tesla'] },
  { symbol: 'META', name: 'Meta Platforms Inc.', aliases: ['meta', 'facebook'] },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', aliases: ['nvidia'] },
  { symbol: 'NFLX', name: 'Netflix Inc.', aliases: ['netflix'] },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.', aliases: ['jpmorgan', 'jp morgan', 'chase'] },
  { symbol: 'BAC', name: 'Bank of America Corporation', aliases: ['bank of america'] },
  { symbol: 'WMT', name: 'Walmart Inc.', aliases: ['walmart'] },
  { symbol: 'DIS', name: 'The Walt Disney Company', aliases: ['disney', 'walt disney'] },
  { symbol: 'KO', name: 'The Coca-Cola Company', aliases: ['coca cola', 'coca-cola', 'coke'] },
  { symbol: 'INTC', name: 'Intel Corporation', aliases: ['intel'] },
  { symbol: 'AMD', name: 'Advanced Micro Devices Inc.', aliases: ['amd', 'advanced micro devices'] },
  { symbol: 'BA', name: 'The Boeing Company', aliases: ['boeing'] },
  { symbol: 'DAL', name: 'Delta Air Lines Inc.', aliases: ['delta', 'delta air lines', 'delta airlines'] },

  // Intentional ambiguity: "United" maps to both an airline and a health insurer.
  { symbol: 'UAL', name: 'United Airlines Holdings Inc.', aliases: ['united', 'united airlines'] },
  { symbol: 'UNH', name: 'UnitedHealth Group Inc.', aliases: ['united', 'unitedhealth', 'united health'] },

  // Intentional ambiguity: "American" maps to both an airline and an express company.
  { symbol: 'AAL', name: 'American Airlines Group Inc.', aliases: ['american', 'american airlines'] },
  { symbol: 'AXP', name: 'American Express Company', aliases: ['american', 'american express', 'amex'] },
];

const KNOWN_TICKERS = new Set(SYMBOLS.map((e) => e.symbol));

/** Lowercased alias → list of matching candidates. */
const ALIAS_INDEX = new Map<string, SymbolCandidate[]>();
for (const entry of SYMBOLS) {
  const candidate: SymbolCandidate = { symbol: entry.symbol, name: entry.name };
  for (const alias of entry.aliases) {
    const key = normalize(alias);
    const existing = ALIAS_INDEX.get(key);
    if (existing) existing.push(candidate);
    else ALIAS_INDEX.set(key, [candidate]);
  }
}

/** Lowercase, collapse whitespace, strip surrounding punctuation. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ResolveResult {
  /** The resolved ticker. */
  symbol: string;
}

/**
 * Resolve a spoken symbol or company name to a ticker.
 *
 * - A clean, known ticker passes through.
 * - A single name/alias match resolves to its ticker.
 * - A name matching several tickers throws AMBIGUOUS_SYMBOL WITH candidates.
 * - No match throws AMBIGUOUS_SYMBOL without candidates.
 */
export function resolveSymbol(spoken: string): ResolveResult {
  const raw = spoken.trim();

  // Clean ticker: 1-5 letters that we recognise.
  const upper = raw.toUpperCase();
  if (/^[A-Z]{1,5}$/.test(upper) && KNOWN_TICKERS.has(upper)) {
    return { symbol: upper };
  }

  const matches = ALIAS_INDEX.get(normalize(raw));

  if (!matches || matches.length === 0) {
    throw new ParseError(
      'AMBIGUOUS_SYMBOL',
      `Could not resolve "${raw}" to a known ticker symbol.`,
    );
  }

  // Dedupe by ticker (an alias like "united" can list the same symbol once each).
  const unique = dedupeBySymbol(matches);

  if (unique.length === 1) {
    return { symbol: unique[0]!.symbol };
  }

  throw new ParseError(
    'AMBIGUOUS_SYMBOL',
    `"${raw}" is ambiguous — please choose a ticker.`,
    undefined,
    unique,
  );
}

function dedupeBySymbol(candidates: SymbolCandidate[]): SymbolCandidate[] {
  const seen = new Set<string>();
  const out: SymbolCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    out.push(c);
  }
  return out;
}

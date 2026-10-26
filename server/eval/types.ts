/**
 * Shared types for the NLP eval suite (generator + runner).
 *
 * A case is either an order we expect the parser to extract exactly, or an
 * error we expect it to raise instead of producing a draft.
 */

export type Category =
  | 'canonical' // rigid grammar the regex parser already handles
  | 'company_name' // spoken company name instead of a ticker
  | 'spoken_numbers' // quantities / prices spoken as words
  | 'phrasing' // varied sentence structure, polite forms, inversions
  | 'filler' // um / uh / okay so
  | 'stop' // stop and stop-loss orders
  | 'correction' // speaker changes their mind mid-sentence
  | 'side_lexicon' // buy/sell intent via slang verbs (get me, add, short, …)
  | 'ambiguous' // name maps to several tickers → must ask
  | 'unknown_symbol' // name maps to no ticker → must ask
  | 'missing_side' // trap: no buy/sell word
  | 'missing_quantity' // trap: no share count
  | 'missing_price' // trap: limit/stop with no price
  | 'non_order'; // not an order at all

/** Categories where producing a draft means the model invented data. */
export const TRAP_CATEGORIES: ReadonlySet<Category> = new Set([
  'missing_side',
  'missing_quantity',
  'missing_price',
  'non_order',
]);

export interface ExpectOrder {
  kind: 'order';
  side: 'BUY' | 'SELL';
  quantity: number;
  symbol: string;
  orderType: 'MARKET' | 'LIMIT' | 'STOP';
  limitPrice?: number;
  stopPrice?: number;
}

export interface ExpectError {
  kind: 'error';
  /** 'ANY' accepts any ParseError code. */
  code: 'MISSING_FIELDS' | 'AMBIGUOUS_SYMBOL' | 'PARSE_FAILED' | 'ANY';
  /** For AMBIGUOUS_SYMBOL with candidates: expected tickers, sorted. */
  candidates?: string[];
}

export interface EvalCase {
  id: string;
  category: Category;
  /** dev = tune against it; heldout = only for reporting final numbers. */
  split: 'dev' | 'heldout';
  source: 'handwritten' | 'generated';
  transcript: string;
  expect: ExpectOrder | ExpectError;
}

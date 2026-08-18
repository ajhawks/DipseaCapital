import type { OrderDraft, SymbolCandidate } from './order.js';

export interface ParseRequest {
  transcript: string;
  /**
   * Iteration 2: a ticker the user explicitly chose after an AMBIGUOUS_SYMBOL
   * clarification. When present, the NLP layer skips symbol resolution and uses this.
   */
  symbolOverride?: string;
}

export interface ParseResponse {
  draft: OrderDraft;
}

export interface ParseErrorResponse {
  error: string;
  code: 'MISSING_FIELDS' | 'AMBIGUOUS_SYMBOL' | 'PARSE_FAILED' | 'RATE_LIMITED';
  missingFields?: (keyof OrderDraft)[];
  /** Populated for AMBIGUOUS_SYMBOL when the spoken name maps to several tickers. */
  candidates?: SymbolCandidate[];
}

export interface DraftCreateRequest {
  draft: OrderDraft;
  /** ISO 8601 timestamp of the explicit confirm click */
  userConfirmedAt: string;
}

export interface DraftCreateResponse {
  silexxTicketId: string;
  status: 'created';
}

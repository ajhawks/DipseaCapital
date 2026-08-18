export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
export type AssetClass = 'EQUITY' | 'OPTION';
export type DraftStatus = 'draft';

/** A possible ticker match for a spoken symbol/company name, used for ambiguity resolution. */
export interface SymbolCandidate {
  symbol: string;
  name: string;
}

/** Raw output of the parser/NLP layer before validation. */
export interface ParsedOrder {
  side?: OrderSide;
  quantity?: number;
  rawSymbol?: string;
  resolvedSymbol?: string;
  orderType?: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  assetClass?: AssetClass;
  confidence?: number;
}

/** Validated, in-progress order ready for human review. */
export interface OrderDraft {
  id: string;
  status: DraftStatus;
  side: OrderSide;
  quantity: number;
  symbol: string;
  rawSymbol: string;
  orderType: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  assetClass: AssetClass;
  createdAt: string;
  transcriptFragment?: string;
}

/**
 * Only exists after explicit confirmed human action — never instantiated by code.
 * Represents data received from Silexx after human-initiated submission.
 */
export interface SubmittedOrder extends OrderDraft {
  silexxTicketId: string;
  submittedAt: string;
  submittedByUserId: string;
}

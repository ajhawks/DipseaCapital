export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type AssetClass = 'EQUITY' | 'OPTION';
export type TimeInForce = 'DAY' | 'GTC' | 'IOC' | 'FOK';

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

/** The economic content of an order: everything that is handed to Silexx. */
export interface OrderFields {
  side: OrderSide;
  quantity: number;
  symbol: string;
  orderType: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  /** Optional until Silexx-required fields are finalized (D5). */
  timeInForce?: TimeInForce;
  account?: string;
  assetClass: AssetClass;
}

/** Fields a trader may change on an existing draft. */
export type EditableFields = Partial<Omit<OrderFields, 'assetClass'>>;

/**
 * Review lifecycle, separate from the handoff lifecycle.
 * - `draft`: has blocking validation errors; must be edited before it can be confirmed.
 * - `awaiting_confirmation`: valid; needs warnings acknowledged and an explicit confirm.
 * - `confirmed`: confirmed at exactly `confirmation.version`.
 * - `cancelled`: terminal.
 */
export type DraftState = 'draft' | 'awaiting_confirmation' | 'confirmed' | 'cancelled';

/**
 * Silexx handoff lifecycle. Only `populated_verified` means the ticket was read back
 * and matched; every other populated state needs the trader to check Silexx.
 */
export type HandoffState =
  | 'none'
  | 'in_progress'
  | 'populated_verified'
  | 'populated_unverified'
  | 'failed_known'
  | 'uncertain'
  | 'mismatch'
  | 'safety_violation';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  /** Stable code; warnings are acknowledged by code. */
  code: string;
  severity: IssueSeverity;
  message: string;
  field?: keyof OrderFields;
}

export interface Confirmation {
  version: number;
  contentHash: string;
  confirmedAt: string;
}

export interface HandoffStatus {
  state: HandoffState;
  idempotencyKey?: string;
  silexxTicketId?: string;
  /** How a populated ticket was verified: by reading it back, or by the trader checking Silexx. */
  verifiedBy?: 'read_back' | 'trader';
  message?: string;
  updatedAt?: string;
}

/** A server-owned draft. Clients can only reference it by `id` + `version`. */
export interface OrderDraft extends OrderFields {
  id: string;
  /** Bumped on every edit; confirmation and acknowledgements apply to one version only. */
  version: number;
  /** sha256 of the canonical OrderFields at this version. */
  contentHash: string;
  state: DraftState;
  rawSymbol: string;
  createdAt: string;
  updatedAt: string;
  transcriptFragment?: string;
  issues: ValidationIssue[];
  /** Warning codes acknowledged at the current version. */
  acknowledgedWarnings: string[];
  confirmation?: Confirmation;
  handoff: HandoffStatus;
}

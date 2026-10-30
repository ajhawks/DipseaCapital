import type { EditableFields, OrderDraft, SymbolCandidate } from './order.js';

export interface ParseRequest {
  transcript: string;
  /**
   * A ticker the user explicitly chose after an AMBIGUOUS_SYMBOL clarification.
   * When present, symbol resolution is skipped and this ticker is used.
   */
  symbolOverride?: string;
}

/** The order could be drafted if the trader answers a question. Nothing was guessed. */
export interface Clarification {
  code: 'MISSING_FIELDS' | 'AMBIGUOUS_SYMBOL' | 'LOW_CONFIDENCE';
  message: string;
  missingFields?: string[];
  candidates?: SymbolCandidate[];
}

/** The utterance can't become a draft in this release. */
export interface Refusal {
  code: 'MULTI_ORDER_UNSUPPORTED' | 'OPTIONS_UNSUPPORTED' | 'PARSE_FAILED';
  message: string;
}

export interface ParseResponse {
  drafts: OrderDraft[];
  clarifications: Clarification[];
  refusals: Refusal[];
}

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'STALE_VERSION'
  | 'INVALID_STATE'
  | 'VALIDATION_BLOCKED'
  | 'WARNINGS_UNACKNOWLEDGED'
  | 'HANDOFF_DISABLED'
  | 'PARSER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'SERVER_ERROR';

export interface ApiError {
  error: string;
  code: ApiErrorCode;
  /** Present on STALE_VERSION / INVALID_STATE so the client can reload the card. */
  draft?: OrderDraft;
}

export interface EditDraftRequest {
  version: number;
  changes: EditableFields;
}

export interface VersionedRequest {
  version: number;
}

export interface AcknowledgeRequest {
  version: number;
  codes: string[];
}

export type ManualCheckResult = 'present_correct' | 'absent' | 'wrong';

export interface ReconcileRequest {
  /** Omit to ask the server to look the ticket up in Silexx (when supported). */
  manualResult?: ManualCheckResult;
}

export interface DraftResponse {
  draft: OrderDraft;
}

export interface DraftListResponse {
  drafts: OrderDraft[];
}

export interface HandoffAvailability {
  enabled: boolean;
  reason?: string;
}

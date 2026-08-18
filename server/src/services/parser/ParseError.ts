import type { OrderDraft, ParseErrorResponse, SymbolCandidate } from '@silexx/shared';

type ParseErrorCode = Exclude<ParseErrorResponse['code'], 'RATE_LIMITED'>;

export class ParseError extends Error {
  public readonly code: ParseErrorCode;
  public readonly missingFields?: (keyof OrderDraft)[];
  /** Set for AMBIGUOUS_SYMBOL when the spoken name maps to several tickers. */
  public readonly candidates?: SymbolCandidate[];

  constructor(
    code: ParseErrorCode,
    message: string,
    missingFields?: (keyof OrderDraft)[],
    candidates?: SymbolCandidate[],
  ) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    // exactOptionalPropertyTypes: only write the property when it has a value.
    if (missingFields !== undefined) {
      this.missingFields = missingFields;
    }
    if (candidates !== undefined) {
      this.candidates = candidates;
    }
  }
}

import type { OrderDraft, OrderSide, OrderType, ParsedOrder } from '@silexx/shared';
import { ParseError } from './ParseError.js';

// Rules applied in pipeline order; first match wins per field (§6.2).
const SIDE_RULE = /^(buy|sell)\b/i;
const QUANTITY_RULE = /\b(\d[\d,]*)\s+shares?\b/i;
// Captures 1-5 alpha chars after "of".
const SYMBOL_RULE = /\bof\s+([A-Za-z]{1,5})\b/i;
const ORDER_TYPE_MARKET_RULE = /\bat\s+(the\s+)?market\b/i;
const ORDER_TYPE_LIMIT_RULE = /\bat\s+([\d.]+)\b/i;

// All-uppercase ("AAPL") or all-lowercase ("aapl") are treated as ticker symbols — STT may
// return either. Mixed-case ("Apple") indicates a company name and triggers AMBIGUOUS_SYMBOL.
const ALL_UPPER = /^[A-Z]{1,5}$/;
const ALL_LOWER = /^[a-z]{1,5}$/;

export { ParseError };

export function parseTranscript(transcript: string): ParsedOrder {
  const missingFields: (keyof OrderDraft)[] = [];

  // ── SIDE ─────────────────────────────────────────────────────────────────
  const sideRaw = SIDE_RULE.exec(transcript)?.[1];
  const side: OrderSide | undefined = sideRaw
    ? (sideRaw.toUpperCase() as OrderSide)
    : undefined;
  if (side === undefined) missingFields.push('side');

  // ── QUANTITY ──────────────────────────────────────────────────────────────
  const quantityRaw = QUANTITY_RULE.exec(transcript)?.[1];
  const quantity: number | undefined =
    quantityRaw !== undefined
      ? parseInt(quantityRaw.replace(/,/g, ''), 10)
      : undefined;
  if (quantity === undefined) missingFields.push('quantity');

  // ── SYMBOL ────────────────────────────────────────────────────────────────
  // Throw immediately on AMBIGUOUS_SYMBOL — can't proceed with an unknown ticker.
  // Accept all-uppercase ("AAPL") or all-lowercase ("aapl") — STT may return either.
  // Mixed-case ("Apple") indicates a spoken company name, not a ticker.
  const symbolCandidate = SYMBOL_RULE.exec(transcript)?.[1];
  let rawSymbol: string | undefined;
  if (symbolCandidate !== undefined) {
    if (!ALL_UPPER.test(symbolCandidate) && !ALL_LOWER.test(symbolCandidate)) {
      throw new ParseError(
        'AMBIGUOUS_SYMBOL',
        `"${symbolCandidate}" looks like a company name, not a ticker symbol. Please speak the ticker (e.g. AAPL).`,
      );
    }
    rawSymbol = symbolCandidate.toUpperCase();
  } else {
    missingFields.push('symbol');
  }

  // ── ORDER TYPE ────────────────────────────────────────────────────────────
  let orderType: OrderType | undefined;
  let limitPrice: number | undefined;

  if (ORDER_TYPE_MARKET_RULE.test(transcript)) {
    orderType = 'MARKET';
  } else {
    const limitRaw = ORDER_TYPE_LIMIT_RULE.exec(transcript)?.[1];
    if (limitRaw !== undefined) {
      orderType = 'LIMIT';
      limitPrice = parseFloat(limitRaw);
    } else {
      missingFields.push('orderType');
    }
  }

  // ── VALIDATION ────────────────────────────────────────────────────────────
  if (missingFields.length > 0) {
    throw new ParseError(
      'MISSING_FIELDS',
      `Missing required fields: ${missingFields.join(', ')}.`,
      missingFields,
    );
  }

  // All required fields are present; type assertions are safe because the
  // missingFields guard above would have thrown if any were undefined.
  return {
    side: side as OrderSide,
    quantity: quantity as number,
    rawSymbol: rawSymbol as string,
    // MVP: no symbol lookup service — resolvedSymbol equals rawSymbol.
    resolvedSymbol: rawSymbol as string,
    orderType: orderType as OrderType,
    assetClass: 'EQUITY',
    ...(limitPrice !== undefined ? { limitPrice } : {}),
  };
}

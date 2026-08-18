import { parseTranscript } from '../src/services/parser/index.js';
import { ParseError } from '../src/services/parser/ParseError.js';

/** Calls parseTranscript and returns the thrown ParseError, or fails the test. */
function throwsParseError(transcript: string): ParseError {
  try {
    parseTranscript(transcript);
  } catch (err) {
    if (err instanceof ParseError) return err;
    throw err;
  }
  throw new Error(`parseTranscript did not throw for: "${transcript}"`);
}

describe('parseTranscript', () => {
  // ── Valid canonical inputs ─────────────────────────────────────────────────

  describe('valid canonical inputs', () => {
    it('parses a canonical LIMIT BUY order', () => {
      expect(parseTranscript('Buy 100 shares of AAPL at 195.50')).toEqual({
        side: 'BUY',
        quantity: 100,
        rawSymbol: 'AAPL',
        resolvedSymbol: 'AAPL',
        orderType: 'LIMIT',
        limitPrice: 195.5,
        assetClass: 'EQUITY',
      });
    });

    it('parses a canonical LIMIT SELL order', () => {
      expect(parseTranscript('Sell 50 shares of MSFT at 320.00')).toEqual({
        side: 'SELL',
        quantity: 50,
        rawSymbol: 'MSFT',
        resolvedSymbol: 'MSFT',
        orderType: 'LIMIT',
        limitPrice: 320.0,
        assetClass: 'EQUITY',
      });
    });

    it('resolvedSymbol equals rawSymbol in MVP (no lookup service)', () => {
      const result = parseTranscript('Buy 100 shares of AAPL at 195.50');
      expect(result.resolvedSymbol).toBe(result.rawSymbol);
    });

    it('always sets assetClass to EQUITY in MVP', () => {
      const result = parseTranscript('Buy 100 shares of AAPL at market');
      expect(result.assetClass).toBe('EQUITY');
    });
  });

  // ── Market order variants ──────────────────────────────────────────────────

  describe('market order variants', () => {
    it('parses "at market"', () => {
      expect(parseTranscript('Sell 500 shares of MSFT at market')).toEqual({
        side: 'SELL',
        quantity: 500,
        rawSymbol: 'MSFT',
        resolvedSymbol: 'MSFT',
        orderType: 'MARKET',
        assetClass: 'EQUITY',
      });
    });

    it('parses "at the market"', () => {
      expect(parseTranscript('Buy 200 shares of TSLA at the market')).toEqual({
        side: 'BUY',
        quantity: 200,
        rawSymbol: 'TSLA',
        resolvedSymbol: 'TSLA',
        orderType: 'MARKET',
        assetClass: 'EQUITY',
      });
    });

    it('parses "AT MARKET" (all-caps, case-insensitive)', () => {
      expect(parseTranscript('BUY 200 shares of TSLA AT MARKET')).toEqual({
        side: 'BUY',
        quantity: 200,
        rawSymbol: 'TSLA',
        resolvedSymbol: 'TSLA',
        orderType: 'MARKET',
        assetClass: 'EQUITY',
      });
    });

    it('does not include limitPrice on a MARKET order', () => {
      const result = parseTranscript('Buy 100 shares of AAPL at market');
      expect(result).not.toHaveProperty('limitPrice');
    });
  });

  // ── Symbol case normalisation ──────────────────────────────────────────────

  describe('symbol case normalisation', () => {
    it('accepts an all-uppercase ticker and preserves it', () => {
      const result = parseTranscript('Buy 100 shares of AAPL at market');
      expect(result.rawSymbol).toBe('AAPL');
    });

    it('accepts an all-lowercase ticker and converts it to uppercase', () => {
      const result = parseTranscript('Buy 100 shares of aapl at market');
      expect(result.rawSymbol).toBe('AAPL');
      expect(result.resolvedSymbol).toBe('AAPL');
    });
  });

  // ── Numeric edge cases ─────────────────────────────────────────────────────

  describe('numeric edge cases', () => {
    it('strips commas from a comma-formatted quantity (1,000)', () => {
      const result = parseTranscript('Buy 1,000 shares of AAPL at market');
      expect(result.quantity).toBe(1000);
    });

    it('parses a large quantity without commas (1000000)', () => {
      const result = parseTranscript('Buy 1000000 shares of AAPL at market');
      expect(result.quantity).toBe(1000000);
    });

    it('parses a limit price with two decimal places', () => {
      const result = parseTranscript('Buy 100 shares of AAPL at 195.99');
      expect(result.limitPrice).toBe(195.99);
    });

    it('parses "share" (singular) as well as "shares"', () => {
      const result = parseTranscript('Buy 1 share of AAPL at market');
      expect(result.quantity).toBe(1);
    });
  });

  // ── Missing required fields ────────────────────────────────────────────────

  describe('missing required fields', () => {
    it('throws MISSING_FIELDS with side when transcript has no buy/sell', () => {
      const err = throwsParseError('100 shares of AAPL at market');
      expect(err.code).toBe('MISSING_FIELDS');
      expect(err.missingFields).toContain('side');
    });

    it('throws MISSING_FIELDS with quantity when no number precedes "shares"', () => {
      const err = throwsParseError('Buy shares of AAPL at 50');
      expect(err.code).toBe('MISSING_FIELDS');
      expect(err.missingFields).toContain('quantity');
    });

    it('throws MISSING_FIELDS with symbol when "of <ticker>" is absent', () => {
      const err = throwsParseError('Buy 100 shares at market');
      expect(err.code).toBe('MISSING_FIELDS');
      expect(err.missingFields).toContain('symbol');
    });

    it('throws MISSING_FIELDS with orderType when no price or market phrase appears', () => {
      const err = throwsParseError('Buy 100 shares of AAPL');
      expect(err.code).toBe('MISSING_FIELDS');
      expect(err.missingFields).toContain('orderType');
    });

    it('lists every missing field when the transcript has no recognisable structure', () => {
      const err = throwsParseError('hello world');
      expect(err.code).toBe('MISSING_FIELDS');
      expect(err.missingFields).toEqual(
        expect.arrayContaining(['side', 'quantity', 'symbol', 'orderType']),
      );
    });

    it('sets missingFields on the thrown error (ParseError constructor true branch)', () => {
      const err = throwsParseError('hello world');
      expect(err.missingFields).toBeDefined();
    });
  });

  // ── Ambiguous symbol ───────────────────────────────────────────────────────

  describe('ambiguous symbol', () => {
    it('throws AMBIGUOUS_SYMBOL for a mixed-case company name', () => {
      const err = throwsParseError('Buy 100 shares of Apple at market');
      expect(err.code).toBe('AMBIGUOUS_SYMBOL');
    });

    it('throws AMBIGUOUS_SYMBOL for another mixed-case name', () => {
      const err = throwsParseError('Sell 200 shares of Tesla at 250.00');
      expect(err.code).toBe('AMBIGUOUS_SYMBOL');
    });

    it('does not set missingFields on AMBIGUOUS_SYMBOL (ParseError constructor false branch)', () => {
      const err = throwsParseError('Buy 100 shares of Apple at market');
      expect(err.missingFields).toBeUndefined();
    });
  });

  // ── Extra words ────────────────────────────────────────────────────────────

  describe('extra words', () => {
    it('fails cleanly when the sentence does not start with buy/sell', () => {
      // SIDE_RULE is anchored at ^ — "Let me buy..." misses it.
      const err = throwsParseError('Let me buy 100 shares of AAPL at 50');
      expect(err.code).toBe('MISSING_FIELDS');
      expect(err.missingFields).toContain('side');
    });

    it('reports only the missing field (side) when every other field is parseable', () => {
      const err = throwsParseError('Let me buy 100 shares of AAPL at 50');
      expect(err.missingFields).toHaveLength(1);
      expect(err.missingFields).toContain('side');
    });
  });
});

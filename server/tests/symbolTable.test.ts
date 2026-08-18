import { resolveSymbol } from '../src/services/symbols/symbolTable.js';
import { ParseError } from '../src/services/parser/ParseError.js';

/** Calls resolveSymbol and returns the thrown ParseError, or fails the test. */
function throwsParseError(spoken: string): ParseError {
  try {
    resolveSymbol(spoken);
  } catch (err) {
    if (err instanceof ParseError) return err;
    throw err;
  }
  throw new Error(`resolveSymbol did not throw for: "${spoken}"`);
}

describe('resolveSymbol', () => {
  describe('clean tickers', () => {
    it('passes through a known uppercase ticker', () => {
      expect(resolveSymbol('AAPL')).toEqual({ symbol: 'AAPL' });
    });

    it('uppercases a known lowercase ticker', () => {
      expect(resolveSymbol('msft')).toEqual({ symbol: 'MSFT' });
    });
  });

  describe('single company-name matches', () => {
    it('resolves a company name to its ticker', () => {
      expect(resolveSymbol('Apple')).toEqual({ symbol: 'AAPL' });
    });

    it('resolves a known alias', () => {
      expect(resolveSymbol('google')).toEqual({ symbol: 'GOOGL' });
    });

    it('is case- and punctuation-insensitive', () => {
      expect(resolveSymbol('Coca-Cola')).toEqual({ symbol: 'KO' });
    });
  });

  describe('ambiguous names', () => {
    it('throws AMBIGUOUS_SYMBOL with candidates when a name maps to several tickers', () => {
      const err = throwsParseError('United');
      expect(err.code).toBe('AMBIGUOUS_SYMBOL');
      expect(err.candidates).toBeDefined();
      const symbols = err.candidates!.map((c) => c.symbol).sort();
      expect(symbols).toEqual(['UAL', 'UNH']);
    });

    it('dedupes so each candidate ticker appears once', () => {
      const err = throwsParseError('American');
      expect(err.code).toBe('AMBIGUOUS_SYMBOL');
      const symbols = err.candidates!.map((c) => c.symbol).sort();
      expect(symbols).toEqual(['AAL', 'AXP']);
    });
  });

  describe('unknown names', () => {
    it('throws AMBIGUOUS_SYMBOL without candidates when nothing matches', () => {
      const err = throwsParseError('Nonexistent Corp');
      expect(err.code).toBe('AMBIGUOUS_SYMBOL');
      expect(err.candidates).toBeUndefined();
    });

    it('does not pass through an unknown ticker-shaped token', () => {
      const err = throwsParseError('ZZZZ');
      expect(err.code).toBe('AMBIGUOUS_SYMBOL');
    });
  });
});

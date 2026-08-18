import { interpretWithNLP } from '../src/services/nlp/index.js';
import { ParseError } from '../src/services/parser/ParseError.js';

/** Builds a fake OpenAI-compatible chat response whose content is `order` as JSON. */
function mockLlmResponse(order: Record<string, unknown>): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(order) } }] }),
  }) as unknown as typeof fetch;
}

/** Awaits interpretWithNLP and returns the thrown ParseError, or fails the test. */
async function throwsParseError(transcript: string, override?: string): Promise<ParseError> {
  try {
    await interpretWithNLP(transcript, override);
  } catch (err) {
    if (err instanceof ParseError) return err;
    throw err;
  }
  throw new Error(`interpretWithNLP did not throw for: "${transcript}"`);
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('interpretWithNLP', () => {
  describe('valid extraction', () => {
    it('returns a fully-populated ParsedOrder for a clean ticker', async () => {
      mockLlmResponse({
        side: 'BUY',
        quantity: 200,
        symbol: 'AAPL',
        orderType: 'MARKET',
        confidence: 0.95,
      });
      await expect(interpretWithNLP('grab me two hundred Apple shares at market')).resolves.toEqual({
        side: 'BUY',
        quantity: 200,
        rawSymbol: 'AAPL',
        resolvedSymbol: 'AAPL',
        orderType: 'MARKET',
        assetClass: 'EQUITY',
        confidence: 0.95,
      });
    });

    it('resolves a spoken company name to its ticker', async () => {
      mockLlmResponse({
        side: 'SELL',
        quantity: 50,
        symbol: 'Microsoft',
        orderType: 'LIMIT',
        limitPrice: 410.25,
        confidence: 0.9,
      });
      await expect(interpretWithNLP('sell fifty Microsoft at 410.25')).resolves.toEqual({
        side: 'SELL',
        quantity: 50,
        rawSymbol: 'Microsoft',
        resolvedSymbol: 'MSFT',
        orderType: 'LIMIT',
        limitPrice: 410.25,
        assetClass: 'EQUITY',
        confidence: 0.9,
      });
    });
  });

  describe('recoverable failures', () => {
    it('throws MISSING_FIELDS when the model omits a required field', async () => {
      mockLlmResponse({ side: null, quantity: 100, symbol: 'AAPL', orderType: 'MARKET', confidence: 0.9 });
      const err = await throwsParseError('a hundred Apple at market');
      expect(err.code).toBe('MISSING_FIELDS');
      expect(err.missingFields).toContain('side');
    });

    it('throws MISSING_FIELDS when a LIMIT order has no price', async () => {
      mockLlmResponse({ side: 'BUY', quantity: 100, symbol: 'AAPL', orderType: 'LIMIT', confidence: 0.9 });
      const err = await throwsParseError('buy a hundred apple limit');
      expect(err.code).toBe('MISSING_FIELDS');
      expect(err.missingFields).toContain('limitPrice');
    });

    it('throws PARSE_FAILED when confidence is below the floor', async () => {
      mockLlmResponse({ side: 'BUY', quantity: 100, symbol: 'AAPL', orderType: 'MARKET', confidence: 0.2 });
      const err = await throwsParseError('mumbled order');
      expect(err.code).toBe('PARSE_FAILED');
    });

    it('throws AMBIGUOUS_SYMBOL with candidates for an ambiguous company name', async () => {
      mockLlmResponse({ side: 'BUY', quantity: 100, symbol: 'United', orderType: 'MARKET', confidence: 0.9 });
      const err = await throwsParseError('buy a hundred United at market');
      expect(err.code).toBe('AMBIGUOUS_SYMBOL');
      expect(err.candidates!.map((c) => c.symbol).sort()).toEqual(['UAL', 'UNH']);
    });
  });

  describe('symbol override', () => {
    it('bypasses resolution and uses the chosen ticker', async () => {
      mockLlmResponse({ side: 'BUY', quantity: 100, symbol: 'United', orderType: 'MARKET', confidence: 0.9 });
      const result = await interpretWithNLP('buy a hundred United at market', 'UAL');
      expect(result.resolvedSymbol).toBe('UAL');
      expect(result.rawSymbol).toBe('United');
    });
  });

  describe('service failures', () => {
    it('throws PARSE_FAILED when the LLM service is unreachable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
      const err = await throwsParseError('buy a hundred apple at market');
      expect(err.code).toBe('PARSE_FAILED');
    });

    it('throws PARSE_FAILED on a non-OK HTTP status', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as unknown as typeof fetch;
      const err = await throwsParseError('buy a hundred apple at market');
      expect(err.code).toBe('PARSE_FAILED');
    });
  });
});

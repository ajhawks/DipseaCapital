/**
 * Unit tests for server/src/services/silexx/silexxClient.ts
 *
 * Strategy:
 *   - jest.mock() replaces auditService so we can inspect calls without I/O.
 *   - global.fetch is replaced with a jest.fn() to control HTTP responses.
 *   - Call-order is verified via a shared event log filled by both mocks.
 */

// ── mocks must be declared before imports ─────────────────────────────────────

jest.mock('../src/services/audit/auditService.js', () => ({
  auditService: { log: jest.fn() },
}));

// ── imports ───────────────────────────────────────────────────────────────────

import { jest } from '@jest/globals';
import type { OrderDraft } from '@silexx/shared';
import { createDraft, SilexxError } from '../src/services/silexx/silexxClient.js';
import { auditService } from '../src/services/audit/auditService.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const mockLog = jest.mocked(auditService.log);

/** Minimal valid OrderDraft fixture. */
const draft: OrderDraft = {
  id: 'draft-001',
  status: 'draft',
  side: 'BUY',
  quantity: 100,
  symbol: 'AAPL',
  rawSymbol: 'AAPL',
  orderType: 'LIMIT',
  limitPrice: 195.5,
  assetClass: 'EQUITY',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Returns a minimal fetch Response-alike for happy-path tests. */
function makeOkResponse(ticketId: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ silexxTicketId: ticketId }),
  } as unknown as Response;
}

/** Returns a minimal fetch Response-alike for non-2xx tests. */
function makeErrorResponse(status: number, statusText: string) {
  return { ok: false, status, statusText } as unknown as Response;
}

// ── setup / teardown ──────────────────────────────────────────────────────────

const mockFetch = jest.fn<typeof globalThis.fetch>();

beforeAll(() => {
  global.fetch = mockFetch;
  process.env['SILEXX_API_URL'] = 'https://mock-silexx.example.com';
  process.env['SILEXX_API_KEY'] = 'test-api-key';
});

afterAll(() => {
  delete process.env['SILEXX_API_URL'];
  delete process.env['SILEXX_API_KEY'];
});

beforeEach(() => {
  mockFetch.mockReset();
  mockLog.mockReset();
  mockLog.mockImplementation(async () => {});
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('createDraft — happy path', () => {
  test('returns the silexxTicketId from the API response', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse('SLX-999'));

    const result = await createDraft(draft, 'trader-1');

    expect(result.silexxTicketId).toBe('SLX-999');
  });

  test('calls auditService.log exactly twice', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse('SLX-999'));

    await createDraft(draft, 'trader-1');

    expect(mockLog).toHaveBeenCalledTimes(2);
  });

  test('first audit entry is SILEXX_API_CALLED', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse('SLX-999'));

    await createDraft(draft, 'trader-1');

    expect(mockLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'SILEXX_API_CALLED', orderId: draft.id, userId: 'trader-1' }),
    );
  });

  test('second audit entry is SILEXX_API_RESPONSE with ticketId', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse('SLX-999'));

    await createDraft(draft, 'trader-1');

    expect(mockLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'SILEXX_API_RESPONSE',
        orderId: draft.id,
        silexxTicketId: 'SLX-999',
      }),
    );
  });

  test('CALLED fires before fetch, RESPONSE fires after', async () => {
    const eventLog: string[] = [];

    mockLog.mockImplementation(async (entry) => {
      eventLog.push(`audit:${entry.action}`);
    });
    mockFetch.mockImplementation(async () => {
      eventLog.push('fetch');
      return makeOkResponse('SLX-X');
    });

    await createDraft(draft, 'trader-1');

    expect(eventLog).toEqual(['audit:SILEXX_API_CALLED', 'fetch', 'audit:SILEXX_API_RESPONSE']);
  });

  test('does not include transcriptFragment in the audit log', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse('SLX-999'));

    const draftWithFragment: OrderDraft = { ...draft, transcriptFragment: 'Buy 100 AAPL' };
    await createDraft(draftWithFragment, 'trader-1');

    const [calledEntry] = mockLog.mock.calls[0]!;
    expect(calledEntry.parsedFields).toBeDefined();
    expect((calledEntry.parsedFields as Record<string, unknown>)['transcriptFragment']).toBeUndefined();
  });
});

describe('createDraft — HTTP error (502)', () => {
  test('throws SilexxError with statusCode 502 on a non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(502, 'Bad Gateway'));

    const err = await createDraft(draft, 'trader-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SilexxError);
    expect((err as SilexxError).statusCode).toBe(502);
  });

  test('still logs SILEXX_API_CALLED then SILEXX_API_RESPONSE on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(502, 'Bad Gateway'));

    await createDraft(draft, 'trader-1').catch(() => undefined);

    expect(mockLog).toHaveBeenCalledTimes(2);
    expect(mockLog).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'SILEXX_API_CALLED' }));
    expect(mockLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: 'SILEXX_API_RESPONSE', errorCode: '502' }),
    );
  });
});

describe('createDraft — network error', () => {
  test('throws SilexxError(502) when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(createDraft(draft, 'trader-1')).rejects.toBeInstanceOf(SilexxError);
  });

  test('logs SILEXX_API_RESPONSE with NETWORK_ERROR on fetch rejection', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await createDraft(draft, 'trader-1').catch(() => undefined);

    expect(mockLog).toHaveBeenCalledTimes(2);
    expect(mockLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: 'SILEXX_API_RESPONSE', errorCode: 'NETWORK_ERROR' }),
    );
  });
});

describe('createDraft — missing configuration', () => {
  test('throws SilexxError when SILEXX_API_URL is absent', async () => {
    const saved = process.env['SILEXX_API_URL'];
    delete process.env['SILEXX_API_URL'];

    await expect(createDraft(draft, 'trader-1')).rejects.toBeInstanceOf(SilexxError);

    process.env['SILEXX_API_URL'] = saved;
  });

  test('throws SilexxError when SILEXX_API_KEY is absent', async () => {
    const saved = process.env['SILEXX_API_KEY'];
    delete process.env['SILEXX_API_KEY'];

    await expect(createDraft(draft, 'trader-1')).rejects.toBeInstanceOf(SilexxError);

    process.env['SILEXX_API_KEY'] = saved;
  });

  test('does not call fetch when config is missing', async () => {
    const saved = process.env['SILEXX_API_URL'];
    delete process.env['SILEXX_API_URL'];

    await createDraft(draft, 'trader-1').catch(() => undefined);
    expect(mockFetch).not.toHaveBeenCalled();

    process.env['SILEXX_API_URL'] = saved;
  });
});

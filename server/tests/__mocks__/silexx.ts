/**
 * Manual mock for server/src/services/silexx/silexxClient.ts
 *
 * Usage in a test file:
 *   jest.mock('../src/services/silexx/silexxClient.js', () => require('../tests/__mocks__/silexx'));
 *
 * Control helpers (call in beforeEach / inside tests):
 *   resetSilexxMock()           — clear captured calls and reset failure mode
 *   setSilexxShouldFail(true)   — next createDraft() rejects with SilexxError(502)
 *   getSilexxCalls()            — returns a copy of captured { draft, userId } pairs
 */

import type { OrderDraft } from '@silexx/shared';

export class SilexxError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SilexxError';
  }
}

interface CapturedCall {
  draft: OrderDraft;
  userId: string;
}

const _calls: CapturedCall[] = [];
let _shouldFail = false;

export async function createDraft(
  draft: OrderDraft,
  userId: string,
): Promise<{ silexxTicketId: string }> {
  _calls.push({ draft, userId });
  if (_shouldFail) {
    throw new SilexxError(502, 'Silexx API unavailable (mock 502)');
  }
  return { silexxTicketId: 'MOCK-TICKET-001' };
}

export function getSilexxCalls(): CapturedCall[] {
  return [..._calls];
}

export function resetSilexxMock(): void {
  _calls.length = 0;
  _shouldFail = false;
}

export function setSilexxShouldFail(fail: boolean): void {
  _shouldFail = fail;
}

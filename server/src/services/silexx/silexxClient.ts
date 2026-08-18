import type { OrderDraft } from '@silexx/shared';
import { auditService } from '../audit/auditService.js';

export class SilexxError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SilexxError';
  }
}

/**
 * Creates a draft order ticket in the Silexx system.
 * Emits SILEXX_API_CALLED before the request and SILEXX_API_RESPONSE after
 * (success or failure) — no exceptions to this rule.
 */
export async function createDraft(
  draft: OrderDraft,
  userId: string,
): Promise<{ silexxTicketId: string }> {
  const baseUrl = process.env['SILEXX_API_URL'];
  const apiKey = process.env['SILEXX_API_KEY'];

  if (!baseUrl || !apiKey) {
    throw new SilexxError(
      500,
      'Silexx API is not configured: missing SILEXX_API_URL or SILEXX_API_KEY.',
    );
  }

  // Strip transcriptFragment before logging — never log spoken text persistently.
  const { transcriptFragment: _transcriptFragment, ...parsedFields } = draft;

  await auditService.log({
    userId,
    action: 'SILEXX_API_CALLED',
    orderId: draft.id,
    parsedFields,
  });

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/orders/draft`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify(draft),
    });
  } catch (networkErr) {
    const message =
      networkErr instanceof Error ? networkErr.message : 'Unknown network error';
    await auditService.log({
      userId,
      action: 'SILEXX_API_RESPONSE',
      orderId: draft.id,
      errorCode: 'NETWORK_ERROR',
      metadata: { message },
    });
    throw new SilexxError(502, `Silexx API unreachable: ${message}`);
  }

  if (!response.ok) {
    const errorCode = String(response.status);
    await auditService.log({
      userId,
      action: 'SILEXX_API_RESPONSE',
      orderId: draft.id,
      errorCode,
      metadata: { statusText: response.statusText },
    });
    throw new SilexxError(
      response.status,
      `Silexx API returned ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as { silexxTicketId: string };

  await auditService.log({
    userId,
    action: 'SILEXX_API_RESPONSE',
    orderId: draft.id,
    silexxTicketId: body.silexxTicketId,
  });

  return { silexxTicketId: body.silexxTicketId };
}

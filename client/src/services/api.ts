import type {
  ParseRequest,
  ParseResponse,
  ParseErrorResponse,
  DraftCreateRequest,
  DraftCreateResponse,
  OrderDraft,
} from '@silexx/shared';

export class ParseApiError extends Error {
  readonly response: ParseErrorResponse;
  constructor(response: ParseErrorResponse) {
    super(response.error);
    this.name = 'ParseApiError';
    this.response = response;
  }
}

export class DraftApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DraftApiError';
    this.status = status;
  }
}

export async function fetchParse(
  transcript: string,
  token: string,
  symbolOverride?: string,
): Promise<ParseResponse> {
  const body: ParseRequest = symbolOverride ? { transcript, symbolOverride } : { transcript };
  const res = await fetch('/api/parse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = (await res.json()) as ParseErrorResponse;
    throw new ParseApiError(err);
  }

  return res.json() as Promise<ParseResponse>;
}

export async function fetchCreateDraft(draft: OrderDraft, token: string): Promise<DraftCreateResponse> {
  const body: DraftCreateRequest = {
    draft,
    userConfirmedAt: new Date().toISOString(),
  };
  const res = await fetch('/api/draft', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new DraftApiError(res.status, `Draft creation failed with status ${res.status}`);
  }

  return res.json() as Promise<DraftCreateResponse>;
}

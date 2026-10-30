import type {
  ApiError,
  DraftListResponse,
  DraftResponse,
  EditableFields,
  HandoffAvailability,
  ManualCheckResult,
  OrderDraft,
  ParseRequest,
  ParseResponse,
} from '@silexx/shared';

/** A non-2xx API response. `draft` is the server's current copy when the request was stale. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiError['code'];
  readonly draft: OrderDraft | undefined;
  constructor(status: number, body: ApiError) {
    super(body.error);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code;
    this.draft = body.draft;
  }
}

async function request<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let err: ApiError;
    try {
      err = (await res.json()) as ApiError;
    } catch {
      err = { error: `Request failed with status ${res.status}`, code: 'SERVER_ERROR' };
    }
    throw new ApiRequestError(res.status, err);
  }
  return res.json() as Promise<T>;
}

export function fetchParse(token: string, transcript: string, symbolOverride?: string): Promise<ParseResponse> {
  const body: ParseRequest = symbolOverride ? { transcript, symbolOverride } : { transcript };
  return request(token, 'POST', '/api/parse', body);
}

export const fetchDrafts = (token: string) => request<DraftListResponse>(token, 'GET', '/api/drafts');

export const fetchAvailability = (token: string) =>
  request<HandoffAvailability>(token, 'GET', '/api/drafts/handoff-availability');

const draftAction = (token: string, id: string, action: string, body: unknown) =>
  request<DraftResponse>(token, 'POST', `/api/drafts/${encodeURIComponent(id)}/${action}`, body).then((r) => r.draft);

export const editDraft = (token: string, d: OrderDraft, changes: EditableFields) =>
  request<DraftResponse>(token, 'PATCH', `/api/drafts/${encodeURIComponent(d.id)}`, { version: d.version, changes }).then(
    (r) => r.draft,
  );

export const acknowledgeWarnings = (token: string, d: OrderDraft, codes: string[]) =>
  draftAction(token, d.id, 'acknowledge', { version: d.version, codes });

export const confirmDraft = (token: string, d: OrderDraft) => draftAction(token, d.id, 'confirm', { version: d.version });

export const cancelDraft = (token: string, d: OrderDraft) => draftAction(token, d.id, 'cancel', { version: d.version });

export const handoffDraft = (token: string, d: OrderDraft) => draftAction(token, d.id, 'handoff', { version: d.version });

export const reconcileDraft = (token: string, d: OrderDraft, manualResult?: ManualCheckResult) =>
  draftAction(token, d.id, 'reconcile', manualResult ? { manualResult } : {});

import type { OrderFields } from '@silexx/shared';
import type { AdapterCapabilities, PopulateResult, SilexxAdapter, TicketSnapshot } from './adapter.js';

/**
 * HTTP adapter for the local Silexx stub (`scripts/silexx-stub.mjs`). The real
 * endpoint shapes are unknown until D1; this exists so the state machine can be
 * exercised end to end. Capabilities come from configuration, not assumptions.
 */

const TICKET_STATUSES = new Set(['draft', 'submitted', 'working', 'routed', 'filled']);

function capabilitiesFromEnv(): AdapterCapabilities {
  const caps = new Set((process.env['SILEXX_CAPABILITIES'] ?? '').split(',').map((s) => s.trim()));
  return { idempotency: caps.has('idempotency'), lookup: caps.has('lookup'), readBack: caps.has('readBack') };
}

function isConnectionRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  return cause?.code === 'ECONNREFUSED' || cause?.code === 'ENOTFOUND';
}

export class HttpSilexxAdapter implements SilexxAdapter {
  readonly capabilities: AdapterCapabilities;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    capabilities: AdapterCapabilities = capabilitiesFromEnv(),
  ) {
    this.capabilities = capabilities;
  }

  async populate(fields: OrderFields, idempotencyKey: string): Promise<PopulateResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/orders/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey, 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Refused before connecting: the request never left. Anything else (timeout,
      // reset) may have been received, so the outcome is unknown.
      if (isConnectionRefused(err)) return { kind: 'rejected', reason: 'Silexx is unreachable (connection refused).' };
      const name = (err as { name?: string }).name;
      return { kind: 'uncertain', reason: name === 'TimeoutError' ? 'Silexx did not respond in time.' : 'Connection lost after sending.' };
    }

    if (res.status >= 500 || res.status === 408 || res.status === 409) {
      return { kind: 'uncertain', reason: `Silexx returned ${res.status}.` };
    }
    if (res.status >= 400) return { kind: 'rejected', reason: `Silexx rejected the draft (${res.status}).` };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'uncertain', reason: 'Silexx accepted the request but the response was unreadable.' };
    }
    const b = body as { silexxTicketId?: unknown; idempotencyKey?: unknown } | null;
    if (!b || typeof b.silexxTicketId !== 'string' || b.silexxTicketId.trim() === '') {
      return { kind: 'uncertain', reason: 'Silexx response had no ticket ID.' };
    }
    return {
      kind: 'accepted',
      ticketId: b.silexxTicketId,
      ...(typeof b.idempotencyKey === 'string' ? { echoedKey: b.idempotencyKey } : {}),
    };
  }

  async lookup(idempotencyKey: string): Promise<TicketSnapshot | 'absent'> {
    const res = await fetch(`${this.baseUrl}/orders/draft?idempotencyKey=${encodeURIComponent(idempotencyKey)}`, {
      headers: { 'X-Api-Key': this.apiKey },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return 'absent';
    if (!res.ok) throw new Error(`lookup failed with ${res.status}`);
    const b = (await res.json()) as { silexxTicketId?: unknown; fields?: unknown; status?: unknown };
    if (typeof b.silexxTicketId !== 'string' || typeof b.fields !== 'object' || b.fields === null) {
      throw new Error('lookup returned a malformed ticket');
    }
    const status = typeof b.status === 'string' && TICKET_STATUSES.has(b.status) ? (b.status as TicketSnapshot['status']) : 'unknown';
    return { ticketId: b.silexxTicketId, fields: b.fields as OrderFields, status };
  }
}

export function adapterFromEnv(): SilexxAdapter | undefined {
  const baseUrl = process.env['SILEXX_API_URL'];
  const apiKey = process.env['SILEXX_API_KEY'];
  if (!baseUrl || !apiKey) return undefined;
  const timeout = Number(process.env['SILEXX_TIMEOUT_MS']);
  return new HttpSilexxAdapter(baseUrl, apiKey, Number.isFinite(timeout) && timeout > 0 ? timeout : 5_000);
}

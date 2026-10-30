import type { OrderFields } from '@silexx/shared';

/**
 * Boundary to Silexx (S1.4). The adapter only *classifies* what it observed;
 * the handoff service decides states. "uncertain" means the request may have
 * reached Silexx: it must never be reported as success or blindly retried.
 */

export interface AdapterCapabilities {
  /** Silexx deduplicates requests carrying the same idempotency key. */
  idempotency: boolean;
  /** Tickets can be looked up by idempotency key. */
  lookup: boolean;
  /** A looked-up ticket exposes its fields and status for comparison. */
  readBack: boolean;
}

export type PopulateResult =
  | { kind: 'accepted'; ticketId: string; echoedKey?: string }
  /** Definitely not created (e.g. validation rejection, connection refused before send). */
  | { kind: 'rejected'; reason: string }
  | { kind: 'uncertain'; reason: string };

export interface TicketSnapshot {
  ticketId: string;
  fields: OrderFields;
  /** Silexx's own status for the ticket. Anything other than a draft is a safety violation. */
  status: 'draft' | 'submitted' | 'working' | 'routed' | 'filled' | 'unknown';
}

export interface SilexxAdapter {
  readonly capabilities: AdapterCapabilities;
  populate(fields: OrderFields, idempotencyKey: string): Promise<PopulateResult>;
  lookup?(idempotencyKey: string): Promise<TicketSnapshot | 'absent'>;
}

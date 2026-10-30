import { createHash } from 'node:crypto';

/**
 * Tamper-evident audit chain. Each row's hash covers the previous row's hash plus
 * the row's own canonical content, so editing, deleting or reordering any row
 * breaks every hash after it.
 */

export type AuditEvent =
  | 'PARSE_REQUEST'
  | 'PARSE_CLARIFICATION'
  | 'PARSE_REFUSAL'
  | 'DRAFT_CREATED'
  | 'DRAFT_EDITED'
  | 'VALIDATION_ISSUES'
  | 'WARNINGS_ACKNOWLEDGED'
  | 'DRAFT_CONFIRMED'
  | 'DRAFT_CANCELLED'
  | 'HANDOFF_ATTEMPT'
  | 'HANDOFF_OUTCOME'
  | 'HANDOFF_READ_BACK'
  | 'HANDOFF_RECONCILED'
  | 'HANDOFF_SWEPT_UNCERTAIN'
  | 'SAFETY_VIOLATION'
  | 'KILL_SWITCH_TRIPPED'
  | 'KILL_SWITCH_RESET';

export type AuditData = Record<string, unknown>;

export interface AuditRow {
  seq: number;
  at: string;
  userId: string;
  event: AuditEvent;
  draftId?: string;
  data: AuditData;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

/** JSON with object keys sorted at every level, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashRow(row: Omit<AuditRow, 'hash'>): string {
  return sha256(row.prevHash + canonicalJson(row));
}

export function buildRow(
  prev: AuditRow | undefined,
  entry: { userId: string; event: AuditEvent; draftId?: string; data?: AuditData },
  at: string,
): AuditRow {
  const base: Omit<AuditRow, 'hash'> = {
    seq: prev ? prev.seq + 1 : 1,
    at,
    userId: entry.userId,
    event: entry.event,
    ...(entry.draftId !== undefined ? { draftId: entry.draftId } : {}),
    data: entry.data ?? {},
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return { ...base, hash: hashRow(base) };
}

export interface VerifyResult {
  ok: boolean;
  rows: number;
  /** 1-based seq of the first row that fails, when !ok. */
  brokenAt?: number;
  reason?: string;
}

export function verifyChain(rows: readonly AuditRow[]): VerifyResult {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as AuditRow;
    const expectedSeq = i + 1;
    if (row.seq !== expectedSeq) {
      return { ok: false, rows: rows.length, brokenAt: expectedSeq, reason: 'sequence gap or reorder' };
    }
    if (row.prevHash !== prevHash) {
      return { ok: false, rows: rows.length, brokenAt: row.seq, reason: 'prevHash does not link' };
    }
    const { hash, ...rest } = row;
    if (hashRow(rest) !== hash) {
      return { ok: false, rows: rows.length, brokenAt: row.seq, reason: 'row content altered' };
    }
    prevHash = hash;
  }
  return { ok: true, rows: rows.length };
}

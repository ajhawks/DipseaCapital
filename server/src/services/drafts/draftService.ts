import { randomUUID } from 'node:crypto';
import type { ApiErrorCode, EditableFields, OrderDraft, OrderFields, ValidationIssue } from '@silexx/shared';
import { canonicalJson, sha256 } from '../audit/chain.js';
import { getStore, type StoredDraft, type Tx } from '../store/store.js';
import { hasBlockingErrors, sanityConfigFromEnv, validateOrder, warningCodes } from '../validation/validate.js';

/**
 * Server-authoritative draft lifecycle (S1.2). Every transition is one store
 * transaction that checks the expected version/state, updates the draft and
 * appends its audit row together (R-ATOMIC). Drafts are scoped to their owner:
 * another user's draft is indistinguishable from a missing one.
 */

export class DraftError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly draft?: OrderDraft,
  ) {
    super(message);
    this.name = 'DraftError';
  }
}

const FIELD_KEYS = [
  'side', 'quantity', 'symbol', 'orderType', 'limitPrice', 'stopPrice', 'timeInForce', 'account', 'assetClass',
] as const satisfies readonly (keyof OrderFields)[];

export function fieldsOf(d: OrderFields): OrderFields {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_KEYS) if (d[k] !== undefined) out[k] = d[k];
  return out as unknown as OrderFields;
}

export const contentHashOf = (fields: OrderFields): string => sha256(canonicalJson(fieldsOf(fields)));

/** Strip the owner id before a draft leaves the server. */
export function publicDraft(d: StoredDraft): OrderDraft {
  const { userId: _userId, ...rest } = d;
  return rest;
}

function duplicateWindowMs(): number {
  const n = Number(process.env['DUPLICATE_WINDOW_MS']);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60_000;
}

/** Same user, same economic content, still open or recently confirmed (S1.6). */
function duplicateIssue(tx: Tx, userId: string, selfId: string, hash: string): ValidationIssue | undefined {
  const cutoff = Date.now() - duplicateWindowMs();
  const match = tx.listDrafts(
    (d) =>
      d.userId === userId &&
      d.id !== selfId &&
      d.state !== 'cancelled' &&
      d.contentHash === hash &&
      Date.parse(d.updatedAt) >= cutoff,
  )[0];
  if (!match) return undefined;
  return {
    code: 'POSSIBLE_DUPLICATE',
    severity: 'warning',
    message: `This looks like a duplicate of another ${match.state === 'confirmed' ? 'confirmed' : 'open'} draft from the last few minutes. Is it intentional?`,
  };
}

/** Recompute issues and the review state for the current content. Clears acknowledgements and confirmation. */
function revalidate(tx: Tx, d: StoredDraft): StoredDraft {
  const fields = fieldsOf(d);
  const contentHash = contentHashOf(fields);
  const issues = validateOrder(fields, sanityConfigFromEnv());
  const dup = duplicateIssue(tx, d.userId, d.id, contentHash);
  if (dup) issues.push(dup);
  const { confirmation: _confirmation, ...rest } = d;
  return {
    ...rest,
    contentHash,
    issues,
    acknowledgedWarnings: [],
    state: hasBlockingErrors(issues) ? 'draft' : 'awaiting_confirmation',
  };
}

function load(tx: Tx, userId: string, id: string): StoredDraft {
  const d = tx.getDraft(id);
  if (!d || d.userId !== userId) throw new DraftError(404, 'NOT_FOUND', 'Draft not found.');
  return d;
}

function expectVersion(d: StoredDraft, version: unknown): void {
  if (d.version !== version) {
    throw new DraftError(409, 'STALE_VERSION', 'This draft changed since you last saw it. Review it again.', publicDraft(d));
  }
}

/** Handoff states after which the draft must not change: the Silexx ticket may exist. */
const LOCKED_HANDOFF = new Set(['in_progress', 'populated_verified', 'populated_unverified', 'uncertain', 'mismatch', 'safety_violation']);

export interface NewDraftInput {
  fields: OrderFields;
  rawSymbol: string;
  transcript?: string;
}

export async function createDrafts(userId: string, inputs: NewDraftInput[]): Promise<OrderDraft[]> {
  return getStore().transaction((tx) =>
    inputs.map((input) => {
      const now = tx.now();
      const base: StoredDraft = {
        ...fieldsOf(input.fields),
        id: randomUUID(),
        userId,
        version: 1,
        contentHash: '',
        state: 'draft',
        rawSymbol: input.rawSymbol,
        createdAt: now,
        updatedAt: now,
        ...(input.transcript !== undefined ? { transcriptFragment: input.transcript } : {}),
        issues: [],
        acknowledgedWarnings: [],
        handoff: { state: 'none' },
      };
      const draft = revalidate(tx, base);
      tx.putDraft(draft);
      tx.audit({
        userId,
        event: 'DRAFT_CREATED',
        draftId: draft.id,
        // Transcript text stays out of the audit until retention is decided (D6): hash + length only.
        data: {
          version: 1,
          fields: fieldsOf(draft),
          contentHash: draft.contentHash,
          ...(input.transcript !== undefined
            ? { transcriptSha256: sha256(input.transcript), transcriptLength: input.transcript.length }
            : {}),
        },
      });
      if (draft.issues.length > 0) {
        tx.audit({ userId, event: 'VALIDATION_ISSUES', draftId: draft.id, data: { version: 1, issues: draft.issues } });
      }
      return publicDraft(draft);
    }),
  );
}

export async function listDrafts(userId: string): Promise<OrderDraft[]> {
  return getStore().transaction((tx) =>
    tx
      .listDrafts((d) => d.userId === userId && d.state !== 'cancelled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(publicDraft),
  );
}

export async function getDraft(userId: string, id: string): Promise<OrderDraft> {
  return getStore().transaction((tx) => publicDraft(load(tx, userId, id)));
}

const EDITABLE = new Set<string>(['side', 'quantity', 'symbol', 'orderType', 'limitPrice', 'stopPrice', 'timeInForce', 'account']);

export async function editDraft(userId: string, id: string, version: number, changes: EditableFields): Promise<OrderDraft> {
  return getStore().transaction((tx) => {
    const d = load(tx, userId, id);
    expectVersion(d, version);
    if (d.state === 'cancelled' || LOCKED_HANDOFF.has(d.handoff.state)) {
      throw new DraftError(409, 'INVALID_STATE', 'This draft can no longer be edited.', publicDraft(d));
    }
    const before = fieldsOf(d);
    const next: Record<string, unknown> = { ...d };
    for (const [k, v] of Object.entries(changes)) {
      if (!EDITABLE.has(k)) throw new DraftError(400, 'INVALID_REQUEST', `Field "${k}" cannot be edited.`);
      if (v === null || v === undefined || v === '') delete next[k];
      else next[k] = k === 'symbol' && typeof v === 'string' ? v.trim().toUpperCase() : v;
    }
    const edited = revalidate(tx, {
      ...(next as unknown as StoredDraft),
      version: d.version + 1,
      updatedAt: tx.now(),
      // An edit after a known failure starts the handoff over.
      handoff: { state: 'none' },
    });
    tx.putDraft(edited);
    tx.audit({
      userId,
      event: 'DRAFT_EDITED',
      draftId: id,
      data: { fromVersion: d.version, toVersion: edited.version, before, after: fieldsOf(edited), clearedConfirmation: d.state === 'confirmed' },
    });
    if (edited.issues.length > 0) {
      tx.audit({ userId, event: 'VALIDATION_ISSUES', draftId: id, data: { version: edited.version, issues: edited.issues } });
    }
    return publicDraft(edited);
  });
}

export async function acknowledgeWarnings(userId: string, id: string, version: number, codes: string[]): Promise<OrderDraft> {
  return getStore().transaction((tx) => {
    const d = load(tx, userId, id);
    expectVersion(d, version);
    if (d.state !== 'awaiting_confirmation') {
      throw new DraftError(409, 'INVALID_STATE', 'Warnings can only be acknowledged before confirming.', publicDraft(d));
    }
    const valid = new Set(warningCodes(d.issues));
    const acked = [...new Set([...d.acknowledgedWarnings, ...codes.filter((c) => valid.has(c))])];
    // Every transition bumps the version, so a request based on an older view loses the compare-and-set.
    const updated: StoredDraft = { ...d, version: d.version + 1, acknowledgedWarnings: acked, updatedAt: tx.now() };
    tx.putDraft(updated);
    tx.audit({ userId, event: 'WARNINGS_ACKNOWLEDGED', draftId: id, data: { version: updated.version, codes: acked } });
    return publicDraft(updated);
  });
}

export async function confirmDraft(userId: string, id: string, version: number): Promise<OrderDraft> {
  return getStore().transaction((tx) => {
    const d = load(tx, userId, id);
    expectVersion(d, version);
    if (hasBlockingErrors(d.issues)) {
      throw new DraftError(422, 'VALIDATION_BLOCKED', 'Fix the blocking errors before confirming.', publicDraft(d));
    }
    if (d.state !== 'awaiting_confirmation') {
      throw new DraftError(409, 'INVALID_STATE', `A ${d.state.replace('_', ' ')} draft cannot be confirmed.`, publicDraft(d));
    }
    const missing = warningCodes(d.issues).filter((c) => !d.acknowledgedWarnings.includes(c));
    if (missing.length > 0) {
      throw new DraftError(422, 'WARNINGS_UNACKNOWLEDGED', 'Acknowledge every warning before confirming.', publicDraft(d));
    }
    const now = tx.now();
    // Bump the version so an edit sent against the pre-confirm view fails instead of
    // silently undoing a confirmation the trader just saw succeed.
    const nextVersion = d.version + 1;
    const confirmed: StoredDraft = {
      ...d,
      version: nextVersion,
      state: 'confirmed',
      confirmation: { version: nextVersion, contentHash: d.contentHash, confirmedAt: now },
      updatedAt: now,
    };
    tx.putDraft(confirmed);
    tx.audit({
      userId,
      event: 'DRAFT_CONFIRMED',
      draftId: id,
      data: { version: nextVersion, contentHash: d.contentHash, fields: fieldsOf(d), acknowledgedWarnings: d.acknowledgedWarnings },
    });
    return publicDraft(confirmed);
  });
}

export async function cancelDraft(userId: string, id: string, version: number): Promise<OrderDraft> {
  return getStore().transaction((tx) => {
    const d = load(tx, userId, id);
    expectVersion(d, version);
    if (d.state === 'cancelled' || d.handoff.state === 'in_progress') {
      throw new DraftError(409, 'INVALID_STATE', 'This draft cannot be cancelled right now.', publicDraft(d));
    }
    const cancelled: StoredDraft = { ...d, state: 'cancelled', updatedAt: tx.now() };
    tx.putDraft(cancelled);
    tx.audit({
      userId,
      event: 'DRAFT_CANCELLED',
      draftId: id,
      data: { version, handoffState: d.handoff.state },
    });
    return publicDraft(cancelled);
  });
}

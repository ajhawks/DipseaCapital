import type { HandoffAvailability, HandoffStatus, ManualCheckResult, OrderDraft, OrderFields } from '@silexx/shared';
import { canonicalJson } from '../audit/chain.js';
import { DraftError, fieldsOf, publicDraft } from '../drafts/draftService.js';
import { getStore, type StoredDraft, type Tx } from '../store/store.js';
import type { PopulateResult, SilexxAdapter, TicketSnapshot } from './adapter.js';
import { adapterFromEnv } from './httpAdapter.js';

/**
 * Handoff state machine (S1.4) with the R-VERIFY success rules.
 *
 * Transaction 1 records the intent (confirmed → in_progress + idempotency key +
 * HANDOFF_ATTEMPT) and commits. Only then is Silexx called, outside any
 * transaction. Transaction 2 records the classified outcome. If the process dies
 * in between, `sweepInProgress()` on startup marks the draft `uncertain`; nothing
 * is ever re-sent automatically.
 */

let adapterOverride: SilexxAdapter | null | undefined;

/** Tests inject a fake adapter; `null` simulates "not configured". */
export function setAdapter(adapter: SilexxAdapter | null | undefined): void {
  adapterOverride = adapter;
}

function adapter(): SilexxAdapter | undefined {
  return adapterOverride === undefined ? adapterFromEnv() : (adapterOverride ?? undefined);
}

export const idempotencyKeyOf = (d: OrderDraft): string => `${d.id}:${d.version}:${d.contentHash}`;

function availability(tx: Tx): HandoffAvailability {
  if (process.env['HANDOFF_DISABLED'] === 'true') return { enabled: false, reason: 'Silexx handoff is disabled by an administrator.' };
  const k = tx.getKillSwitch();
  if (k.tripped) return { enabled: false, reason: `Silexx handoff is disabled: ${k.reason ?? 'safety stop'}.` };
  if (!adapter()) return { enabled: false, reason: 'Silexx is not configured on this server.' };
  return { enabled: true };
}

export async function getAvailability(): Promise<HandoffAvailability> {
  return getStore().transaction(availability);
}

/** What the trader sees for each state (copy per the R-VERIFY table). */
const MESSAGES: Record<HandoffStatus['state'], string> = {
  none: '',
  in_progress: 'Sending to Silexx…',
  populated_verified: 'Populated in Silexx, fields verified. Not submitted. Review and submit in Silexx.',
  populated_unverified:
    "Silexx accepted the draft, but the app can't verify it. Check the ticket fields in Silexx before submitting.",
  failed_known: 'Silexx did not create the ticket. Your confirmation still stands; you can try again.',
  uncertain: 'Outcome unknown: check Silexx manually before doing anything else with this order.',
  mismatch: 'Ticket in Silexx does not match your confirmed order. Do not submit it; correct or delete it in Silexx.',
  safety_violation:
    'CRITICAL: Silexx shows this ticket as already submitted. Handoff is disabled for everyone until an administrator investigates.',
};

interface Outcome {
  handoff: HandoffStatus;
  readBack?: { status: TicketSnapshot['status']; fieldsMatch: boolean };
  safetyViolation?: boolean;
}

function sameFields(a: OrderFields, b: OrderFields): boolean {
  return canonicalJson(fieldsOf(a)) === canonicalJson(fieldsOf(b));
}

/** Turn what Silexx returned (and what read-back showed) into an R-VERIFY state. */
async function classify(a: SilexxAdapter, confirmed: OrderFields, key: string, result: PopulateResult): Promise<Outcome> {
  const at = new Date().toISOString();
  const status = (state: HandoffStatus['state'], extra: Partial<HandoffStatus> = {}, message = MESSAGES[state]): HandoffStatus => ({
    state,
    idempotencyKey: key,
    message,
    updatedAt: at,
    ...extra,
  });

  if (result.kind === 'rejected') return { handoff: status('failed_known', {}, `${result.reason} ${MESSAGES.failed_known}`) };
  if (result.kind === 'uncertain') return { handoff: status('uncertain', {}, `${result.reason} ${MESSAGES.uncertain}`) };
  if (result.echoedKey !== undefined && result.echoedKey !== key) {
    return { handoff: status('uncertain', {}, `Silexx answered for a different request. ${MESSAGES.uncertain}`) };
  }

  const ticket = { silexxTicketId: result.ticketId };
  if (!(a.capabilities.lookup && a.capabilities.readBack && a.lookup)) {
    return { handoff: status('populated_unverified', ticket) };
  }
  let snap: TicketSnapshot | 'absent';
  try {
    snap = await a.lookup(key);
  } catch {
    return { handoff: status('populated_unverified', ticket, `Read-back failed. ${MESSAGES.populated_unverified}`) };
  }
  if (snap === 'absent') {
    return { handoff: status('uncertain', ticket, `Silexx returned a ticket ID but read-back can't find it. ${MESSAGES.uncertain}`) };
  }
  return verdictFromSnapshot(confirmed, key, snap, at);
}

function verdictFromSnapshot(confirmed: OrderFields, key: string, snap: TicketSnapshot, at: string): Outcome {
  const fieldsMatch = sameFields(snap.fields, confirmed);
  const base = { idempotencyKey: key, silexxTicketId: snap.ticketId, updatedAt: at };
  const readBack = { status: snap.status, fieldsMatch };
  if (snap.status !== 'draft') {
    return { handoff: { ...base, state: 'safety_violation', message: MESSAGES.safety_violation }, readBack, safetyViolation: true };
  }
  if (!fieldsMatch) return { handoff: { ...base, state: 'mismatch', message: MESSAGES.mismatch }, readBack };
  return { handoff: { ...base, state: 'populated_verified', verifiedBy: 'read_back', message: MESSAGES.populated_verified }, readBack };
}

function recordOutcome(tx: Tx, userId: string, d: StoredDraft, outcome: Outcome, event: 'HANDOFF_OUTCOME' | 'HANDOFF_RECONCILED'): StoredDraft {
  const updated: StoredDraft = { ...d, handoff: outcome.handoff, updatedAt: tx.now() };
  tx.putDraft(updated);
  tx.audit({
    userId,
    event,
    draftId: d.id,
    data: { version: d.version, state: outcome.handoff.state, idempotencyKey: outcome.handoff.idempotencyKey, silexxTicketId: outcome.handoff.silexxTicketId, message: outcome.handoff.message },
  });
  if (outcome.readBack) {
    tx.audit({ userId, event: 'HANDOFF_READ_BACK', draftId: d.id, data: outcome.readBack });
  }
  if (outcome.safetyViolation) {
    const reason = `ticket ${outcome.handoff.silexxTicketId ?? '?'} for draft ${d.id} was not an unsubmitted draft`;
    tx.audit({ userId, event: 'SAFETY_VIOLATION', draftId: d.id, data: { reason } });
    tx.setKillSwitch({ tripped: true, reason, at: tx.now() });
    tx.audit({ userId: 'system', event: 'KILL_SWITCH_TRIPPED', data: { reason } });
  }
  return updated;
}

export async function startHandoff(userId: string, id: string, version: number): Promise<OrderDraft> {
  const store = getStore();

  // Transaction 1: durable intent before any external call (R-ATOMIC 4).
  const { draft, key, silexx } = await store.transaction((tx) => {
    const d = tx.getDraft(id);
    if (!d || d.userId !== userId) throw new DraftError(404, 'NOT_FOUND', 'Draft not found.');
    if (d.version !== version) throw new DraftError(409, 'STALE_VERSION', 'This draft changed since you last saw it.', publicDraft(d));
    const avail = availability(tx);
    const a = adapter();
    if (!avail.enabled || !a) throw new DraftError(503, 'HANDOFF_DISABLED', avail.reason ?? 'Handoff unavailable.', publicDraft(d));
    const c = d.confirmation;
    if (d.state !== 'confirmed' || !c || c.version !== d.version || c.contentHash !== d.contentHash) {
      throw new DraftError(409, 'INVALID_STATE', 'Confirm this exact version before sending it to Silexx.', publicDraft(d));
    }
    if (d.handoff.state !== 'none' && d.handoff.state !== 'failed_known') {
      throw new DraftError(409, 'INVALID_STATE', 'This draft has already been handed off or needs reconciliation.', publicDraft(d));
    }
    const k = idempotencyKeyOf(d);
    const inProgress: StoredDraft = {
      ...d,
      handoff: { state: 'in_progress', idempotencyKey: k, message: MESSAGES.in_progress, updatedAt: tx.now() },
      updatedAt: tx.now(),
    };
    tx.putDraft(inProgress);
    tx.audit({ userId, event: 'HANDOFF_ATTEMPT', draftId: id, data: { version, idempotencyKey: k, fields: fieldsOf(d), retryAfterKnownFailure: d.handoff.state === 'failed_known' } });
    return { draft: inProgress, key: k, silexx: a };
  });

  // The external call: outside any transaction (R-ATOMIC 3).
  let result: PopulateResult;
  try {
    result = await silexx.populate(fieldsOf(draft), key);
  } catch (err) {
    result = { kind: 'uncertain', reason: err instanceof Error ? err.message : 'Unexpected adapter error.' };
  }
  const outcome = await classify(silexx, fieldsOf(draft), key, result);

  // Transaction 2: record the outcome. If the sweep already moved it, keep its verdict and just audit.
  return store.transaction((tx) => {
    const d = tx.getDraft(id) as StoredDraft;
    if (d.handoff.state !== 'in_progress' || d.handoff.idempotencyKey !== key) {
      tx.audit({ userId, event: 'HANDOFF_OUTCOME', draftId: id, data: { lateOutcome: outcome.handoff.state, keptState: d.handoff.state } });
      return publicDraft(d);
    }
    return publicDraft(recordOutcome(tx, userId, d, outcome, 'HANDOFF_OUTCOME'));
  });
}

/**
 * Resolve an `uncertain` or `populated_unverified` handoff, either from the
 * trader's own check in Silexx or by looking the ticket up when supported.
 * "absent" sends the draft back for re-confirmation; it never re-sends by itself.
 */
export async function reconcile(userId: string, id: string, manualResult?: ManualCheckResult): Promise<OrderDraft> {
  const store = getStore();
  const d0 = await store.transaction((tx) => {
    const d = tx.getDraft(id);
    if (!d || d.userId !== userId) throw new DraftError(404, 'NOT_FOUND', 'Draft not found.');
    if (d.handoff.state !== 'uncertain' && d.handoff.state !== 'populated_unverified') {
      throw new DraftError(409, 'INVALID_STATE', 'Nothing to reconcile for this draft.', publicDraft(d));
    }
    return d;
  });
  const key = d0.handoff.idempotencyKey as string;

  let outcome: Outcome | 'absent';
  if (manualResult === 'present_correct') {
    outcome = { handoff: { ...d0.handoff, state: 'populated_verified', verifiedBy: 'trader', message: 'You checked the ticket in Silexx and marked it correct. Not submitted.', updatedAt: new Date().toISOString() } };
  } else if (manualResult === 'wrong') {
    outcome = { handoff: { ...d0.handoff, state: 'mismatch', message: MESSAGES.mismatch, updatedAt: new Date().toISOString() } };
  } else if (manualResult === 'absent') {
    outcome = 'absent';
  } else {
    const a = adapter();
    if (!a?.lookup || !a.capabilities.lookup) {
      throw new DraftError(409, 'INVALID_STATE', 'Silexx lookup is not available. Check Silexx manually and record what you found.', publicDraft(d0));
    }
    let snap: TicketSnapshot | 'absent';
    try {
      snap = await a.lookup(key);
    } catch {
      throw new DraftError(503, 'HANDOFF_DISABLED', 'Silexx lookup failed. The outcome is still unknown; check Silexx manually.', publicDraft(d0));
    }
    outcome = snap === 'absent'
      ? 'absent'
      : a.capabilities.readBack
        ? verdictFromSnapshot(fieldsOf(d0), key, snap, new Date().toISOString())
        : { handoff: { ...d0.handoff, state: 'populated_unverified', silexxTicketId: snap.ticketId, message: MESSAGES.populated_unverified, updatedAt: new Date().toISOString() } };
  }

  return store.transaction((tx) => {
    const d = tx.getDraft(id) as StoredDraft;
    if (d.handoff.idempotencyKey !== key || (d.handoff.state !== 'uncertain' && d.handoff.state !== 'populated_unverified')) {
      throw new DraftError(409, 'INVALID_STATE', 'This draft changed while reconciling.', publicDraft(d));
    }
    if (outcome === 'absent') {
      // The ticket isn't there. The uncertain attempt voids the confirmation: review again.
      const { confirmation: _c, ...rest } = d;
      const reset: StoredDraft = { ...rest, state: 'awaiting_confirmation', acknowledgedWarnings: [], handoff: { state: 'none' }, updatedAt: tx.now() };
      tx.putDraft(reset);
      tx.audit({ userId, event: 'HANDOFF_RECONCILED', draftId: id, data: { result: 'absent', source: manualResult ? 'trader' : 'lookup', idempotencyKey: key } });
      return publicDraft(reset);
    }
    return publicDraft(recordOutcome(tx, userId, d, outcome, 'HANDOFF_RECONCILED'));
  });
}

/** On startup: anything left mid-handoff by a crash becomes `uncertain`. Never re-sent. */
export async function sweepInProgress(): Promise<number> {
  return getStore().transaction((tx) => {
    const stuck = tx.listDrafts((d) => d.handoff.state === 'in_progress');
    for (const d of stuck) {
      tx.putDraft({ ...d, handoff: { ...d.handoff, state: 'uncertain', message: `The server restarted during handoff. ${MESSAGES.uncertain}`, updatedAt: tx.now() } });
      tx.audit({ userId: 'system', event: 'HANDOFF_SWEPT_UNCERTAIN', draftId: d.id, data: { idempotencyKey: d.handoff.idempotencyKey } });
    }
    return stuck.length;
  });
}

export async function resetKillSwitch(adminId: string, note: string): Promise<void> {
  await getStore().transaction((tx) => {
    tx.setKillSwitch({ tripped: false });
    tx.audit({ userId: adminId, event: 'KILL_SWITCH_RESET', data: { note } });
  });
}

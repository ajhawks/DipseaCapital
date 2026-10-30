import type { OrderDraft, OrderFields } from '@silexx/shared';
import { buildRow, verifyChain, type AuditRow } from '../src/services/audit/chain.js';
import {
  acknowledgeWarnings,
  cancelDraft,
  confirmDraft,
  createDrafts,
  DraftError,
  editDraft,
  getDraft,
} from '../src/services/drafts/draftService.js';
import type { PopulateResult, SilexxAdapter, TicketSnapshot } from '../src/services/handoff/adapter.js';
import {
  getAvailability,
  reconcile,
  resetKillSwitch,
  setAdapter,
  startHandoff,
  sweepInProgress,
} from '../src/services/handoff/handoffService.js';
import { setStore, Store } from '../src/services/store/store.js';
import { validateOrder } from '../src/services/validation/validate.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const LIMIT_ORDER: OrderFields = { side: 'BUY', quantity: 100, symbol: 'AAPL', orderType: 'LIMIT', limitPrice: 195.5, assetClass: 'EQUITY' };

let store: Store;

beforeEach(() => {
  store = new Store();
  setStore(store);
  setAdapter(null);
  delete process.env['SANITY_MAX_QUANTITY'];
  delete process.env['SANITY_MAX_NOTIONAL'];
  delete process.env['HANDOFF_DISABLED'];
});

async function newDraft(userId = 'alice', fields: OrderFields = LIMIT_ORDER): Promise<OrderDraft> {
  const [d] = await createDrafts(userId, [{ fields, rawSymbol: fields.symbol, transcript: 'buy 100 AAPL at 195.50' }]);
  return d as OrderDraft;
}

async function confirmed(userId = 'alice', fields: OrderFields = LIMIT_ORDER): Promise<OrderDraft> {
  const d = await newDraft(userId, fields);
  return confirmDraft(userId, d.id, d.version);
}

async function expectDraftError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(DraftError);
  await expect(p).rejects.toMatchObject({ code });
}

/** A scripted Silexx: `populate` returns `result`; lookup returns `snapshot` (or absent). */
function fakeAdapter(
  result: PopulateResult,
  opts: { lookup?: boolean; snapshot?: (fields: OrderFields) => TicketSnapshot | 'absent' } = {},
): SilexxAdapter & { calls: number } {
  const a = {
    calls: 0,
    capabilities: { idempotency: true, lookup: opts.lookup ?? true, readBack: opts.lookup ?? true },
    populate: async (fields: OrderFields, key: string): Promise<PopulateResult> => {
      a.calls += 1;
      lastFields = fields;
      return result.kind === 'accepted' && result.echoedKey === undefined ? { ...result, echoedKey: key } : result;
    },
    lookup: async (): Promise<TicketSnapshot | 'absent'> =>
      opts.snapshot ? opts.snapshot(lastFields) : { ticketId: 'T-1', fields: lastFields, status: 'draft' },
  };
  let lastFields: OrderFields = LIMIT_ORDER;
  return a;
}

const ACCEPTED: PopulateResult = { kind: 'accepted', ticketId: 'T-1' };

// ── audit chain (S1.5) ────────────────────────────────────────────────────────

describe('audit chain', () => {
  function chain(n: number): AuditRow[] {
    const rows: AuditRow[] = [];
    for (let i = 0; i < n; i++) rows.push(buildRow(rows[i - 1], { userId: 'u', event: 'DRAFT_CREATED', data: { i } }, `t${i}`));
    return rows;
  }

  it('verifies an intact chain', () => {
    expect(verifyChain(chain(5))).toEqual({ ok: true, rows: 5 });
  });

  it('detects an edited row', () => {
    const rows = chain(5);
    (rows[2] as AuditRow).data = { i: 99 };
    expect(verifyChain(rows)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it('detects a deleted row', () => {
    const rows = chain(5);
    rows.splice(1, 1);
    expect(verifyChain(rows).ok).toBe(false);
  });

  it('detects reordered rows', () => {
    const rows = chain(5);
    [rows[1], rows[2]] = [rows[2] as AuditRow, rows[1] as AuditRow];
    expect(verifyChain(rows).ok).toBe(false);
  });

  it('stays valid under concurrent appends (R-ATOMIC 7)', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => newDraft(`user-${i}`)));
    expect(verifyChain(store.auditRows())).toMatchObject({ ok: true });
    expect(store.auditRows().length).toBeGreaterThanOrEqual(20);
  });
});

// ── validation (S1.3) ─────────────────────────────────────────────────────────

describe('validation', () => {
  const codes = (f: OrderFields, cfg = {}) => validateOrder(f, cfg).map((i) => `${i.severity}:${i.code}`);

  it('accepts a complete limit order', () => {
    expect(codes(LIMIT_ORDER)).toEqual([]);
  });

  it('blocks a stop-limit without both prices', () => {
    expect(codes({ ...LIMIT_ORDER, orderType: 'STOP_LIMIT' })).toContain('error:STOP_PRICE_REQUIRED');
    expect(codes({ ...LIMIT_ORDER, orderType: 'STOP_LIMIT', stopPrice: 190, limitPrice: undefined } as unknown as OrderFields)).toContain(
      'error:LIMIT_PRICE_REQUIRED',
    );
    expect(codes({ ...LIMIT_ORDER, orderType: 'STOP_LIMIT', stopPrice: 190 })).toEqual([]);
  });

  it('blocks options in Core', () => {
    expect(codes({ ...LIMIT_ORDER, assetClass: 'OPTION' })).toEqual(['error:OPTIONS_UNSUPPORTED']);
  });

  it('blocks a fractional or zero quantity and a bad ticker', () => {
    expect(codes({ ...LIMIT_ORDER, quantity: 0 })).toContain('error:QUANTITY_INVALID');
    expect(codes({ ...LIMIT_ORDER, quantity: 1.5 })).toContain('error:QUANTITY_INVALID');
    expect(codes({ ...LIMIT_ORDER, symbol: 'Apple Inc' })).toContain('error:SYMBOL_INVALID');
  });

  it('produces nothing for unconfigured sanity checks', () => {
    expect(codes({ ...LIMIT_ORDER, quantity: 10_000_000 })).toEqual([]);
  });

  it('warns (never blocks) for configured sanity checks, and discloses an unchecked notional', () => {
    expect(codes({ ...LIMIT_ORDER, quantity: 5000 }, { maxQuantity: 1000 })).toEqual(['warning:QUANTITY_ABOVE_MAX']);
    expect(codes(LIMIT_ORDER, { maxNotional: 1000 })).toEqual(['warning:NOTIONAL_ABOVE_MAX']);
    expect(codes({ ...LIMIT_ORDER, orderType: 'MARKET', limitPrice: undefined } as unknown as OrderFields, { maxNotional: 1000 })).toEqual([
      'warning:NOTIONAL_UNCHECKED',
    ]);
  });
});

// ── draft lifecycle (S1.2, S1.6) ──────────────────────────────────────────────

describe('draft lifecycle', () => {
  it('only drafts the server created can be confirmed or handed off', async () => {
    setAdapter(fakeAdapter(ACCEPTED));
    await expectDraftError(confirmDraft('alice', 'made-up-id', 1), 'NOT_FOUND');
    await expectDraftError(startHandoff('alice', 'made-up-id', 1), 'NOT_FOUND');
  });

  it("scopes drafts to their owner: user B gets 404 on user A's draft", async () => {
    const d = await newDraft('alice');
    await expectDraftError(getDraft('bob', d.id), 'NOT_FOUND');
    await expectDraftError(confirmDraft('bob', d.id, d.version), 'NOT_FOUND');
    await expectDraftError(editDraft('bob', d.id, d.version, { quantity: 1 }), 'NOT_FOUND');
  });

  it('confirm requires the current version', async () => {
    const d = await newDraft();
    await expectDraftError(confirmDraft('alice', d.id, d.version + 1), 'STALE_VERSION');
  });

  it('an edit after confirm clears the confirmation and needs a re-confirm', async () => {
    const c = await confirmed();
    expect(c.state).toBe('confirmed');
    const e = await editDraft('alice', c.id, c.version, { quantity: 200 });
    expect(e).toMatchObject({ state: 'awaiting_confirmation', version: c.version + 1, quantity: 200 });
    expect(e.confirmation).toBeUndefined();
    setAdapter(fakeAdapter(ACCEPTED));
    await expectDraftError(startHandoff('alice', e.id, e.version), 'INVALID_STATE');
  });

  it('an edit that introduces a blocking error moves the draft back to draft', async () => {
    const d = await newDraft();
    const e = await editDraft('alice', d.id, d.version, { orderType: 'STOP_LIMIT' });
    expect(e.state).toBe('draft');
    await expectDraftError(confirmDraft('alice', e.id, e.version), 'VALIDATION_BLOCKED');
  });

  it('a failed audit insert leaves the draft unchanged (fail closed)', async () => {
    const d = await newDraft();
    const auditBefore = store.auditRows().length;
    store.failNextAudit = true;
    await expect(confirmDraft('alice', d.id, d.version)).rejects.toThrow('audit append failed');
    const after = await getDraft('alice', d.id);
    expect(after).toEqual(d);
    expect(store.auditRows().length).toBe(auditBefore);
  });

  it('concurrent confirm + edit: exactly one wins', async () => {
    const d = await newDraft();
    const results = await Promise.allSettled([
      confirmDraft('alice', d.id, d.version),
      editDraft('alice', d.id, d.version, { quantity: 300 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'STALE_VERSION' });
  });

  it('warnings must be acknowledged at the current version before confirm', async () => {
    process.env['SANITY_MAX_QUANTITY'] = '50';
    const d = await newDraft();
    expect(d.issues.map((i) => i.code)).toEqual(['QUANTITY_ABOVE_MAX']);
    await expectDraftError(confirmDraft('alice', d.id, d.version), 'WARNINGS_UNACKNOWLEDGED');
    const acked = await acknowledgeWarnings('alice', d.id, d.version, ['QUANTITY_ABOVE_MAX']);
    expect((await confirmDraft('alice', acked.id, acked.version)).state).toBe('confirmed');
  });

  it('flags a repeated order as a possible duplicate needing acknowledgement; nothing is dropped', async () => {
    const first = await newDraft();
    const second = await newDraft();
    expect(first.issues).toEqual([]);
    expect(second.issues.map((i) => i.code)).toEqual(['POSSIBLE_DUPLICATE']);
    await expectDraftError(confirmDraft('alice', second.id, second.version), 'WARNINGS_UNACKNOWLEDGED');
    // Another user's identical order is not a duplicate of yours.
    expect((await newDraft('bob')).issues).toEqual([]);
  });

  it('cancelled drafts cannot be confirmed', async () => {
    const d = await newDraft();
    const c = await cancelDraft('alice', d.id, d.version);
    await expectDraftError(confirmDraft('alice', c.id, c.version), 'INVALID_STATE');
  });
});

// ── handoff state machine (S1.4, R-VERIFY) ────────────────────────────────────

describe('handoff', () => {
  it('requires a confirmed draft', async () => {
    setAdapter(fakeAdapter(ACCEPTED));
    const d = await newDraft();
    await expectDraftError(startHandoff('alice', d.id, d.version), 'INVALID_STATE');
  });

  it('accepted + matching read-back → populated_verified', async () => {
    setAdapter(fakeAdapter(ACCEPTED));
    const c = await confirmed();
    const h = await startHandoff('alice', c.id, c.version);
    expect(h.handoff).toMatchObject({ state: 'populated_verified', verifiedBy: 'read_back', silexxTicketId: 'T-1' });
    expect(h.handoff.idempotencyKey).toBe(`${c.id}:${c.version}:${c.contentHash}`);
  });

  it('accepted without lookup → populated_unverified, never verified', async () => {
    setAdapter(fakeAdapter(ACCEPTED, { lookup: false }));
    const c = await confirmed();
    expect((await startHandoff('alice', c.id, c.version)).handoff.state).toBe('populated_unverified');
  });

  it('echoed idempotency key that differs → uncertain', async () => {
    setAdapter(fakeAdapter({ kind: 'accepted', ticketId: 'T-1', echoedKey: 'someone-else' }));
    const c = await confirmed();
    expect((await startHandoff('alice', c.id, c.version)).handoff.state).toBe('uncertain');
  });

  it('read-back fields differ → mismatch', async () => {
    setAdapter(fakeAdapter(ACCEPTED, { snapshot: (f) => ({ ticketId: 'T-1', fields: { ...f, quantity: 999 }, status: 'draft' }) }));
    const c = await confirmed();
    expect((await startHandoff('alice', c.id, c.version)).handoff.state).toBe('mismatch');
  });

  it('read-back shows submitted → safety_violation and the kill switch trips for everyone', async () => {
    setAdapter(fakeAdapter(ACCEPTED, { snapshot: (f) => ({ ticketId: 'T-1', fields: f, status: 'submitted' }) }));
    const c = await confirmed();
    expect((await startHandoff('alice', c.id, c.version)).handoff.state).toBe('safety_violation');
    expect(await getAvailability()).toMatchObject({ enabled: false });
    const other = await confirmed('bob', { ...LIMIT_ORDER, symbol: 'MSFT' });
    await expectDraftError(startHandoff('bob', other.id, other.version), 'HANDOFF_DISABLED');
    // Drafts can still be created and reviewed while it's tripped.
    expect((await newDraft('carol')).state).toBe('awaiting_confirmation');
    const events = store.auditRows().map((r) => r.event);
    expect(events).toContain('SAFETY_VIOLATION');
    expect(events).toContain('KILL_SWITCH_TRIPPED');
    await resetKillSwitch('admin', 'investigated');
    expect((await getAvailability()).enabled).toBe(true);
  });

  it('known failure keeps the confirmation and allows another attempt', async () => {
    const a = fakeAdapter({ kind: 'rejected', reason: 'bad' });
    setAdapter(a);
    const c = await confirmed();
    const failed = await startHandoff('alice', c.id, c.version);
    expect(failed).toMatchObject({ state: 'confirmed', handoff: { state: 'failed_known' } });
    setAdapter(fakeAdapter(ACCEPTED));
    expect((await startHandoff('alice', c.id, c.version)).handoff.state).toBe('populated_verified');
  });

  it('uncertain outcome blocks another handoff: no blind retry', async () => {
    const a = fakeAdapter({ kind: 'uncertain', reason: 'timeout' });
    setAdapter(a);
    const c = await confirmed();
    expect((await startHandoff('alice', c.id, c.version)).handoff.state).toBe('uncertain');
    await expectDraftError(startHandoff('alice', c.id, c.version), 'INVALID_STATE');
    await expectDraftError(editDraft('alice', c.id, c.version, { quantity: 1 }), 'INVALID_STATE');
    expect(a.calls).toBe(1);
  });

  it('an adapter that throws is treated as uncertain, not as failure', async () => {
    setAdapter({ capabilities: { idempotency: false, lookup: false, readBack: false }, populate: async () => { throw new Error('boom'); } });
    const c = await confirmed();
    expect((await startHandoff('alice', c.id, c.version)).handoff.state).toBe('uncertain');
  });

  it('reconcile: lookup absent → back to awaiting confirmation (the uncertain attempt voids the confirmation)', async () => {
    setAdapter(fakeAdapter({ kind: 'uncertain', reason: 'timeout' }, { snapshot: () => 'absent' }));
    const c = await confirmed();
    await startHandoff('alice', c.id, c.version);
    const r = await reconcile('alice', c.id);
    expect(r).toMatchObject({ state: 'awaiting_confirmation', handoff: { state: 'none' } });
    expect(r.confirmation).toBeUndefined();
  });

  it('reconcile: lookup present and matching → verified', async () => {
    setAdapter(fakeAdapter({ kind: 'uncertain', reason: 'timeout' }));
    const c = await confirmed();
    await startHandoff('alice', c.id, c.version);
    expect((await reconcile('alice', c.id)).handoff.state).toBe('populated_verified');
  });

  it('reconcile manually when there is no lookup', async () => {
    setAdapter(fakeAdapter({ kind: 'uncertain', reason: 'timeout' }, { lookup: false }));
    const c = await confirmed();
    await startHandoff('alice', c.id, c.version);
    await expectDraftError(reconcile('alice', c.id), 'INVALID_STATE');
    const r = await reconcile('alice', c.id, 'present_correct');
    expect(r.handoff).toMatchObject({ state: 'populated_verified', verifiedBy: 'trader' });
  });

  it('crash after transaction 1 → uncertain on restart, and no second Silexx call', async () => {
    let release: () => void = () => undefined;
    const a = fakeAdapter(ACCEPTED);
    a.populate = async () => {
      a.calls += 1;
      await new Promise<void>((r) => (release = r));
      return { kind: 'accepted', ticketId: 'late' };
    };
    setAdapter(a);
    const c = await confirmed();
    const pending = startHandoff('alice', c.id, c.version);
    await new Promise((r) => setTimeout(r, 10)); // transaction 1 committed, Silexx call in flight

    // "Restart": the startup sweep runs over the committed state.
    expect(await sweepInProgress()).toBe(1);
    expect((await getDraft('alice', c.id)).handoff.state).toBe('uncertain');

    release();
    expect((await pending).handoff.state).toBe('uncertain'); // the late answer doesn't overwrite the sweep
    expect(a.calls).toBe(1);
  });

  it('double handoff click: exactly one call reaches Silexx', async () => {
    const a = fakeAdapter(ACCEPTED);
    setAdapter(a);
    const c = await confirmed();
    const results = await Promise.allSettled([startHandoff('alice', c.id, c.version), startHandoff('alice', c.id, c.version)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(a.calls).toBe(1);
  });

  it('is unavailable when Silexx is not configured or disabled by env', async () => {
    const c = await confirmed();
    await expectDraftError(startHandoff('alice', c.id, c.version), 'HANDOFF_DISABLED');
    setAdapter(fakeAdapter(ACCEPTED));
    process.env['HANDOFF_DISABLED'] = 'true';
    await expectDraftError(startHandoff('alice', c.id, c.version), 'HANDOFF_DISABLED');
  });

  it('every transition leaves a verifiable audit chain', async () => {
    setAdapter(fakeAdapter(ACCEPTED));
    const c = await confirmed();
    await startHandoff('alice', c.id, c.version);
    const events = store.auditRows().map((r) => r.event);
    expect(events).toEqual(['DRAFT_CREATED', 'DRAFT_CONFIRMED', 'HANDOFF_ATTEMPT', 'HANDOFF_OUTCOME', 'HANDOFF_READ_BACK']);
    expect(verifyChain(store.auditRows()).ok).toBe(true);
    expect(JSON.stringify(store.auditRows())).not.toContain('buy 100 AAPL'); // no transcript text (D6)
  });
});

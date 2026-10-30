import { useState } from 'react';
import type {
  EditableFields,
  HandoffAvailability,
  ManualCheckResult,
  OrderDraft,
  OrderSide,
  OrderType,
  TimeInForce,
} from '@silexx/shared';
import { WarningIcon } from './icons.tsx';

// ── helpers ───────────────────────────────────────────────────────────────────

const money = (n: number | undefined) => (n !== undefined ? `$${n.toFixed(2)}` : '—');

const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  MARKET: 'Market',
  LIMIT: 'Limit',
  STOP: 'Stop (market)',
  STOP_LIMIT: 'Stop-limit',
};

/** Plain-English restatement: the on-screen readback of exactly what will be handed off. */
export function orderSentence(d: OrderDraft): string {
  const action = d.side === 'BUY' ? 'buy' : 'sell';
  const unit = d.quantity === 1 ? 'share' : 'shares';
  const price =
    d.orderType === 'MARKET'
      ? 'at the market'
      : d.orderType === 'LIMIT'
        ? `with a limit of ${money(d.limitPrice)}`
        : d.orderType === 'STOP'
          ? `with a stop of ${money(d.stopPrice)} (stop-market)`
          : `with a stop of ${money(d.stopPrice)} and a limit of ${money(d.limitPrice)}`;
  const tif = d.timeInForce ? `, ${d.timeInForce}` : '';
  return `Draft order to ${action} ${d.quantity.toLocaleString()} ${unit} of ${d.symbol} ${price}${tif}.`;
}

type Tone = 'red' | 'amber' | 'blue' | 'green' | 'slate';

function badgeFor(d: OrderDraft, availability: HandoffAvailability | null): { label: string; tone: Tone } {
  switch (d.handoff.state) {
    case 'in_progress':
      return { label: 'Handoff in progress', tone: 'blue' };
    case 'populated_verified':
      return { label: 'Populated, verified', tone: 'green' };
    case 'populated_unverified':
      return { label: 'Populated, unverified: check Silexx', tone: 'amber' };
    case 'failed_known':
      return { label: 'Handoff failed', tone: 'red' };
    case 'uncertain':
      return { label: 'Outcome uncertain: check Silexx', tone: 'amber' };
    case 'mismatch':
      return { label: 'Mismatch: do not submit', tone: 'red' };
    case 'safety_violation':
      return { label: 'Safety stop', tone: 'red' };
    case 'none':
      break;
  }
  if (d.state === 'draft') return { label: 'Fix required', tone: 'red' };
  if (d.state === 'awaiting_confirmation') return { label: 'Awaiting confirmation', tone: 'amber' };
  if (d.state === 'confirmed' && availability?.enabled === false) return { label: 'Confirmed · handoff disabled', tone: 'slate' };
  return { label: 'Confirmed', tone: 'blue' };
}

const TONE: Record<Tone, string> = {
  red: 'bg-red-50 text-red-800 ring-red-600/25',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  blue: 'bg-blue-50 text-blue-800 ring-blue-600/25',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-600/25',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/25',
};

const BUTTON =
  'rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY = `${BUTTON} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`;
const SECONDARY = `${BUTTON} bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus:ring-slate-400`;
const INPUT =
  'mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

const EDITABLE_HANDOFF = new Set(['none', 'failed_known']);

// ── edit form ─────────────────────────────────────────────────────────────────

function EditForm({ draft, onSave, onClose }: { draft: OrderDraft; onSave: (c: EditableFields) => void; onClose: () => void }) {
  const [side, setSide] = useState<OrderSide>(draft.side);
  const [quantity, setQuantity] = useState(String(draft.quantity));
  const [symbol, setSymbol] = useState(draft.symbol);
  const [orderType, setOrderType] = useState<OrderType>(draft.orderType);
  const [limit, setLimit] = useState(draft.limitPrice?.toString() ?? '');
  const [stop, setStop] = useState(draft.stopPrice?.toString() ?? '');
  const [tif, setTif] = useState<string>(draft.timeInForce ?? '');
  const [account, setAccount] = useState(draft.account ?? '');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Only send what changed. An emptied field is sent as null, which the server clears.
    const changes: Record<string, unknown> = {};
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    if (side !== draft.side) changes['side'] = side;
    if (Number(quantity) !== draft.quantity) changes['quantity'] = Number(quantity);
    if (symbol.trim().toUpperCase() !== draft.symbol) changes['symbol'] = symbol;
    if (orderType !== draft.orderType) changes['orderType'] = orderType;
    if (num(limit) !== (draft.limitPrice ?? null)) changes['limitPrice'] = num(limit);
    if (num(stop) !== (draft.stopPrice ?? null)) changes['stopPrice'] = num(stop);
    if ((tif || null) !== (draft.timeInForce ?? null)) changes['timeInForce'] = tif || null;
    if ((account.trim() || null) !== (draft.account ?? null)) changes['account'] = account.trim() || null;
    if (Object.keys(changes).length === 0) return onClose();
    onSave(changes as EditableFields);
  }

  const field = (label: string, control: React.ReactNode) => (
    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
      {label}
      {control}
    </label>
  );

  return (
    <form onSubmit={submit} aria-label="Edit draft" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {field('Side', <select className={INPUT} value={side} onChange={(e) => setSide(e.target.value as OrderSide)}><option>BUY</option><option>SELL</option></select>)}
      {field('Quantity', <input className={INPUT} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />)}
      {field('Symbol', <input className={INPUT} value={symbol} onChange={(e) => setSymbol(e.target.value)} />)}
      {field(
        'Order type',
        <select className={INPUT} value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>
          {(Object.keys(ORDER_TYPE_LABEL) as OrderType[]).map((t) => (
            <option key={t} value={t}>{ORDER_TYPE_LABEL[t]}</option>
          ))}
        </select>,
      )}
      {field('Limit price', <input className={INPUT} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />)}
      {field('Stop price', <input className={INPUT} inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />)}
      {field(
        'Time in force',
        <select className={INPUT} value={tif} onChange={(e) => setTif(e.target.value as TimeInForce | '')}>
          <option value="">Not set</option>
          <option>DAY</option><option>GTC</option><option>IOC</option><option>FOK</option>
        </select>,
      )}
      {field('Account', <input className={INPUT} value={account} onChange={(e) => setAccount(e.target.value)} />)}
      <div className="col-span-full flex gap-2">
        <button type="submit" className={PRIMARY}>Save changes</button>
        <button type="button" className={SECONDARY} onClick={onClose}>Discard</button>
      </div>
    </form>
  );
}

// ── card ──────────────────────────────────────────────────────────────────────

export interface DraftCardProps {
  draft: OrderDraft;
  busy: boolean;
  error: string | undefined;
  availability: HandoffAvailability | null;
  onEdit: (changes: EditableFields) => void;
  onAcknowledge: (codes: string[]) => void;
  onConfirm: () => void;
  onHandOff: () => void;
  onCancel: () => void;
  onReconcile: (result?: ManualCheckResult) => void;
}

export default function DraftCard(p: DraftCardProps) {
  const { draft: d } = p;
  const [editing, setEditing] = useState(false);
  const badge = badgeFor(d, p.availability);
  const errors = d.issues.filter((i) => i.severity === 'error');
  const warnings = d.issues.filter((i) => i.severity === 'warning');
  const unacked = warnings.filter((w) => !d.acknowledgedWarnings.includes(w.code));
  const canEdit = d.state !== 'cancelled' && EDITABLE_HANDOFF.has(d.handoff.state);
  const canConfirm = d.state === 'awaiting_confirmation' && errors.length === 0 && unacked.length === 0;
  const h = d.handoff.state;
  const titleId = `draft-${d.id}-title`;

  return (
    <article
      aria-labelledby={titleId}
      data-testid="draft-card"
      className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-900/5 animate-fade-up motion-reduce:animate-none"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h3 id={titleId} className="text-base font-semibold text-slate-900">
          {orderSentence(d)}
        </h3>
        <span data-testid="draft-badge" className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset ${TONE[badge.tone]}`}>
          {badge.label}
        </span>
      </header>

      <p className="mt-1 text-xs font-medium text-amber-700">
        Draft only. Nothing is submitted or executed by this app; you submit in Silexx.
      </p>

      {/* Status changes are announced to screen readers. */}
      <div aria-live="polite" className="mt-3 space-y-2">
        {d.handoff.message && (
          <p
            role={h === 'mismatch' || h === 'safety_violation' ? 'alert' : undefined}
            className={[
              'rounded-lg px-3 py-2 text-sm',
              h === 'populated_verified' ? 'bg-emerald-50 text-emerald-800' : h === 'mismatch' || h === 'safety_violation' || h === 'failed_known' ? 'bg-red-50 text-red-800 font-semibold' : 'bg-amber-50 text-amber-900',
            ].join(' ')}
          >
            {d.handoff.message}
            {d.handoff.silexxTicketId && <span className="ml-1 font-mono text-xs">(ticket {d.handoff.silexxTicketId})</span>}
          </p>
        )}
        {d.state === 'confirmed' && h === 'none' && p.availability?.enabled === false && (
          <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{p.availability.reason}</p>
        )}
        {p.error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
            {p.error}
          </p>
        )}
      </div>

      {!editing && (
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {[
            ['Side', d.side],
            ['Quantity', d.quantity.toLocaleString()],
            ['Symbol', d.symbol],
            ['Type', ORDER_TYPE_LABEL[d.orderType]],
            ...(d.limitPrice !== undefined ? [['Limit', money(d.limitPrice)]] : []),
            ...(d.stopPrice !== undefined ? [['Stop', money(d.stopPrice)]] : []),
            ['Time in force', d.timeInForce ?? 'Not set'],
            ['Account', d.account ?? 'Not set'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{k}</dt>
              <dd className="font-bold tabular-nums text-slate-900">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {editing && (
        <div className="mt-4">
          <EditForm
            draft={d}
            onClose={() => setEditing(false)}
            onSave={(c) => {
              setEditing(false);
              p.onEdit(c);
            }}
          />
        </div>
      )}

      {errors.length > 0 && (
        <ul aria-label="Blocking errors" className="mt-4 space-y-1">
          {errors.map((e) => (
            <li key={e.code + (e.field ?? '')} className="flex gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              <span className="font-bold">Blocked:</span> {e.message}
            </li>
          ))}
        </ul>
      )}

      {warnings.length > 0 && d.state !== 'confirmed' && (
        <fieldset className="mt-4 space-y-1">
          <legend className="text-xs font-semibold uppercase tracking-wide text-amber-800">Warnings: acknowledge each to continue</legend>
          {warnings.map((w) => {
            const acked = d.acknowledgedWarnings.includes(w.code);
            return (
              <label key={w.code} className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={acked}
                  disabled={acked || p.busy || d.state !== 'awaiting_confirmation'}
                  onChange={() => p.onAcknowledge([w.code])}
                />
                <WarningIcon className="h-4 w-4 shrink-0 text-amber-600" />
                <span>{w.message}</span>
              </label>
            );
          })}
        </fieldset>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {/* In the tab order, never auto-focused, and never triggered by Enter in a text field. */}
        {(d.state === 'awaiting_confirmation' || d.state === 'draft') && (
          <button type="button" className={PRIMARY} disabled={!canConfirm || p.busy || editing} onClick={p.onConfirm}>
            Confirm and send draft to Silexx
          </button>
        )}
        {d.state === 'confirmed' && h === 'failed_known' && (
          <button type="button" className={PRIMARY} disabled={p.busy} onClick={p.onHandOff}>
            Try handoff again
          </button>
        )}
        {d.state === 'confirmed' && h === 'none' && p.availability?.enabled !== false && (
          <button type="button" className={PRIMARY} disabled={p.busy} onClick={p.onHandOff}>
            Send draft to Silexx
          </button>
        )}
        {(h === 'uncertain' || h === 'populated_unverified') && (
          <div role="group" aria-label="Record what you found in Silexx" className="flex flex-wrap gap-2">
            {h === 'uncertain' && (
              <button type="button" className={SECONDARY} disabled={p.busy} onClick={() => p.onReconcile()}>
                Look it up in Silexx
              </button>
            )}
            <button type="button" className={SECONDARY} disabled={p.busy} onClick={() => p.onReconcile('present_correct')}>
              Checked: present and correct
            </button>
            <button type="button" className={SECONDARY} disabled={p.busy} onClick={() => p.onReconcile('absent')}>
              Checked: not in Silexx
            </button>
            <button type="button" className={SECONDARY} disabled={p.busy} onClick={() => p.onReconcile('wrong')}>
              Checked: ticket is wrong
            </button>
          </div>
        )}
        {canEdit && !editing && (
          <button type="button" className={SECONDARY} disabled={p.busy} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {d.state !== 'cancelled' && h !== 'in_progress' && (
          <button type="button" className={SECONDARY} disabled={p.busy} onClick={p.onCancel}>
            {h === 'none' || h === 'failed_known' ? 'Cancel draft' : 'Dismiss (does not change Silexx)'}
          </button>
        )}
      </div>
    </article>
  );
}

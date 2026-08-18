import { useEffect, useRef } from 'react';
import type { OrderDraft, ParseErrorResponse, SymbolCandidate } from '@silexx/shared';
import { WarningIcon } from './icons.tsx';

// ── helpers ───────────────────────────────────────────────────────────────────

function formatPrice(price: number | undefined): string {
  return price !== undefined ? `$${price.toFixed(2)}` : '—';
}

/** Plain-English restatement of the draft, so the trader reads exactly what
 *  the ticket will contain in one sentence. Kept as a single text node. */
export function orderSentence(draft: OrderDraft): string {
  const action = draft.side === 'BUY' ? 'buy' : 'sell';
  const qty = draft.quantity.toLocaleString();
  const unit = draft.quantity === 1 ? 'share' : 'shares';
  const pricePart =
    draft.orderType === 'MARKET'
      ? 'at the current market price'
      : draft.orderType === 'LIMIT'
        ? `at a limit price of ${formatPrice(draft.limitPrice)}`
        : `with a stop price of ${formatPrice(draft.stopPrice)}`;
  return `You are drafting an order to ${action} ${qty} ${unit} of ${draft.symbol} ${pricePart}.`;
}

function requiredFieldsPresent(draft: OrderDraft): boolean {
  return !!(draft.side && draft.quantity && draft.symbol && draft.orderType);
}

// ── sub-components ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200/70 bg-slate-50/70 px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 text-lg font-bold tracking-tight text-slate-900 tabular-nums">
        {children}
      </dd>
    </div>
  );
}

function OrderTicket({ draft }: { draft: OrderDraft }) {
  const isBuy = draft.side === 'BUY';
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Field label="Side">
        <span
          className={[
            'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-0.5 font-bold ring-1 ring-inset',
            isBuy
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
              : 'bg-red-50 text-red-700 ring-red-600/20',
          ].join(' ')}
        >
          <span
            aria-hidden="true"
            className={['h-2 w-2 rounded-full', isBuy ? 'bg-emerald-500' : 'bg-red-500'].join(
              ' ',
            )}
          />
          {draft.side}
        </span>
      </Field>
      <Field label="Quantity">{draft.quantity.toLocaleString()}</Field>
      <Field label="Symbol">{draft.symbol}</Field>
      <Field label="Order Type">{draft.orderType}</Field>
      {draft.limitPrice !== undefined && (
        <Field label="Limit Price">{formatPrice(draft.limitPrice)}</Field>
      )}
      {draft.stopPrice !== undefined && (
        <Field label="Stop Price">{formatPrice(draft.stopPrice)}</Field>
      )}
      <Field label="Asset Class">{draft.assetClass}</Field>
    </dl>
  );
}

function SymbolConfirmBanner({
  rawSymbol,
  resolvedSymbol,
}: {
  rawSymbol: string;
  resolvedSymbol: string;
}) {
  if (rawSymbol === resolvedSymbol) return null;
  return (
    <div className="rounded-lg border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
      <span className="font-semibold">Symbol resolved: </span>
      you said &ldquo;<span className="font-mono">{rawSymbol}</span>&rdquo;, using{' '}
      <span className="font-mono font-semibold">{resolvedSymbol}</span>
    </div>
  );
}

function SymbolClarifyPanel({
  candidates,
  isLoading,
  onResolve,
  onCancel,
}: {
  candidates: SymbolCandidate[];
  isLoading: boolean;
  onResolve: (symbol: string) => void;
  onCancel: () => void;
}) {
  return (
    <section
      aria-label="Symbol clarification"
      className="space-y-3 rounded-2xl border border-yellow-300 bg-yellow-50 p-6 shadow-card
                 animate-fade-up motion-reduce:animate-none"
    >
      <p className="text-base font-semibold text-yellow-900">Which symbol did you mean?</p>
      <p className="text-sm text-yellow-800">
        That name matches more than one ticker. Choose one to continue — no order is created.
      </p>
      <div className="flex flex-col gap-2">
        {candidates.map((c) => (
          <button
            key={c.symbol}
            type="button"
            disabled={isLoading}
            onClick={() => onResolve(c.symbol)}
            className="flex items-center justify-between rounded-lg border border-yellow-400 bg-white
                       px-4 py-3 text-left text-sm hover:bg-yellow-100 disabled:opacity-40
                       disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-yellow-500"
          >
            <span className="font-mono text-base font-semibold text-slate-900">{c.symbol}</span>
            <span className="text-slate-600">{c.name}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="text-sm font-medium text-slate-600 underline hover:text-slate-800
                   focus:outline-none focus:ring-2 focus:ring-slate-400 rounded"
      >
        Cancel
      </button>
    </section>
  );
}

function WarningBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
    >
      <WarningIcon className="h-5 w-5 shrink-0 text-amber-600" />
      <p className="text-sm font-semibold text-amber-900">
        This order has NOT been submitted to the market
      </p>
    </div>
  );
}

// ── ReviewPanel ───────────────────────────────────────────────────────────────

interface ReviewPanelProps {
  draft: OrderDraft | null;
  isLoading: boolean;
  parseError: ParseErrorResponse | null;
  draftError: string | null;
  candidates: SymbolCandidate[];
  onConfirm: () => Promise<void>;
  onResolve: (symbol: string) => void;
  onCancel: () => void;
}

export default function ReviewPanel({
  draft,
  isLoading,
  parseError,
  draftError,
  candidates,
  onConfirm,
  onResolve,
  onCancel,
}: ReviewPanelProps) {
  // Move keyboard/screen-reader context to the review heading when a draft
  // arrives — never to the confirm button (see §7.3 ReviewPanel invariants).
  const headingRef = useRef<HTMLHeadingElement>(null);
  const draftId = draft?.id;
  useEffect(() => {
    if (draftId) headingRef.current?.focus();
  }, [draftId]);

  if (!draft) {
    // Ambiguous symbol with candidates → let the trader pick a ticker.
    if (candidates.length > 0) {
      return (
        <SymbolClarifyPanel
          candidates={candidates}
          isLoading={isLoading}
          onResolve={onResolve}
          onCancel={onCancel}
        />
      );
    }
    if (parseError) {
      return (
        <div
          role="alert"
          data-testid="parse-error"
          className="space-y-1 rounded-2xl border border-red-200 bg-red-50 px-5 py-4
                     shadow-card animate-fade-up motion-reduce:animate-none"
        >
          <p className="text-sm font-semibold text-red-800">Could not parse order</p>
          <p className="text-sm text-red-700">{parseError.error}</p>
          {parseError.missingFields && parseError.missingFields.length > 0 && (
            <p className="text-sm text-red-700">
              Missing: <span className="font-mono">{parseError.missingFields.join(', ')}</span>
            </p>
          )}
        </div>
      );
    }
    return null;
  }

  const isBuy = draft.side === 'BUY';
  const confirmEnabled = !isLoading && requiredFieldsPresent(draft);

  return (
    <section
      data-testid="review-panel"
      aria-labelledby="review-panel-heading"
      className={[
        'space-y-4 overflow-hidden rounded-2xl border-t-4 bg-white p-6 shadow-card',
        'ring-1 ring-slate-900/5 animate-fade-up motion-reduce:animate-none',
        isBuy ? 'border-t-emerald-500' : 'border-t-red-500',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <h2
          id="review-panel-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-lg font-bold tracking-tight text-slate-900 focus:outline-none"
        >
          Review Order Draft
        </h2>
        <span
          className="rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-xs
                     font-bold uppercase tracking-wide text-slate-600"
        >
          Draft
        </span>
      </div>

      <WarningBanner />

      <SymbolConfirmBanner rawSymbol={draft.rawSymbol} resolvedSymbol={draft.symbol} />

      <p className="text-base text-slate-700">{orderSentence(draft)}</p>

      <OrderTicket draft={draft} />

      {draftError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {draftError}
        </div>
      )}

      <div className="flex gap-3 pt-1">
        {/* type="button" prevents Enter-key form submission; tabIndex prevents auto-focus */}
        <button
          type="button"
          tabIndex={-1}
          disabled={!confirmEnabled}
          onClick={() => {
            void onConfirm();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault();
          }}
          className="flex-1 rounded-xl bg-gradient-to-b from-emerald-500 to-emerald-600 px-4 py-3
                     text-base font-semibold text-white shadow-md shadow-emerald-600/25 transition
                     enabled:hover:from-emerald-600 enabled:hover:to-emerald-700
                     enabled:active:scale-[0.99] disabled:opacity-40 disabled:shadow-none
                     disabled:cursor-not-allowed focus:outline-none focus:ring-2
                     focus:ring-emerald-500 focus:ring-offset-2"
        >
          {isLoading ? 'Sending…' : 'Confirm Draft'}
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-base
                     font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50
                     active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-slate-400
                     focus:ring-offset-2"
        >
          Cancel
        </button>
      </div>

      <p className="text-xs text-slate-500">
        Confirming creates a draft ticket in Silexx for your review. Nothing is sent to the
        market.
      </p>
    </section>
  );
}

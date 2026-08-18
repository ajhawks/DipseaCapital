import { useRef, useEffect } from 'react';
import { useVoiceCapture } from '../hooks/useVoiceCapture.ts';
import { useOrderDraft } from '../hooks/useOrderDraft.ts';
import RecordButton from './RecordButton.tsx';
import TranscriptDisplay from './TranscriptDisplay.tsx';
import ReviewPanel from './ReviewPanel.tsx';
import { CheckCircleIcon } from './icons.tsx';

// ── step indicator ────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3;

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Speak' },
  { n: 2, label: 'Review' },
  { n: 3, label: 'Draft created' },
];

function StepIndicator({ current }: { current: Step }) {
  return (
    <ol aria-label="Order entry progress" className="flex items-center justify-center gap-2">
      {STEPS.map((s, i) => {
        const state = s.n < current ? 'done' : s.n === current ? 'active' : 'upcoming';
        return (
          <li
            key={s.n}
            aria-current={state === 'active' ? 'step' : undefined}
            className="flex items-center gap-2"
          >
            <span
              className={[
                'flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold transition-colors',
                state === 'done'
                  ? 'bg-emerald-500 text-white shadow-sm shadow-emerald-500/40'
                  : state === 'active'
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-600/40 ring-4 ring-blue-600/15'
                    : 'border border-slate-300 bg-white text-slate-400',
              ].join(' ')}
            >
              {state === 'done' ? (
                <CheckCircleIcon className="h-5 w-5" />
              ) : (
                s.n
              )}
            </span>
            <span
              className={[
                'text-sm font-medium',
                state === 'upcoming' ? 'text-slate-400' : 'text-slate-800',
              ].join(' ')}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className={[
                  'ml-1 h-0.5 w-8 rounded-full transition-colors',
                  s.n < current ? 'bg-emerald-400' : 'bg-slate-300',
                ].join(' ')}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ── VoiceOrderPanel ───────────────────────────────────────────────────────────

interface VoiceOrderPanelProps {
  token: string;
}

export default function VoiceOrderPanel({ token }: VoiceOrderPanelProps) {
  const {
    isRecording,
    transcript,
    error: speechError,
    startRecording,
    stopRecording,
    reset: resetVoice,
  } = useVoiceCapture();

  const {
    draft,
    isLoading,
    parseError,
    draftError,
    draftStatus,
    candidates,
    ticketId,
    submitTranscript,
    resolveSymbol,
    confirmDraft,
    cancelDraft,
  } = useOrderDraft(token);

  // Detect recording → stopped transition and submit the finalised transcript.
  // Web Speech API fires onend asynchronously after recognition.stop(), so we
  // cannot read the final transcript synchronously inside the stop handler.
  // React 18 batches setTranscript + setIsRecording from onend into one render,
  // so this effect always sees the final transcript when isRecording flips false.
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    if (wasRecordingRef.current && !isRecording && transcript.trim()) {
      void submitTranscript(transcript);
    }
    wasRecordingRef.current = isRecording;
  }, [isRecording, transcript, submitTranscript]);

  function handleCancel() {
    cancelDraft();
    resetVoice();
  }

  if (draftStatus === 'submitted') {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <StepIndicator current={3} />

        <section
          aria-label="Draft created"
          className="rounded-2xl bg-white p-8 shadow-card ring-1 ring-emerald-500/20
                     animate-fade-up motion-reduce:animate-none"
        >
          <div className="flex flex-col items-center gap-4 text-center">
            <span
              className="flex h-16 w-16 items-center justify-center rounded-full
                         bg-gradient-to-b from-emerald-50 to-emerald-100
                         ring-8 ring-emerald-500/10"
            >
              <CheckCircleIcon className="h-9 w-9 text-emerald-600" />
            </span>
            <div>
              <h2 className="text-xl font-bold tracking-tight text-slate-900">
                Draft ticket created in Silexx
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Open Silexx to review the draft and submit when ready.
              </p>
            </div>
            <div className="flex flex-col items-center gap-2">
              {draft && (
                <p
                  className={[
                    'rounded-lg px-4 py-2 font-mono text-sm font-bold tracking-tight ring-1 ring-inset',
                    draft.side === 'BUY'
                      ? 'bg-emerald-50 text-emerald-800 ring-emerald-600/20'
                      : 'bg-red-50 text-red-800 ring-red-600/20',
                  ].join(' ')}
                >
                  {draft.side} {draft.quantity.toLocaleString()} {draft.symbol}
                  {draft.orderType === 'MARKET'
                    ? ' · MARKET'
                    : draft.limitPrice !== undefined
                      ? ` · LIMIT $${draft.limitPrice.toFixed(2)}`
                      : draft.stopPrice !== undefined
                        ? ` · STOP $${draft.stopPrice.toFixed(2)}`
                        : ` · ${draft.orderType}`}
                </p>
              )}
              {ticketId && (
                <p className="font-mono text-xs text-slate-500">Ticket {ticketId}</p>
              )}
            </div>
            <p className="text-xs font-semibold text-amber-700">
              No order has been submitted to the market.
            </p>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-5 py-2.5
                         text-sm font-semibold text-white shadow-md shadow-blue-600/25
                         transition hover:from-blue-600 hover:to-blue-700 active:scale-[0.99]
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Record another order
            </button>
          </div>
        </section>
      </div>
    );
  }

  const step: Step = draftStatus === 'reviewing' || draftStatus === 'clarifying' ? 2 : 1;

  const statusMessage = isRecording
    ? 'Listening — speak your order, then press stop.'
    : isLoading
      ? 'Processing your order…'
      : draftStatus === 'reviewing'
        ? 'Check every field below before confirming.'
        : draftStatus === 'clarifying'
          ? 'Choose the symbol you meant below.'
          : 'Press the microphone and speak your order.';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <StepIndicator current={step} />

      <section
        aria-label="Voice input"
        className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-900/5"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <RecordButton
            isRecording={isRecording}
            isLoading={isLoading}
            onStart={startRecording}
            onStop={stopRecording}
          />
          <p aria-live="polite" className="text-sm font-medium text-slate-600">
            {statusMessage}
          </p>
          {!transcript && !isRecording && (
            <p className="text-sm text-slate-400">
              Example: &ldquo;Buy 100 shares of AAPL at 195.50&rdquo;
            </p>
          )}
          {speechError && (
            <p role="alert" className="text-sm font-medium text-red-600">
              Microphone error: {speechError}
            </p>
          )}
        </div>

        <div className="mt-5">
          <TranscriptDisplay transcript={transcript} isRecording={isRecording} />
        </div>

        {parseError !== null && draft === null && draftStatus !== 'clarifying' && (
          <p className="mt-3 text-sm text-slate-500">
            Record again with a different phrase to retry.
          </p>
        )}
      </section>

      <ReviewPanel
        draft={draft}
        isLoading={isLoading}
        parseError={parseError}
        draftError={draftError}
        candidates={candidates}
        onConfirm={confirmDraft}
        onResolve={(symbol) => {
          void resolveSymbol(symbol);
        }}
        onCancel={handleCancel}
      />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useVoiceCapture } from '../hooks/useVoiceCapture.ts';
import { useDrafts } from '../hooks/useDrafts.ts';
import RecordButton from './RecordButton.tsx';
import TranscriptDisplay from './TranscriptDisplay.tsx';
import TextEntry from './TextEntry.tsx';
import DraftCard from './DraftCard.tsx';

interface VoiceOrderPanelProps {
  token: string;
}

export default function VoiceOrderPanel({ token }: VoiceOrderPanelProps) {
  const { isRecording, transcript, error: speechError, startRecording, stopRecording } = useVoiceCapture();
  const d = useDrafts(token);
  // Remember the last utterance so a symbol choice can re-parse it with an override.
  const [lastTranscript, setLastTranscript] = useState('');

  const submit = (text: string, symbolOverride?: string) => {
    setLastTranscript(text);
    void d.submitTranscript(text, symbolOverride);
  };

  // Web Speech fires onend asynchronously after stop(); submit when recording flips off.
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    if (wasRecordingRef.current && !isRecording && transcript.trim()) submit(transcript);
    wasRecordingRef.current = isRecording;
  }, [isRecording, transcript]); // `submit` is recreated each render; including it would re-fire the effect.

  const status = isRecording
    ? 'Listening: speak one order, then press stop.'
    : d.isParsing
      ? 'Interpreting…'
      : d.drafts.length > 0
        ? 'Review each draft below. Each one is confirmed on its own.'
        : 'Press the microphone or type an order.';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section aria-label="Order input" className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-900/5">
        <div className="flex flex-col items-center gap-3 text-center">
          <RecordButton isRecording={isRecording} isLoading={d.isParsing} onStart={startRecording} onStop={stopRecording} />
          <p aria-live="polite" className="text-sm font-medium text-slate-600">
            {status}
          </p>
          {speechError && (
            <p role="alert" className="text-sm font-medium text-red-600">
              Microphone error: {speechError}. You can type the order instead.
            </p>
          )}
        </div>
        <div className="mt-5">
          <TranscriptDisplay transcript={transcript} isRecording={isRecording} />
        </div>
        <div className="mt-4">
          <TextEntry disabled={d.isParsing} onSubmit={(t) => submit(t)} />
        </div>
      </section>

      <div aria-live="polite" className="space-y-3">
        {d.error && (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800 ring-1 ring-red-600/20">
            {d.error}
          </p>
        )}
        {d.refusals.map((r) => (
          <p key={r.code} role="alert" data-testid="refusal" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-600/20">
            <span className="font-semibold">Not drafted. </span>
            {r.message}
          </p>
        ))}
        {d.clarifications.map((c) => (
          <div key={c.code} data-testid="clarification" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-600/20">
            <p>
              <span className="font-semibold">Clarification needed. </span>
              {c.message}
            </p>
            {c.candidates && c.candidates.length > 0 && (
              <div role="group" aria-label="Which symbol did you mean?" className="mt-2 flex flex-wrap gap-2">
                {c.candidates.map((cand) => (
                  <button
                    key={cand.symbol}
                    type="button"
                    onClick={() => submit(lastTranscript, cand.symbol)}
                    className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {cand.symbol} <span className="font-normal text-slate-500">{cand.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <section aria-label="Drafts" className="space-y-4">
        {d.drafts.map((draft) => (
          <DraftCard
            key={draft.id}
            draft={draft}
            busy={d.busyId === draft.id}
            error={d.cardErrors[draft.id] || undefined}
            availability={d.availability}
            onEdit={(c) => void d.edit(draft, c)}
            onAcknowledge={(codes) => void d.acknowledge(draft, codes)}
            onConfirm={() => void d.confirmAndHandOff(draft)}
            onHandOff={() => void d.handOff(draft)}
            onCancel={() => void d.cancel(draft)}
            onReconcile={(r) => void d.reconcile(draft, r)}
          />
        ))}
      </section>
    </div>
  );
}

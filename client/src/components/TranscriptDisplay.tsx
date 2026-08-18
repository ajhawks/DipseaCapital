interface TranscriptDisplayProps {
  transcript: string;
  isRecording?: boolean;
}

export default function TranscriptDisplay({
  transcript,
  isRecording = false,
}: TranscriptDisplayProps) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        You said
      </p>
      <div
        role="log"
        aria-live="polite"
        aria-label="Live transcript"
        className="min-h-[4.5rem] rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-base text-slate-800"
      >
        {transcript ? (
          <span className="italic">&ldquo;{transcript}&rdquo;</span>
        ) : isRecording ? (
          <span className="flex items-center gap-2 text-slate-500">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-red-500 animate-pulse motion-reduce:animate-none"
            />
            Listening…
          </span>
        ) : (
          <span className="text-slate-400 select-none">Transcript will appear here…</span>
        )}
      </div>
    </div>
  );
}

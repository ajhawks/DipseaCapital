import { MicIcon, SpinnerIcon, StopIcon } from './icons.tsx';

interface RecordButtonProps {
  isRecording: boolean;
  isLoading: boolean;
  onStart: () => void;
  onStop: () => void;
}

export default function RecordButton({
  isRecording,
  isLoading,
  onStart,
  onStop,
}: RecordButtonProps) {
  const disabled = isLoading;

  function handleClick() {
    if (isRecording) {
      onStop();
    } else {
      onStart();
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label={isRecording ? 'Stop recording' : 'Start recording'}
      aria-pressed={isRecording}
      className={[
        'relative inline-flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-full',
        'transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-offset-2',
        disabled
          ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
          : isRecording
            ? 'bg-gradient-to-b from-red-500 to-red-600 text-white shadow-lg shadow-red-600/40 hover:from-red-600 hover:to-red-700 focus-visible:ring-red-300'
            : 'bg-gradient-to-b from-blue-500 to-blue-600 text-white shadow-lg shadow-blue-600/40 hover:from-blue-600 hover:to-blue-700 hover:shadow-xl hover:shadow-blue-600/40 focus-visible:ring-blue-300',
      ].join(' ')}
    >
      {isRecording && (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-red-500 opacity-40 animate-ping motion-reduce:animate-none"
        />
      )}
      <span className="relative">
        {disabled ? (
          <SpinnerIcon className="h-6 w-6" />
        ) : isRecording ? (
          <StopIcon className="h-7 w-7" />
        ) : (
          <MicIcon className="h-7 w-7" />
        )}
      </span>
    </button>
  );
}

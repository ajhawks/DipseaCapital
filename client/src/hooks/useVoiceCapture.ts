import { useState, useRef, useCallback } from 'react';

interface UseVoiceCaptureReturn {
  isRecording: boolean;
  transcript: string;
  error: string | null;
  startRecording: () => void;
  stopRecording: () => void;
  reset: () => void;
}

type WebkitWindow = Window & { webkitSpeechRecognition?: typeof SpeechRecognition };

export function useVoiceCapture(): UseVoiceCaptureReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const finalTranscriptRef = useRef('');

  const startRecording = useCallback(() => {
    const SpeechRecognitionImpl =
      window.SpeechRecognition ??
      (window as WebkitWindow).webkitSpeechRecognition;

    if (!SpeechRecognitionImpl) {
      setError('Speech recognition is not supported in this browser.');
      return;
    }

    finalTranscriptRef.current = '';
    setTranscript('');
    setError(null);

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          finalTranscriptRef.current += text;
        } else {
          interim += text;
        }
      }
      setTranscript(finalTranscriptRef.current + interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setError(event.error);
      setIsRecording(false);
    };

    recognition.onend = () => {
      setTranscript(finalTranscriptRef.current);
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }, []);

  const reset = useCallback(() => {
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    finalTranscriptRef.current = '';
    setIsRecording(false);
    setTranscript('');
    setError(null);
  }, []);

  return { isRecording, transcript, error, startRecording, stopRecording, reset };
}

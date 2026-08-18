import { useState, useCallback } from 'react';
import type { OrderDraft, ParseErrorResponse, SymbolCandidate } from '@silexx/shared';
import { fetchParse, fetchCreateDraft, ParseApiError } from '../services/api';

type DraftStatus = 'idle' | 'reviewing' | 'clarifying' | 'submitted';

interface UseOrderDraftReturn {
  draft: OrderDraft | null;
  isLoading: boolean;
  parseError: ParseErrorResponse | null;
  draftError: string | null;
  draftStatus: DraftStatus;
  candidates: SymbolCandidate[];
  ticketId: string | null;
  submitTranscript: (transcript: string) => Promise<void>;
  resolveSymbol: (symbol: string) => Promise<void>;
  confirmDraft: () => Promise<void>;
  cancelDraft: () => void;
}

export function useOrderDraft(token: string): UseOrderDraftReturn {
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [parseError, setParseError] = useState<ParseErrorResponse | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>('idle');
  const [candidates, setCandidates] = useState<SymbolCandidate[]>([]);
  const [ticketId, setTicketId] = useState<string | null>(null);
  // Remember the last transcript so an ambiguity choice can be re-parsed with an override.
  const [lastTranscript, setLastTranscript] = useState<string>('');

  const runParse = useCallback(
    async (transcript: string, symbolOverride?: string) => {
      setIsLoading(true);
      setParseError(null);
      try {
        const { draft: parsed } = await fetchParse(transcript, token, symbolOverride);
        setDraft(parsed);
        setCandidates([]);
        setDraftStatus('reviewing');
      } catch (err) {
        const response =
          err instanceof ParseApiError
            ? err.response
            : ({ error: 'Unexpected error', code: 'PARSE_FAILED' } as ParseErrorResponse);
        setParseError(response);
        setDraft(null);
        // An ambiguous symbol with candidates is recoverable: let the trader pick one.
        if (response.code === 'AMBIGUOUS_SYMBOL' && response.candidates?.length) {
          setCandidates(response.candidates);
          setDraftStatus('clarifying');
        } else {
          setCandidates([]);
          setDraftStatus('idle');
        }
      } finally {
        setIsLoading(false);
      }
    },
    [token],
  );

  const submitTranscript = useCallback(
    async (transcript: string) => {
      setLastTranscript(transcript);
      await runParse(transcript);
    },
    [runParse],
  );

  const resolveSymbol = useCallback(
    async (symbol: string) => {
      if (!lastTranscript) return;
      await runParse(lastTranscript, symbol);
    },
    [runParse, lastTranscript],
  );

  const confirmDraft = useCallback(async () => {
    if (!draft) return;
    setIsLoading(true);
    setDraftError(null);
    try {
      const res = await fetchCreateDraft(draft, token);
      setTicketId(res.silexxTicketId);
      setDraftStatus('submitted');
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'Draft creation failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [draft, token]);

  const cancelDraft = useCallback(() => {
    setDraft(null);
    setParseError(null);
    setDraftError(null);
    setCandidates([]);
    setLastTranscript('');
    setTicketId(null);
    setDraftStatus('idle');
  }, []);

  return {
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
  };
}
